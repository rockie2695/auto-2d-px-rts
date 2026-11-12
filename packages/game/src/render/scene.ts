import { Container, Graphics, Sprite, Texture } from 'pixi.js'

import { isRockAt, UNITS_PER_TILE } from '../sim/types.ts'
import type { World, WorldDefs } from '../sim/types.ts'
import type { WorldSnapshot } from '../sim/world.ts'
import type { InfluenceMap } from '../ai/influence.ts'

import {
  COLOR_BUILDING_ENEMY,
  COLOR_BUILDING_PLAYER,
  COLOR_CRYSTAL_NODE,
  COLOR_EMERALD_NODE,
  COLOR_FLOOR,
  COLOR_HP_BG,
  COLOR_HP_HIGH,
  COLOR_HP_LOW,
  COLOR_HP_MID,
  COLOR_RUBY_NODE,
  COLOR_ROCK,
  COLOR_SELECTED,
  COLOR_UNIT_ENEMY,
  COLOR_UNIT_PLAYER,
  ARMOR_BAR_HEIGHT,
  HP_BAR_HEIGHT,
  TILE_SIZE,
  UNIT_RENDER_SIZE,
} from './constants.ts'
import { armorBarRatio, armorTierColorPixiOf, armorTierOf } from './armor.ts'
import { influenceCellColor } from './overlay.ts'
import { clamp01, fixedToPx, interpolateDisplay } from './interpolate.ts'
import { firedThisTick, towerVictimOf } from './attackFx.ts'
import {
  clampCamera,
  fitCamera,
  panBy as panCamera,
  worldPxOf,
  zoomAt as zoomCamera,
} from './camera.ts'
import type { Camera } from './camera.ts'
import type { SelectionTarget } from './hitTest.ts'
import type { Viewport } from './viewport.ts'

/**
 * 遊戲場景（render 層，Prompt 9）：持有 PixiJS 顯示物件，把世界快照畫成像素風。
 *
 * - MVP 不用 sprite 圖：tiles／建築／單位／血條全用 `Graphics` 色塊（SPEC §15）。
 * - 邏輯 20Hz、渲染 60fps：單位位置在前後兩份快照之間線性插值（`interpolate.ts`）。
 * - 靜態層（地板／岩石／資源點）在 `initialize` 畫一次；動態層每幀重畫
 *   （實體數量 ≤ 數十個，重畫成本可忽略，避免維護實體 display object 生命週期）。
 * - 選取框由 ui 層經 `setSelected` 推入 —— 本層不 import React / zustand。
 */
export class GameScene {
  /** 掛到 `app.stage` 的根容器（縮放／置中在 `update` 時套用）。 */
  readonly root = new Container()

  private readonly tilesG = new Graphics()
  /** 疊加層容器（Prompt 9.5 完整版）：熱力圖 Sprite（tiles 之上、單位之下）。 */
  private readonly overlayG = new Container()
  private heatmapSprite: Sprite | null = null
  private heatmapCanvas: HTMLCanvasElement | null = null
  private heatmapTexture: Texture | null = null
  private heatmapData: InfluenceMap | null = null
  /** 迷霧暗罩（Prompt 9.5 完整版）：最頂層半透明暗格＝player AI 知識邊界。 */
  private readonly fogG = new Graphics()
  /** 路徑虛線（Prompt 9.5 完整版）：開關開啟時取代極淡意圖直線。 */
  private readonly pathsG = new Graphics()
  private readonly markersG = new Graphics()
  private readonly objG = new Graphics()
  private readonly fxG = new Graphics()
  /** 疊加層開關（Prompt 9.5 完整版）：只切 visible，不影響任何繪製與 sim。 */
  private overlays = { heatmap: false, fog: false, paths: false }

  private readonly mapSizeTiles: number
  private defs: WorldDefs | null = null
  private selected: SelectionTarget | null = null
  /** 攻擊特效（Prompt 10.10）：開火 → 彈丸／揮擊＋受擊閃光，短暫存在後過期。 */
  private effects: AttackEffect[] = []
  private lastFxTick = -1
  /** 視角相機（Prompt 10.12）：預設完整入鏡，可拖曳平移／游標縮放。 */
  private camera: Camera | null = null
  /** 使用者調過視角（縮放／平移）→ resize 時保留其視角（僅重新夾限）。 */
  private userAdjusted = false
  /** 地圖標記（Prompt 10.13）：集結點／生產點，由 ui/session 推入。 */
  private markers: MapMarker[] = []

