import { getPlayer, isBlockedAt, tileOf, UNITS_PER_TILE } from '../sim/types.ts'
import type { Building, PlayerId, TilePos, Unit, World } from '../sim/types.ts'
import { computeInfluenceMap, DEFENSE_RADIUS_TILES, enemyThreatAtPoint, enemyThreatAtTile, pickMostUrgentThreat, unitThreatMilli } from './influence.ts'
import type { InfluenceMap } from './influence.ts'
import { clampSlider } from './policy.ts'
import type { PolicyValues } from './policy.ts'

/**
 * AI 戰術層（SPEC §9.2，Prompt 7）：每 500ms（= 10 tick）重編小隊、指派任務、
 * 選定進攻目標、判斷撤退。
 *
 * **本層只產出計畫（純函式），不下單**：實際的移動與聚火由微操層
 * （`micro.ts`，Prompt 8）每 100ms 依行為樹決定 —— 單一「命令來源」
 * 才能讓風箏／集火／撤退互相協調而不打架。戰鬥仍由 sim 自動接戰結算。
 *
 * 小隊編組：
 * - `squadCount = round(lerp(4, 1, clusterSpread))`（0 → 4 隊分散、1 → 1 隊集中）
 * - `squadSize  = round(lerp(4, 18, clusterSpread))`
 * - 隊數不超過兵力（不產生空隊）；兵力超過 `squadCount × squadSize` 時自動擴隊。
 * - **就近聚類（Prompt 10.7）**：成員按地理位置聚類分隊（k-means-lite，固定 3 輪、
 *   容量受限最終分配）——同區域的兵編成同一隊，小隊是地理群而非名冊，行軍自然成團；
 *   空群丟棄、重新編號。
 *
 * 任務（`aggression` 決定攻守比例）：
 * - `attackCount = round(squadCount × aggression)`；`attackCount ≥ 2` 且隊數 ≥ 3 時
 *   其中 1 隊為 `harass`（打敵方經濟），其餘 `attack`，剩下的 `defend`。
 * - 進攻目標評分 = `建築value × 1/(敵方格威脅+1) × 1/(1+距離)`（價值高 × 防守弱 × 距離近）。
 * - **集結再攻（Prompt 10.7）**：成員鬆散（最遠成員離重心 > `REGROUP_DISTANCE_TILES`
 *   = 5 格）的攻擊隊先往「重心→目標」方向的集結點聚攏，到齊後才直接鎖定目標建築。
 * - **主動防禦（Prompt 10.6）**：敵軍進入我方建築守備半徑（`DEFENSE_RADIUS_TILES`
 *   = 6 格）→ 受威脅建築（平手優先水晶礦場）旁的來襲敵軍重心成為**攔截目標**：
 *   守備隊前出接敵，保護建築與水晶收入；全軍出擊（無守備隊）時把離威脅最近的
 *   一支攻擊隊拉回守備。同時戰略層生產軌加 **壓境防守加權**（`THREAT_DEFENSE_BONUS`
 *   = 1.0，保護建築與水晶 → 持續產兵回防）。
 *
 * 主動防禦（Prompt 10.6）：
 * - 敵軍進入我方建築守備半徑（`DEFENSE_RADIUS_TILES`）→ 受威脅建築（平手優先
 *   水晶礦場）旁的來襲敵軍重心成為**攔截目標**：守備隊前出接敵，保護建築與
 *   水晶收入；全軍出擊時把離威脅最近的一支攻擊隊拉回守備。
 *
 * 撤退（MVP 簡化版）：
 * - 隊級：`squadPower < 敵方在重心的即時威脅 × 0.7` → 本循環全隊 `retreat` 回集結點
 *   （用即時點位威脅而非格中心值，才反映「貼身敵軍」的壓力）。
 * - 個體：`hp < retreatHpPct × maxHp`（JSON 讀）→ 脫離戰鬥；傷兵不閒置，
 *   round-robin 補進守備隊尾端（attack／harass 隊不收）。
 *
 * 編組為無狀態（每循環按 unit id 排序重算），確保相同世界 → 相同計畫。
 */

/** 戰術循環間隔（SPEC §9.2：500ms = 10 tick）。 */
export const TACTICAL_INTERVAL_TICKS = 10

/** 撤退門檻：小隊戰力 < 敵附近戰力 × 0.7（SPEC §8 小隊撤退）。 */
export const RETREAT_POWER_RATIO = 0.7

/** 集結再攻門檻（tile）：最遠成員離隊重心超過此距離 → 先集結、到齊再進攻。 */
export const REGROUP_DISTANCE_TILES = 5

