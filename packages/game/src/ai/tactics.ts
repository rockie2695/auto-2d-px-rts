import { getPlayer, isBlockedAt, tileOf, UNITS_PER_TILE } from '../sim/types.ts'
import type { Building, PlayerId, TilePos, Unit, World } from '../sim/types.ts'
import { computeInfluenceMap, DEFENSE_RADIUS_TILES, enemyThreatAtPoint, enemyThreatAtTile, pickMostUrgentThreat, unitThreatMilli } from './influence.ts'
import type { BuildingThreat, InfluenceMap } from './influence.ts'
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

/** 接觸注意半徑（tile，Prompt 10.15 W1）：敵人進到小隊重心此半徑內算「接觸」。
 *  接觸本身不等于接戰——射程內照樣由模擬層自動接戰，AI 層只在接觸時做**重新評估**。 */
export const CONTACT_NOTICE_RADIUS_TILES = 6

/** 接觸重評估冷卻（tick，Prompt 10.15 W1）：同小隊冷卻期內不重複評估（防抖動）。 */
export const CONTACT_REPLAN_COOLDOWN_TICKS = 60

/** 夾擊接應半徑（tile，Prompt 10.15 W2）：受襲小隊只向「此範圍內且殺得掉」的友隊求援。 */
export const PINCER_REPLY_RADIUS_TILES = 12

/** 夾擊繞後半徑（tile，Prompt 10.15 W2）：接應小隊自敵群重心此半徑的**不同方位**接近。 */
export const PINCER_STANDOFF_TILES = 3

/** 最多幾支小隊響應夾擊（Prompt 10.15 W2）。 */
export const PINCER_MAX_RESPONDERS = 2

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
  /** 接觸重評估（Prompt 10.15）：true = 決定迎戰敵群（target = 敵群接近格；集火不指建築）。
   *  false/未設 = 維持原命令——單位不自行離隊追擊，射程內仍由模擬層自動接戰。 */
  engaging?: boolean
}

/** 接觸事件（Prompt 10.15）：一次接觸驅動的重新評估／夾擊呼叫，供決策日誌逐條顯示。 */
export interface ContactEvent {
  squadIndex: number
  /** `engage` = 迎戰；`keep` = 維持原命令；`pincer` = 呼叫友隊夾擊。 */
  outcome: 'engage' | 'keep' | 'pincer'
  /** 人類可讀的完整句（規則生成、中文、確定性）。 */
  text: string
}

/** 接觸狀態（Prompt 10.15）：跨循環持續的小隊接觸記錄（以 squad index 為鍵）。 */
export interface ContactState {
  /** squadIndex → 上次接觸重評估 tick（冷卻期內不再重複評估）。 */
  replanTick: Record<number, number>
  /** squadIndex → 隊上已知的敵人 id（這循環才出現者為「新接觸」）。 */
  known: Record<number, number[]>
}

