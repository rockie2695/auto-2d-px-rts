import type { ContentPack } from '@auto-2d-px-rts/shared'

import { stepCombat } from './combat.ts'
import { addBuilding, spawnUnit, stepEconomy } from './economy.ts'
import { findPath } from './pathfinding.ts'
import { createRng } from './rng.ts'
import { rebuildSpatialHash } from './spatialHash.ts'
import {
  getPlayer,
  isBlockedAt,
  isRockAt,
  speedToFixedPerTick,
  tileCenter,
  tileOf,
} from './types.ts'
import type { PlayerId, TilePos, World } from './types.ts'

/**
 * 世界初始化與每 tick 順序（SPEC §7、§11）。
 *
 * tick 順序：`tick++ → 經濟 → 移動 → 重建空間雜湊 → 戰鬥`。
 * 開局配置採「離出生點最近的有效位置」確定性搜尋（距離、y、x 依序平手裁決）。
 */

/** 距離排序的候選（平手依 y、x、index，保證跨平台一致）。 */
interface ScoredTile {
  distance: number
  y: number
  x: number
}

function nearestFirst(a: ScoredTile, b: ScoredTile): number {
  if (a.distance !== b.distance) return a.distance - b.distance
  if (a.y !== b.y) return a.y - b.y
  return a.x - b.x
}

function manhattan(a: TilePos, b: TilePos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

/** 依離 anchor 的距離列出所有格（確定性排序）。 */
function tilesByDistance(size: number, anchor: TilePos): TilePos[] {
  const scored: ScoredTile[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      scored.push({ distance: manhattan({ x, y }, anchor), y, x })
    }
  }
  scored.sort(nearestFirst)
  return scored.map((tile) => ({ x: tile.x, y: tile.y }))
}

/** 建築佔地是否可用（界內、無岩石、無重疊、未覆盖資源點）。 */
function isFootprintValid(world: World, tile: TilePos, w: number, h: number): boolean {
  if (tile.x < 0 || tile.y < 0 || tile.x + w > world.map.size || tile.y + h > world.map.size) {
    return false
  }
  for (let y = tile.y; y < tile.y + h; y++) {
    for (let x = tile.x; x < tile.x + w; x++) {
      if (isRockAt(world, { x, y })) return false
      if (isBlockedAt(world, { x, y })) return false
    }
  }
  // 開局建築不得壓到資源點（礦場除外，礦場直接選點）。
  const coveredNode = world.resourceNodes.some(
    (node) =>
      node.x >= tile.x && node.x < tile.x + w && node.y >= tile.y && node.y < tile.y + h,
  )
  return !coveredNode
}

/** 找離 anchor 最近的有效建築位置（keep／barracks 用）。 */
function findNearestPlacement(world: World, anchor: TilePos, w: number, h: number): TilePos {
  for (const tile of tilesByDistance(world.map.size, anchor)) {
    if (isFootprintValid(world, tile, w, h)) return tile
  }
  throw new Error(`地圖上找不到 ${w}x${h} 的有效建築位置`)
}

/** 找離 anchor 最近的空閒資源點；無空閒資源點丟錯。 */
function findNearestFreeNode(world: World, anchor: TilePos): { tile: TilePos; nodeIndex: number } {
  let best: { tile: TilePos; nodeIndex: number } | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  world.resourceNodes.forEach((node, index) => {
    if (node.buildingId !== null) return
    const distance = manhattan(anchor, { x: node.x, y: node.y })
    if (distance < bestDistance) {
      bestDistance = distance
      best = { tile: { x: node.x, y: node.y }, nodeIndex: index }
    }
  })
  if (best === null) throw new Error('沒有空閒的資源點可供開局礦場使用')
  return best
}

