import { setAttackTarget } from '../sim/combat.ts'
import { isBlockedAt, tileOf, UNITS_PER_TILE } from '../sim/types.ts'
import { orderMove } from '../sim/world.ts'
import type { PlayerId, TilePos, Unit, World } from '../sim/types.ts'
import { nearestWalkable, rallyPoint } from './tactics.ts'
import type { Squad, TacticalPlan } from './tactics.ts'

/**
 * AI 微操層（SPEC §9.3，Prompt 8）：每 100ms（= 2 tick）對每個單位跑一次
 * 輕量行為樹，並是全遊戲**唯一的單位命令來源**（戰術層只產計畫）。
 *
 * 行為樹（依序命中，`hp` 門檻與 `preferredRange` 取自單位 JSON）：
 * 1. `hp < retreatHpPct × maxHp` → **撤退**：移往集結點（「最近安全點」的 MVP 簡化）、
 *    清空攻擊目標。
 * 2. 最近敵在**攻擊射程內** → **攻擊**：目標取「同小隊集火目標」（離小隊重心最近的敵
 *    單位，平手取 id 小者）在射程內者，否則射程內最近者。遠程若最近敵
 *    距 < `preferredRange × KITE_MARGIN` → **風箏**：往遠離敵人的方向退，邊退邊打。
 * 3. 有小隊 → **編隊**：移往集結隊形的位置（`squad.target` 周圍環狀 slot）；
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

export type MicroAction = 'retreat' | 'attack' | 'kite' | 'formation' | 'rally'

export interface MicroDecision {
  unitId: number
  action: MicroAction
  /** 所屬小隊 index；未編隊為 null。 */
  squadIndex: number | null
  /** 本循環實際下達的移動目的地；null = 沿用現有路徑（不重下移動令）。 */
  moveDest: TilePos | null
  /** 攻擊目標 id（敵單位或建築）；null = 回到自動接戰。 */
  attackTargetId: number | null
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

/** 是否該重下移動令：閒置、目的地變更，或到 500ms 重算點。 */
function shouldIssueMove(world: World, unit: Unit, dest: TilePos): boolean {
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

/** 小隊集火目標：離小隊重心最近的敵方單位（平手取 id 小者）。 */
function squadFocus(world: World, playerId: PlayerId, squad: Squad): Unit | null {
  const cx = squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2
  const cy = squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2
  let best: Unit | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const other of world.units) {
    if (other.player === playerId || other.hp <= 0) continue
    const dist = distanceSquared(cx, cy, other.x, other.y)
    if (dist < bestDist || (dist === bestDist && other.id < (best?.id ?? Number.POSITIVE_INFINITY))) {
      best = other
      bestDist = dist
    }
  }
  return best
}

/** 隊形位置：以 squad.target 為基準，依成員序取環狀 slot（擋路則順移）。 */
function formationSlot(world: World, base: TilePos, index: number): TilePos {
  const size = world.map.size
  for (let attempt = 0; attempt < FORMATION_OFFSETS.length; attempt++) {
    const offset = FORMATION_OFFSETS[(index + attempt) % FORMATION_OFFSETS.length]
    if (offset === undefined) continue
    const tile = { x: base.x + offset.x, y: base.y + offset.y }
    if (tile.x < 0 || tile.y < 0 || tile.x >= size || tile.y >= size) continue
    if (!isBlockedAt(world, tile)) return tile
  }
  return { x: base.x, y: base.y }
}

/** 風箏後退格：往遠離敵人的方向退 2 格（對角 → 主軸 → 朝集結點退）。 */
function kiteDest(world: World, unit: Unit, enemy: Unit, rally: TilePos): TilePos {
  const from = tileOf(unit.x, unit.y)
  const enemyTile = tileOf(enemy.x, enemy.y)
  const dx = Math.sign(from.x - enemyTile.x)
  const dy = Math.sign(from.y - enemyTile.y)
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
    const fallback = nearestWalkable(world, { x: from.x + rdx * step, y: from.y + rdy * step })
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

/** 純計算：每個單位的行為樹決策（不修改世界）。 */
export function computeMicroPlan(
  world: World,
  playerId: PlayerId,
  plan: TacticalPlan | null,
): MicroDecision[] {
  const rally = plan?.rally ?? rallyPoint(world, playerId)

  const squadByUnit = new Map<number, Squad>()
  const slotByUnit = new Map<number, number>()
  for (const squad of plan?.squads ?? []) {
    squad.memberIds.forEach((id, index) => {
      squadByUnit.set(id, squad)
      slotByUnit.set(id, index)
    })
  }
  const focusBySquad = focusTargets(world, playerId, plan)

  const decisions: MicroDecision[] = []
  const units = world.units
    .filter((unit) => unit.player === playerId && unit.hp > 0)
    .sort((a, b) => a.id - b.id)

  for (const unit of units) {
    const def = world.defs.units[unit.defId]
    if (def === undefined) continue
    const squad = squadByUnit.get(unit.id)
    const squadIndex = squad === undefined ? null : squad.index

    // 1. 撤退：hp < retreatHpPct × maxHp（JSON）→ 移往集結點、清空攻擊目標。
    if (def.stats.hp > 0 && unit.hp < def.stats.hp * def.ai.retreatHpPct) {
      decisions.push({
        unitId: unit.id,
        action: 'retreat',
        squadIndex,
        moveDest: shouldIssueMove(world, unit, rally) ? { x: rally.x, y: rally.y } : null,
        attackTargetId: null,
      })
      continue
    }

    // 2. 敵在射程內 → 攻擊（遠程被貼近時風箏）。
    const rangeFixed = Math.round(def.stats.range * UNITS_PER_TILE)
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
          const dest = kiteDest(world, unit, nearest.unit, rally)
          decisions.push({
            unitId: unit.id,
            action: 'kite',
            squadIndex,
            moveDest: shouldIssueMove(world, unit, dest) ? dest : null,
            attackTargetId: target.id,
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
      })
      continue
    }

    // 3. 有小隊 → 移往隊形位置（attack／harass 同時對目標建築聚火）。
    if (squad !== undefined) {
      const slot = formationSlot(world, squad.target, slotByUnit.get(unit.id) ?? 0)
      decisions.push({
        unitId: unit.id,
        action: 'formation',
        squadIndex,
        moveDest: shouldIssueMove(world, unit, slot) ? slot : null,
        attackTargetId: squad.targetBuildingId,
      })
      continue
    }

    // 4. 待機：新兵／尚未編隊 → 回集結點。
    decisions.push({
      unitId: unit.id,
      action: 'rally',
      squadIndex: null,
      moveDest: shouldIssueMove(world, unit, rally) ? { x: rally.x, y: rally.y } : null,
      attackTargetId: null,
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
