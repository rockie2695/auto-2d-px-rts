import { Container, Graphics } from 'pixi.js'

import { isRockAt } from '../sim/types.ts'
import type { World, WorldDefs } from '../sim/types.ts'
import type { WorldSnapshot } from '../sim/world.ts'

import {
  COLOR_BUILDING_ENEMY,
  COLOR_BUILDING_PLAYER,
  COLOR_CRYSTAL_NODE,
  COLOR_FLOOR,
  COLOR_HP_BG,
  COLOR_HP_HIGH,
  COLOR_HP_LOW,
  COLOR_HP_MID,
  COLOR_ROCK,
  COLOR_SELECTED,
  COLOR_UNIT_ENEMY,
  COLOR_UNIT_PLAYER,
  HP_BAR_HEIGHT,
  TILE_SIZE,
  UNIT_RENDER_SIZE,
} from './constants.ts'
import { clamp01, fixedToPx, interpolateDisplay } from './interpolate.ts'
import { computeViewport } from './viewport.ts'
import type { SelectionTarget } from './hitTest.ts'

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
  private readonly objG = new Graphics()

  private readonly mapSizeTiles: number
  private defs: WorldDefs | null = null
  private selected: SelectionTarget | null = null

  constructor(mapSizeTiles: number) {
    this.mapSizeTiles = mapSizeTiles
    this.root.addChild(this.tilesG, this.objG)
  }

  /** ui（選取）→ render 的單向設定。 */
  setSelected(target: SelectionTarget | null): void {
    this.selected = target
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
    // 資源點：亮藍小方塊，讓礦場在空地上有依附參照。
    for (const node of world.resourceNodes) {
      this.tilesG
        .rect(
          node.x * TILE_SIZE + TILE_SIZE / 2 - 5,
          node.y * TILE_SIZE + TILE_SIZE / 2 - 5,
          10,
          10,
        )
        .fill(COLOR_CRYSTAL_NODE)
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
    const { scale, offsetX, offsetY } = computeViewport(this.mapSizeTiles, viewW, viewH)
    this.root.scale.set(scale)
    this.root.position.set(offsetX, offsetY)

    const t = clamp01(alpha)
    // 前一份快照的單位显示位置（px），插值用。
    const prevById = new Map<number, { x: number; y: number }>()
    if (prev !== null) {
      for (const unit of prev.units) {
        prevById.set(unit.id, { x: fixedToPx(unit.x), y: fixedToPx(unit.y) })
      }
    }

    this.objG.clear()

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
      this.drawHpBar({ x, y: y - HP_BAR_HEIGHT - 2, width: UNIT_RENDER_SIZE, ratio })

      if (this.selected?.kind === 'unit' && unit.id === this.selected.id) {
        this.objG
          .rect(x - 2, y - 2, UNIT_RENDER_SIZE + 4, UNIT_RENDER_SIZE + 4)
          .stroke({ width: 1, color: COLOR_SELECTED })
      }
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
}

/** hp 比例 → 血條顏色。 */
function hpColor(ratio: number): number {
  if (ratio > 0.66) return COLOR_HP_HIGH
  if (ratio > 0.33) return COLOR_HP_MID
  return COLOR_HP_LOW
}