export interface TacticalPlan {
  tick: number
  player: PlayerId
  /** 集結點（無威脅＝keep 旁；有威脅＝往受威脅建築方向前移，Prompt 10.13）。 */
  rally: TilePos
  /** 生產點（Prompt 10.13）：新兵出廠後的集合格——集結點往主目標方向前移。 */
  gather: TilePos
  squads: Squad[]
  /** hp < retreatHpPct 而脫離戰鬥的單位 id（守備隊補位者仍列於此，供資訊面板顯示）。 */
  disengaged: number[]
  influence: InfluenceMap
  /** 接觸狀態（Prompt 10.15）：供下一循環區分「新接觸」與冷卻判斷。 */
  contact?: ContactState
  /** 本循環產生的接觸事件（迎戰／維持原命令／夾擊呼叫），session 轉進決策日誌。 */
  events?: readonly ContactEvent[]
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

/** 編組遲滯裕度（格）：換隊需比原隊近超過此值（避免邊界單位每循環乒乓）。 */
const SQUAD_HYSTERESIS_TILES = 2

/**
 * 就近聚類（k-means-lite）：讓同區域的兵編成同一隊。
 * 1. 種子：優先用前次群心（warm start，Prompt 10.13），不足則按 id 升冪等距取。
 * 2. 固定 `REGROUP_ITERATIONS` 輪「就近分配 → 重算重心」（平手取 index 小）。
 * 3. 最終分配：按 id 升冪、就近且未滿 `capacity` 的群；**遲滯**——原隊距離在
 *    「最近距離 + 裕度」內就留在原隊（不乒乓）。
 * 回傳每群的 unit id 清單（群內 id 升冪）；空群保留（呼叫端過濾）。
 */
export function groupByProximity(
  ready: readonly Unit[],
  squadCount: number,
  capacity: number,
  seedCenters: readonly TilePos[] = [],
  previousIndex: ReadonlyMap<number, number> = new Map(),
): number[][] {
  const clusters: number[][] = Array.from({ length: Math.max(0, squadCount) }, () => [])
  if (squadCount <= 0 || ready.length === 0) return clusters

  const centers: Array<{ x: number; y: number }> = []
  for (let index = 0; index < squadCount; index++) {
    const seed = seedCenters[index]
    if (seed !== undefined) {
      // warm start：前次群心（固定點中心）。
      centers.push({ x: seed.x * UNITS_PER_TILE + UNITS_PER_TILE / 2, y: seed.y * UNITS_PER_TILE + UNITS_PER_TILE / 2 })
      continue
    }
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

  const hysteresisMargin = SQUAD_HYSTERESIS_TILES * UNITS_PER_TILE
  // 遲滯距離以「前次群心」為準（迭代後的中心會漂移，不適合當原隊參考）。
  const previousCenters = seedCenters.map((seed) => ({
    x: seed.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    y: seed.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
  }))
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
    // 遲滯（Prompt 10.13）：原隊仍在且距離在「最近距離 + 裕度」內 → 留原隊（不乒乓）。
    const previous = previousIndex.get(unit.id)
    if (previous !== undefined && previous < centers.length && previous !== bestIndex && found) {
      const cluster = clusters[previous]
      const center = previousCenters[previous] ?? centers[previous]
      if (cluster !== undefined && center !== undefined && cluster.length < capacity) {
        const dx = unit.x - center.x
        const dy = unit.y - center.y
        const limit = (Math.sqrt(bestDistance) + hysteresisMargin) ** 2
        if (dx * dx + dy * dy <= limit) {
          cluster.push(unit.id)
          continue
        }
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

/** 由指定格往外找最近的可走格（環狀搜尋）。微操層亦共用。
 *  `mirrorOrder`（Prompt 10.9）：敵方側用**鏡像掃描序**（候選取負偏移）——
 *  讓紅藍雙方對鏡射位置挑出互為鏡像的格，消除「兩邊都往左上找」的幾何偏誤。 */
export function nearestWalkable(
  world: World,
  tile: TilePos,
  mirrorOrder = false,
): TilePos | null {
  const { size } = world.map
  const inBounds = (candidate: TilePos): boolean =>
    candidate.x >= 0 && candidate.y >= 0 && candidate.x < size && candidate.y < size
  const candidateOf = (offset: TilePos): TilePos =>
    mirrorOrder
      ? { x: tile.x - offset.x, y: tile.y - offset.y }
      : { x: tile.x + offset.x, y: tile.y + offset.y }

  if (inBounds(tile) && !isBlockedAt(world, tile)) return { x: tile.x, y: tile.y }
  for (let radius = 1; radius < size * 2; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const candidate = candidateOf({ x: dx, y: dy })
        if (!inBounds(candidate)) continue
        if (!isBlockedAt(world, candidate)) return candidate
      }
    }
  }
  return null
}

/**
 * 集結點（Prompt 10.13）：AI 依局勢選點——
 * - 無威脅 → keep 旁的可走格（原行為）。
 * - 有威脅（`threat`）→ 往受威脅建築方向**前移**到中點附近的可走格
 *   （防守儲備更靠近前線）；沒有 keep 時退回出生點。
 */
export function rallyPoint(
  world: World,
  playerId: PlayerId,
  threat: BuildingThreat | null = null,
): TilePos {
  const spawn = getPlayer(world, playerId).spawn
  const mirrorOrder = playerId === 'enemy'
  const keep = world.buildings.find(
    (building) => building.player === playerId && building.hp > 0 && building.defId === 'keep',
  )
  const base =
    keep === undefined
      ? spawn
      : { x: keep.x + Math.floor(keep.w / 2), y: keep.y + Math.floor(keep.h / 2) }
  const home = nearestWalkable(world, base, mirrorOrder) ?? { x: spawn.x, y: spawn.y }
  if (threat === null) return home
  const forward: TilePos = {
    x: Math.round((home.x + threat.buildingCenterTile.x) / 2),
    y: Math.round((home.y + threat.buildingCenterTile.y) / 2),
  }
  return nearestWalkable(world, forward, mirrorOrder) ?? home
}

/** 生產點前移格數（集結點往主目標方向）。 */
const GATHER_FORWARD_TILES = 4

/** 建築中心格。 */
function buildingCenterTile(building: Building): TilePos {
  return tileOf(buildingCenter(building).x, buildingCenter(building).y)
}

/**
 * 生產點（Prompt 10.13）：新兵出廠後的集合格——
 * 由集結點往**主目標**（進攻／騷擾隊的目標建築，否則敵方 keep）方向前移 4 格；
 * 找不到目標則同集結點。整數比例、確定性、鏡射一致。
 */
function gatherPoint(
  world: World,
  playerId: PlayerId,
  rally: TilePos,
  squads: readonly Squad[],
): TilePos {
  const mirrorOrder = playerId === 'enemy'
  const attacker = squads.find(
    (squad) =>
      (squad.mission === 'attack' || squad.mission === 'harass') && squad.targetBuildingId !== null,
  )
  let objective: TilePos | null = attacker?.target ?? null
  if (objective === null) {
    const enemyKeep = world.buildings.find(
      (building) => building.player !== playerId && building.defId === 'keep' && building.hp > 0,
    )
    objective = enemyKeep === undefined ? null : buildingCenterTile(enemyKeep)
  }
  if (objective === null) return rally
  const dx = objective.x - rally.x
  const dy = objective.y - rally.y
  const steps = Math.max(Math.abs(dx), Math.abs(dy))
  if (steps === 0) return rally
  const stepX = Math.round((dx * GATHER_FORWARD_TILES) / steps)
  const stepY = Math.round((dy * GATHER_FORWARD_TILES) / steps)
  return nearestWalkable(world, { x: rally.x + stepX, y: rally.y + stepY }, mirrorOrder) ?? rally
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
function stagingPoint(
  world: World,
  playerId: PlayerId,
  centroid: TilePos,
  targetTile: TilePos,
): TilePos | null {
  const dx = targetTile.x - centroid.x
  const dy = targetTile.y - centroid.y
  const steps = Math.max(Math.abs(dx), Math.abs(dy))
  if (steps === 0) return nearestWalkable(world, centroid, playerId === 'enemy')
  const stepX = Math.round((dx * REGROUP_DISTANCE_TILES) / steps)
  const stepY = Math.round((dy * REGROUP_DISTANCE_TILES) / steps)
  return nearestWalkable(
    world,
    { x: centroid.x + stepX, y: centroid.y + stepY },
    playerId === 'enemy',
  )
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

/**
 * 純計算：編組、任務、目標、撤退判斷（不修改世界）。
 * `previous`（Prompt 10.13）：前一循環的計畫——供編組 warm start 與遲滯，
 * 避免邊界單位每循環乒乓換隊（反覆切組＝原地發呆）。
 */
export function computeTacticalPlan(
  world: World,
  playerId: PlayerId,
  policies: PolicyValues,
  previous: TacticalPlan | null = null,
): TacticalPlan {
  const influence = computeInfluenceMap(world, playerId)
  // 先偵測威脅（集結點依局勢選點；Prompt 10.13）。
  const threat = pickMostUrgentThreat(world, playerId)
  const rally = rallyPoint(world, playerId, threat)

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

  // 全體存活單位索引（含傷兵，供補位與重心計算共用）。
  const unitById = new Map<number, Unit>()
  for (const unit of world.units) {
    if (unit.player === playerId && unit.hp > 0) unitById.set(unit.id, unit)
  }

  // 後期呆滯修復（Prompt 10.9）：全部單位都受傷（ready 為 0）時，傷兵也照常編隊——
  // 否則小隊數 = 0、全軍蹲集結點不推進；微操層的安全距離撤退規則會保護他們。
  const disengagedUnits = disengaged
    .map((id) => unitById.get(id))
    .filter((unit): unit is Unit => unit !== undefined)
  const groupable = ready.length > 0 ? ready : disengagedUnits
  const rawCount = countSquads(groupable.length, sizing)

  // 就近聚類編組（Prompt 10.7）：同區域的兵編成同一隊——小隊是地理群而非名冊，
  // 行軍自然成團。空群丟棄、重新編號（0..n-1）。
  // warm start＋遲滯（Prompt 10.13）：以前一循環的群心為種子、原隊在裕度內不換。
  // 前一循環的群組索引：**以 group index 為鍵**（與 `clusters`／`seedCenters` 同一索引空間），
  // 不是壓縮後的 squad.index——否則空群被丟棄、索引位移，warm start 與遲滯會指到錯的群
  // （且紅藍的位移時機不同 → 系統性偏差）。
  const previousIndex = new Map<number, number>()
  for (const squad of previous?.squads ?? []) {
    for (const id of squad.memberIds) previousIndex.set(id, squad.index)
  }
  // 接觸迎戰狀態（Prompt 10.15）：上一循環是否在迎戰——以群 index 為鍵沿續，
  // 避免 engaging 在循環間失憶（ squads 每循環全新物件）造成忽進忽停。
  const previousEngaging = new Map<number, boolean>()
  for (const squad of previous?.squads ?? []) previousEngaging.set(squad.index, squad.engaging === true)
  const seedCenters: TilePos[] = []
  for (const squad of previous?.squads ?? []) seedCenters[squad.index] = squad.centroid
  const groups = groupByProximity(groupable, rawCount, sizing.size, seedCenters, previousIndex)
  const missions = assignMissions(
    groups.filter((group) => group.length > 0).length,
    policies,
  )

  // squad.index ＝ group index（可能因空群而有跳號）：與上一循環的鍵同一索引空間，
  // warm start／遲滯才能跨循環對齊（微操只用 index 當 map 鍵，跳號無妨）。
  const squads: Squad[] = []
  let missionIndex = 0
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const memberIds = groups[groupIndex]
    if (memberIds === undefined || memberIds.length === 0) continue
    const squad: Squad = {
      index: groupIndex,
      mission: missions[missionIndex] ?? 'defend',
      memberIds,
      target: { x: rally.x, y: rally.y },
      targetBuildingId: null,
      power: 0,
      centroid: { x: rally.x, y: rally.y },
      engaging: previousEngaging.get(groupIndex) ?? false,
    }
    for (const id of memberIds) {
      const unit = unitById.get(id)
      if (unit === undefined) continue
      squad.power += unitPower(world, unit)
    }
    squads.push(squad)
    missionIndex += 1
  }

  // 傷兵補位（SPEC §9.2 補註，Prompt 9.4）：脫離戰鬥的單位不閒置——
  // round-robin 補進**守備隊**尾端（attack／harass 隊不收傷兵，避免拖累行軍）。
  // 已在守備隊佔位 → micro 層撤退抵達集結點後落回行為樹，照常吃 slot 並自動接戰。
  // （ready 為 0 時傷兵已直接作為編組成員，不重複補位——Prompt 10.9。）
  if (disengaged.length > 0 && ready.length > 0) {
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
    const approach = nearestWalkable(world, tileOf(center.x, center.y), playerId === 'enemy')
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
          const econApproach = nearestWalkable(world, tileOf(econCenter.x, econCenter.y), playerId === 'enemy')
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
      const staging = stagingPoint(world, playerId, squad.centroid, tileOf(center.x, center.y))
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
  //   retreat 隊不拉（已在撤）。（threat 已於函式開頭偵測，集結點選點共用。）
  if (threat !== null) {
    const intercept =
      nearestWalkable(world, threat.centroid, playerId === 'enemy') ?? { x: rally.x, y: rally.y }
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
      ? (nearestWalkable(world, threat.buildingCenterTile, playerId === 'enemy') ?? {
          x: rally.x,
          y: rally.y,
        })
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
      squad.engaging = false
    }
  }

  /* ------------------------------------------------------------------ */
  /* 接觸驅動再評估與夾擊（Prompt 10.15，W1/W2）                              */
  /* ------------------------------------------------------------------ */

  const previousContact = previous?.contact ?? { replanTick: {}, known: {} }
  const contact: ContactState = { replanTick: {}, known: {} }
  /** 這循環的特殊事件（session 轉進決策日誌）。 */
  const events: ContactEvent[] = []
  /** 各小隊的本循環接觸（供夾擊呼叫；以小隊 index 為鍵）。 */
  const contactBySquad = new Map<number, { enemies: Unit[]; powerMilli: number; tile: TilePos }>()
  const noticeLimit = CONTACT_NOTICE_RADIUS_TILES * UNITS_PER_TILE
  const replyLimit = PINCER_REPLY_RADIUS_TILES * UNITS_PER_TILE

  for (const squad of squads) {
    // 沿續接觸狀態（以 squad index 為鍵；warm start 同一索引空間）。
    contact.replanTick[squad.index] = previousContact.replanTick[squad.index] ?? 0
    contact.known[squad.index] = [...(previousContact.known[squad.index] ?? [])]

    // 撤退隊不再接觸接戰（已在撤）。
    if (squad.mission === 'retreat') continue
    const centroidFixed = {
      x: squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
      y: squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    }
    const noticeSq = noticeLimit * noticeLimit
    const seen: Unit[] = []
    let contactPower = 0
    let sumX = 0
    let sumY = 0
    for (const enemy of world.units) {
      if (enemy.player === playerId || enemy.hp <= 0) continue
      const dx = enemy.x - centroidFixed.x
      const dy = enemy.y - centroidFixed.y
      if (dx * dx + dy * dy > noticeSq) continue
      seen.push(enemy)
      contactPower += unitThreatMilli(world, enemy)
      sumX += enemy.x
      sumY += enemy.y
    }
    if (seen.length === 0) {
      contact.known[squad.index] = []
      squad.engaging = false // 視野內沒有敵人：迎戰狀態解除，回到原命令。
      continue
    }
    seen.sort((a, b) => a.id - b.id)

    const known = contact.known[squad.index] ?? []
    const knownIds = new Set(known)
    const newIds = seen.filter((enemy) => !knownIds.has(enemy.id))
    const enemyTile = tileOf(sumX / seen.length, sumY / seen.length)
    contact.known[squad.index] = seen.map((enemy) => enemy.id)
    contactBySquad.set(squad.index, { enemies: seen, powerMilli: contactPower, tile: enemyTile })

    const lastTick = contact.replanTick[squad.index] ?? 0
    const cooledDown = world.tick - lastTick >= CONTACT_REPLAN_COOLDOWN_TICKS
    if (newIds.length === 0) {
      // 既有接觸：上一循環已在迎戰 → 目標跟著敵群現位走（不再重評估）。
      if (squad.engaging === true) {
        squad.target = enemyTile
        squad.targetBuildingId = null
      }
      continue
    }
    if (!cooledDown) continue

    // **新接觸 → AI 重新評估**（模擬層射程內自動接戰照舊、不受影響）：
    // 殺得掉 → 迎戰（小隊目標改敵群重心格）；殺不掉 → 維持原命令。
    contact.replanTick[squad.index] = world.tick
    const winnable = canKillGroup(
      world,
      unitById,
      squad.memberIds,
      squad.power * 1000,
      contactPower,
      seen,
    )
    if (winnable) {
      squad.engaging = true
      squad.target = enemyTile
      squad.targetBuildingId = null
      events.push({
        squadIndex: squad.index,
        outcome: 'engage',
        text: `小隊 #${squad.index} 遭遇敵軍（戰力 ${squad.power} vs 威脅 ${Math.round(contactPower / 1000)}）：重新評估 → 迎戰`,
      })
    } else {
      squad.engaging = false
      events.push({
        squadIndex: squad.index,
        outcome: 'keep',
        text: `小隊 #${squad.index} 遭遇敵軍（戰力 ${squad.power} vs 威脅 ${Math.round(contactPower / 1000)}）：重新評估 → 維持原命令`,
      })
    }
  }

  // 夾擊呼叫（W2）：受襲殺不掉的小隊向「附近殺得掉」的友隊求援；接應小隊
  // 自敵群重心的**不同方位**繞行接近（夾擊而非一窩蜂正面撞），方位序由
  // responder 順序決定（確定性）。**方位向量在敵方（鏡像序）取負**——
  // 否則藍方永遠從敵群東側接近、紅方也是東側，鏡射對稱會在接觸後破裂
  // （pairProbe 實測 t=211 位置分叉的根因）。
  const directions: readonly TilePos[] = [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
  ]
  const mirrorOrder = playerId === 'enemy'
  // 前一計畫各小隊的目標（供「接應位沒變就不重複記事件」判斷）。
  const previousTargets = new Map<number, TilePos>()
  for (const squad of previous?.squads ?? []) previousTargets.set(squad.index, squad.target)
  for (const contactSquad of contactBySquad.values()) {
    const losingPower = contactSquad.powerMilli
    const responders: Squad[] = []
    for (const squad of squads) {
      if (responders.length >= PINCER_MAX_RESPONDERS) break
      if (squad.mission !== 'attack' && squad.mission !== 'harass') continue
      const centroidFixed = {
        x: squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
        y: squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
      }
      const dx = centroidFixed.x - (contactSquad.tile.x + 0.5) * UNITS_PER_TILE
      const dy = centroidFixed.y - (contactSquad.tile.y + 0.5) * UNITS_PER_TILE
      if (dx * dx + dy * dy > replyLimit * replyLimit) continue
      if (
        !canKillGroup(
          world,
          unitById,
          squad.memberIds,
          squad.power * 1000,
          losingPower,
          contactSquad.enemies,
        )
      ) {
        continue
      }
      responders.push(squad)
    }
    responders.sort((a, b) => a.index - b.index)
    for (const responder of responders) {
      const base = directions[responders.indexOf(responder) % directions.length] ?? { x: 0, y: 1 }
      const dir = mirrorOrder ? { x: -base.x, y: -base.y } : base
      const approach =
        nearestWalkable(
          world,
          {
            x: contactSquad.tile.x + dir.x * PINCER_STANDOFF_TILES,
            y: contactSquad.tile.y + dir.y * PINCER_STANDOFF_TILES,
          },
          mirrorOrder,
        ) ?? contactSquad.tile
      responder.engaging = true
      responder.target = approach
      responder.targetBuildingId = null
      const before = previousTargets.get(responder.index)
      if (before === undefined || before.x !== approach.x || before.y !== approach.y) {
        events.push({
          squadIndex: responder.index,
          outcome: 'pincer',
          text: `小隊 #${responder.index} 響應受襲小隊的夾擊呼叫（接應位 (${approach.x},${approach.y})）`,
        })
      }
    }
  }

  // 生產點（Prompt 10.13）：主目標定案後才計算。
  const gather = gatherPoint(world, playerId, rally, squads)

  return { tick: world.tick, player: playerId, rally, gather, squads, disengaged, influence, contact, events }
}


