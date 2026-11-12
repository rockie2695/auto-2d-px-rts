import { distanceSquaredToBuilding, setAttackTarget } from '../sim/combat.ts'
import { isBlockedAt, isConstructed, UNITS_PER_TILE } from '../sim/types.ts'
import { orderMove } from '../sim/world.ts'
import type { Building, PlayerId, TilePos, Unit, World } from '../sim/types.ts'
import { enemyThreatAtPoint, unitThreatMilli } from './influence.ts'
import { isVisibleTo } from './sight.ts'
import { mirrorSafeTileOf } from './mirrorTile.ts'
import {
  nearestSpawnPoint,
  nearestWalkable,
  rallyPoint,
  siegeApproachTile,
  ENGAGE_POWER_RATIO,
  FOCUS_RADIUS_TILES,
} from './tactics.ts'
import type { Squad, TacticalPlan } from './tactics.ts'

/**
 * AI 微操層（SPEC §9.3，Prompt 8）：每 100ms（= 2 tick）對每個單位跑一次
 * 輕量行為樹，並是全遊戲**唯一的單位命令來源**（戰術層只產計畫）。
 *
 * 行為樹（依序命中，`hp` 門檻與 `preferredRange` 取自單位 JSON）：
 * 1. `hp < retreatHpPct × maxHp` → **撤退**：移往集結點（「最近安全點」的 MVP 簡化）；
 *    射程內有敵人 → **邊退邊打**（Prompt 10：保持最近射程內敵人為目標，
 *    後撤本身即拉開距離，不再是清空目標的靜默撤退）；**抵達集結點後落回行為樹**
 *    （守備隊 slot＋sim 自動接戰，Prompt 9.4 傷兵補位——不再永久停擺）。
 * 2. 最近敵在**攻擊射程內** → **攻擊**：目標取「同小隊集火目標」（集火半徑
 *    `FOCUS_RADIUS_TILES` 內 **hp% 最低**者——斬殺集火，Prompt 10.7；
 *    半徑內無敵人取離小隊重心最近者）在射程內者，否則射程內最近者。遠程若最近敵
 *    距 < `preferredRange × KITE_MARGIN` → **風箏**：往遠離敵人的方向退，邊退邊打。
 * 2.4 **受火反應**（Prompt 10.24 D）：最近受過傷且打不到攻擊者 → 有支援就貼身
 *    （追擊門檻放寬到 `range + UNDER_FIRE_CHASE_MARGIN`），無支援或攻擊者是塔
 *    （非攻城目標）→ **脫離**（背離攻擊者方向）。攻城換血除外；`atRally` 單位
 *    同樣適用（不再站樁被點射到死）。
 * 2.5 最近敵在**射程外但在追擊距離內**（≤ `range + CHASE_MARGIN`）→ **追擊**：
 *    前壓到敵人當下所在格接戰（Prompt 10.15 修訂：**不吃 AI 閘門**——量測顯示
 *    閘門系統性偏藍；接觸重評估只驅動小隊目標／夾擊，不鎖貼身追擊）。
 *    追擊支援規則（Prompt 10.8）仍適用：目標是遠程（風箏型）且在我方射程外時，
 *    需有其他友軍在其 `CHASE_SUPPORT_RADIUS_TILES` 內作支援才追。
 * 2.6 小隊任務為 **retreat**（戰術層判退）→ **fallback**：朝集結點退、
 *    射程內有敵人 → **邊退邊打**（Prompt 10.15 W2：受襲不原地等死，
 *    撤到集結點重整等待支援；與分支 1 的單位級撤退同一語義）。
 * 3. 有小隊 → **編隊**：移往集結隊形的位置（`squad.target` 周圍環狀 slot，
 *    **近戰內環、遠程外環**，Prompt 10.7）；
 *    attack／harass 任務同時對 `squad.targetBuildingId` 聚火。
 *    **攻城收尾（Prompt 10.18）**：目標是建築而隊形位／自身在射程外時，
 *    改往與佔地正交相鄰的**射程內**接近格——否則部隊站在射程外永遠打不到。
 * 4. 否則（新兵／尚未編隊）→ **待機**：前往最近一間生產建築的出廠集合格
 *    （Prompt 10.19；無生產建築則集結點）。
 *
 * A\* 節流（SPEC §9.4「路徑每 500ms 重算」）：目的地未變且非重算 tick 時沿用現有
 * 路徑；`tick % MICRO_REPATH_TICKS === 0` 定期重算；目的地變化（風箏）立即重算。
 * 全部決策依 unit id 排序、固定 slot 順序，確定性可重現。
 */

/** 微操循環間隔（SPEC §9.3：100ms = 2 tick）。 */
export const MICRO_INTERVAL_TICKS = 2

/** 路徑重算間隔（SPEC §9.4：500ms = 10 tick）。 */
export const MICRO_REPATH_TICKS = 10

/** 風箏門檻：最近敵距 < `preferredRange × KITE_MARGIN` 就後退（archer 3.0 → 2.1 格）。 */
export const KITE_MARGIN = 0.7

/** 追擊門檻：射程外但 ≤ `range + CHASE_MARGIN`（格）就前壓接戰（SPEC §9.3 第 4 節）。 */
export const CHASE_MARGIN = 1.0

/** 追擊支援半徑（tile，Prompt 10.8）：追擊**風箏型遠程**敵人（在我方射程外）時，
 * 需有其他友軍位於該敵人此半徑內作支援——單兵追風箏 = 被射死，不追、守在建築旁等支援。 */