  constructor(mapSizeTiles: number) {
    this.mapSizeTiles = mapSizeTiles
    // 圖層序：tiles → 熱力圖 → 標記 → 實體 → 路徑虛線 → 特效 → 迷霧暗罩（最頂）。
    this.root.addChild(
      this.tilesG,
      this.overlayG,
      this.markersG,
      this.objG,
      this.pathsG,
      this.fxG,
      this.fogG,
    )
    this.overlayG.visible = false
    this.fogG.visible = false
    this.pathsG.visible = false
  }

  /** 疊加層開關（Prompt 9.5 完整版）：只切容器 visible——不重繪、不碰 sim。 */
  setOverlays(opts: { heatmap: boolean; fog: boolean; paths: boolean }): void {
    this.overlays = { ...opts }
    // 熱力圖：有資料才亮（開關先於資料推入時不會閃空圖）。
    this.overlayG.visible = opts.heatmap && this.heatmapSprite !== null
    this.fogG.visible = opts.fog
    this.pathsG.visible = opts.paths
    // 關閉路徑疊加 → 回到既有極淡意圖直線（fxG 內畫）。
  }

  /**
   * 熱力圖資料推入（Prompt 9.5 完整版）：UI 500ms 呼叫一次。
   * 離屏 canvas 每格一像素（紅＝敵威脅、藍＝我方控制）→ `Texture.from(canvas)`
   * nearest 縮放貼滿地圖；同 tick 重複推入不重繪。
   */
  updateInfluence(map: InfluenceMap): void {
    this.heatmapData = map
    if (!this.overlays.heatmap) return
    this.redrawHeatmap()
  }