/** 集結門檻的平方（固定點）：5 × 200 = 1000 → 1,000,000。 */
const REGROUP_LIMIT_SQUARED =
  REGROUP_DISTANCE_TILES * REGROUP_DISTANCE_TILES * UNITS_PER_TILE * UNITS_PER_TILE

/** 集火半徑（tile）：斬殺集火只在小隊重心此距離內的敵人裡挑（維持協同）。 */
export const FOCUS_RADIUS_TILES = 8

/**
 * 戰力評估比例（Prompt 10.8）：我方戰力（milli）≥ 敵方戰力 × 此值才承諾
 * 進攻／攔截；打不贏 → 降級騷擾或守在原處等待支援。
 */
export const ENGAGE_POWER_RATIO = 0.9

export type SquadMission = 'defend' | 'attack' | 'harass' | 'retreat'

export interface Squad {
  index: number
  mission: SquadMission
  memberIds: number[]
  /** 任務目標格（attack/harass = 目標建築旁可走格；defend = 集結點或攔截點；retreat = 集結點）。 */
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
  /** hp < retreatHpPct 而脫離戰鬥的單位 id（守備隊補位者仍列於此，供資訊面板顯示）。 */
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

/* ------------------------------------------------------------------ */
/* 就近聚類編組（Prompt 10.7）                                          */
/* ------------------------------------------------------------------ */

/** 聚類迭代輪數（固定值 → 確定性；不判斷收斂）。 */
const REGROUP_ITERATIONS = 3

/**
 * 就近聚類（k-means-lite）：讓同區域的兵編成同一隊。
 * 1. 種子：按 id 升冪等距取 `squadCount` 個單位的初始位置。
 * 2. 固定 `REGROUP_ITERATIONS` 輪「就近分配 → 重算重心」（平手取 index 小）。
 * 3. 最終分配：按 id 升冪、就近且未滿 `capacity` 的群（平手取 index 小）。
 * 回傳每群的 unit id 清單（群內 id 升冪）；空群保留（呼叫端過濾）。
 */
function groupByProximity(
  ready: readonly Unit[],
  squadCount: number,
  capacity: number,
): number[][] {
  const clusters: number[][] = Array.from({ length: Math.max(0, squadCount) }, () => [])
  if (squadCount <= 0 || ready.length === 0) return clusters

  const centers: Array<{ x: number; y: number }> = []
  for (let index = 0; index < squadCount; index++) {
    const unit = ready[Math.floor((index * ready.length) / squadCount)]
    if (unit === undefined) continue
    centers.push({ x: unit.x, y: unit.y })
  }

  for (let round = 0; round < REGROUP_ITERATIONS; round++) {
    const sums = centers.map(() => ({ x: 0, y: 0, count: 0 }))
    for (const unit of ready) {
      let bestIndex = 0
      let bestDistance = Number.POSITIVE_INFINITY
      for (let index = 0; index < centers.length; index++) {
        const center = centers[index]
        if (center === undefined) continue
        const dx = unit.x - center.x
        const dy = unit.y - center.y
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = index
        }
      }
      const bucket = sums[bestIndex]
      if (bucket === undefined) continue
      bucket.x += unit.x
      bucket.y += unit.y
      bucket.count += 1
    }
    for (let index = 0; index < centers.length; index++) {
      const bucket = sums[index]
      const center = centers[index]
      if (bucket === undefined || center === undefined || bucket.count === 0) continue
      center.x = bucket.x / bucket.count
      center.y = bucket.y / bucket.count
    }
  }

  for (const unit of ready) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY
    let found = false
    for (let index = 0; index < centers.length; index++) {
      const cluster = clusters[index]
      if (cluster === undefined || cluster.length >= capacity) continue
      const center = centers[index]
      if (center === undefined) continue
      const dx = unit.x - center.x
      const dy = unit.y - center.y
      const distance = dx * dx + dy * dy
      if (!found || distance < bestDistance) {
        found = true
        bestDistance = distance
        bestIndex = index
      }
    }
    const cluster = clusters[found ? bestIndex : 0]
    if (cluster === undefined) continue
    cluster.push(unit.id)
  }
  return clusters
}

/** 單位有效戰力（`value × hp / maxHp`，整數）。 */
function unitPower(world: World, unit: Unit): number {
  const def = world.defs.units[unit.defId]
  if (def === undefined || def.stats.hp <= 0) return 0
  return Math.round((def.ai.value * Math.max(0, unit.hp)) / def.stats.hp)
}