export const CHASE_SUPPORT_RADIUS_TILES = 4

/**
 * 撤退安全半徑（tile，Prompt 10.9）：傷兵只在**附近此半徑內有敵人**時撤退——
 * 附近無敵人時照常跟隊推進（途中回血），不再無限期蹲集結點造成後期呆滯。
 */
export const SAFE_RETREAT_RADIUS_TILES = 8

/**
 * 殘血門檻（Prompt 10.13，HP 撤退分級；Prompt 10.21 調 0.1 → 0.2 保守保命）：
 * `hp < 20%` → **一律回家**（避免被一刀撿頭）；
 * `20% ≤ hp < retreatHpPct`（單位 JSON，現 0.5）→ **只在附近敵威脅 > 自身戰力 × 0.9** 時撤退；
 * 以上 → 正常作戰（半血但優勢時不退）。
 */
export const CRITICAL_HP_PCT = 0.2

/**
 * 受火判定窗口（tick，Prompt 10.24 D）：`unit.hp < maxHp` 且
 * `tick − lastCombatTick ≤ 窗` 視為「正在被攻擊」（`lastCombatTick` 在出手
 * 或受傷時都會重置；hp 滿血的新兵不算——否則開局全員「受火」亂跑）。
 */
export const UNDER_FIRE_WINDOW_TICKS = 60

/**
 * 受火追擊上限（tile，Prompt 10.24 D）：受火時追擊門檻從 `range + CHASE_MARGIN`
 * 放寬到 `range + UNDER_FIRE_CHASE_MARGIN`——被打還站著挨射是行為樹盲區；
 * 超過此距離的攻擊者多半夠不著（塔／超遠程），脫離比貼身划算。
 * （平衡實測：4 會放大先手紅利 → 24-seed 13/7 超門；2 → 攻勢萎縮回 10 平局；
 *  3 為 12-seed 公平門內最均衡值——5 藍/5 紅/2 平。）
 */
export const UNDER_FIRE_CHASE_MARGIN = 3

export type MicroAction =
  | 'retreat'
  | 'attack'
  | 'kite'
  | 'chase'
  | 'disengage'
  | 'fallback'
  | 'formation'
  | 'rally'

export interface MicroDecision {
  unitId: number
  action: MicroAction
  /** 所屬小隊 index；未編隊為 null。 */
  squadIndex: number | null
  /** 本循環實際下達的移動目的地；null = 沿用現有路徑（不重下移動令）。 */
  moveDest: TilePos | null
  /** 攻擊目標 id（敵單位或建築）；null = 回到自動接戰。 */
  attackTargetId: number | null
  /** 人類可讀的決策原因（規則生成、中文、確定性）。資訊面板直接顯示。 */
  reason: string
  /** 決策主導因素（Prompt 8.5：記錄層歸因；與 action 不同——同一 action
   *  有多個分支成因，如 retreat 的殘血／低於門檻二分支）。 */
  topFactor: MicroTopFactor
}

/**
 * 微操層決策主導因素（Prompt 8.5）：觸發分支的成因（不是 action 的複讀——
 * 例如 `disengage` 有騷擾壓制／塔火／受火打不到三個分支，成因各自不同）。
 */
export type MicroTopFactor =
  | 'hpCritical' // 殘血（< CRITICAL_HP_PCT）一律撤
  | 'hpThreshold' // hp 低於 retreatHpPct 門檻且附近敵優勢
  | 'harassPressured' // 騷擾隊遭優勢敵人壓制 → 脫離不硬拼
  | 'kiteRange' // 敵距 < preferredRange × KITE_MARGIN → 風箏
  | 'inRange' // 敵進入射程 → 接戰
  | 'chaseMargin' // 敵在射程外一步內（含受火有支援貼身）→ 前壓接戰
  | 'underFire' // 受火反應：塔火壓制／攻擊者打不到 → 脫離
  | 'fallbackSquad' // 小隊級撤退（mission 'retreat'）：邊退邊打
  | 'formation' // 移往隊形位／攻城接近格
  | 'rally' // 未編隊 → 出廠集合格

/** 動作中文名（記錄 explanation 開頭用）。 */
const MICRO_ACTION_LABEL: Readonly<Record<MicroAction, string>> = {
  retreat: '撤退',
  attack: '攻擊',
  kite: '風箏',
  chase: '追擊',
  disengage: '脫離',
  fallback: '小隊撤退',
  formation: '編隊',
  rally: '集結',
}

/** 戰鬥態動作（Prompt 8.5 記錄過濾：切換的任一端 ∈ 此集合才記錄）。 */
const COMBAT_ACTIONS: ReadonlySet<MicroAction> = new Set<MicroAction>([
  'retreat',
  'attack',
  'kite',
  'chase',
  'disengage',
  'fallback',
])

/**
 * 微操層決策記錄（Prompt 8.5）：與戰略／戰術記錄同構、獨立型別。
 * **只在戰鬥狀態切換時產生**（見 `microRecords`），避免每微操循環爆量。
 */
export interface MicroRecord {
  tick: number
  layer: 'micro'
  actor: PlayerId
  action: MicroAction
  /** `u{單位id}`，有攻擊目標時附 `←t{目標id}`。 */
  target: string
  reason: {
    topFactor: MicroTopFactor
    /** 一行中文解釋，例：「撤退。理由：hp 22% < 閾值 25%」。 */
    explanation: string
  }
}

