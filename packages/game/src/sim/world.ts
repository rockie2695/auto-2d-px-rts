import { MAX_RESOURCE } from '@auto-2d-px-rts/shared'
import type { ContentPack } from '@auto-2d-px-rts/shared'

import { stepCombat } from './combat.ts'
import { addBuilding, spawnUnit, stepEconomy } from './economy.ts'
import { findPath } from './pathfinding.ts'
import { createRng, hashFate } from './rng.ts'
import { rebuildSpatialHash } from './spatialHash.ts'
import {
  getPlayer,
  isBlockedAt,
  isRockAt,
  speedToFixedPerTick,
  tileCenter,
  tileOf,
  UNITS_PER_TILE,
} from './types.ts'
import type { PlayerId, TilePos, World } from './types.ts'

/**
 * 世界初始化與每 tick 順序（SPEC §7、§11）。
 *
 * tick 順序：`tick++ → 經濟 → 移動 → 重建空間雜湊 → 戰鬥`。
 * 開局配置：玩家側採「離出生點最近的有效位置」確定性搜尋（距離、y、x 依序平手裁決），
 * 敵方側取玩家佈局的 180° 點鏡射——地圖、出生點、資源點與開局全部鏡射對稱。
 */

/** 距離排序的候選（平手依 y、x，保證跨平台一致）。 */
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

/** 敵方側（Prompt 10.9）：平手裁決取 y、x 降冪——對鏡射位置排出互為鏡像的候選順序。 */
function nearestFirstMirrored(a: ScoredTile, b: ScoredTile): number {
  if (a.distance !== b.distance) return a.distance - b.distance
  if (a.y !== b.y) return b.y - a.y
  return b.x - a.x
}

function manhattan(a: TilePos, b: TilePos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

/** 依離 anchor 的距離列出所有格（確定性排序；mirrorOrder 反轉平手裁決，Prompt 10.9）。 */
function tilesByDistance(size: number, anchor: TilePos, mirrorOrder = false): TilePos[] {
  const scored: ScoredTile[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      scored.push({ distance: manhattan({ x, y }, anchor), y, x })
    }
  }
  scored.sort(mirrorOrder ? nearestFirstMirrored : nearestFirst)
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

/**
 * 找離 anchor 最近的建築位置：以**佔地中心**到 anchor 的距離排序
 * （Prompt 10.9：中心距對鏡射等距——top-left 距離在鏡射下會平移 (w−1,h−1) 而失稱）。
 * 平手裁決：鏡像序 y、x 降冪（敵方）或升冪（我方）。找不到回傳 null。
 */
export function findNearestPlacement(
  world: World,
  anchor: TilePos,
  w: number,
  h: number,
  mirrorOrder = false,
): TilePos | null {
  const size = world.map.size
  const anchorFixed = tileCenter(anchor)
  const candidates: Array<{ tile: TilePos; distance: number; y: number; x: number }> = []
  for (let y = 0; y + h <= size; y++) {
    for (let x = 0; x + w <= size; x++) {
      const centerX = x * UNITS_PER_TILE + (w * UNITS_PER_TILE) / 2
      const centerY = y * UNITS_PER_TILE + (h * UNITS_PER_TILE) / 2
      const distance = Math.abs(centerX - anchorFixed.x) + Math.abs(centerY - anchorFixed.y)
      candidates.push({ tile: { x, y }, distance, y, x })
    }
  }
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance
    if (mirrorOrder) {
      if (a.y !== b.y) return b.y - a.y
      return b.x - a.x
    }
    if (a.y !== b.y) return a.y - b.y
    return a.x - b.x
  })
  for (const candidate of candidates) {
    if (isFootprintValid(world, candidate.tile, w, h)) return candidate.tile
  }
  return null
}

/** 找離 anchor 最近的空閒資源點；無空閒資源點回傳 null。
 *  `mirrorOrder`（Prompt 10.9）：平手（同距離節點成對鏡像）時敵方取 y、x 較大者，
 *  讓紅藍對鏡射位置選出互為鏡像的節點。 */