/** 建立世界（純函式：不修改傳入的 content）。 */
export function createWorld(content: ContentPack, seed: number): World {
  const defs = {
    units: Object.fromEntries(content.units.map((unit) => [unit.id, unit])),
    buildings: Object.fromEntries(content.buildings.map((building) => [building.id, building])),
  }

  const world: World = {
    tick: 0,
    map: content.map,
    match: content.match,
    faction: content.faction,
    defs,
    units: [],
    buildings: [],
    resourceNodes: content.map.resourceNodes.map((node) => ({
      x: node.x,
      y: node.y,
      buildingId: null,
    })),
    players: [],
    rng: createRng(seed),
    hash: { units: new Map(), buildings: new Map() },
    nextUnitId: 1,
    nextBuildingId: 1,
  }

  const spawnA = content.map.spawnPoints[0]
  const spawnB = content.map.spawnPoints[1]
  if (spawnA === undefined || spawnB === undefined) {
    throw new Error('地圖必須提供 2 個出生點')
  }

  for (const [playerId, spawn] of [
    ['player', spawnA],
    ['enemy', spawnB],
  ] as const) {
    world.players.push({
      id: playerId,
      factionId: content.faction.id,
      blueCrystal: content.faction.startResources.blue_crystal,
      incomeAccMilli: 0,
      spawn: { x: spawn.x, y: spawn.y },
      unitCount: 0,
      mineCount: 0,
      barracksCount: 0,
    })
    placeOpeningBuildings(world, playerId, { x: spawn.x, y: spawn.y })
    placeStartUnits(world, playerId, { x: spawn.x, y: spawn.y })
  }

  rebuildSpatialHash(world)
  return world
}

/** 開局建築：keep → barracks（最近有效位）→ crystal_mine（最近空閒資源點）。 */
function placeOpeningBuildings(world: World, playerId: PlayerId, spawn: TilePos): void {
  for (const defId of world.faction.startBuildings) {
    const def = world.defs.buildings[defId]
    if (def === undefined) throw new Error(`開局建築定義不存在：${defId}`)

    if (def.requiresResourceNode === true) {
      const { tile, nodeIndex } = findNearestFreeNode(world, spawn)
      addBuilding(world, playerId, defId, tile, { built: true, nodeId: nodeIndex })
      continue
    }

    const [w, h] = def.size
    const tile = findNearestPlacement(world, spawn, w, h)
    addBuilding(world, playerId, defId, tile, { built: true, nodeId: null })
  }
}

/** 開局單位：放在離出生點最近的可走空格（各單位取不同格）。 */
function placeStartUnits(world: World, playerId: PlayerId, spawn: TilePos): void {
  const occupied = new Set<string>()
  for (const [defId, count] of Object.entries(world.faction.startUnits)) {
    for (let index = 0; index < count; index++) {
      let placed = false
      for (const tile of tilesByDistance(world.map.size, spawn)) {
        const key = `${tile.x},${tile.y}`
        if (occupied.has(key)) continue
        if (isBlockedAt(world, tile)) continue
        occupied.add(key)
        spawnUnit(world, playerId, defId, tile)
        placed = true
        break
      }
      if (!placed) throw new Error(`找不到空間放置開局單位：${defId}`)
    }
  }
}

/**
 * 移動命令：以 A\* 規劃路徑（SPEC §9.4）。失敗（無路徑）回傳 false。
 */
export function orderMove(world: World, unitId: number, dest: TilePos): boolean {
  const unit = world.units.find((candidate) => candidate.id === unitId)
  if (unit === undefined) return false
  const start = tileOf(unit.x, unit.y)
  const path = findPath(
    { size: world.map.size, walkable: (tile) => !isBlockedAt(world, tile) },
    start,
    dest,
  )
  if (path === null) {
    unit.path = null
    unit.dest = null
    return false
  }
  unit.path = path
  unit.dest = { x: dest.x, y: dest.y }
  return true
}

/* ------------------------------------------------------------------ */
/* 移動                                                                */
/* ------------------------------------------------------------------ */