  /** 迷霧暗罩資料推入（Prompt 9.5b 接 sight.ts；9.5a 為空 mask＝全可見）。 */
  updateFogMask(mask: readonly boolean[] | null): void {
    this.fogG.clear()
    if (mask === null) return
    const size = mask.length === 0 ? 0 : Math.round(Math.sqrt(mask.length))
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (mask[y * size + x] === true) continue
        this.fogG
          .rect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
          .fill({ color: 0x05070c, alpha: 0.5 })
      }
    }
  }

  /** 離屏 canvas 重繪熱力圖（開關開啟或資料更新時呼叫）。 */
  private redrawHeatmap(): void {
    const map = this.heatmapData
    if (map === null) return
    if (this.heatmapSprite === null || this.heatmapCanvas === null) {
      this.heatmapCanvas = document.createElement('canvas')
      this.heatmapCanvas.width = map.gridSize
      this.heatmapCanvas.height = map.gridSize
      this.heatmapTexture = Texture.from(this.heatmapCanvas)
      // 像素風：一格一像素、nearest 縮放不模糊。
      this.heatmapTexture.source.scaleMode = 'nearest'
      this.heatmapSprite = new Sprite(this.heatmapTexture)
      this.heatmapSprite.width = map.mapSize * TILE_SIZE
      this.heatmapSprite.height = map.mapSize * TILE_SIZE
      this.overlayG.addChild(this.heatmapSprite)
    }
    const canvas = this.heatmapCanvas
    if (canvas.width !== map.gridSize) {
      canvas.width = map.gridSize
      canvas.height = map.gridSize
    }
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    // 全圖最大格值（紅藍共用強度歸一，相對強度不失真）。
    let max = 0
    for (let index = 0; index < map.own.length; index++) {
      max = Math.max(max, map.own[index] ?? 0, map.enemy[index] ?? 0)
    }
    const image = ctx.createImageData(map.gridSize, map.gridSize)
    for (let index = 0; index < map.gridSize * map.gridSize; index++) {
      const color = influenceCellColor(map.own[index] ?? 0, map.enemy[index] ?? 0, max)
      const offset = index * 4
      image.data[offset] = color.r
      image.data[offset + 1] = color.g
      image.data[offset + 2] = color.b
      image.data[offset + 3] = Math.round(color.a * 255)
    }
    ctx.putImageData(image, 0, 0)
    if (this.heatmapTexture !== null) this.heatmapTexture.source.update()
  }

  /** ui/session（戰術計畫）→ render 的標記推入（集結點／生產點）。 */
  setMarkers(markers: readonly MapMarker[]): void {
    this.markers = [...markers]
  }

  /** ui（選取）→ render 的單向設定。 */
  setSelected(target: SelectionTarget | null): void {
    this.selected = target
  }

  /* ---------------------------------------------------------------- */
  /* 視角相機（Prompt 10.12）：完整入鏡為預設；ui 經以下 API 平移／縮放。 */
  /* ---------------------------------------------------------------- */

  /** 目前視埠（供 ui 的打點換算；與 `update` 用同一份相機）。 */
  viewportOf(viewW: number, viewH: number): Viewport {
    const worldPx = worldPxOf(this.mapSizeTiles)
    const camera = this.camera ?? fitCamera(worldPx, viewW, viewH)
    return { scale: camera.scale, offsetX: camera.offsetX, offsetY: camera.offsetY, worldPx }
  }

  /** 拖曳平移（含邊界夾限）。 */
  panBy(dx: number, dy: number, viewW: number, viewH: number): void {
    const worldPx = worldPxOf(this.mapSizeTiles)
    this.camera = panCamera(
      this.camera ?? fitCamera(worldPx, viewW, viewH),
      dx,
      dy,
      worldPx,
      viewW,
      viewH,
    )
    this.userAdjusted = true
  }

  /** 以螢幕點為中心滾輪縮放（游標下的世界點固定；下限＝完整入鏡）。 */
  zoomAt(screenX: number, screenY: number, factor: number, viewW: number, viewH: number): void {
    const worldPx = worldPxOf(this.mapSizeTiles)
    this.camera = zoomCamera(
      this.camera ?? fitCamera(worldPx, viewW, viewH),
      screenX,
      screenY,
      factor,
      worldPx,
      viewW,
      viewH,
    )
    this.userAdjusted = true
  }

  /** 重置視角：回完整入鏡。（雙擊畫布） */
  resetView(): void {
    this.camera = null
    this.userAdjusted = false
  }

  /**
   * 建築佔地查表（render 層供拾取用；Prompt 9.1）。
   * `initialize` 後 defs 已就位，此查表與靜態底圖用同一份內容。
   */
  buildingSizeOf(defId: string): { w: number; h: number } | null {
    const def = this.defs?.buildings[defId]
    if (def === undefined) return null
    const [w, h] = def.size
    return { w, h }
  }

  /**
   * 載入靜態資料：畫 tile 底圖與資源點、記住建築/單位定義查表
   * （`world.defs` 與 `world.map` 為不可變內容，直接引用安全）。
   * 由組合根在世界建立後呼叫一次。
   */
  initialize(world: World): void {
    this.defs = world.defs

    this.tilesG.clear()
    for (let y = 0; y < this.mapSizeTiles; y++) {
      for (let x = 0; x < this.mapSizeTiles; x++) {
        this.tilesG
          .rect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
          .fill(isRockAt(world, { x, y }) ? COLOR_ROCK : COLOR_FLOOR)
      }
    }
    // 資源點：小方塊**按資源類型著色**（Prompt 5：藍水晶／紅寶石／綠翡翠），
    // 讓礦場在空地上有依附參照、礦點類型一眼可辨。
    for (const node of world.resourceNodes) {
      const color =
        node.resourceType === 'red_ruby'
          ? COLOR_RUBY_NODE
          : node.resourceType === 'green_emerald'
            ? COLOR_EMERALD_NODE
            : COLOR_CRYSTAL_NODE
      this.tilesG
        .rect(
          node.x * TILE_SIZE + TILE_SIZE / 2 - 5,
          node.y * TILE_SIZE + TILE_SIZE / 2 - 5,
          10,
          10,
        )
        .fill(color)
    }
  }

  /** 每幀呼叫：套用整數縮放排佈 + 重畫動態實體（建築 → 單位 → 血條 → 選取框）。 */
  update(
    curr: WorldSnapshot,
    prev: WorldSnapshot | null,
    alpha: number,
    viewW: number,
    viewH: number,
  ): void {
    if (this.defs === null) return
    // 相機：未調過＝跟隨視窗（完整入鏡）；調過＝保留視角、resize 僅重新夾限。
    const worldPx = worldPxOf(this.mapSizeTiles)
    if (this.camera === null || !this.userAdjusted) {
      this.camera = fitCamera(worldPx, viewW, viewH)
    } else {
      this.camera = clampCamera(this.camera, worldPx, viewW, viewH)
    }
    this.root.scale.set(this.camera.scale)
    this.root.position.set(this.camera.offsetX, this.camera.offsetY)

    const t = clamp01(alpha)
    // 前一份快照的單位显示位置（px），插值用。
    const prevById = new Map<number, { x: number; y: number }>()
    if (prev !== null) {
      for (const unit of prev.units) {
        prevById.set(unit.id, { x: fixedToPx(unit.x), y: fixedToPx(unit.y) })
      }
    }

    this.objG.clear()

    // 地圖標記（Prompt 10.19）：出廠集合格＝菱形（每間生產建築一個），分陣營上色 + 深色描邊。
    this.markersG.clear()
    for (const marker of this.markers) {
      const color = marker.player === 'player' ? COLOR_UNIT_PLAYER : COLOR_UNIT_ENEMY
      const cx = marker.tile.x * TILE_SIZE + TILE_SIZE / 2
      const cy = marker.tile.y * TILE_SIZE + TILE_SIZE / 2
      const r = 5
      this.markersG
        .poly([cx, cy - r - 1, cx + r + 1, cy, cx, cy + r + 1, cx - r - 1, cy])
        .fill(color)
        .stroke({ width: 1, color: 0x10131a })
      // 標記選取框（Prompt 10.17）：點中的標記外描一圈亮框。
      if (
        this.selected?.kind === 'marker' &&
        this.selected.marker.kind === marker.kind &&
        this.selected.marker.player === marker.player &&
        this.selected.marker.buildingId === marker.buildingId
      ) {
        this.markersG
          .rect(cx - r - 4, cy - r - 4, (r + 4) * 2, (r + 4) * 2)
          .stroke({ width: 1, color: COLOR_SELECTED })
      }
    }

    // 建築：按定義佔地的色塊 + 頂部血條（未完工按完成比例折算 maxHp，SPEC §5）。
    for (const building of curr.buildings) {
      const def = this.defs.buildings[building.defId]
      if (def === undefined) continue
      const [w, h] = def.size
      const x = building.x * TILE_SIZE
      const y = building.y * TILE_SIZE
      this.objG
        .rect(x, y, w * TILE_SIZE, h * TILE_SIZE)
        .fill(building.player === 'player' ? COLOR_BUILDING_PLAYER : COLOR_BUILDING_ENEMY)

      const effMax =
        building.totalTicks === 0
          ? def.hp
          : Math.max(1, Math.floor((def.hp * building.builtTicks) / building.totalTicks))
      const ratio = effMax > 0 ? Math.min(1, Math.max(0, building.hp / effMax)) : 0
      this.drawHpBar({ x: x + 4, y: y + 4, width: w * TILE_SIZE - 8, ratio })

      // 建築選取框：描在佔地外框（Prompt 9.1：點建築與點單位行為對稱）。
      if (this.selected?.kind === 'building' && building.id === this.selected.id) {
        this.objG
          .rect(x - 2, y - 2, w * TILE_SIZE + 4, h * TILE_SIZE + 4)
          .stroke({ width: 1, color: COLOR_SELECTED })
      }
    }

    // 單位：插值位置（取整維持像素密度）+ 色塊 + 血條 + 選取框。
    for (const unit of curr.units) {
      if (unit.hp <= 0) continue
      const def = this.defs.units[unit.defId]
      if (def === undefined) continue

      const pos = interpolateDisplay(
        prevById.get(unit.id) ?? null,
        { x: fixedToPx(unit.x), y: fixedToPx(unit.y) },
        t,
      )
      const cx = Math.round(pos.x)
      const cy = Math.round(pos.y)
      const x = cx - UNIT_RENDER_SIZE / 2
      const y = cy - UNIT_RENDER_SIZE / 2
      this.objG
        .rect(x, y, UNIT_RENDER_SIZE, UNIT_RENDER_SIZE)
        .fill(unit.player === 'player' ? COLOR_UNIT_PLAYER : COLOR_UNIT_ENEMY)

      const ratio = def.stats.hp > 0 ? Math.min(1, Math.max(0, unit.hp / def.stats.hp)) : 0
      // 血條與單位色塊之間插裝甲條（Prompt 9.5 完整版）：armor > 0 才畫。
      // 版式：血條（頂）→ 2px → 裝甲條 → 2px → 單位色塊。
      const armorTier = armorTierOf(def.stats.armor)
      const hasArmorBar = armorTier !== 'none'
      const hpY = y - HP_BAR_HEIGHT - (hasArmorBar ? ARMOR_BAR_HEIGHT + 4 : 2)
      this.drawHpBar({ x, y: hpY, width: UNIT_RENDER_SIZE, ratio })
      if (hasArmorBar) {
        this.drawArmorBar({
          x,
          y: y - ARMOR_BAR_HEIGHT - 2,
          width: UNIT_RENDER_SIZE,
          armor: def.stats.armor,
        })
      }

      if (this.selected?.kind === 'unit' && unit.id === this.selected.id) {
        this.objG
          .rect(x - 2, y - 2, UNIT_RENDER_SIZE + 4, UNIT_RENDER_SIZE + 4)
          .stroke({ width: 1, color: COLOR_SELECTED })
      }
    }

    // 攻擊特效（Prompt 10.10）：每個新 tick 以快照 diff 偵測開火一次
    // （attackAcc 由 ≥1 掉落 → 本 tick 開火），加入特效佇列後逐幀衰減重畫。
    const now = performance.now()
    if (prev !== null && prev.tick !== this.lastFxTick) {
      this.lastFxTick = prev.tick
      const currById = new Map<number, WorldSnapshot['units'][number]>()
      for (const unit of curr.units) currById.set(unit.id, unit)
      const buildingsById = new Map<number, WorldSnapshot['buildings'][number]>()
      for (const building of curr.buildings) buildingsById.set(building.id, building)
      for (const before of prev.units) {
        const after = currById.get(before.id)
        if (after === undefined || after.hp <= 0) continue
        // 開火判據（Prompt 10.24 修，attackFx.ts）：attackAcc 只在開火 tick 下降。
        if (!firedThisTick(before.attackAcc, after.attackAcc)) continue
        const def = this.defs.units[after.defId]
        if (def === undefined) continue
        const victim = victimOf(this.defs, after, currById, buildingsById)
        if (victim === null) continue
        this.effects.push({
          kind: def.role === 'ranged' ? 'shot' : 'melee',
          fromX: fixedToPx(after.x),
          fromY: fixedToPx(after.y),
          toX: fixedToPx(victim.x),
          toY: fixedToPx(victim.y),
          color: after.player === 'player' ? COLOR_UNIT_PLAYER : COLOR_UNIT_ENEMY,
          born: now,
        })
      }
      // 塔的開火特效（Prompt 10.16，10.24 修）：快照 diff 偵測 `building.attackAcc`
      // 掉落（同單位判據）；受害者由**渲染層現算**（`towerVictimOf`：射程內最近
      // 敵方單位）——sim 的 `building.targetId` 恆為 null（無人設值），舊條件
      // 讓塔的開火特效從未出現過。起點 = 建築**外框**最近受害者的點、終點 = 受害單位。
      for (const before of prev.buildings) {
        const after = buildingsById.get(before.id)
        if (after === undefined || after.hp <= 0) continue
        if (!firedThisTick(before.attackAcc, after.attackAcc)) continue
        if (this.defs.buildings[after.defId]?.defense === undefined) continue
        const victim = towerVictimOf(this.defs, after, curr.units)
        if (victim === null) continue
        const edge = closestPointOnBuilding(victim, after, this.defs)
        this.effects.push({
          kind: 'shot',
          fromX: fixedToPx(edge.x),
          fromY: fixedToPx(edge.y),
          toX: fixedToPx(victim.x),
          toY: fixedToPx(victim.y),
          color: after.player === 'player' ? COLOR_BUILDING_PLAYER : COLOR_BUILDING_ENEMY,
          born: now,
        })
      }
    }
    this.effects = this.effects.filter((fx) => now - fx.born < ATTACK_FX_MS)
    this.fxG.clear()

    // 持續接戰線（Prompt 10.13）：射程內有目標的單位畫淡色細線到目標——
    // 一眼看出「誰在打誰」（不只開火那一瞬）。**受害者含建築**（Prompt 10.14）：
    // 打建築同樣畫線（端點 = 建築外框最近點），之前打建築什麼都不畫。
    const engageById = new Map<number, WorldSnapshot['units'][number]>()
    for (const unit of curr.units) engageById.set(unit.id, unit)
    const engageBuildingsById = new Map<number, WorldSnapshot['buildings'][number]>()
    for (const building of curr.buildings) engageBuildingsById.set(building.id, building)
    for (const unit of curr.units) {
      if (unit.hp <= 0) continue
      const victim = victimOf(this.defs, unit, engageById, engageBuildingsById)
      if (victim === null) continue
      const color = unit.player === 'player' ? COLOR_UNIT_PLAYER : COLOR_UNIT_ENEMY
      this.fxG
        .moveTo(fixedToPx(unit.x), fixedToPx(unit.y))
        .lineTo(fixedToPx(victim.x), fixedToPx(victim.y))
        .stroke({ width: 1, color, alpha: 0.28 })
    }
    // 塔的持續接戰線（Prompt 10.16，10.24 修）：受害者由 `towerVictimOf` 現算——
    // 舊條件依賴 `building.targetId`（恆 null）→ 塔的接戰線從未畫過。
    for (const building of curr.buildings) {
      if (building.hp <= 0) continue
      if (this.defs.buildings[building.defId]?.defense === undefined) continue
      const victim = towerVictimOf(this.defs, building, curr.units)
      if (victim === null) continue
      const edge = closestPointOnBuilding(victim, building, this.defs)
      const color = building.player === 'player' ? COLOR_BUILDING_PLAYER : COLOR_BUILDING_ENEMY
      this.fxG
        .moveTo(fixedToPx(edge.x), fixedToPx(edge.y))
        .lineTo(fixedToPx(victim.x), fixedToPx(victim.y))
        .stroke({ width: 1, color, alpha: 0.28 })
    }

    // 移動意圖線（Prompt 10.17）：有路徑的單位畫一條**極淡**的線到路徑終點格心——
    // 一眼看出「部隊正往哪去」（alpha 0.12，與接戰線 0.28／開火線區隔，不喧賓奪主）。
    // 快照的 `path` 最後一格即當前移動目的地（`dest` 未進快照）。
    // 路徑疊加（Prompt 9.5 完整版）：開關開啟 → 改畫**逐格虛線**（pathsG），
    // 極淡直線停用（兩者擇一，不疊加）；關閉 → 回到既有直線。
    this.pathsG.clear()
    for (const unit of curr.units) {
      if (unit.hp <= 0 || unit.path === null || unit.path.length === 0) continue
      const goal = unit.path[unit.path.length - 1]
      if (goal === undefined) continue
      const fromX = fixedToPx(unit.x)
      const fromY = fixedToPx(unit.y)
      const toX = goal.x * TILE_SIZE + TILE_SIZE / 2
      const toY = goal.y * TILE_SIZE + TILE_SIZE / 2
      if (Math.abs(toX - fromX) < 0.5 && Math.abs(toY - fromY) < 0.5) continue // 已抵達終點格
      const color = unit.player === 'player' ? COLOR_UNIT_PLAYER : COLOR_UNIT_ENEMY
      if (this.overlays.paths) {
        this.drawDashedPath({ x: fromX, y: fromY }, unit.path, color)
      } else {
        this.fxG.moveTo(fromX, fromY).lineTo(toX, toY).stroke({ width: 1, color, alpha: 0.12 })
      }
    }

    for (const fx of this.effects) {
      const age = Math.min(1, (now - fx.born) / ATTACK_FX_MS)
      // 開火瞬間：攻擊者 → 受擊者的亮線（更粗、隨時間淡出）。
      this.fxG
        .moveTo(fx.fromX, fx.fromY)
        .lineTo(fx.toX, fx.toY)
        .stroke({ width: 3, color: fx.color, alpha: 1 - age })
      if (fx.kind === 'shot') {
        // 遠程：彈丸從攻擊者飛向受擊者。
        const x = Math.round(fx.fromX + (fx.toX - fx.fromX) * age)
        const y = Math.round(fx.fromY + (fx.toY - fx.fromY) * age)
        this.fxG.rect(x - 1, y - 1, 3, 3).fill(fx.color)
      } else {
        // 近戰：揮擊斜線。
        this.fxG
          .moveTo(fx.toX - 4, fx.toY - 4)
          .lineTo(fx.toX + 4, fx.toY + 4)
          .stroke({ width: 1, color: 0xffffff, alpha: 1 - age })
      }
      // 受擊閃光（兩種開火都閃，比接戰線醒目）。
      this.fxG
        .rect(fx.toX - 6, fx.toY - 6, 12, 12)
        .fill({ color: 0xffffff, alpha: (1 - age) * 0.55 })
    }
  }

  /** 血條：底 + 按比例填充（綠 / 黃 / 紅）。 */
  private drawHpBar(options: { x: number; y: number; width: number; ratio: number }): void {
    this.objG.rect(options.x, options.y, options.width, HP_BAR_HEIGHT).fill(COLOR_HP_BG)
    const fillW = Math.round(options.width * options.ratio)
    if (fillW > 0) {
      this.objG
        .rect(options.x, options.y, fillW, HP_BAR_HEIGHT)
        .fill(hpColor(options.ratio))
    }
  }

  /** 裝甲條（Prompt 9.5 完整版）：底 + `armor / 0.8` 比例填充，顏色按分檔。 */
  private drawArmorBar(options: {
    x: number
    y: number
    width: number
    armor: number
  }): void {
    this.objG.rect(options.x, options.y, options.width, ARMOR_BAR_HEIGHT).fill(COLOR_HP_BG)
    const fillW = Math.round(options.width * armorBarRatio(options.armor))
    if (fillW > 0) {
      const color = armorTierColorPixiOf(options.armor)
      if (color !== null) {
        this.objG.rect(options.x, options.y, fillW, ARMOR_BAR_HEIGHT).fill(color)
      }
    }
  }

  /**
   * 路徑虛線（Prompt 9.5 完整版）：沿路徑逐格畫短段模擬 dash
   * （Pixi Graphics 無原生 dash——ON 8px / OFF 6px 的手工短段）。
   */
  private drawDashedPath(
    from: { x: number; y: number },
    path: readonly { x: number; y: number }[],
    color: number,
  ): void {
    const centers = path.map((tile) => ({
      x: tile.x * TILE_SIZE + TILE_SIZE / 2,
      y: tile.y * TILE_SIZE + TILE_SIZE / 2,
    }))
    const points = [from, ...centers]
    const DASH_ON = 8
    const DASH_OFF = 6
    const period = DASH_ON + DASH_OFF
    for (let index = 0; index < points.length - 1; index++) {
      const a = points[index]
      const b = points[index + 1]
      if (a === undefined || b === undefined) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = Math.hypot(dx, dy)
      if (length < 0.5) continue
      const ux = dx / length
      const uy = dy / length
      // 逐段：每 period 像素畫 ON 段、留 OFF 段（視覺用途，不需全局相位）。
      for (let travelled = 0; travelled < length; travelled += period) {
        const segEnd = Math.min(travelled + DASH_ON, length)
        this.pathsG
          .moveTo(a.x + ux * travelled, a.y + uy * travelled)
          .lineTo(a.x + ux * segEnd, a.y + uy * segEnd)
          .stroke({ width: 1, color, alpha: 0.75 })
      }
    }
  }
}