export function tryFindNearestFreeNode(
  world: World,
  anchor: TilePos,
  mirrorOrder = false,
): { tile: TilePos; nodeIndex: number } | null {
  let best: { tile: TilePos; nodeIndex: number } | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  world.resourceNodes.forEach((node, index) => {
    if (node.buildingId !== null) return
    const distance = manhattan(anchor, { x: node.x, y: node.y })
    if (distance > bestDistance) return
    if (distance < bestDistance) {
      bestDistance = distance
      best = { tile: { x: node.x, y: node.y }, nodeIndex: index }
      return
    }
    // 同距離平手：座標制裁決（鏡像序取 y、x 較大者）。
    const bestTile = best?.tile
    if (bestTile === undefined) return
    const better =
      mirrorOrder
        ? node.y > bestTile.y || (node.y === bestTile.y && node.x > bestTile.x)
        : node.y < bestTile.y || (node.y === bestTile.y && node.x < bestTile.x)
    if (better) {
      best = { tile: { x: node.x, y: node.y }, nodeIndex: index }
    }
  })
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
    seed,
    map: content.map,
    match: content.match,
    faction: content.faction,
    defs,
    units: [],
    buildings: [],
    resourceNodes: content.map.resourceNodes.map((node) => ({
      x: node.x,
      y: node.y,
      amountRemaining: node.amount,
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
      blueCrystal: Math.min(MAX_RESOURCE, content.faction.startResources.blue_crystal),
      spawn: { x: spawn.x, y: spawn.y },
      unitCount: 0,
      mineCount: 0,
      barracksCount: 0,
    })
  }

  // 開局佈局（SPEC §7）：玩家側用「離出生點最近」的確定性搜尋佈置；
  // 敵方直接取玩家佈局的 180° 點鏡射（(x,y) → (last−x, last−y)，佔地中心對中心）。
  // 不對敵方重跑同一演算法——nearest-first 的平手裁決（距離 → y → x）在點鏡射下
  // 會反序，兩邊各自搜尋無法保證鏡射對稱；先佈一邊再鏡射才完全對稱（紅藍如常規 RTS）。
  placeOpeningBuildings(world, 'player', spawnA)
  placeStartUnits(world, 'player', spawnA)
  placeMirroredOpening(world, 'enemy')

  rebuildSpatialHash(world)
  return world
}

