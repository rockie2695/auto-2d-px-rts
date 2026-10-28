import { TICK_RATE_HZ } from '@auto-2d-px-rts/shared'

import {
  buildingEffectiveMaxHp,
  getPlayer,
  isBlockedAt,
  isConstructed,
  tileCenter,
  UNITS_PER_TILE,
} from './types.ts'
import type { Building, PlayerId, TilePos, Unit, World } from './types.ts'

/**
 * 經濟系統（SPEC §5–§7）：採礦收入、建築施工、生產佇列與放置／生成 API。
 *
 * 全整數運算：
 * - 收入：每個有 `incomePerSec` 的建築（crystal_mine）把
 *   `round(blue_crystal × 1000)` 累積到所屬玩家的 `incomeAccMilli`，
 *   每 tick 取出 `floor(acc / (TICK_RATE_HZ × 1000))` 入庫（整數精確、無浮點漂移）。
 * - 建造進度以 tick 計數；未完工建築 hp 按完成比例折算（SPEC §5）。
 * - 生產佇列倒數至 0 時在建築外圍第一個空格生成單位；
 *   無空格或達單位上限則留在佇列，下一 tick 重試。
 */

/** 每個收入結算期的分母（milli·tick）：20Hz × 1000。 */
const INCOME_DIVISOR = TICK_RATE_HZ * 1000

/** 建築外圍（依序上、右、下、左）逐環找空格，生成單位用。 */
const PERIMETER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

/* ------------------------------------------------------------------ */
/* 收入                                                                */
/* ------------------------------------------------------------------ */

function stepIncome(world: World): void {
  for (const player of world.players) {
    // 以「實際建築」計算產出：礦場被打掉收入立即減少。
    let perSecMilli = 0
    for (const building of world.buildings) {
      if (building.player !== player.id || building.hp <= 0) continue
      const rate = world.defs.buildings[building.defId]?.incomePerSec
      if (rate !== undefined) perSecMilli += Math.round(rate.blue_crystal * 1000)
    }
    if (perSecMilli <= 0) continue

    player.incomeAccMilli += perSecMilli
    const gain = Math.floor(player.incomeAccMilli / INCOME_DIVISOR)
    if (gain > 0) {
      player.incomeAccMilli -= gain * INCOME_DIVISOR
      player.blueCrystal += gain
    }
  }
}

/* ------------------------------------------------------------------ */
/* 建造進度                                                            */
/* ------------------------------------------------------------------ */

function stepConstruction(world: World): void {
  for (const building of world.buildings) {
    if (isConstructed(building)) continue
    building.builtTicks += 1
    const def = world.defs.buildings[building.defId]
    if (def === undefined) throw new Error(`未知建築定義：${building.defId}`)
    const effectiveMax = buildingEffectiveMaxHp(def, building)
    building.hp = Math.min(effectiveMax, Math.max(1, effectiveMax - building.damageTaken))
  }
}

/* ------------------------------------------------------------------ */
/* 單位生成                                                            */
/* ------------------------------------------------------------------ */

/** 在建築外圍（上、右、下、左逐環）找第一個可走空格並設定座標；無空格回傳 false。 */
function placeAtPerimeter(world: World, building: Building, unit: Unit): boolean {
  const centerX = building.x + Math.floor(building.w / 2)
  const centerY = building.y + Math.floor(building.h / 2)
  const maxRing = Math.max(building.w, building.h)

  for (const [dx, dy] of PERIMETER_OFFSETS) {
    for (let ring = 1; ring <= maxRing; ring++) {
      const tile: TilePos = {
        x: dx === 0 ? centerX : building.x + dx * ring,
        y: dy === 0 ? centerY : building.y + dy * ring,
      }
      if (isBlockedAt(world, tile)) continue // isRockAt 亦涵蓋界外
      const center = tileCenter(tile)
      unit.x = center.x
      unit.y = center.y
      return true
    }
  }
  return false
}

