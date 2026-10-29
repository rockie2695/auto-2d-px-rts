import { setAttackTarget } from '../sim/combat.ts'
import { getPlayer, isBlockedAt, tileOf, UNITS_PER_TILE } from '../sim/types.ts'
import { orderMove } from '../sim/world.ts'
import type { Building, PlayerId, TilePos, Unit, World } from '../sim/types.ts'
import { computeInfluenceMap, enemyThreatAtPoint, enemyThreatAtTile } from './influence.ts'
import type { InfluenceMap } from './influence.ts'
import { clampSlider } from './policy.ts'
import type { PolicyValues } from './policy.ts'

/**
 * AI 戰術層（SPEC §9.2，Prompt 7）：每 500ms（= 10 tick）重編小隊、指派任務、
 * 選定進攻目標、判斷撤退，並透過 sim 的既有 API（`orderMove` / `setAttackTarget`）
 * 下單。戰鬥本身仍由 sim 的自動接戰（`stepCombat`）結算。
 *
 * 小隊編組：
 * - `squadCount = round(lerp(4, 1, clusterSpread))`（0 → 4 隊分散、1 → 1 隊集中）
 * - `squadSize  = round(lerp(4, 18, clusterSpread))`
 * - 隊數不超過兵力（不產生空隊）；兵力超過 `squadCount × squadSize` 時自動擴隊。
 *
 * 任務（`aggression` 決定攻守比例）：
 * - `attackCount = round(squadCount × aggression)`；`attackCount ≥ 2` 且隊數 ≥ 3 時
 *   其中 1 隊為 `harass`（打敵方經濟），其餘 `attack`，剩下的 `defend`。
 * - 進攻目標評分 = `建築value × 1/(敵方格威脅+1) × 1/(1+距離)`（價值高 × 防守弱 × 距離近）。
 *
 * 撤退（MVP 簡化版）：
 * - 隊級：`squadPower < 敵方在重心的即時威脅 × 0.7` → 本循環全隊 `retreat` 回集結點
 *   （用即時點位威脅而非格中心值，才反映「貼身敵軍」的壓力）。
 * - 個體：`hp < retreatHpPct × maxHp`（JSON 讀）→ 脫離戰鬥、排除於小隊之外。
 *
 * 編組為無狀態（每循環按 unit id 排序重算），確保相同世界 → 相同計畫。
 */

/** 戰術循環間隔（SPEC §9.2：500ms = 10 tick）。 */
export const TACTICAL_INTERVAL_TICKS = 10

/** 撤退門檻：小隊戰力 < 敵附近戰力 × 0.7（SPEC §8 小隊撤退）。 */
export const RETREAT_POWER_RATIO = 0.7

export type SquadMission = 'defend' | 'attack' | 'harass' | 'retreat'

export interface Squad {
  index: number
  mission: SquadMission
  memberIds: number[]
  /** 任務目標格（attack/harass = 目標建築旁可走格；defend/retreat = 集結點）。 */
  target: TilePos
  /** attack/harass 的目標建築 id；其餘為 null。 */
  targetBuildingId: number | null
  /** 隊伍有效戰力（Σ value × hp/maxHp，整數）。 */
  power: number
  /** 成員重心格。 */
  centroid: TilePos
}

export interface TacticalPlan {
  tick: number
  player: PlayerId
  /** 集結點（自己 keep 旁的可走格）。 */
  rally: TilePos
  squads: Squad[]
  /** hp < retreatHpPct 而脫離戰鬥、被排除於小隊之外的單位 id。 */
  disengaged: number[]
  influence: InfluenceMap
}

/** 線性插值。 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** clusterSpread → 小隊數量與每隊上限。 */
export function squadSizing(policies: PolicyValues): { count: number; size: number } {
  const spread = clampSlider(policies.clusterSpread)
  return {
    count: Math.round(lerp(4, 1, spread)),
    size: Math.round(lerp(4, 18, spread)),
  }
}

/**
 * 依兵力把「目標隊數」修正為實際隊數：
 * 隊數不超過兵力（不產生空隊），兵力超過 `隊數 × 每隊上限` 時自動擴隊。
 */
export function countSquads(unitCount: number, sizing: { count: number; size: number }): number {
  if (unitCount <= 0) return 0
  let count = Math.min(sizing.count, unitCount)
  while (count * sizing.size < unitCount) count += 1
  return count
}