/** 每單位的微操狀態（記錄 diff 用）：上次動作＋上次被記錄的循環序號。 */
export type MicroRecordState = Map<number, { action: MicroAction; lastRecordedCycle: number }>

/** 環狀隊形偏移（radius 0→3，共 49 格，足夠 squadSize 上限 18）。 */
const FORMATION_OFFSETS: readonly TilePos[] = (() => {
  const offsets: TilePos[] = []
  for (let radius = 0; radius <= 3; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        offsets.push({ x: dx, y: dy })
      }
    }
  }
  return offsets
})()

/** 平方距離（固定點），避免開方。 */
function distanceSquared(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

/** 是否該重下移動令：閒置、目的地變更，或到 500ms 重算點。
 *  已站上目的地且路徑結束 → 不再重下（省 A*，杜絕「原地反覆下令」）。
 *  比對單位格用鏡像安全取格（Prompt 10.22，Prompt 10.23 共用 `mirrorTile.ts`）
 *  —紅方單位 px 在格邊界時若用直接 floor 的格比對，會與鏡像的藍方差一格
 *  → 單邊重下移動令 → 單邊換路。 */

function shouldIssueMove(world: World, unit: Unit, dest: TilePos): boolean {
  const tile = mirrorSafeTileOf(world.map.size, unit.player === 'enemy', unit.x, unit.y)
  if (tile.x === dest.x && tile.y === dest.y && unit.path === null) return false
  if (unit.path === null && unit.dest === null) return true
  if (unit.dest === null || unit.dest.x !== dest.x || unit.dest.y !== dest.y) return true
  return world.tick % MICRO_REPATH_TICKS === 0
}

/**
 * 射程內最近的敵方單位（平手取 id 小者）。
 * **視野過濾（Prompt 9.5b）**：只回視野內敵人——微操的攻擊／風箏／追擊目標
 * 全部經此函式，出視野即失標（無記憶）；射程 ≤ 視野時為防禦性檢查。
 */
function nearestEnemyWithin(world: World, unit: Unit, rangeFixed: number): Unit | null {
  let best: Unit | null = null
  let bestDist = Number.POSITIVE_INFINITY
  const limit = rangeFixed * rangeFixed
  for (const other of world.units) {
    if (other.player === unit.player || other.hp <= 0) continue
    const dist = distanceSquared(unit.x, unit.y, other.x, other.y)
    if (dist > limit) continue
    if (!isVisibleTo(world, unit.player, other.x, other.y)) continue
    if (dist < bestDist || (dist === bestDist && other.id < (best?.id ?? Number.POSITIVE_INFINITY))) {
      best = other
      bestDist = dist
    }
  }
  return best
}

/** 全場最近的敵方單位（風箏判斷用）；視野外不計（Prompt 9.5b）。 */
function nearestEnemy(world: World, unit: Unit): { unit: Unit; distSq: number } | null {
  let best: Unit | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const other of world.units) {
    if (other.player === unit.player || other.hp <= 0) continue
    const dist = distanceSquared(unit.x, unit.y, other.x, other.y)
    if (dist < bestDist || (dist === bestDist && other.id < (best?.id ?? Number.POSITIVE_INFINITY))) {
      best = other
      bestDist = dist
    }
  }
  if (best !== null && !isVisibleTo(world, unit.player, best.x, best.y)) return null
  return best === null ? null : { unit: best, distSq: bestDist }
}

/**
 * 小隊集火目標（Prompt 10.7 斬殺集火）：集火半徑（`FOCUS_RADIUS_TILES`）內
 * **hp% 最低**的敵方單位——集火用來收頭，加快滾雪球；半徑內無敵人 →
 * 退回「離小隊重心最近者」。平手：先近者、再 id 小者。純函式、確定性。
 * **視野過濾（Prompt 9.5b）**：看不見的敵人不集火（無記憶）。
 */
function squadFocus(world: World, playerId: PlayerId, squad: Squad): Unit | null {
  const cx = squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2
  const cy = squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2
  const radiusFixed = FOCUS_RADIUS_TILES * UNITS_PER_TILE
  const limit = radiusFixed * radiusFixed
  let best: Unit | null = null
  let bestHpMilli = Number.POSITIVE_INFINITY
  let bestDistance = Number.POSITIVE_INFINITY
  let nearest: Unit | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const other of world.units) {
    if (other.player === playerId || other.hp <= 0) continue
    if (!isVisibleTo(world, playerId, other.x, other.y)) continue
    const distance = distanceSquared(cx, cy, other.x, other.y)
    if (
      distance < nearestDistance ||
      (distance === nearestDistance && other.id < (nearest?.id ?? Number.POSITIVE_INFINITY))
    ) {
      nearest = other
      nearestDistance = distance
    }
    if (distance > limit) continue
    const def = world.defs.units[other.defId]
    if (def === undefined || def.stats.hp <= 0) continue
    const hpMilli = Math.round((other.hp * 1000) / def.stats.hp)
    if (hpMilli < bestHpMilli || (hpMilli === bestHpMilli && distance < bestDistance)) {
      best = other
      bestHpMilli = hpMilli
      bestDistance = distance
    }
  }
  return best ?? nearest
}

/** 隊形位置：以 squad.target 為基準，依成員序取環狀 slot（擋路則順移）。
 *  `mirrorOrder`（Prompt 10.9）：敵方側 slot 取**負偏移**——紅藍隊形互為鏡像。 */
