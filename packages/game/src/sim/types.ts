import { TICK_RATE_HZ } from '@auto-2d-px-rts/shared'
import type {
  BuildingDef,
  FactionDef,
  MapDef,
  MatchDef,
  Role,
  UnitDef,
} from '@auto-2d-px-rts/shared'

import type { Rng } from './rng.ts'

/**
 * 模擬核心的型別（規則 5：本層不得 import PixiJS 或 React）。
 *
 * 數值表示遵循 SPEC §2.2：
 * - 位置／距離用**整數固定點**，1 格 = `UNITS_PER_TILE` 單位。
 * - 移動每 tick 的步長 = `round(moveSpeed × 10)`
 *   （`moveSpeed 格/秒 × 200 ÷ 20Hz`，legionnaire 2.1 → 21、archer 2.5 → 25）。
 * - 攻擊冷卻用累積器 `acc += attackSpeed / 20`，`acc ≥ 1` 攻擊後 `acc -= 1`。
 */

/** 1 格 = 200 固定點單位（SPEC §2.2）。 */
export const UNITS_PER_TILE = 200

/** 固定點步長（單位/tick）= moveSpeed 格/秒 × UNITS_PER_TILE ÷ TICK_RATE_HZ。 */
export function speedToFixedPerTick(moveSpeed: number): number {
  return Math.round((moveSpeed * UNITS_PER_TILE) / TICK_RATE_HZ)
}

/** 射程（格）轉固定點。 */
export function rangeToFixed(range: number): number {
  return Math.round(range * UNITS_PER_TILE)
}

export type PlayerId = 'player' | 'enemy'

/** 格座標。 */
export interface TilePos {
  x: number
  y: number
}

export interface Unit {
  id: number
  player: PlayerId
  defId: string
  role: Role
  hp: number
  /** 固定點座標（格左上角為原點：tile x 的範圍是 [x×200, (x+1)×200)）。 */
  x: number
  y: number
  /** 攻擊冷卻累積器（SPEC §2.2）。 */
  attackAcc: number
  /** 顯式攻擊目標（單位 id）；null = 自動接戰「射程內最近的敵人」。 */
  targetId: number | null
  /** 剩餘路徑（格，不含目前所在格）；null = 無移動命令。 */
  path: TilePos[] | null
  /** 移動命令的最終目的格（供路徑被建築擋住時重算）。 */
  dest: TilePos | null
}

/** 生產佇列的工作。 */
export interface TrainJob {
  defId: string
  remainingTicks: number
}

export interface Building {
  id: number
  player: PlayerId
  defId: string
  /** 佔地左上角（格）。 */
  x: number
  y: number
  w: number
  h: number
  hp: number
  /** 建造進度（tick）。開局建築建成：builtTicks === totalTicks。 */
  builtTicks: number
  totalTicks: number
  /** 已承受傷害（用於「hp 按完成比例折算」，SPEC §5）。 */
  damageTaken: number
  /** 生產佇列（barracks）。 */
  queue: TrainJob[]
  /** 佔用的資源點 index；null = 不佔資源點。 */
  nodeId: number | null
}

/** 單一資源的礦點。 */
export interface ResourceNode {
  x: number
  y: number
  /** 採用中的礦場 building id；null = 空閒。 */
  buildingId: number | null
}

export interface Player {
  id: PlayerId
  factionId: string
  /** 藍水晶整數庫存。 */
  blueCrystal: number
  /** 收入累積器，單位 milli·tick（見 economy.ts，整數精確結算）。 */
  incomeAccMilli: number
  spawn: TilePos
  unitCount: number
  mineCount: number
  barracksCount: number
}

/** 每格 1 個 bucket 的空間雜湊（鍵 = 格 index）。 */
export interface SpatialHash {
  units: Map<number, number[]>
  buildings: Map<number, number[]>
}

/** 內容定義的查表（由 ContentPack 建立）。 */
export interface WorldDefs {
  units: Record<string, UnitDef>
  buildings: Record<string, BuildingDef>
}

export interface World {
  tick: number
  map: MapDef
  match: MatchDef
  faction: FactionDef
  defs: WorldDefs
  units: Unit[]
  buildings: Building[]
  resourceNodes: ResourceNode[]
  players: Player[]
  rng: Rng
  hash: SpatialHash
  nextUnitId: number
  nextBuildingId: number
}

/** 戰鬥目標：單位或建築。 */
export type CombatTarget =
  | { kind: 'unit'; unit: Unit }
  | { kind: 'building'; building: Building }

/** 建築是否已完工（totalTicks === 0 視為完工，例如開局 keep）。 */
export function isConstructed(building: Building): boolean {
  return building.builtTicks >= building.totalTicks
}

/**
 * 建築目前的最大 hp：未完工時按完成比例折算（SPEC §5），
 * 完工後即 def.hp。至少保留 1 hp，否則剛放下的建築會瞬間不存在。
 */
export function buildingEffectiveMaxHp(def: BuildingDef, building: Building): number {
  if (building.totalTicks === 0) return def.hp
  const progress = building.builtTicks / building.totalTicks
  return Math.max(1, Math.floor(def.hp * progress))
}

export function getPlayer(world: World, playerId: PlayerId): Player {
  const player = world.players.find((candidate) => candidate.id === playerId)
  if (player === undefined) {
    throw new Error(`找不到玩家：${playerId}`)
  }
  return player
}

/** 格座標 → 該格中心的固定點座標。 */
export function tileCenter(tile: TilePos): { x: number; y: number } {
  return {
    x: tile.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    y: tile.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
  }
}

/** 固定點座標 → 格座標。 */
export function tileOf(x: number, y: number): TilePos {
  return { x: Math.floor(x / UNITS_PER_TILE), y: Math.floor(y / UNITS_PER_TILE) }
}

/** 格是否可走（岩石 = 1 不可走；不含建築，建築由各呼叫點另外檢查）。 */
export function isRockAt(world: World, tile: TilePos): boolean {
  if (tile.x < 0 || tile.y < 0 || tile.x >= world.map.size || tile.y >= world.map.size) {
    return true
  }
  return world.map.tiles[tile.y * world.map.size + tile.x] !== 0
}

/** 格上是否有建築佔地。 */
export function isBuildingAt(world: World, tile: TilePos): boolean {
  return world.buildings.some(
    (building) =>
      tile.x >= building.x &&
      tile.x < building.x + building.w &&
      tile.y >= building.y &&
      tile.y < building.y + building.h,
  )
}

/** 格是否完全不可走（岩石、界外或建築佔地）。 */
export function isBlockedAt(world: World, tile: TilePos): boolean {
  return isRockAt(world, tile) || isBuildingAt(world, tile)
}
