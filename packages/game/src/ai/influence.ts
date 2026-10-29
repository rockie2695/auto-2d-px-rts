import { tileCenter, UNITS_PER_TILE } from '../sim/types.ts'
import type { PlayerId, TilePos, World } from '../sim/types.ts'

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

/** 格中心（格座標）→ 固定點座標。 */
function cellCenterFixed(cx: number, cy: number, cellTiles: number): { x: number; y: number } {
  return tileCenter({ x: cx * cellTiles + cellTiles / 2, y: cy * cellTiles + cellTiles / 2 })
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
