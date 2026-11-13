import { MAX_RESOURCE, RESOURCE_IDS, TICK_RATE_HZ } from '@auto-2d-px-rts/shared'
import type { BuildingDef, ResourceAmount, ResourceId } from '@auto-2d-px-rts/shared'

import {
  buildingEffectiveMaxHp,
  getPlayer,
  isBlockedAt,
  isConstructed,
  tileCenter,
  UNITS_PER_TILE,
  INCOME_WINDOW_TICKS,
} from './types.ts'
import type { Building, PlayerId, ResourceStock, TilePos, Unit, World } from './types.ts'

/**
 * 經濟系統（SPEC §5–§7）：採礦收入、建築施工、生產佇列與放置／生成 API。
 *
 * 全整數運算：
 * - 收入（Prompt 5）：每個有 `incomePerSec` 的建築各自累積
 *   `round(blue_crystal × 1000)` 到自己的 `incomeAccMilli`，
 *   每 tick 取出 `floor(acc / (TICK_RATE_HZ × 1000))`，
 *   並以 `MIN(gain, MAX_RESOURCE − 庫存, 節點 amountRemaining)` 夾制後入帳；
 *   節點耗盡則該礦場收入為 0（礦場保留）。
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

/**
 * 建築產出的資源（Prompt 5）：`incomePerSec` 中第一個 rate > 0 的鍵。
 * MVP 每座礦場只產**一種**資源（crystal_mine → blue、ruby_mine → red、
 * emerald_sanctuary → green）；多鍵同時非 0 屬未定義（schema 不禁止、sim 取首鍵）。
 */
export function producedResourceOf(def: BuildingDef): ResourceId | null {
  for (const id of RESOURCE_IDS) {
    const rate = def.incomePerSec
    if (rate !== undefined && rate[id] > 0) return id
  }
  return null
}

function stepIncome(world: World): void {
  // 收入環（Prompt 5 getIncome）：本 tick 的槽先清零（即使 0 也要清——窗口滾動）。
  const slot = world.tick % INCOME_WINDOW_TICKS
  for (const player of world.players) {
    for (const id of RESOURCE_IDS) {
      const ring = player.incomeRing[id]
      if (ring !== undefined) ring[slot] = 0
    }
  }

  // 逐礦結算（Prompt 5）：每座有 incomePerSec 的建築各自累積，
  // 取出的資源同時受「庫存上限 MAX_RESOURCE」與「節點剩餘量」夾制。
  for (const building of world.buildings) {
    if (building.hp <= 0) continue
    const def = world.defs.buildings[building.defId]
    const rate = def?.incomePerSec
    if (def === undefined || rate === undefined) continue
    const resourceType = producedResourceOf(def)
    if (resourceType === null) continue
    // AI 投降（Prompt 8.6）：投降方停止資源採集。
    if (isSurrendered(world, building.player)) continue

    building.incomeAccMilli += Math.round(rate[resourceType] * 1000)
    let gain = Math.floor(building.incomeAccMilli / INCOME_DIVISOR)
    if (gain <= 0) continue
    building.incomeAccMilli -= gain * INCOME_DIVISOR

    const player = getPlayer(world, building.player)
    const stock = player.resources[resourceType]
    gain = Math.min(gain, MAX_RESOURCE - stock) // 庫存滿 → 不入帳
    if (building.nodeId !== null) {
      const node = world.resourceNodes[building.nodeId]
      if (node === undefined) continue
      gain = Math.min(gain, node.amountRemaining) // 節點耗盡 → 收入為 0
      node.amountRemaining -= gain
    }
    if (gain > 0) {
      player.resources[resourceType] += gain
      const ring = player.incomeRing[resourceType]
      if (ring !== undefined) ring[slot] = (ring[slot] ?? 0) + gain
    }
  }
}

/** 玩家指定資源的庫存（Prompt 5 指定 API）。 */
export function getResource(world: World, playerId: PlayerId, type: ResourceId): number {
  return getPlayer(world, playerId).resources[type]
}

/** 玩家指定資源最近 60 tick（3 秒）的總入帳（Prompt 5 指定 API）。 */
export function getIncome(world: World, playerId: PlayerId, type: ResourceId): number {
  const ring = getPlayer(world, playerId).incomeRing[type]
  return ring === undefined ? 0 : ring.reduce((total, value) => total + value, 0)
}

/* ------------------------------------------------------------------ */
/* 多資源支付（Prompt 5）                                               */
/* ------------------------------------------------------------------ */