function formationSlot(
  world: World,
  base: TilePos,
  index: number,
  mirrorOrder = false,
): TilePos {
  const size = world.map.size
  for (let attempt = 0; attempt < FORMATION_OFFSETS.length; attempt++) {
    const offset = FORMATION_OFFSETS[(index + attempt) % FORMATION_OFFSETS.length]
    if (offset === undefined) continue
    const tile = mirrorOrder
      ? { x: base.x - offset.x, y: base.y - offset.y }
      : { x: base.x + offset.x, y: base.y + offset.y }
    if (tile.x < 0 || tile.y < 0 || tile.x >= size || tile.y >= size) continue
    if (!isBlockedAt(world, tile)) return tile
  }
  return { x: base.x, y: base.y }
}

/** 風箏後退格：往遠離敵人的方向退 2 格（對角 → 主軸 → 朝集結點退）。 */
function kiteDest(
  world: World,
  playerId: PlayerId,
  unit: Unit,
  enemy: Unit,
  rally: TilePos,
): TilePos {
  return fleeDestFrom(world, playerId, unit, enemy.x, enemy.y, rally)
}

/**
 * 脫離方向格（Prompt 10.24 D，`kiteDest` 的點來源一般化）：背離來源 px
 * （敵單位／敵塔中心）退 2 格（對角 → 主軸）；全被擋 → 朝集結點退。
 * 取格走鏡像安全路徑（Prompt 10.23）。
 */
function fleeDestFrom(
  world: World,
  playerId: PlayerId,
  unit: Unit,
  srcPxX: number,
  srcPxY: number,
  rally: TilePos,
): TilePos {
  const mirrorOrder = playerId === 'enemy'
  const from = mirrorSafeTileOf(world.map.size, mirrorOrder, unit.x, unit.y)
  const src = mirrorSafeTileOf(world.map.size, mirrorOrder, srcPxX, srcPxY)
  const dx = Math.sign(from.x - src.x)
  const dy = Math.sign(from.y - src.y)
  const step = 2
  const size = world.map.size
  const candidates: TilePos[] = []
  if (dx !== 0 || dy !== 0) {
    candidates.push({ x: from.x + dx * step, y: from.y + dy * step })
    candidates.push({ x: from.x + dx * step, y: from.y })
    candidates.push({ x: from.x, y: from.y + dy * step })
  }
  for (const candidate of candidates) {
    if (candidate.x < 0 || candidate.y < 0 || candidate.x >= size || candidate.y >= size) continue
    if (!isBlockedAt(world, candidate)) return candidate
  }
  // 敵我同格或全被擋：改往集結點方向退。
  const rdx = Math.sign(rally.x - from.x)
  const rdy = Math.sign(rally.y - from.y)
  if (rdx !== 0 || rdy !== 0) {
    const fallback = nearestWalkable(
      world,
      { x: from.x + rdx * step, y: from.y + rdy * step },
      mirrorOrder,
    )
    if (fallback !== null) return fallback
  }
  return { x: from.x, y: from.y }
}

/** 追擊支援判定（Prompt 10.8）：目標不是風箏型遠程 → 直接可追；是遠程則需有
 *  其他友軍在其 `CHASE_SUPPORT_RADIUS_TILES` 內（單兵追風箏 = 被射死，不追）。
 *  Prompt 10.24 D：受火反應共用此判定。 */
function chaseSupported(
  world: World,
  playerId: PlayerId,
  enemy: Unit,
  chaserId: number,
): boolean {
  if (enemy.role !== 'ranged') return true
  const supportLimit = CHASE_SUPPORT_RADIUS_TILES * UNITS_PER_TILE
  const supportSq = supportLimit * supportLimit
  for (const ally of world.units) {
    if (ally.player !== playerId || ally.id === chaserId || ally.hp <= 0) continue
    const dx = ally.x - enemy.x
    const dy = ally.y - enemy.y
    if (dx * dx + dy * dy <= supportSq) return true
  }
  return false
}

/**
 * 正在射我的敵方防禦建築（Prompt 10.24 D）：帶 `defense`、**已完工**、防禦射程
 * 覆蓋我（外框量測，與 sim 同算法）。回傳覆蓋我的**最近**一座；平手取 id 小者
 * （掃描序 id 升冪＋嚴格小於 ⟺ 同）。純函式、確定性。
 */
function threateningTowerOf(world: World, playerId: PlayerId, unit: Unit): Building | null {
  let best: Building | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const building of world.buildings) {
    if (building.player === playerId || building.hp <= 0) continue
    const def = world.defs.buildings[building.defId]
    const defense = def?.defense
    if (def === undefined || defense === undefined || !isConstructed(building)) continue
    const rangeFixed = Math.round(defense.range * UNITS_PER_TILE)
    const distSq = distanceSquaredToBuilding(unit, building)
    if (distSq > rangeFixed * rangeFixed) continue
    if (distSq < bestDist) {
      best = building
      bestDist = distSq
    }
  }
  return best
}

/** 各小隊的集火目標（squadIndex → 敵單位 id；無敵方為 null）。CLI 顯示亦共用。 */
export function focusTargets(
  world: World,
  playerId: PlayerId,
  plan: TacticalPlan | null,
): Map<number, number | null> {
  const targets = new Map<number, number | null>()
  for (const squad of plan?.squads ?? []) {
    targets.set(squad.index, squadFocus(world, playerId, squad)?.id ?? null)
  }
  return targets
}

