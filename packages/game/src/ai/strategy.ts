import type { PolicyValues } from './policy.ts'
import { buildEconWeight, buildMilitaryWeight } from './policy.ts'
import type { Role } from '@auto-2d-px-rts/shared'
import { placeBuilding, queueTrain } from '../sim/economy.ts'
import { findNearestPlacement, tryFindNearestFreeNode } from '../sim/world.ts'
import { getPlayer } from '../sim/types.ts'
import type { PlayerId, TilePos, World } from '../sim/types.ts'

/**
 * AI 戰略層（SPEC §8，Prompt 6）：每 40 tick（= 2 秒）決定「蓋什麼、生什麼」。
 *
 * 兩條獨立軌道，各取最高分且可負擔者執行一次：
 * - 建築軌：`U = weight × (1 − 飽和度)`；一礦都沒有時礦場強制 3.0
 *   （SPEC §8.1「除非一礦都沒有」，避免重經濟滑桿餓死）。
 * - 生產軌：`score = counterScore + tierScore + rangeScore − 稀缺性懲罰`。
 *
 * 本層只做決策與下單（placeBuilding / queueTrain）；
 * 移動與接戰屬戰術層／微操層（之後的 Prompt）。全部決策確定性可重現。
 */

/** 戰略決策間隔（SPEC §8.1：每 40 tick = 2 秒）。 */
export const STRATEGIC_INTERVAL_TICKS = 40

/** 同種單位每多 1 個的稀缺性懲罰（防止鎖死單一種，同分時自然均攤）。 */
const SCARCITY_PENALTY = 0.05

/** tier 由小到大的序數（unitSize 滑桿目標：0 → large、1 → small）。 */
const TIER_ORDER: Record<string, number> = { small: 0, medium: 1, large: 2 }

/** 一次戰略循環的產出（供 CLI 紀錄與測試斷言）。 */
export type StrategicAction =
  | { kind: 'build'; defId: string; tile: TilePos }
  | { kind: 'train'; defId: string }

/* ------------------------------------------------------------------ */
/* 建築軌                                                              */
/* ------------------------------------------------------------------ */

/** 候選建築的可行性與效用。 */
interface BuildingCandidate {
  defId: string
  score: number
  /** 放置點（mine 用最近空閒節點，其餘用最近有效位）。 */
  tile: TilePos
}

/** 玩家的錨點：keep 佔地左上角；無 keep（合成世界）用出生點。 */
function anchorOf(world: World, playerId: PlayerId): TilePos {
  const keep = world.buildings.find(
    (building) => building.player === playerId && building.defId === 'keep',
  )
  if (keep !== undefined) return { x: keep.x, y: keep.y }
  return getPlayer(world, playerId).spawn
}

/** 飽和度：count / cap（mine 用礦場數/礦場上限，兵營同理）。 */
function saturationOf(world: World, playerId: PlayerId, defId: string): number {
  const player = getPlayer(world, playerId)
  const def = world.defs.buildings[defId]
  if (def === undefined) return 1
  if (def.requiresResourceNode === true) {
    return player.mineCount / world.match.mineCap
  }
  if (def.produces.length > 0) {
    return player.barracksCount / world.match.barracksCap
  }
  const count = world.buildings.filter(
    (building) => building.player === playerId && building.defId === defId,
  ).length
  return count // 未分類建築：蓋 1 座即飽和
}

/**
 * 評估建築候選（含可行性）：
 * 不可負擔、無空閒節點、無放置空間的候選直接剔除（效用 -Infinity）。
 */
function evaluateBuildings(world: World, playerId: PlayerId, policies: PolicyValues): BuildingCandidate[] {
  const player = getPlayer(world, playerId)
  const anchor = anchorOf(world, playerId)
  const econ = buildEconWeight(policies)
  const military = buildMilitaryWeight(policies)

  const candidates: BuildingCandidate[] = []
  for (const defId of world.faction.buildings) {
    const def = world.defs.buildings[defId]
    if (def === undefined) continue

    // 可行性：放置點必須找得到。
    const [w, h] = def.size
    let tile: TilePos | null
    if (def.requiresResourceNode === true) {
      tile = tryFindNearestFreeNode(world, anchor)?.tile ?? null
    } else {
      tile = findNearestPlacement(world, anchor, w, h)
    }
    if (tile === null) continue

    // 效用（Prompt 6 權重映射 × 飽和度）。
    const weight = def.requiresResourceNode === true ? econ : military
    let score = weight * (1 - saturationOf(world, playerId, defId))
    // SPEC §8.1：一礦都沒有時強制高優先（含 econMilitary=0 也要有基本收入）。
    if (def.requiresResourceNode === true && player.mineCount === 0) {
      score = Math.max(score, 3.0)
    }
    // 不可負擔 → 剔除。
    if (player.blueCrystal < def.cost.blue_crystal) continue

    candidates.push({ defId, score, tile })
  }

  // 依分數降冪；平手保留 palette 順序（穩定、確定性）。
  return candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
}

/* ------------------------------------------------------------------ */
/* 生產軌                                                              */
/* ------------------------------------------------------------------ */

interface UnitCandidate {
  defId: string
  score: number
}

