import { UNITS_PER_TILE } from '../sim/types.ts'
import type { PlayerId, TilePos, World } from '../sim/types.ts'
import { mirrorSafeTileOf } from './mirrorTile.ts'

/**
 * 影響力地圖（SPEC §9.2，Prompt 7）：把 32×32 地圖切成 8×8 tile 的粗格子
 * （→ 4×4 = 16 格），每格分別累積我方與敵方的「威脅」。
 *
 * ```
 * threat(cell) = Σ value × strength / (1 + dist²)
 * ```
 * - `value`：單位 JSON 的 `ai.value`（legionnaire／archer 皆 100）。
 * - `strength`：`hp / maxHp`（滿血 1、殘血按比例遞減）。
 * - `dist`：單位到格中心（格）的距離。
 *
 * 數值以**整數 milli** 累積（`value × permille × 40000 / (40000 + dist²固定點)`），
 * 不引入浮點，跨平台結果一致；AI 只在每 `TACTICAL_INTERVAL_TICKS` 重算一次。
 */

/** 粗格邊長（tile）。SPEC §9.2 補註：MVP 採 8×8 tile 粗網格。 */
export const CELL_TILES = 8

/** 影響力地圖（own / enemy 各一格一值，index = cy × gridSize + cx）。 */
export interface InfluenceMap {
  /** 每格邊長（tile）。 */
  cellTiles: number
  /** 網格邊長（格數）；地圖邊長 ÷ cellTiles 向上取整。 */
  gridSize: number
  /** 地圖邊長（tile），供座標換算。 */
  mapSize: number
  /** 我方威脅（milli-value）。 */
  own: number[]
  /** 敵方威脅（milli-value）。 */
  enemy: number[]
}

const UNITS_PER_TILE_SQUARED = UNITS_PER_TILE * UNITS_PER_TILE

/** 單位有效戰力（milli）：`value × hp / maxHp × 1000`。 */
export function unitThreatMilli(world: World, unit: { defId: string; hp: number }): number {
  const def = world.defs.units[unit.defId]
  if (def === undefined || def.stats.hp <= 0 || unit.hp <= 0) return 0
  const permille = Math.round((unit.hp * 1000) / def.stats.hp)
  return def.ai.value * permille
}

/** 距離衰減核心：`threat / (1 + dist²)`，整數 milli 版本。 */
function contributionMilli(threatMilli: number, dx: number, dy: number): number {
  return Math.round((threatMilli * UNITS_PER_TILE_SQUARED) / (UNITS_PER_TILE_SQUARED + dx * dx + dy * dy))
}

/**
 * 敵方在固定點座標 `(x, y)` 的即時威脅（milli）。
 *
 * 與地圖同一核函式，但**在指定點求值**（而非格中心）——供小隊撤退判斷使用：
 * 小隊站在格邊緣時，格中心值會被距離衰減稀釋，無法反映「貼身敵軍」的壓力。
 */
export function enemyThreatAtPoint(world: World, playerId: PlayerId, x: number, y: number): number {
  let total = 0
  for (const unit of world.units) {
    if (unit.player === playerId) continue
    const threat = unitThreatMilli(world, unit)
    if (threat <= 0) continue
    total += contributionMilli(threat, unit.x - x, unit.y - y)
  }
  return total
}

/**
 * 格中心 → 固定點座標（Prompt 10.13 修正）。
 * 用**固定點中點**（`cx × 格寬×200 + 格寬×200/2`）而非格中心格——後者在偶數格寬下
 * 與鏡射點差半格（cell 3 的中心格 28 vs 真鏡射點格 27），會讓紅藍的影響力地圖
 * 在固定點層級不對稱（目標評分失真 → 雙方打不同目標）。
 */
function cellCenterFixed(cx: number, cy: number, cellTiles: number): { x: number; y: number } {
  const cellFixed = cellTiles * UNITS_PER_TILE
  return { x: cx * cellFixed + cellFixed / 2, y: cy * cellFixed + cellFixed / 2 }
}

/** 由格座標求格 index（夾到地圖範圍內）。 */
export function cellIndexOf(map: InfluenceMap, tile: TilePos): number {
  const cx = Math.min(map.gridSize - 1, Math.max(0, Math.floor(tile.x / map.cellTiles)))
  const cy = Math.min(map.gridSize - 1, Math.max(0, Math.floor(tile.y / map.cellTiles)))
  return cy * map.gridSize + cx
}

/** 指定格的敵方威脅（milli）。 */
export function enemyThreatAtTile(map: InfluenceMap, tile: TilePos): number {
  return map.enemy[cellIndexOf(map, tile)] ?? 0
}

/** 指定格的我方威脅（milli）。 */
export function ownThreatAtTile(map: InfluenceMap, tile: TilePos): number {
  return map.own[cellIndexOf(map, tile)] ?? 0
}

/* ------------------------------------------------------------------ */
/* 主動防禦：受威脅建築偵測（Prompt 10.6）                              */
/* ------------------------------------------------------------------ */

/** 守備半徑（tile）：敵人進入守備建築中心此距離內即視為「來襲」。 */
export const DEFENSE_RADIUS_TILES = 6