/** 是否付得起（三資源逐一檢查）。 */
export function canAfford(stock: ResourceStock, cost: ResourceAmount): boolean {
  return RESOURCE_IDS.every((id) => stock[id] >= (cost[id] ?? 0))
}

/** 逐資源扣款（呼叫前必先 canAfford——本函式不做餘額檢查）。 */
function payCost(stock: ResourceStock, cost: ResourceAmount): void {
  for (const id of RESOURCE_IDS) {
    const amount = cost[id] ?? 0
    if (amount > 0) stock[id] -= amount
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

/** 在建築外圍（上、右、下、左逐環）找第一個可走空格並設定座標；無空格回傳 false。
 *  `mirrorOrder`（Prompt 10.11）：敵方改在**鏡像座標系**搜尋後把出廠格鏡射回來——
 *  偶數寬高的置中、掃描序、擋路順移全部精確鏡像（紅藍新兵出廠格互為鏡像，
 *  增援到前線的距離對稱）。 */
function placeAtPerimeter(world: World, building: Building, unit: Unit, mirrorOrder = false): boolean {
  if (mirrorOrder) {
    const last = world.map.size - 1
    const mirrored: Building = {
      ...building,
      x: last - (building.x + building.w - 1),
      y: last - (building.y + building.h - 1),
    }
    const probe: Unit = { ...unit }
    if (!placeAtPerimeter(world, mirrored, probe, false)) return false
    // 固定點鏡射：x' = size×200 − x（tile 中心互鏡）。
    const span = world.map.size * UNITS_PER_TILE
    unit.x = span - probe.x
    unit.y = span - probe.y
    return true
  }

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
    // tick 0 = 對局開始視為未交戰（單位滿血出生，回血計時從此起算也無妨）。
    lastCombatTick: 0,
    // 出生 tick（Prompt 10.5 完整版元數據：決策歸因後果欄；行為讀取點為零）。
    spawnTick: world.tick,
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

/** 建築是否屬已投降方（Prompt 8.6：停生產、停採集）。 */
function isSurrendered(world: World, playerId: PlayerId): boolean {
  return world.surrender !== null && world.surrender.player === playerId
}

function stepProduction(world: World): void {
  for (const building of world.buildings) {
    if (!isConstructed(building) || building.queue.length === 0) continue
    // AI 投降（Prompt 8.6）：投降方不再生產（佇列在投降當刻已清空）。
    if (isSurrendered(world, building.player)) continue
    const job = building.queue[0]
    if (job === undefined) continue
    job.remainingTicks -= 1
    if (job.remainingTicks > 0) continue

    const player = getPlayer(world, building.player)
    if (player.unitCount >= world.match.unitCap) continue // 達上限：留在佇列重試

    const spawnTile: TilePos = { x: building.x, y: building.y }
    const unit = spawnUnit(world, building.player, job.defId, spawnTile)
    if (unit === null) continue
    if (!placeAtPerimeter(world, building, unit, building.player === 'enemy')) {
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
  if (!canAfford(player.resources, def.cost)) return false

  payCost(player.resources, def.cost)
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
    incomeAccMilli: 0,
    attackAcc: 0,
    targetId: null,
    // 進場 tick（Prompt 10.5 完整版元數據；開局建築由 createWorld 在 tick 0 加 → 0）。
    spawnTick: world.tick,
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
  if (!canAfford(player.resources, def.cost)) return null

  const [w, h] = def.size
  if (tile.x < 0 || tile.y < 0 || tile.x + w > world.map.size || tile.y + h > world.map.size) {
    return null
  }

  for (let y = tile.y; y < tile.y + h; y++) {
    for (let x = tile.x; x < tile.x + w; x++) {
      if (isBlockedAt(world, { x, y })) return null // 岩石、界外或與既有建築重疊
    }
  }

  // 資源點規則（Prompt 5）：礦場必須蓋在**對應資源類型**的節點上。
  const center = tileCenter(tile)
  const coveredNode = nodeIndexAt(world, center.x, center.y)
  if (def.requiresResourceNode === true) {
    if (coveredNode === null) return null
    const node = world.resourceNodes[coveredNode]
    if (node === undefined || node.buildingId !== null) return null
    // 類型匹配：建築產什麼資源、就只能蓋在該類型節點上。
    const wantedType = producedResourceOf(def)
    if (wantedType !== null && node.resourceType !== wantedType) return null
    if (player.mineCount >= world.match.mineCap) return null
  } else {
    if (coveredNode !== null) return null // 一般建築不得蓋在資源點上
    if (def.produces.length > 0 && player.barracksCount >= world.match.barracksCap) return null
  }

  payCost(player.resources, def.cost)
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
