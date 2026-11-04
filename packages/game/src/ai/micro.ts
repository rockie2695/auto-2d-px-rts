import { setAttackTarget } from '../sim/combat.ts'
import { isBlockedAt, tileOf, UNITS_PER_TILE } from '../sim/types.ts'
import { orderMove } from '../sim/world.ts'
import type { PlayerId, TilePos, Unit, World } from '../sim/types.ts'
import { enemyThreatAtPoint, unitThreatMilli } from './influence.ts'
import {
  nearestWalkable,
  rallyPoint,
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
 * 2.5 最近敵在**射程外但在追擊距離內**（≤ `range + CHASE_MARGIN`）→ **追擊**：
 *    前壓到敵人當下所在格接戰（SPEC §9.3 行為樹第 4 節「追擊」）；殺掉後
 *    下一循環由編隊分支接管。行軍／後退途中的近旁敵人不會再被「並行放走」。
 * 3. 有小隊 → **編隊**：移往集結隊形的位置（`squad.target` 周圍環狀 slot，
 *    **近戰內環、遠程外環**，Prompt 10.7）；
 *    attack／harass 任務同時對 `squad.targetBuildingId` 聚火。
 * 4. 否則（新兵／尚未編隊）→ **待機**：回集結點。
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
 * 殘血門檻（Prompt 10.13，HP 撤退分級）：
 * `hp < 10%` → **一律回家**（避免被一刀撿頭）；
 * `10% ≤ hp < retreatHpPct`（單位 JSON，現 0.5）→ **只在附近敵威脅 > 自身戰力 × 0.9** 時撤退；
 * 以上 → 正常作戰（半血但優勢時不退）。
 */
export const CRITICAL_HP_PCT = 0.1

export type MicroAction =
  | 'retreat'
  | 'attack'
  | 'kite'
  | 'chase'
  | 'disengage'
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
}

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
 *  已站上目的地且路徑結束 → 不再重下（省 A*，杜絕「原地反覆下令」）。 */
function shouldIssueMove(world: World, unit: Unit, dest: TilePos): boolean {
  const tile = tileOf(unit.x, unit.y)
  if (tile.x === dest.x && tile.y === dest.y && unit.path === null) return false
  if (unit.path === null && unit.dest === null) return true
  if (unit.dest === null || unit.dest.x !== dest.x || unit.dest.y !== dest.y) return true
  return world.tick % MICRO_REPATH_TICKS === 0
}

/** 射程內最近的敵方單位（平手取 id 小者）。 */
function nearestEnemyWithin(world: World, unit: Unit, rangeFixed: number): Unit | null {
  let best: Unit | null = null
  let bestDist = Number.POSITIVE_INFINITY
  const limit = rangeFixed * rangeFixed
  for (const other of world.units) {
    if (other.player === unit.player || other.hp <= 0) continue
    const dist = distanceSquared(unit.x, unit.y, other.x, other.y)
    if (dist > limit) continue
    if (dist < bestDist || (dist === bestDist && other.id < (best?.id ?? Number.POSITIVE_INFINITY))) {
      best = other
      bestDist = dist
    }
  }
  return best
}

/** 全場最近的敵方單位（風箏判斷用）。 */
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
  return best === null ? null : { unit: best, distSq: bestDist }
}