/** hp 比例 → 血條顏色。 */
function hpColor(ratio: number): number {
  if (ratio > 0.66) return COLOR_HP_HIGH
  if (ratio > 0.33) return COLOR_HP_MID
  return COLOR_HP_LOW
}

/* ------------------------------------------------------------------ */
/* 攻擊特效（Prompt 10.10：讓「誰在打誰」看得見）                        */
/* ------------------------------------------------------------------ */

/** 地圖標記（Prompt 10.19）：出廠集合格（菱形，每間生產建築一個），分陣營上色。 */
export interface MapMarker {
  kind: 'gather'
  player: 'player' | 'enemy'
  /** 出廠集合格所屬的生產建築 id。 */
  buildingId: number
  tile: { x: number; y: number }
}

/** 單次開火特效：近戰 = 受擊閃光＋揮擊斜線；遠程 = 飛行彈丸＋受擊閃光。 */
interface AttackEffect {
  kind: 'melee' | 'shot'
  fromX: number
  fromY: number
  toX: number
  toY: number
  color: number
  born: number
}

/** 特效壽命（ms）：開火線／閃光短暫存在，疊加不混亂。 */
const ATTACK_FX_MS = 200

/** 開火受害者位置（固定點座標）：單位 → 中心；建築 → 外框最近點。 */
interface VictimPoint {
  x: number
  y: number
}