/**
 * 建立單位實體並放入世界（不設上限，由呼叫端負責）。
 * 開局配置與生產佇列共用此入口。
 */
export function spawnUnit(
  world: World,
  playerId: PlayerId,
  defId: string,
  tile: TilePos,
): Unit | null {
  const def = world.defs.units[defId]
  if (def === undefined) return null
  const center = tileCenter(tile)
  const unit: Unit = {
    id: world.nextUnitId,
    player: playerId,
    defId,
    role: def.role,
    hp: def.stats.hp,
    x: center.x,
    y: center.y,
    attackAcc: 0,
    targetId: null,
    path: null,
    dest: null,
  }
  world.nextUnitId += 1
  world.units.push(unit)
  const player = getPlayer(world, playerId)
  player.unitCount = world.units.filter((candidate) => candidate.player === playerId).length
  return unit
}

/* ------------------------------------------------------------------ */
/* 生產佇列                                                            */
/* ------------------------------------------------------------------ */

function stepProduction(world: World): void {
  for (const building of world.buildings) {
    if (!isConstructed(building) || building.queue.length === 0) continue
    const job = building.queue[0]
    if (job === undefined) continue
    job.remainingTicks -= 1
    if (job.remainingTicks > 0) continue

    const player = getPlayer(world, building.player)
    if (player.unitCount >= world.match.unitCap) continue // 達上限：留在佇列重試

    const spawnTile: TilePos = { x: building.x, y: building.y }
    const unit = spawnUnit(world, building.player, job.defId, spawnTile)
    if (unit === null) continue
    if (!placeAtPerimeter(world, building, unit)) {
      // 外圍無空格：移除剛建立的單位，下一 tick 重試。
      world.units = world.units.filter((candidate) => candidate.id !== unit.id)
      player.unitCount = world.units.filter((candidate) => candidate.player === building.player).length
      continue
    }
    building.queue.shift()
  }
}

/* ------------------------------------------------------------------ */
/* 公開 API：排程生產／放置建築                                        */
/* ------------------------------------------------------------------ */

/** 把單位排入建築生產佇列；扣費在排入時一次結清。失敗回傳 false。 */
export function queueTrain(world: World, buildingId: number, defId: string): boolean {
  const building = world.buildings.find((candidate) => candidate.id === buildingId)
  if (building === undefined || !isConstructed(building)) return false

  const def = world.defs.units[defId]
  if (def === undefined) return false
  if (!world.faction.roster.includes(defId)) return false
  const buildingDef = world.defs.buildings[building.defId]
  if (buildingDef === undefined || !buildingDef.produces.includes(defId)) return false

  const player = getPlayer(world, building.player)
  const queuedCount = world.buildings
    .filter((candidate) => candidate.player === player.id)
    .reduce((total, candidate) => total + candidate.queue.length, 0)
  if (player.unitCount + queuedCount >= world.match.unitCap) return false
  if (player.blueCrystal < def.cost.blue_crystal) return false

  player.blueCrystal -= def.cost.blue_crystal
  building.queue.push({ defId, remainingTicks: Math.round(def.trainTimeSec * TICK_RATE_HZ) })
  return true
}

/** 內部：把建築實體放入世界並維持計數（放置與開局初始化共用）。 */
export function addBuilding(
  world: World,
  playerId: PlayerId,
  defId: string,
  tile: TilePos,
  options: { built: boolean; nodeId: number | null },
): Building {
  const def = world.defs.buildings[defId]
  if (def === undefined) throw new Error(`未知建築定義：${defId}`)
  const [w, h] = def.size
  const totalTicks = Math.round(def.buildTimeSec * TICK_RATE_HZ)
  const building: Building = {
    id: world.nextBuildingId,
    player: playerId,
    defId,
    x: tile.x,
    y: tile.y,
    w,
    h,
    hp: def.hp,
    builtTicks: options.built ? totalTicks : 0,
    totalTicks,
    damageTaken: 0,
    queue: [],
    nodeId: options.nodeId,
  }
  world.nextBuildingId += 1
  world.buildings.push(building)

  // 未完工建築的 hp 立即按完成比例折算（與 stepConstruction 一致）。
  if (!options.built) {
    building.hp = buildingEffectiveMaxHp(def, building)
  }

  if (options.nodeId !== null) {
    const node = world.resourceNodes[options.nodeId]
    if (node !== undefined) node.buildingId = building.id
  }

  refreshBuildingCounts(world, playerId)
  return building
}