/** 隊形編排（Prompt 10.7）：**近戰前排（內環）、遠程後排（外環）**；
 *  各角色內維持成員原序（id 升冪）→ 確定性。近戰頂在前、遠程在後排輸出。 */
function formationOrder(world: World, squad: Squad, unitById: Map<number, Unit>): number[] {
  const melee: number[] = []
  const ranged: number[] = []
  for (const id of squad.memberIds) {
    const unit = unitById.get(id)
    const role = unit === undefined ? undefined : world.defs.units[unit.defId]?.role
    if (role === 'ranged') ranged.push(id)
    else melee.push(id)
  }
  return [...melee, ...ranged]
}

/** 純計算：每個單位的行為樹決策（不修改世界）。 */
export function computeMicroPlan(
  world: World,
  playerId: PlayerId,
  plan: TacticalPlan | null,
): MicroDecision[] {
  const rally = plan?.rally ?? rallyPoint(world, playerId)

  const squadByUnit = new Map<number, Squad>()
  const slotByUnit = new Map<number, number>()
  // 存活單位索引（隊形編排查角色用；成員必屬本玩家且存活）。
  const unitById = new Map<number, Unit>()
  for (const unit of world.units) {
    if (unit.player === playerId && unit.hp > 0) unitById.set(unit.id, unit)
  }
  for (const squad of plan?.squads ?? []) {
    // 隊形編排：近戰取內環 slot、遠程取外環（Prompt 10.7）。
    formationOrder(world, squad, unitById).forEach((id, index) => {
      squadByUnit.set(id, squad)
      slotByUnit.set(id, index)
    })
  }
  const focusBySquad = focusTargets(world, playerId, plan)

  const decisions: MicroDecision[] = []
  const units = world.units
    .filter((unit) => unit.player === playerId && unit.hp > 0)
    .sort((a, b) => a.id - b.id)
  // 敵方側的幾何掃描序鏡像（Prompt 10.9）：紅藍對鏡射位置挑出互為鏡像的格。
  const mirrorOrder = playerId === 'enemy'

  for (const unit of units) {
    const def = world.defs.units[unit.defId]
    if (def === undefined) continue
    const squad = squadByUnit.get(unit.id)
    const squadIndex = squad === undefined ? null : squad.index
    const unitTile = mirrorSafeTileOf(world.map.size, playerId === 'enemy', unit.x, unit.y)
    const atRally = unitTile.x === rally.x && unitTile.y === rally.y
    // 出廠集合格（Prompt 10.19）：最近一間生產建築的集合格（平手取 buildingId 小者）；
    // 沒有生產建築（spawns 空）→ 退回集結點。
    const spawnAnchor = nearestSpawnPoint(plan?.spawns ?? [], unitTile)

    // 1. 撤退：hp < retreatHpPct × maxHp（JSON）→ 移往集結點；射程內有敵人 →
    //    邊退邊打（保持最近射程內敵人為攻擊目標，每微操循環更新；移動仍朝集結點——
    //    後撤本身即拉開距離，Prompt 10 修：不再是「清空攻擊目標的靜默撤退」）。
    //    撤退安全距離（Prompt 10.9）：附近 SAFE_RETREAT_RADIUS_TILES 內**有敵人**才撤退——
    //    無近距離威脅時傷兵照常跟隊推進（途中回血），不再無限期蹲集結點。
    //    抵達集結點後落回行為樹（守備隊 slot＋sim 自動接戰）——傷兵補位不永久停擺。
    const maxHp = def.stats.hp
    const rangeFixed = Math.round(def.stats.range * UNITS_PER_TILE)
    if (maxHp > 0 && !atRally) {
      const hpFraction = unit.hp / maxHp
      const safeLimit = SAFE_RETREAT_RADIUS_TILES * UNITS_PER_TILE
      const near = nearestEnemy(world, unit)
      const threatened = near !== null && near.distSq <= safeLimit * safeLimit
      // 分級（Prompt 10.13）：
      // 1) 殘血 < 20%：一律回家（不被一刀撿頭）。
      const critical = hpFraction < CRITICAL_HP_PCT
      // 2) 10% ≤ hp < retreatHpPct（JSON × retreatHpFactor，Prompt 6 #8）：
      //    附近敵威脅 > 自身戰力 × 0.9 才退（還打得贏就繼續；保留「附近無敵
      //    不撤退」的安全距離）。plan 為 null（戰術層未跑）→ factor 中性 1.0。
      const retreatFactor = plan?.retreatHpFactor ?? 1
      const outmatched =
        hpFraction < def.ai.retreatHpPct * retreatFactor &&
        enemyThreatAtPoint(world, playerId, unit.x, unit.y) >
          unitThreatMilli(world, unit) * ENGAGE_POWER_RATIO
      if (critical || (outmatched && threatened)) {
        const hpPct = Math.floor(hpFraction * 100)
        const target = nearestEnemyWithin(world, unit, rangeFixed)
        const why = critical
          ? `hp ${hpPct}% 殘血（< ${Math.round(CRITICAL_HP_PCT * 100)}%）：一律撤回集結點`
          : `hp ${hpPct}% 低於門檻且附近敵優勢：撤回集結點`
        decisions.push({
          unitId: unit.id,
          action: 'retreat',
          squadIndex,
          moveDest: shouldIssueMove(world, unit, rally) ? { x: rally.x, y: rally.y } : null,
          attackTargetId: target?.id ?? null,
          reason: target !== null ? `${why}（邊退邊打）` : why,
          topFactor: critical ? 'hpCritical' : 'hpThreshold',
        })
        continue
      }
      // 未達撤退條件：落入下方分支照常作戰／跟隊。
    }

    // 2. 騷擾脫離（Prompt 10.13）：騷擾隊遇「附近敵威脅 > 我隊戰力 × 0.9」不硬拼——
    //    往遠離敵人的方向脫離（打不贏就跑，改日再騷擾），而不是原地被打死。
    if (squad !== undefined && squad.mission === 'harass') {
      const threatMilli = enemyThreatAtPoint(world, playerId, unit.x, unit.y)
      if (
        squad.power > 0 &&
        threatMilli > squad.power * 1000 * ENGAGE_POWER_RATIO
      ) {
        const near = nearestEnemy(world, unit)
        const nearbyEnemy =
          near !== null &&
          near.distSq <=
            (rangeFixed + 2 * UNITS_PER_TILE) * (rangeFixed + 2 * UNITS_PER_TILE)
        if (nearbyEnemy && near !== null) {
          const escape = kiteDest(world, playerId, unit, near.unit, spawnAnchor?.tile ?? rally)
          decisions.push({
            unitId: unit.id,
            action: 'disengage',
            squadIndex,
            moveDest: shouldIssueMove(world, unit, escape) ? escape : null,
            attackTargetId: null,
            reason: `騷擾隊遭優勢敵人壓制（威脅 ${Math.round(threatMilli / 1000)} > 我隊戰力 ${squad.power} × 0.9）：脫離不硬拼`,
            topFactor: 'harassPressured',
          })
          continue
        }
      }
    }

    // 2. 敵在射程內 → 攻擊（遠程被貼近時風箏）。
    const inRange = nearestEnemyWithin(world, unit, rangeFixed)
    if (inRange !== null) {
      const focusId = squadIndex === null ? null : (focusBySquad.get(squadIndex) ?? null)
      const focus =
        focusId === null
          ? null
          : (world.units.find(
              (candidate) =>
                candidate.id === focusId && candidate.hp > 0 && candidate.player !== playerId,
            ) ?? null)
      let target = inRange
      if (focus !== null && distanceSquared(unit.x, unit.y, focus.x, focus.y) <= rangeFixed * rangeFixed) {
        target = focus
      }

      if (def.role === 'ranged') {
        const nearest = nearestEnemy(world, unit)
        const threshold = def.ai.preferredRange * KITE_MARGIN * UNITS_PER_TILE
        if (nearest !== null && nearest.distSq < threshold * threshold) {
          const dest = kiteDest(world, playerId, unit, nearest.unit, rally)
          decisions.push({
            unitId: unit.id,
            action: 'kite',
            squadIndex,
            moveDest: shouldIssueMove(world, unit, dest) ? dest : null,
            attackTargetId: target.id,
            reason: `敵距 ${(Math.sqrt(nearest.distSq) / UNITS_PER_TILE).toFixed(1)} 格 < ${def.ai.preferredRange * KITE_MARGIN} 格：邊退邊打`,
            topFactor: 'kiteRange',
          })
          continue
        }
      }

      decisions.push({
        unitId: unit.id,
        action: 'attack',
        squadIndex,
        moveDest: null,
        attackTargetId: target.id,
        reason:
          target.id === focus?.id
            ? `集火同隊目標 #${target.id}（射程內）`
            : `敵人 #${target.id} 進入射程`,
        topFactor: 'inRange',
      })
      continue
    }

    // 2.4 受火反應（Prompt 10.24 D）：最近受過傷（滿血新兵不算——`lastCombatTick`
    // 在出手或受傷時都會重置，開局 tick 0 全員不得誤判受火）且**打不到**攻擊者 →
    // 有支援就貼身（追擊門檻放寬到 `range + UNDER_FIRE_CHASE_MARGIN`），無支援
    // 或攻擊者是塔 → 脫離（背離攻擊者方向，`fleeDestFrom`）。
    // 舊行為樹在「被打但打不到」時直接落到編隊分支站樁挨打致死；攻城換血除外
    // （`squad.targetBuildingId` 非 null：正對建築輸出，塔火下的換血是攻城的
    // 計畫內成本——撤了就永遠拆不掉主堡）。
    const underFire =
      unit.hp < maxHp && world.tick - unit.lastCombatTick <= UNDER_FIRE_WINDOW_TICKS
    const sieging = squad !== undefined && squad.targetBuildingId !== null
    if (underFire && !sieging) {
      const tower = threateningTowerOf(world, playerId, unit)
      if (tower !== null && squad?.targetBuildingId !== tower.id) {
        const cover = fleeDestFrom(
          world,
          playerId,
          unit,
          (tower.x + tower.w / 2) * UNITS_PER_TILE,
          (tower.y + tower.h / 2) * UNITS_PER_TILE,
          rally,
        )
        decisions.push({
          unitId: unit.id,
          action: 'disengage',
          squadIndex,
          moveDest: shouldIssueMove(world, unit, cover) ? cover : null,
          attackTargetId: null,
            reason: `塔火壓制（${tower.defId} #${tower.id}，非攻城目標）：撤出射程`,
            topFactor: 'underFire',
        })
        continue
      }
      const near = nearestEnemy(world, unit)
      const chaseLimitFixed = rangeFixed + CHASE_MARGIN * UNITS_PER_TILE
      if (near !== null && near.distSq > chaseLimitFixed * chaseLimitFixed) {
        const underFireLimitFixed = rangeFixed + UNDER_FIRE_CHASE_MARGIN * UNITS_PER_TILE
        if (
          near.distSq <= underFireLimitFixed * underFireLimitFixed &&
          chaseSupported(world, playerId, near.unit, unit.id)
        ) {
          const enemyTile = mirrorSafeTileOf(
            world.map.size,
            playerId === 'enemy',
            near.unit.x,
            near.unit.y,
          )
          decisions.push({
            unitId: unit.id,
            action: 'chase',
            squadIndex,
            moveDest: shouldIssueMove(world, unit, enemyTile) ? enemyTile : null,
            attackTargetId: near.unit.id,
            reason: `受火反應：攻擊者 #${near.unit.id} 壓制中（${(Math.sqrt(near.distSq) / UNITS_PER_TILE).toFixed(1)} 格）——有支援，貼身接戰`,
            topFactor: 'chaseMargin',
          })
          continue
        }
        // 更遠或無支援：脫離不硬拼（背離攻擊者方向），不再站樁挨打。
        const cover = fleeDestFrom(world, playerId, unit, near.unit.x, near.unit.y, rally)
        decisions.push({
          unitId: unit.id,
          action: 'disengage',
          squadIndex,
          moveDest: shouldIssueMove(world, unit, cover) ? cover : null,
          attackTargetId: null,
          reason: `受火反應：攻擊者 #${near.unit.id} 距 ${(Math.sqrt(near.distSq) / UNITS_PER_TILE).toFixed(1)} 格打不到——脫離不站樁挨打`,
          topFactor: 'underFire',
        })
        continue
      }
    }

    // 2.5 追擊（Prompt 10.15 修訂）：敵在射程外但 ≤ range + CHASE_MARGIN → 前壓接戰。
    //     **不吃 AI 閘門**——量測（24 種子）顯示閘門造成系統性偏藍（16/3/5 → 14/7/3），
    //     追擊是「射程外一步內的貼身反應」，屬本地行為；接觸重評估（W1）改為
    //     驅動**小隊目標**（`engaging` → target 跟隨敵群重心）與夾擊呼叫（W2），
    //     不禁止單位-Level 的貼身追擊。追擊支援規則（Prompt 10.8）仍適用：
    //     目標是遠程（風箏型）且在我方射程外時，需有其他友軍在其
    //     CHASE_SUPPORT_RADIUS_TILES 內作支援才追（單兵追風箏 = 被射死）。
    const near = nearestEnemy(world, unit)
    if (near !== null) {
      const chaseLimitFixed = rangeFixed + CHASE_MARGIN * UNITS_PER_TILE
      if (near.distSq <= chaseLimitFixed * chaseLimitFixed) {
        const supported = chaseSupported(world, playerId, near.unit, unit.id)
        if (supported) {
          const enemyTile = mirrorSafeTileOf(
            world.map.size,
            playerId === 'enemy',
            near.unit.x,
            near.unit.y,
          )
          decisions.push({
            unitId: unit.id,
            action: 'chase',
            squadIndex,
            moveDest: shouldIssueMove(world, unit, enemyTile) ? enemyTile : null,
            attackTargetId: near.unit.id,
            reason: `敵人 #${near.unit.id} 在追擊距離內（${(Math.sqrt(near.distSq) / UNITS_PER_TILE).toFixed(1)} 格，射程 ${(rangeFixed / UNITS_PER_TILE).toFixed(1)} 格）：前壓接戰`,
            topFactor: 'chaseMargin',
          })
          continue
        }
        // 無支援：不追（落回編隊分支，守在建築旁等待支援）。
      }
    }

    // 2.6 小隊級 fallback（Prompt 10.15 W2）：戰術層判退的小隊（mission 'retreat'）
    //     → 朝集結點退、射程內有敵人 → **邊退邊打**（不就地等死，撤回集結點
    //     重整等待支援；語義與分支 1 的單位級撤退相同，觸發層級在小隊）。
    if (squad !== undefined && squad.mission === 'retreat') {
      const inRange = nearestEnemyWithin(world, unit, rangeFixed)
      decisions.push({
        unitId: unit.id,
        action: 'fallback',
        squadIndex,
        moveDest: shouldIssueMove(world, unit, rally) ? { x: rally.x, y: rally.y } : null,
        attackTargetId: inRange?.id ?? null,
        reason: inRange !== null
          ? `小隊受襲撤退：邊退邊打 #${inRange.id}，撤回集結點等待支援`
          : '小隊受襲撤退：撤回集結點等待支援',
        topFactor: 'fallbackSquad',
      })
      continue
    }

    // 3. 有小隊 → 移往隊形位置（attack／harass 同時對目標建築聚火）。
    if (squad !== undefined) {
      let slot = formationSlot(world, squad.target, slotByUnit.get(unit.id) ?? 0, mirrorOrder)
      let siege = false
      // 攻城收尾（Prompt 10.18）：目標是建築時，若隊形位／本身**打不到**該建築
      // （射程以外），改往與佔地正交相鄰的射程內接近格——否則部隊站在射程外
      // 永遠打不到、攻城卡死（無敵方單位時也啃不掉主堡）。
      if (squad.targetBuildingId !== null) {
        const building = world.buildings.find(
          (candidate) => candidate.id === squad.targetBuildingId && candidate.hp > 0,
        )
        if (
          building !== undefined &&
          distanceSquaredToBuilding(unit, building) > rangeFixed * rangeFixed
        ) {
          const approach = siegeApproachTile(world, playerId, building, unitTile)
          if (approach !== null) {
            slot = approach
            siege = true
          }
        }
      }
      decisions.push({
        unitId: unit.id,
        action: 'formation',
        squadIndex,
        moveDest: shouldIssueMove(world, unit, slot) ? slot : null,
        attackTargetId: squad.targetBuildingId,
        reason: siege
          ? `小隊 #${squadIndex}（${squad.mission}）攻城接近格 (${slot.x},${slot.y})（原隊形位在射程外）`
          : `小隊 #${squadIndex}（${squad.mission}）→ 隊形位 (${slot.x},${slot.y})`,
        topFactor: 'formation',
      })
      continue
    }

    // 4. 待機：新兵／尚未編隊 → 前往**最近一間生產建築**的出廠集合格
    //    （Prompt 10.19；無生產建築則集結點）。AI 再就近聚類編組。
    const gather = spawnAnchor?.tile ?? rally
    const atGather = unitTile.x === gather.x && unitTile.y === gather.y
    const buildingName =
      spawnAnchor === null
        ? ''
        : world.buildings.find((candidate) => candidate.id === spawnAnchor.buildingId)?.defId ??
          `#${spawnAnchor.buildingId}`
    decisions.push({
      unitId: unit.id,
      action: 'rally',
      squadIndex: null,
      moveDest: shouldIssueMove(world, unit, gather) ? { x: gather.x, y: gather.y } : null,
      attackTargetId: null,
      reason:
        spawnAnchor === null
          ? atGather
            ? '未編隊：在集結點待命'
            : '未編隊：前往集結點'
          : atGather
            ? `未編隊：在出廠集合格待命（${buildingName}）`
            : `未編隊：前往出廠集合格（${buildingName}）`,
      topFactor: 'rally',
    })
  }

  return decisions
}