/** 依 aggression 決定各隊任務（index 由小到大：harass → attack → defend）。 */
export function assignMissions(squadCount: number, policies: PolicyValues): SquadMission[] {
  const aggression = clampSlider(policies.aggression)
  const attackCount = Math.round(squadCount * aggression)
  const harassCount = squadCount >= 3 && attackCount >= 2 ? 1 : 0
  const missions: SquadMission[] = []
  for (let index = 0; index < squadCount; index++) {
    if (index < harassCount) missions.push('harass')
    else if (index < attackCount) missions.push('attack')
    else missions.push('defend')
  }
  return missions
}

/** 單位有效戰力（`value × hp / maxHp`，整數）。 */
function unitPower(world: World, unit: Unit): number {
  const def = world.defs.units[unit.defId]
  if (def === undefined || def.stats.hp <= 0) return 0
  return Math.round((def.ai.value * Math.max(0, unit.hp)) / def.stats.hp)
}

/** 由指定格往外找最近的可走格（環狀搜尋，固定順序）。 */
function nearestWalkable(world: World, tile: TilePos): TilePos | null {
  const { size } = world.map
  const inBounds = (candidate: TilePos): boolean =>
    candidate.x >= 0 && candidate.y >= 0 && candidate.x < size && candidate.y < size

  if (inBounds(tile) && !isBlockedAt(world, tile)) return { x: tile.x, y: tile.y }
  for (let radius = 1; radius < size * 2; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const candidate = { x: tile.x + dx, y: tile.y + dy }
        if (!inBounds(candidate)) continue
        if (!isBlockedAt(world, candidate)) return candidate
      }
    }
  }
  return null
}

/** 集結點：自己 keep 旁的可走格；沒有 keep 時退回出生點附近。 */
export function rallyPoint(world: World, playerId: PlayerId): TilePos {
  const spawn = getPlayer(world, playerId).spawn
  const keep = world.buildings.find(
    (building) => building.player === playerId && building.hp > 0 && building.defId === 'keep',
  )
  const base =
    keep === undefined
      ? spawn
      : { x: keep.x + Math.floor(keep.w / 2), y: keep.y + Math.floor(keep.h / 2) }
  return nearestWalkable(world, base) ?? { x: spawn.x, y: spawn.y }
}

/** 建築中心（固定點）。 */
function buildingCenter(building: Building): { x: number; y: number } {
  return {
    x: building.x * UNITS_PER_TILE + (building.w * UNITS_PER_TILE) / 2,
    y: building.y * UNITS_PER_TILE + (building.h * UNITS_PER_TILE) / 2,
  }
}

/** 進攻目標評分：價值高 × 敵防守弱 × 距離近。 */
function scoreTarget(value: number, threatMilli: number, distanceTiles: number): number {
  const defense = 1 / (1 + threatMilli / 1000)
  const proximity = 1 / (1 + distanceTiles)
  return value * defense * proximity
}

/** 從候選建築挑最高分者（平手取陣列中較前者，即 id 較小者）。 */
function pickTarget(
  world: World,
  influence: InfluenceMap,
  from: { x: number; y: number },
  candidates: readonly Building[],
): Building | null {
  let best: Building | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const building of candidates) {
    const value = world.defs.buildings[building.defId]?.ai.value ?? 0
    const center = buildingCenter(building)
    const dx = center.x - from.x
    const dy = center.y - from.y
    const distanceTiles = Math.sqrt(dx * dx + dy * dy) / UNITS_PER_TILE
    const tile = tileOf(center.x, center.y)
    const score = scoreTarget(value, enemyThreatAtTile(influence, tile), distanceTiles)
    if (score > bestScore) {
      bestScore = score
      best = building
    }
  }
  return best
}

/** 敵方目標建築清單（economicOnly 時只取需資源點的礦場）。 */
function enemyTargets(world: World, playerId: PlayerId, economicOnly: boolean): Building[] {
  return world.buildings.filter((building) => {
    if (building.player === playerId || building.hp <= 0) return false
    if (!economicOnly) return true
    return world.defs.buildings[building.defId]?.requiresResourceNode === true
  })
}