/** 固定點座標對建築（外框矩形）的最近點（點在框內回傳自身）。 */
function closestPointOnBuilding(
  attacker: WorldSnapshot['units'][number],
  building: WorldSnapshot['buildings'][number],
  defs: WorldDefs,
): { x: number; y: number } {
  const size = defs.buildings[building.defId]?.size ?? [1, 1]
  const x0 = building.x * UNITS_PER_TILE
  const y0 = building.y * UNITS_PER_TILE
  const x1 = (building.x + size[0]) * UNITS_PER_TILE
  const y1 = (building.y + size[1]) * UNITS_PER_TILE
  return {
    x: Math.min(Math.max(attacker.x, x0), x1),
    y: Math.min(Math.max(attacker.y, y0), y1),
  }
}

/**
 * 開火受害者（Prompt 10.10；10.14 擴充建築）：
 * 顯式目標（敵方、存活）→ 單位中心／建築外框最近點；
 * 否則自動接戰近似：射程內最近敵人**單位**，射程內無單位 → 射程內最近敵方**建築**
 * （外框量測，與 `combat.ts` 相同的固定點算法）。
 * 回傳固定點座標；呼叫端轉像素。
 */
function victimOf(
  defs: WorldDefs,
  attacker: WorldSnapshot['units'][number],
  unitsById: Map<number, WorldSnapshot['units'][number]>,
  buildingsById: Map<number, WorldSnapshot['buildings'][number]>,
): VictimPoint | null {
  const def = defs.units[attacker.defId]
  if (def === undefined) return null
  const rangeFixed = Math.round(def.stats.range * UNITS_PER_TILE)
  const rangeSq = rangeFixed * rangeFixed

  if (attacker.targetId !== null) {
    const explicitUnit = unitsById.get(attacker.targetId)
    if (explicitUnit !== undefined && explicitUnit.hp > 0 && explicitUnit.player !== attacker.player) {
      return { x: explicitUnit.x, y: explicitUnit.y }
    }
    // 顯式目標是建築：仍在射程內 → 畫到外框最近點；超出射程 = 沒在打該建築。
    const explicitBuilding = buildingsById.get(attacker.targetId)
    if (explicitBuilding !== undefined && explicitBuilding.hp > 0 && explicitBuilding.player !== attacker.player) {
      const point = closestPointOnBuilding(attacker, explicitBuilding, defs)
      const dx = point.x - attacker.x
      const dy = point.y - attacker.y
      return dx * dx + dy * dy <= rangeSq ? point : null
    }
  }

  let bestPoint: VictimPoint | null = null
  let bestDist = rangeSq

  for (const candidate of unitsById.values()) {
    if (candidate.player === attacker.player || candidate.hp <= 0) continue
    const dx = candidate.x - attacker.x
    const dy = candidate.y - attacker.y
    const distance = dx * dx + dy * dy
    // unitIds 無序，≤ 保留先設值（快照順序確定，平手裁決穩定）。
    if (distance <= bestDist) {
      bestDist = distance
      bestPoint = { x: candidate.x, y: candidate.y }
    }
  }
  if (bestPoint !== null) return bestPoint

  for (const candidate of buildingsById.values()) {
    if (candidate.player === attacker.player || candidate.hp <= 0) continue
    const point = closestPointOnBuilding(attacker, candidate, defs)
    const dx = point.x - attacker.x
    const dy = point.y - attacker.y
    const distance = dx * dx + dy * dy
    if (distance <= bestDist) {
      bestDist = distance
      bestPoint = point
    }
  }
  return bestPoint
}