function stepMovement(world: World): void {
  for (const unit of world.units) {
    if (unit.hp <= 0 || unit.path === null || unit.path.length === 0) continue
    const def = world.defs.units[unit.defId]
    if (def === undefined) throw new Error(`未知單位定義：${unit.defId}`)

    let remaining = speedToFixedPerTick(def.stats.moveSpeed)
    while (remaining > 0 && unit.path !== null && unit.path.length > 0) {
      const waypoint = unit.path[0]
      if (waypoint === undefined) break

      // 建築落成可能擋住下一個路徑格：從目前位置重算到目的地。
      if (isBlockedAt(world, waypoint)) {
        const dest = unit.dest
        unit.path = null
        unit.dest = null
        if (dest !== null) orderMove(world, unit.id, dest)
        break
      }

      const target = tileCenter(waypoint)
      const dx = target.x - unit.x
      const dy = target.y - unit.y
      const distance = Math.abs(dx) + Math.abs(dy) // 路徑為 4 方向，只會有一軸非 0

      if (distance <= remaining) {
        unit.x = target.x
        unit.y = target.y
        remaining -= distance
        unit.path.shift()
      } else {
        if (dx !== 0) unit.x += Math.sign(dx) * remaining
        else unit.y += Math.sign(dy) * remaining
        remaining = 0
      }
    }

    if (unit.path !== null && unit.path.length === 0) {
      unit.path = null
      unit.dest = null
    }
  }
}

/* ------------------------------------------------------------------ */
/* tick 入口                                                           */
/* ------------------------------------------------------------------ */

/** 推進一個 tick（SPEC §11 順序）。 */
export function stepWorld(world: World): void {
  world.tick += 1
  stepEconomy(world)
  stepMovement(world)
  rebuildSpatialHash(world)
  stepCombat(world)
}

/* ------------------------------------------------------------------ */
/* 快照                                                                */
/* ------------------------------------------------------------------ */

/** 世界快照（JSON 相容，供確定性比對與 UI）。 */
export interface WorldSnapshot {
  tick: number
  rngState: number
  nextUnitId: number
  nextBuildingId: number
  players: Array<{
    id: PlayerId
    blueCrystal: number
    unitCount: number
    mineCount: number
    barracksCount: number
  }>
  units: Array<{
    id: number
    player: PlayerId
    defId: string
    hp: number
    x: number
    y: number
    attackAcc: number
    targetId: number | null
    path: TilePos[] | null
  }>
  buildings: Array<{
    id: number
    player: PlayerId
    defId: string
    x: number
    y: number
    hp: number
    builtTicks: number
    totalTicks: number
    damageTaken: number
    queue: Array<{ defId: string; remainingTicks: number }>
    nodeId: number | null
  }>
  resourceNodes: Array<{ x: number; y: number; buildingId: number | null }>
}

/** 產出當下世界的完整快照（純觀測，不推進模擬）。 */
export function snapshotWorld(world: World): WorldSnapshot {
  return {
    tick: world.tick,
    rngState: world.rng.state,
    nextUnitId: world.nextUnitId,
    nextBuildingId: world.nextBuildingId,
    players: world.players.map((player) => ({
      id: player.id,
      blueCrystal: player.blueCrystal,
      unitCount: player.unitCount,
      mineCount: player.mineCount,
      barracksCount: player.barracksCount,
    })),
    units: world.units.map((unit) => ({
      id: unit.id,
      player: unit.player,
      defId: unit.defId,
      hp: unit.hp,
      x: unit.x,
      y: unit.y,
      attackAcc: unit.attackAcc,
      targetId: unit.targetId,
      path: unit.path === null ? null : unit.path.map((tile) => ({ ...tile })),
    })),
    buildings: world.buildings.map((building) => ({
      id: building.id,
      player: building.player,
      defId: building.defId,
      x: building.x,
      y: building.y,
      hp: building.hp,
      builtTicks: building.builtTicks,
      totalTicks: building.totalTicks,
      damageTaken: building.damageTaken,
      queue: building.queue.map((job) => ({ ...job })),
      nodeId: building.nodeId,
    })),
    resourceNodes: world.resourceNodes.map((node) => ({ ...node })),
  }
}

/** 供 CLI 顯示的簡報字串。 */
export function describePlayer(world: World, playerId: PlayerId): string {
  const player = getPlayer(world, playerId)
  const totalHp = world.units
    .filter((unit) => unit.player === playerId)
    .reduce((total, unit) => total + unit.hp, 0)
  return (
    `${playerId}: blueCrystal=${player.blueCrystal} units=${player.unitCount} ` +
    `unitHp=${totalHp} mines=${player.mineCount} barracks=${player.barracksCount}`
  )
}