/** 重算玩家的礦場／兵營計數（放置與摧毀後呼叫）。 */
function refreshBuildingCounts(world: World, playerId: PlayerId): void {
  const player = getPlayer(world, playerId)
  player.mineCount = world.buildings.filter(
    (building) => building.player === playerId && building.nodeId !== null,
  ).length
  player.barracksCount = world.buildings.filter(
    (building) =>
      building.player === playerId &&
      building.nodeId === null &&
      (world.defs.buildings[building.defId]?.produces.length ?? 0) > 0,
  ).length
}

/** 固定點座標落在哪個資源點上；不在任何資源點回傳 null。 */
function nodeIndexAt(world: World, fixedX: number, fixedY: number): number | null {
  for (let index = 0; index < world.resourceNodes.length; index++) {
    const node = world.resourceNodes[index]
    if (node === undefined) continue
    const centerX = node.x * UNITS_PER_TILE + UNITS_PER_TILE / 2
    const centerY = node.y * UNITS_PER_TILE + UNITS_PER_TILE / 2
    if (Math.abs(fixedX - centerX) <= UNITS_PER_TILE / 2 && Math.abs(fixedY - centerY) <= UNITS_PER_TILE / 2) {
      return index
    }
  }
  return null
}

/**
 * 放置建築（SPEC §7）：驗證 palette（不含 keep）、費用、界內、無岩石、
 * 無重疊、資源點規則與數量上限；通過即扣費並開始施工。失敗回傳 null。
 */
export function placeBuilding(
  world: World,
  playerId: PlayerId,
  defId: string,
  tile: TilePos,
): Building | null {
  const def = world.defs.buildings[defId]
  if (def === undefined) return null
  // keep 不可由玩家放置（faction.buildings palette 不含 keep）。
  if (!world.faction.buildings.includes(defId)) return null

  const player = getPlayer(world, playerId)
  if (player.blueCrystal < def.cost.blue_crystal) return null

  const [w, h] = def.size
  if (tile.x < 0 || tile.y < 0 || tile.x + w > world.map.size || tile.y + h > world.map.size) {
    return null
  }

  for (let y = tile.y; y < tile.y + h; y++) {
    for (let x = tile.x; x < tile.x + w; x++) {
      if (isBlockedAt(world, { x, y })) return null // 岩石、界外或與既有建築重疊
    }
  }

  // 資源點規則。
  const center = tileCenter(tile)
  const coveredNode = nodeIndexAt(world, center.x, center.y)
  if (def.requiresResourceNode === true) {
    if (coveredNode === null) return null
    const node = world.resourceNodes[coveredNode]
    if (node === undefined || node.buildingId !== null) return null
    if (player.mineCount >= world.match.mineCap) return null
  } else {
    if (coveredNode !== null) return null // 一般建築不得蓋在資源點上
    if (def.produces.length > 0 && player.barracksCount >= world.match.barracksCap) return null
  }

  player.blueCrystal -= def.cost.blue_crystal
  return addBuilding(world, playerId, defId, tile, { built: false, nodeId: coveredNode })
}

/* ------------------------------------------------------------------ */
/* tick 結算入口                                                       */
/* ------------------------------------------------------------------ */

/** 一個 tick 的經濟結算：收入 → 建造進度 → 生產佇列。 */
export function stepEconomy(world: World): void {
  stepIncome(world)
  stepConstruction(world)
  stepProduction(world)
}