/** 純計算：編組、任務、目標、撤退判斷（不修改世界）。 */
export function computeTacticalPlan(
  world: World,
  playerId: PlayerId,
  policies: PolicyValues,
): TacticalPlan {
  const influence = computeInfluenceMap(world, playerId)
  const rally = rallyPoint(world, playerId)

  // 個體撤退：hp < retreatHpPct × maxHp → 脫離戰鬥（JSON 讀門檻）。
  const disengaged: number[] = []
  const ready: Unit[] = []
  for (const unit of world.units) {
    if (unit.player !== playerId || unit.hp <= 0) continue
    const def = world.defs.units[unit.defId]
    const maxHp = def?.stats.hp ?? 0
    const threshold = maxHp * (def?.ai.retreatHpPct ?? 0)
    if (def !== undefined && maxHp > 0 && unit.hp < threshold) disengaged.push(unit.id)
    else ready.push(unit)
  }
  ready.sort((a, b) => a.id - b.id)

  const sizing = squadSizing(policies)
  const squadCount = countSquads(ready.length, sizing)
  const missions = assignMissions(squadCount, policies)

  const squads: Squad[] = []
  for (let index = 0; index < squadCount; index++) {
    squads.push({
      index,
      mission: missions[index] ?? 'defend',
      memberIds: [],
      target: { x: rally.x, y: rally.y },
      targetBuildingId: null,
      power: 0,
      centroid: { x: rally.x, y: rally.y },
    })
  }

  // 輪流分配（平衡隊員數）；同時累計戰力。
  const unitById = new Map<number, Unit>()
  for (const unit of ready) unitById.set(unit.id, unit)
  ready.forEach((unit, index) => {
    const squad = squads[index % squadCount]
    if (squad === undefined) return
    squad.memberIds.push(unit.id)
    squad.power += unitPower(world, unit)
  })

  for (const squad of squads) {
    let sumX = 0
    let sumY = 0
    for (const id of squad.memberIds) {
      const unit = unitById.get(id)
      if (unit === undefined) continue
      sumX += unit.x
      sumY += unit.y
    }
    const memberCount = Math.max(1, squad.memberIds.length)
    squad.centroid = tileOf(sumX / memberCount, sumY / memberCount)
  }

  // 進攻／騷擾目標。
  for (const squad of squads) {
    if (squad.mission !== 'attack' && squad.mission !== 'harass') continue
    let candidates = enemyTargets(world, playerId, squad.mission === 'harass')
    // 騷擾找不到敵方經濟建築時，退回一般進攻目標。
    if (candidates.length === 0 && squad.mission === 'harass') {
      candidates = enemyTargets(world, playerId, false)
      squad.mission = 'attack'
    }
    const centroidFixed = {
      x: squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
      y: squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    }
    const target = pickTarget(world, influence, centroidFixed, candidates)
    if (target === null) {
      // 沒有可攻擊目標 → 轉為守備，避免空轉。
      squad.mission = 'defend'
      squad.target = { x: rally.x, y: rally.y }
      squad.targetBuildingId = null
      continue
    }
    const center = buildingCenter(target)
    const approach = nearestWalkable(world, tileOf(center.x, center.y))
    squad.targetBuildingId = target.id
    squad.target = approach ?? { x: rally.x, y: rally.y }
    if (approach === null) {
      squad.mission = 'defend'
      squad.targetBuildingId = null
    }
  }

  // 隊級撤退：貼身敵軍威脅 > 自身戰力 / 0.7 → 撤回集結點。
  for (const squad of squads) {
    const centroidFixed = {
      x: squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
      y: squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    }
    const enemyThreat = enemyThreatAtPoint(world, playerId, centroidFixed.x, centroidFixed.y)
    const threshold = Math.round(enemyThreat * RETREAT_POWER_RATIO)
    if (squad.power * 1000 < threshold) {
      squad.mission = 'retreat'
      squad.target = { x: rally.x, y: rally.y }
      squad.targetBuildingId = null
    }
  }

  return { tick: world.tick, player: playerId, rally, squads, disengaged, influence }
}

/** 把計畫下單給 sim（移動 + 聚火）。 */
export function applyTacticalPlan(world: World, plan: TacticalPlan): void {
  for (const squad of plan.squads) {
    for (const id of squad.memberIds) {
      orderMove(world, id, squad.target)
      setAttackTarget(world, id, squad.targetBuildingId)
    }
  }
  for (const id of plan.disengaged) {
    orderMove(world, id, plan.rally)
    setAttackTarget(world, id, null)
  }
}

/** 計算並下單一次戰術循環（呼叫端負責每 TACTICAL_INTERVAL_TICKS 節流）。 */
export function planTactics(world: World, playerId: PlayerId, policies: PolicyValues): TacticalPlan {
  const plan = computeTacticalPlan(world, playerId, policies)
  applyTacticalPlan(world, plan)
  return plan
}