/** 開局建築：keep → barracks（最近有效位）→ crystal_mine（最近空閒資源點）。 */
function placeOpeningBuildings(world: World, playerId: PlayerId, spawn: TilePos): void {
  for (const defId of world.faction.startBuildings) {
    const def = world.defs.buildings[defId]
    if (def === undefined) throw new Error(`開局建築定義不存在：${defId}`)

    if (def.requiresResourceNode === true) {
      const found = tryFindNearestFreeNode(world, spawn)
      if (found === null) throw new Error('沒有空閒的資源點可供開局礦場使用')
      addBuilding(world, playerId, defId, found.tile, { built: true, nodeId: found.nodeIndex })
      continue
    }

    const [w, h] = def.size
    const tile = findNearestPlacement(world, spawn, w, h)
    if (tile === null) throw new Error(`地圖上找不到 ${defId}（${w}x${h}）的有效建築位置`)
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
 * 敵方開局：逐項鏡射玩家的建築與單位（180° 點鏡射，(x,y) → (last−x, last−y)）。
 * 建築以佔地「左上角」座標記錄，鏡射要按佔地寬高換算成鏡像佔地的左上角；
 * 礦場的資源點連結換成鏡像位置上的節點（地圖節點本身必須點對稱）。
 * 前提：先佈完玩家側；鏡像位置由對稱性保證有效（界內、無岩石、不重疊）。
 */
function placeMirroredOpening(world: World, playerId: PlayerId): void {
  const last = world.map.size - 1

  for (const building of world.buildings.filter((item) => item.player === 'player')) {
    const def = world.defs.buildings[building.defId]
    if (def === undefined) throw new Error(`開局建築定義不存在：${building.defId}`)
    const [w, h] = def.size
    const tile = { x: last - (building.x + w - 1), y: last - (building.y + h - 1) }

    let nodeId: number | null = null
    if (building.nodeId !== null) {
      const source = world.resourceNodes[building.nodeId]
      if (source === undefined) throw new Error('開局礦場指向不存在的資源點')
      const mirrored = world.resourceNodes.findIndex(
        (node) => node.x === last - source.x && node.y === last - source.y,
      )
      if (mirrored === -1) {
        throw new Error('資源點不是 180° 點對稱，無法鏡射開局礦場')
      }
      nodeId = mirrored
    }
    addBuilding(world, playerId, building.defId, tile, { built: true, nodeId })
  }

  for (const unit of world.units.filter((item) => item.player === 'player')) {
    const tile = tileOf(unit.x, unit.y)
    spawnUnit(world, playerId, unit.defId, { x: last - tile.x, y: last - tile.y })
  }
}

/**
 * 移動命令：以 A\* 規劃路徑（SPEC §9.4）。
 * 敵方單位使用**鏡像鄰居序**（Prompt 10.9/10.11）——鏡射起訖走出互為鏡像的路徑。
 * 失敗（無路徑）回傳 false。
 */
export function orderMove(world: World, unitId: number, dest: TilePos): boolean {
  const unit = world.units.find((candidate) => candidate.id === unitId)
  if (unit === undefined) return false
  const start = tileOf(unit.x, unit.y)
  // 等價路徑抽選鹽（Prompt 10.14）：以**正規化（藍方座標）起點＋tick＋比賽種子**
  // 雜湊——鏡射查詢同值（公平性不破）、跨種子抽出不同但等價的路徑（種子活化）。
  const canonical =
    unit.player === 'enemy'
      ? { x: world.map.size - 1 - start.x, y: world.map.size - 1 - start.y }
      : start
  const path = findPath(
    {
      size: world.map.size,
      walkable: (tile) => !isBlockedAt(world, tile),
      mirrorOrder: unit.player === 'enemy',
      tieBreakSalt: hashFate(world.seed, canonical.x, canonical.y, world.tick),
    },
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
      const distance = Math.abs(dx) + Math.abs(dy)

      if (distance <= remaining) {
        unit.x = target.x
        unit.y = target.y
        remaining -= distance
        unit.path.shift()
      } else {
        // 步長夾限到該軸的缺口量：路徑重排後的首格可能與目前的偏心座標
        // 垂直對齊（dx、dy 同時非 0），若不夾限會走滿 remaining 造成
        // 該軸過衝 → 每 tick ±1 步永久乒乓（永遠到不了格中心）。剩餘步數
        // 留給迴圈下一輪補另一軸。
        if (dx !== 0) {
          const step = Math.min(remaining, Math.abs(dx))
          unit.x += Math.sign(dx) * step
          remaining -= step
        } else {
          const step = Math.min(remaining, Math.abs(dy))
          unit.y += Math.sign(dy) * step
          remaining -= step
        }
      }
    }

    if (unit.path !== null && unit.path.length === 0) {
      unit.path = null
      unit.dest = null
    }
  }
}

/* ------------------------------------------------------------------ */
/* 回血                                                                */
/* ------------------------------------------------------------------ */

/** 回血節奏：每秒（20 tick）評估一次。 */
export const REGEN_INTERVAL_TICKS = 20

/** 脫戰寬限：最後交戰（出手或受傷）3 秒（60 tick）後開始回血。 */
export const REGEN_GRACE_TICKS = 60

/** 每次回血量（hp）。 */
export const REGEN_HP = 1

/**
 * 脫戰回血（Prompt 10.8）：每 20 tick（1 秒）評估一次——
 * 存活單位若最後交戰（出手或受傷）已超過寬限期 → hp +1（上限 maxHp）。
 * 整數運算、依 world.units 順序 → 確定性。
 */
function stepRegeneration(world: World): void {
  if (world.tick % REGEN_INTERVAL_TICKS !== 0) return
  for (const unit of world.units) {
    if (unit.hp <= 0) continue
    const def = world.defs.units[unit.defId]
    if (def === undefined || unit.hp >= def.stats.hp) continue
    if (world.tick - unit.lastCombatTick < REGEN_GRACE_TICKS) continue
    unit.hp = Math.min(def.stats.hp, unit.hp + REGEN_HP)
  }
}

/* ------------------------------------------------------------------ */
/* tick 入口                                                           */
/* ------------------------------------------------------------------ */

/** 推進一個 tick（SPEC §2.3 順序）。 */
export function stepWorld(world: World): void {
  world.tick += 1
  stepEconomy(world)
  stepRegeneration(world)
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
    lastCombatTick: number
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
    incomeAccMilli: number
  }>
  resourceNodes: Array<{
    x: number
    y: number
    amountRemaining: number
    buildingId: number | null
  }>
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
      lastCombatTick: unit.lastCombatTick,
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
      incomeAccMilli: building.incomeAccMilli,
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