/**
 * 小隊集火目標（Prompt 10.7 斬殺集火）：集火半徑（`FOCUS_RADIUS_TILES`）內
 * **hp% 最低**的敵方單位——集火用來收頭，加快滾雪球；半徑內無敵人 →
 * 退回「離小隊重心最近者」。平手：先近者、再 id 小者。純函式、確定性。
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
  const from = tileOf(unit.x, unit.y)
  const enemyTile = tileOf(enemy.x, enemy.y)
  const dx = Math.sign(from.x - enemyTile.x)
  const dy = Math.sign(from.y - enemyTile.y)
  const step = 2
  const size = world.map.size
  const mirrorOrder = playerId === 'enemy'
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
    const unitTile = tileOf(unit.x, unit.y)
    const atRally = unitTile.x === rally.x && unitTile.y === rally.y

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
      // 1) 殘血 < 10%：一律回家（不被一刀撿頭）。
      const critical = hpFraction < CRITICAL_HP_PCT
      // 2) 10% ≤ hp < retreatHpPct（JSON 0.5）：附近敵威脅 > 自身戰力 × 0.9 才退
      //    （還打得贏就繼續；保留「附近無敵不撤退」的安全距離）。
      const outmatched =
        hpFraction < def.ai.retreatHpPct &&
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
          const escape = kiteDest(world, playerId, unit, near.unit, plan?.gather ?? rally)
          decisions.push({
            unitId: unit.id,
            action: 'disengage',
            squadIndex,
            moveDest: shouldIssueMove(world, unit, escape) ? escape : null,
            attackTargetId: null,
            reason: `騷擾隊遭優勢敵人壓制（威脅 ${Math.round(threatMilli / 1000)} > 我隊戰力 ${squad.power} × 0.9）：脫離不硬拼`,
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
      })
      continue
    }

    // 2.5 追擊：敵在射程外但 ≤ range + CHASE_MARGIN → 前壓到敵人所在格接戰
    //     （SPEC §9.3 行為樹第 4 節）。近旁敵人不會再被同速行軍「並行放走」。
    //     追擊支援規則（Prompt 10.8）：目標是遠程（風箏型）且在我方射程外時，
    //     需有其他友軍在其 CHASE_SUPPORT_RADIUS_TILES 內作支援才追——
    //     單兵追風箏會被射死；無支援則不追（落回編隊分支守在建築旁等隊友，
    //     支援到齊後一起從各自位置包夾收頭）。
    const near = nearestEnemy(world, unit)
    const chaseLimitFixed = rangeFixed + CHASE_MARGIN * UNITS_PER_TILE
    if (near !== null && near.distSq <= chaseLimitFixed * chaseLimitFixed) {
      let supported = near.unit.role !== 'ranged'
      if (!supported) {
        const supportLimit = CHASE_SUPPORT_RADIUS_TILES * UNITS_PER_TILE
        const supportSq = supportLimit * supportLimit
        for (const ally of world.units) {
          if (ally.player !== playerId || ally.id === unit.id || ally.hp <= 0) continue
          const dx = ally.x - near.unit.x
          const dy = ally.y - near.unit.y
          if (dx * dx + dy * dy <= supportSq) {
            supported = true
            break
          }
        }
      }
      if (supported) {
        const enemyTile = tileOf(near.unit.x, near.unit.y)
        decisions.push({
          unitId: unit.id,
          action: 'chase',
          squadIndex,
          moveDest: shouldIssueMove(world, unit, enemyTile) ? enemyTile : null,
          attackTargetId: near.unit.id,
          reason: `敵人 #${near.unit.id} 在追擊距離內（${(Math.sqrt(near.distSq) / UNITS_PER_TILE).toFixed(1)} 格，射程 ${(rangeFixed / UNITS_PER_TILE).toFixed(1)} 格）：前壓接戰`,
        })
        continue
      }
      // 無支援：不追（落回編隊分支，守在建築旁等待支援）。
    }

    // 3. 有小隊 → 移往隊形位置（attack／harass 同時對目標建築聚火）。
    if (squad !== undefined) {
      const slot = formationSlot(world, squad.target, slotByUnit.get(unit.id) ?? 0, mirrorOrder)
      decisions.push({
        unitId: unit.id,
        action: 'formation',
        squadIndex,
        moveDest: shouldIssueMove(world, unit, slot) ? slot : null,
        attackTargetId: squad.targetBuildingId,
        reason: `小隊 #${squadIndex}（${squad.mission}）→ 隊形位 (${slot.x},${slot.y})`,
      })
      continue
    }

    // 4. 待機：新兵／尚未編隊 → 前往**生產點**（Prompt 10.13；無則集結點）。
    const gather = plan?.gather ?? rally
    const atGather = unitTile.x === gather.x && unitTile.y === gather.y
    decisions.push({
      unitId: unit.id,
      action: 'rally',
      squadIndex: null,
      moveDest: shouldIssueMove(world, unit, gather) ? { x: gather.x, y: gather.y } : null,
      attackTargetId: null,
      reason: atGather ? '未編隊：在生產點待命' : '未編隊：前往生產點',
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