/** 把微操決策下單給 sim（移動 + 攻擊目標）。 */
export function applyMicroPlan(world: World, decisions: readonly MicroDecision[]): void {
  for (const decision of decisions) {
    if (decision.moveDest !== null) orderMove(world, decision.unitId, decision.moveDest)
    setAttackTarget(world, decision.unitId, decision.attackTargetId)
  }
}

/** 計算並下單一次微操循環（呼叫端負責每 MICRO_INTERVAL_TICKS 節流）。 */
export function runMicroCycle(
  world: World,
  playerId: PlayerId,
  plan: TacticalPlan | null,
): MicroDecision[] {
  const decisions = computeMicroPlan(world, playerId, plan)
  applyMicroPlan(world, decisions)
  return decisions
}

/**
 * 微操層決策記錄（Prompt 8.5）：**只在戰鬥狀態切換時**產生記錄。
 * - 切換＝本循環 action 與該單位上次 action 不同，且切換的**任一端**屬
 *   戰鬥態（`COMBAT_ACTIONS`）——formation↔rally 的常規巡迴切換不記。
 * - 防抖：同一單位兩條記錄至少相隔 `cooldownCycles` 個微操循環（預設 20
 *   ＝每微操循環 2 tick × 20 ＝ 40 tick）——杜絕「進出射程」震盪刷屏。
 * - 首次進入戰鬥態（無上次動作）＝狀態入場，記錄且不受防抖約束。
 *
 * 純函式、無副作用：狀態由呼叫端持有（`state` 就地更新），對 sim 與決策
 * **零影響**（記錄不進 replay）。回傳值確定性：決策順序＝單位順序。
 */