/** 由指定格往外找最近的可走格（環狀搜尋，固定順序）。微操層亦共用。 */
export function nearestWalkable(world: World, tile: TilePos): TilePos | null {
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

/** 隊伍鬆散度：最遠成員與隊重心的距離平方（固定點）。 */
function squadSpreadSquared(unitById: Map<number, Unit>, squad: Squad): number {
  const cx = squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2
  const cy = squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2
  let max = 0
  for (const id of squad.memberIds) {
    const unit = unitById.get(id)
    if (unit === undefined) continue
    const dx = unit.x - cx
    const dy = unit.y - cy
    const distance = dx * dx + dy * dy
    if (distance > max) max = distance
  }
  return max
}

/** 集結點：從隊重心朝目標格方向前進 `REGROUP_DISTANCE_TILES` 的最近可走格（整數比例，確定性）。 */
function stagingPoint(world: World, centroid: TilePos, targetTile: TilePos): TilePos | null {
  const dx = targetTile.x - centroid.x
  const dy = targetTile.y - centroid.y
  const steps = Math.max(Math.abs(dx), Math.abs(dy))
  if (steps === 0) return nearestWalkable(world, centroid)
  const stepX = Math.round((dx * REGROUP_DISTANCE_TILES) / steps)
  const stepY = Math.round((dy * REGROUP_DISTANCE_TILES) / steps)
  return nearestWalkable(world, { x: centroid.x + stepX, y: centroid.y + stepY })
}

/** 目標附近的敵方守軍（守備半徑內）與其戰力（milli）。 */
function defendersNear(
  world: World,
  playerId: PlayerId,
  centerFixed: { x: number; y: number },
): { enemies: Unit[]; powerMilli: number } {
  const radiusFixed = DEFENSE_RADIUS_TILES * UNITS_PER_TILE
  const limit = radiusFixed * radiusFixed
  const enemies: Unit[] = []
  let powerMilli = 0
  for (const unit of world.units) {
    if (unit.player === playerId || unit.hp <= 0) continue
    const dx = unit.x - centerFixed.x
    const dy = unit.y - centerFixed.y
    if (dx * dx + dy * dy > limit) continue
    enemies.push(unit)
    powerMilli += unitThreatMilli(world, unit)
  }
  return { enemies, powerMilli }
}

/**
 * 交戰評估（Prompt 10.8）：這群我們殺得掉嗎？
 * 1. 戰力：我方總戰力（milli）≥ 敵方戰力 × `ENGAGE_POWER_RATIO`。
 * 2. 角色：敵方**全遠程**而我方無遠程 → 會被風箏到死，判為殺不掉
 *    （打不贏就騷擾／守建築等待支援）。
 */
function canKillGroup(
  world: World,
  unitById: Map<number, Unit>,
  memberIds: readonly number[],
  totalPowerMilli: number,
  enemyPowerMilli: number,
  enemies: readonly Unit[],
): boolean {
  if (totalPowerMilli < enemyPowerMilli * ENGAGE_POWER_RATIO) return false
  const allRanged = enemies.length > 0 && enemies.every((enemy) => enemy.role === 'ranged')
  if (!allRanged) return true
  return memberIds.some((id) => {
    const unit = unitById.get(id)
    return unit !== undefined && world.defs.units[unit.defId]?.role === 'ranged'
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
  const rawCount = countSquads(ready.length, sizing)

  // 全體存活單位索引（含傷兵，供補位與重心計算共用）。
  const unitById = new Map<number, Unit>()
  for (const unit of world.units) {
    if (unit.player === playerId && unit.hp > 0) unitById.set(unit.id, unit)
  }

  // 就近聚類編組（Prompt 10.7）：同區域的兵編成同一隊——小隊是地理群而非名冊，
  // 行軍自然成團。空群丟棄、重新編號（0..n-1）。
  const groups = groupByProximity(ready, rawCount, sizing.size)
  const missions = assignMissions(
    groups.filter((group) => group.length > 0).length,
    policies,
  )

  const squads: Squad[] = []
  let squadIndex = 0
  for (const memberIds of groups) {
    if (memberIds.length === 0) continue
    const squad: Squad = {
      index: squadIndex,
      mission: missions[squadIndex] ?? 'defend',
      memberIds,
      target: { x: rally.x, y: rally.y },
      targetBuildingId: null,
      power: 0,
      centroid: { x: rally.x, y: rally.y },
    }
    for (const id of memberIds) {
      const unit = unitById.get(id)
      if (unit === undefined) continue
      squad.power += unitPower(world, unit)
    }
    squads.push(squad)
    squadIndex += 1
  }

  // 傷兵補位（SPEC §9.2 補註，Prompt 9.4）：脫離戰鬥的單位不閒置——
  // round-robin 補進**守備隊**尾端（attack／harass 隊不收傷兵，避免拖累行軍）。
  // 已在守備隊佔位 → micro 層撤退抵達集結點後落回行為樹，照常吃 slot 並自動接戰。
  if (disengaged.length > 0) {
    const defendSquads = squads.filter((squad) => squad.mission === 'defend')
    defendSquads.forEach((squad, index) => {
      const id = disengaged[index]
      if (id === undefined) return
      const unit = unitById.get(id)
      if (unit === undefined) return
      squad.memberIds.push(id)
      squad.power += unitPower(world, unit)
    })
    // 傷兵多於守備隊時：多的依舊只留在 disengaged 清單（不進攻擊隊）。
  }

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
    if (approach === null) {
      squad.mission = 'defend'
      squad.targetBuildingId = null
      continue
    }
    squad.targetBuildingId = target.id

    // 交戰評估（Prompt 10.8）：目標處守軍殺不掉 → 降級等待支援。
    // attack 打不贏 → 轉 harass（改打敵方經濟）；harass 也打不贏 → 轉 defend（守家等兵）。
    const defense = defendersNear(world, playerId, center)
    if (
      !canKillGroup(
        world,
        unitById,
        squad.memberIds,
        squad.power * 1000,
        defense.powerMilli,
        defense.enemies,
      )
    ) {
      if (squad.mission === 'attack') {
        const econCandidates = enemyTargets(world, playerId, true).filter(
          (candidate) => candidate.id !== target.id,
        )
        const econ = pickTarget(world, influence, centroidFixed, econCandidates)
        if (econ !== null) {
          const econCenter = buildingCenter(econ)
          const econApproach = nearestWalkable(world, tileOf(econCenter.x, econCenter.y))
          if (econApproach !== null) {
            squad.mission = 'harass'
            squad.targetBuildingId = econ.id
            squad.target = econApproach
            continue
          }
        }
      }
      squad.mission = 'defend'
      squad.target = { x: rally.x, y: rally.y }
      squad.targetBuildingId = null
      continue
    }

    // 集結再攻（Prompt 10.7）：成員鬆散（最遠成員離重心 > REGROUP_DISTANCE_TILES）
    // → 先往「重心→目標」方向的集結點聚攏；到齊後直接鎖定目標建築。
    if (squadSpreadSquared(unitById, squad) > REGROUP_LIMIT_SQUARED) {
      const staging = stagingPoint(world, squad.centroid, tileOf(center.x, center.y))
      if (staging !== null) {
        squad.target = staging
        continue
      }
    }
    squad.target = approach
  }

  // 主動防禦（Prompt 10.6）：敵軍進入守備半徑（DEFENSE_RADIUS_TILES）→ 攔截。
  // - 受威脅建築（平手時優先水晶礦場）旁的來襲敵軍重心成為守備隊的攔截目標——
  //   保護建築與水晶收入，而不是窩在集結點等敵人打上門。
  // - 全軍出擊（沒有守備隊）時：把離受威脅建築最近的一支攻擊／騷擾隊拉回守備；
  //   retreat 隊不拉（已在撤）。
  const threat = pickMostUrgentThreat(world, playerId)
  if (threat !== null) {
    const intercept = nearestWalkable(world, threat.centroid) ?? { x: rally.x, y: rally.y }
    let defenders = squads.filter((squad) => squad.mission === 'defend')
    if (defenders.length === 0) {
      let closest: Squad | null = null
      let closestDistance = Number.POSITIVE_INFINITY
      for (const squad of squads) {
        if (squad.mission !== 'attack' && squad.mission !== 'harass') continue
        const dx = squad.centroid.x - threat.buildingCenterTile.x
        const dy = squad.centroid.y - threat.buildingCenterTile.y
        const distance = dx * dx + dy * dy
        if (distance < closestDistance) {
          closestDistance = distance
          closest = squad
        }
      }
      if (closest !== null) {
        closest.mission = 'defend'
        defenders = [closest]
      }
    }
    // 交戰評估（Prompt 10.8）：攔截打不贏來襲群 → 不前出，守在受威脅建築旁
    // （自動接戰近身敵人 + 脫戰回血 + 壓境產兵加權），等戰力翻轉再攔截包夾。
    const raiders = threat.enemyIds
      .map((id) => world.units.find((unit) => unit.id === id))
      .filter((unit): unit is Unit => unit !== undefined && unit.hp > 0)
    const totalPowerMilli = defenders.reduce((total, squad) => total + squad.power * 1000, 0)
    const memberIds = defenders.flatMap((squad) => squad.memberIds)
    const hold = !canKillGroup(
      world,
      unitById,
      memberIds,
      totalPowerMilli,
      threat.threatPower,
      raiders,
    )
    const holdTarget = hold
      ? (nearestWalkable(world, threat.buildingCenterTile) ?? { x: rally.x, y: rally.y })
      : null
    for (const squad of defenders) {
      squad.mission = 'defend'
      squad.target = holdTarget ?? intercept
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