/** 一座受威脅建築的快照（主動防禦的偵測結果）。 */
export interface BuildingThreat {
  buildingId: number
  buildingDefId: string
  /** 受威脅建築中心（格座標）。 */
  buildingCenterTile: TilePos
  /** 是否經濟建築（礦場＝水晶收入來源；平手時優先守）。 */
  isEconomic: boolean
  /** 半徑內來襲敵軍戰力合（milli）。 */
  threatPower: number
  /** 來襲敵軍重心（格座標）＝攔截目標。 */
  centroid: TilePos
  /** 來襲敵軍 unit ids（id 升冪）。 */
  enemyIds: number[]
}

/**
 * 偵測受威脅建築：我方存活建築的守備半徑內有存活敵軍者。
 * 回傳依來襲戰力**降冪**（平手取 buildingId 小者），純函式、確定性。
 */
export function detectBuildingThreats(world: World, playerId: PlayerId): BuildingThreat[] {
  const radiusFixed = DEFENSE_RADIUS_TILES * UNITS_PER_TILE
  const limit = radiusFixed * radiusFixed
  const threats: BuildingThreat[] = []
  // 取格一律走鏡像安全路徑（Prompt 10.23 擴及全 AI 層）：偶數尺寸建築（barracks/
  // tower 2×2）的中心 px 恰停**格邊界**，紅方直接 floor 會翻錯邊 → 威脅中心
  // （攔截點／集結點）紅藍差一格、fullMirrorProbe 分叉。由正規化格鏡射而來 → 對稱。
  const mirrorOrder = playerId === 'enemy'

  for (const building of world.buildings) {
    if (building.player !== playerId || building.hp <= 0) continue
    const centerX = building.x * UNITS_PER_TILE + (building.w * UNITS_PER_TILE) / 2
    const centerY = building.y * UNITS_PER_TILE + (building.h * UNITS_PER_TILE) / 2

    let threatPower = 0
    let sumX = 0
    let sumY = 0
    const enemyIds: number[] = []
    for (const unit of world.units) {
      if (unit.player === playerId || unit.hp <= 0) continue
      const dx = unit.x - centerX
      const dy = unit.y - centerY
      if (dx * dx + dy * dy > limit) continue
      const milli = unitThreatMilli(world, unit)
      if (milli <= 0) continue
      threatPower += milli
      sumX += unit.x
      sumY += unit.y
      enemyIds.push(unit.id)
    }
    if (enemyIds.length === 0) continue

    threats.push({
      buildingId: building.id,
      buildingDefId: building.defId,
      buildingCenterTile: mirrorSafeTileOf(
        world.map.size,
        mirrorOrder,
        centerX,
        centerY,
      ),
      isEconomic: world.defs.buildings[building.defId]?.requiresResourceNode === true,
      threatPower,
      centroid: mirrorSafeTileOf(
        world.map.size,
        mirrorOrder,
        sumX / enemyIds.length,
        sumY / enemyIds.length,
      ),
      enemyIds: [...enemyIds].sort((a, b) => a - b),
    })
  }

  // 來襲戰力降冪；平手取 buildingId 小者（確定性）。
  threats.sort((a, b) => b.threatPower - a.threatPower || a.buildingId - b.buildingId)
  return threats
}

/**
 * 最急迫的威脅：來襲戰力最高者；**平手時經濟建築（礦場＝水晶收入）優先**，
 * 再取 buildingId 小者。無任何威脅回傳 null。
 */
export function pickMostUrgentThreat(world: World, playerId: PlayerId): BuildingThreat | null {
  const threats = detectBuildingThreats(world, playerId)
  let best = threats[0]
  for (const threat of threats) {
    if (best === undefined) {
      best = threat
      continue
    }
    if (threat.threatPower > best.threatPower) {
      best = threat
      continue
    }
    if (
      threat.threatPower === best.threatPower &&
      threat.isEconomic &&
      !best.isEconomic
    ) {
      best = threat
    }
  }
  return best ?? null
}

/** 由玩家視角重算整張影響力地圖（純函式）。 */
export function computeInfluenceMap(world: World, playerId: PlayerId): InfluenceMap {
  const cellTiles = CELL_TILES
  const gridSize = Math.ceil(world.map.size / cellTiles)
  const own = new Array<number>(gridSize * gridSize).fill(0)
  const enemy = new Array<number>(gridSize * gridSize).fill(0)

  for (const unit of world.units) {
    if (unit.hp <= 0) continue
    const threat = unitThreatMilli(world, unit)
    if (threat <= 0) continue
    const grid = unit.player === playerId ? own : enemy

    for (let cy = 0; cy < gridSize; cy++) {
      for (let cx = 0; cx < gridSize; cx++) {
        const center = cellCenterFixed(cx, cy, cellTiles)
        const contribution = contributionMilli(threat, unit.x - center.x, unit.y - center.y)
        grid[cy * gridSize + cx] = (grid[cy * gridSize + cx] ?? 0) + contribution
      }
    }
  }

  return { cellTiles, gridSize, mapSize: world.map.size, own, enemy }
}