/** 敵方角色佔比（melee / ranged）；無敵方單位回傳 null。 */
function enemyRoleShare(world: World, playerId: PlayerId): Record<Role, number> | null {
  const totals: Record<Role, number> = { melee: 0, ranged: 0 }
  for (const unit of world.units) {
    if (unit.hp <= 0 || unit.player === playerId) continue
    totals[unit.role] += 1
  }
  const total = totals.melee + totals.ranged
  if (total === 0) return null
  return { melee: totals.melee / total, ranged: totals.ranged / total }
}

/** 克制分：Σ_敵方角色 佔比 × counterMatrix[我方角色][敵方角色]。 */
function counterScoreOf(world: World, myRole: Role, share: Record<Role, number> | null): number {
  if (share === null) return 1.0 // 無敵方單位 → 中性
  const matrix = world.faction.counterMatrix[myRole]
  return share.melee * matrix.melee + share.ranged * matrix.ranged
}

/** tier 分：與 unitSize 目標 tier 的接近度（1 → small、0 → large）。 */
function tierScoreOf(world: World, defId: string, policies: PolicyValues): number {
  const def = world.defs.units[defId]
  if (def === undefined) return 0
  const myIndex = TIER_ORDER[def.tier] ?? 1
  const target = Math.round((1 - Math.min(1, Math.max(0, policies.unitSize))) * 2)
  return 1 - Math.abs(myIndex - target) / 2
}

/** range 分：單位射程在 roster 內正規化後與 unitRange 的接近度（等價 §8.3 配額）。 */
function rangeScoreOf(world: World, defId: string, policies: PolicyValues): number {
  const def = world.defs.units[defId]
  if (def === undefined) return 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const rosterId of world.faction.roster) {
    const rosterDef = world.defs.units[rosterId]
    if (rosterDef === undefined) continue
    min = Math.min(min, rosterDef.stats.range)
    max = Math.max(max, rosterDef.stats.range)
  }
  const normalized = max === min ? 0.5 : (def.stats.range - min) / (max - min)
  const slider = Math.min(1, Math.max(0, policies.unitRange))
  return 1 - Math.abs(normalized - slider)
}

/** 玩家已擁有（活著 + 排程中）的某單位數量。 */
function ownedCountOf(world: World, playerId: PlayerId, defId: string): number {
  const alive = world.units.filter(
    (unit) => unit.player === playerId && unit.defId === defId && unit.hp > 0,
  ).length
  let queued = 0
  for (const building of world.buildings) {
    if (building.player !== playerId) continue
    queued += building.queue.filter((job) => job.defId === defId).length
  }
  return alive + queued
}

/** 評估生產候選：克制 + tier + range − 稀缺性；不可負擔或無產能者剔除。 */
function evaluateUnits(world: World, playerId: PlayerId, policies: PolicyValues): UnitCandidate[] {
  const player = getPlayer(world, playerId)
  const share = enemyRoleShare(world, playerId)

  const candidates: UnitCandidate[] = []
  for (const defId of world.faction.roster) {
    const def = world.defs.units[defId]
    if (def === undefined) continue
    // 可行性：有兵營能生產 + 負擔得起。
    const hasProducer = world.buildings.some(
      (building) =>
        building.player === playerId &&
        world.defs.buildings[building.defId]?.produces.includes(defId) === true,
    )
    if (!hasProducer) continue
    if (player.blueCrystal < def.cost.blue_crystal) continue

    const score =
      counterScoreOf(world, def.role, share) +
      tierScoreOf(world, defId, policies) +
      rangeScoreOf(world, defId, policies) -
      ownedCountOf(world, playerId, defId) * SCARCITY_PENALTY
    candidates.push({ defId, score })
  }

  return candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
}

/* ------------------------------------------------------------------ */
/* 決策執行                                                            */
/* ------------------------------------------------------------------ */

/** 選佇列最短、可生產該單位的兵營（平手取 id 小）。 */
function chooseProducer(world: World, playerId: PlayerId, defId: string): number | null {
  let bestId: number | null = null
  let bestLength = Number.POSITIVE_INFINITY
  for (const building of world.buildings) {
    if (building.player !== playerId) continue
    if (world.defs.buildings[building.defId]?.produces.includes(defId) !== true) continue
    if (building.queue.length < bestLength) {
      bestLength = building.queue.length
      bestId = building.id
    }
  }
  return bestId
}

/**
 * 執行一次戰略循環（呼叫端負責節流：每 STRATEGIC_INTERVAL_TICKS 一次）。
 * 建築軌與生產軌各嘗試執行一個最高分動作；回傳實際執行的動作（0–2 個）。
 */
export function runStrategicCycle(
  world: World,
  playerId: PlayerId,
  policies: PolicyValues,
): StrategicAction[] {
  const actions: StrategicAction[] = []

  // 建築軌：最高分優先，placeBuilding 拒絕（競態：節點被佔等）則嘗試次高。
  for (const candidate of evaluateBuildings(world, playerId, policies)) {
    const building = placeBuilding(world, playerId, candidate.defId, candidate.tile)
    if (building !== null) {
      actions.push({ kind: 'build', defId: candidate.defId, tile: candidate.tile })
      break
    }
  }

  // 生產軌：最高分優先，queueTrain 拒絕則嘗試次高。
  for (const candidate of evaluateUnits(world, playerId, policies)) {
    const producerId = chooseProducer(world, playerId, candidate.defId)
    if (producerId === null) continue
    if (queueTrain(world, producerId, candidate.defId)) {
      actions.push({ kind: 'train', defId: candidate.defId })
      break
    }
  }

  return actions
}