export function microRecords(
  playerId: PlayerId,
  tick: number,
  decisions: readonly MicroDecision[],
  state: MicroRecordState,
  cycleIndex: number,
  cooldownCycles = 20,
): MicroRecord[] {
  const records: MicroRecord[] = []
  for (const decision of decisions) {
    const before = state.get(decision.unitId)
    const anchor = before?.lastRecordedCycle ?? Number.NEGATIVE_INFINITY
    const changed =
      before !== undefined &&
      before.action !== decision.action &&
      (COMBAT_ACTIONS.has(decision.action) || COMBAT_ACTIONS.has(before.action))
    // 首次進入戰鬥態（狀態入場）或戰鬥態間切換且過防抖 → 記錄。
    const entering =
      before === undefined && COMBAT_ACTIONS.has(decision.action)
    const shouldRecord =
      entering || (changed && before !== undefined && cycleIndex - anchor >= cooldownCycles)
    if (shouldRecord) {
      records.push({
        tick,
        layer: 'micro',
        actor: playerId,
        action: decision.action,
        target:
          decision.attackTargetId === null
            ? `u${decision.unitId}`
            : `u${decision.unitId}←t${decision.attackTargetId}`,
        reason: {
          topFactor: decision.topFactor,
          explanation: `${MICRO_ACTION_LABEL[decision.action]}。理由：${decision.reason}`,
        },
      })
    }
    // 狀態與冷卻錨點：action 始終推進（反映最新決策）；`lastRecordedCycle`
    // 只在**真的記錄**時推進（被防抖壓制的切換不重置冷卻，否則高頻震盪會把
    // 記錄永遠往後推）。
    state.set(decision.unitId, {
      action: decision.action,
      lastRecordedCycle: shouldRecord ? cycleIndex : anchor,
    })
  }
  return records
}
