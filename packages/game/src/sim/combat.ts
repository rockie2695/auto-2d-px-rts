import { TICK_RATE_HZ } from '@auto-2d-px-rts/shared'

import { queryNear } from './spatialHash.ts'
import { buildingEffectiveMaxHp, tileOf, UNITS_PER_TILE } from './types.ts'
import type { CombatTarget, Unit, World } from './types.ts'

/**
 * 自動接戰（SPEC §10）：每個 tick 對每個單位嘗試攻擊一次。
 *
 * - 攻擊冷卻用累積器：`acc += attackSpeed / TICK_RATE_HZ`，
 *   `acc ≥ 1` 才實際攻擊一次並 `acc -= 1`（SPEC §2.2）。
 * - 射程判定用**固定點平方距離**（避免開方、跨平台一致）。
 * - 目標選擇：顯式 `targetId` 優先；否則「射程內最近的敵人單位，
 *   平手取 id 較小者；射程內無單位時才打最近的敵方建築」。
 * - 未完工建築可被打，承受傷害照算（SPEC §5）。
 */

/** 平方距離是否在射程內（含等於）。 */
export function inRangeSquared(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rangeFixed: number,
): boolean {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy <= rangeFixed * rangeFixed
}

/** 單位固定點座標到建築外框的平方距離（點在框內為 0）。 */
export function distanceSquaredToBuilding(
  unit: Unit,
  building: { x: number; y: number; w: number; h: number },
): number {
  const { x: unitTileX, y: unitTileY } = tileOf(unit.x, unit.y)
  const closestX = Math.min(Math.max(unitTileX, building.x), building.x + building.w - 1)
  const closestY = Math.min(Math.max(unitTileY, building.y), building.y + building.h - 1)
  // 以佔地格中心近似：差值與單位座標同一量綱（固定點）。
  const dx = unit.x - (closestX * UNITS_PER_TILE + UNITS_PER_TILE / 2)
  const dy = unit.y - (closestY * UNITS_PER_TILE + UNITS_PER_TILE / 2)
  return dx * dx + dy * dy
}

/** 由顯式目標 id 找出在射程內的敵方目標；不合條件回傳 null。 */
function explicitTargetInRange(world: World, unit: Unit, rangeFixed: number): CombatTarget | null {
  if (unit.targetId === null) return null
  const enemyUnit = world.units.find(
    (candidate) => candidate.id === unit.targetId && candidate.player !== unit.player && candidate.hp > 0,
  )
  if (enemyUnit !== undefined) {
    return inRangeSquared(unit.x, unit.y, enemyUnit.x, enemyUnit.y, rangeFixed)
      ? { kind: 'unit', unit: enemyUnit }
      : null
  }
  const enemyBuilding = world.buildings.find(
    (candidate) =>
      candidate.id === unit.targetId && candidate.player !== unit.player && candidate.hp > 0,
  )
  if (enemyBuilding === undefined) return null
  return distanceSquaredToBuilding(unit, enemyBuilding) <= rangeFixed * rangeFixed
    ? { kind: 'building', building: enemyBuilding }
    : null
}

/** 自動接戰目標：射程內最近敵方單位（平手取 id 小者），否則最近敵方建築。 */
function acquireTarget(world: World, unit: Unit, rangeFixed: number): CombatTarget | null {
  const { unitIds, buildingIds } = queryNear(world, unit.x, unit.y, rangeFixed)

  let bestUnit: Unit | null = null
  let bestUnitDistance = Number.POSITIVE_INFINITY
  for (const id of unitIds) {
    if (id === unit.id) continue
    const candidate = world.units.find((other) => other.id === id)
    if (candidate === undefined || candidate.hp <= 0 || candidate.player === unit.player) continue
    const dx = candidate.x - unit.x
    const dy = candidate.y - unit.y
    const distance = dx * dx + dy * dy
    // unitIds 已排序，嚴格小於即可保留較小 id。
    if (distance <= rangeFixed * rangeFixed && distance < bestUnitDistance) {
      bestUnit = candidate
      bestUnitDistance = distance
    }
  }
  if (bestUnit !== null) return { kind: 'unit', unit: bestUnit }

  let bestBuilding: World['buildings'][number] | null = null
  let bestBuildingDistance = Number.POSITIVE_INFINITY
  for (const id of buildingIds) {
    const candidate = world.buildings.find((other) => other.id === id)
    if (candidate === undefined || candidate.hp <= 0 || candidate.player === unit.player) continue
    const distance = distanceSquaredToBuilding(unit, candidate)
    if (distance <= rangeFixed * rangeFixed && distance < bestBuildingDistance) {
      bestBuilding = candidate
      bestBuildingDistance = distance
    }
  }
  return bestBuilding === null ? null : { kind: 'building', building: bestBuilding }
}

/** 傷害打到建築上：記錄累計傷害並折算目前 hp（未完工按比例，SPEC §5）。 */
function damageBuilding(world: World, buildingId: number, damage: number): void {
  const building = world.buildings.find((candidate) => candidate.id === buildingId)
  if (building === undefined || building.hp <= 0) return
  const def = world.defs.buildings[building.defId]
  if (def === undefined) throw new Error(`未知建築定義：${building.defId}`)
  building.damageTaken += damage
  building.hp = Math.max(0, buildingEffectiveMaxHp(def, building) - building.damageTaken)
}

/** 外部（AI／玩家命令）指定單位的攻擊目標；null = 回到自動接戰。 */
export function setAttackTarget(world: World, unitId: number, targetId: number | null): void {
  const unit = world.units.find((candidate) => candidate.id === unitId)
  if (unit !== undefined) unit.targetId = targetId
}

/** 移除死亡單位／建築，並清理計數、指標與占用的資源點。 */
function removeDead(world: World): void {
  const deadUnitIds = new Set<number>()
  for (const unit of world.units) {
    if (unit.hp <= 0) deadUnitIds.add(unit.id)
  }
  if (deadUnitIds.size > 0) {
    world.units = world.units.filter((unit) => !deadUnitIds.has(unit.id))
    for (const unit of world.units) {
      if (unit.targetId !== null && deadUnitIds.has(unit.targetId)) unit.targetId = null
    }
    for (const player of world.players) {
      player.unitCount = world.units.filter((unit) => unit.player === player.id).length
    }
  }

  const deadBuildingIds = new Set<number>()
  for (const building of world.buildings) {
    if (building.hp <= 0) deadBuildingIds.add(building.id)
  }
  if (deadBuildingIds.size > 0) {
    world.buildings = world.buildings.filter((building) => !deadBuildingIds.has(building.id))
    for (const node of world.resourceNodes) {
      if (node.buildingId !== null && deadBuildingIds.has(node.buildingId)) {
        node.buildingId = null
      }
    }
    for (const player of world.players) {
      player.mineCount = world.buildings.filter(
        (building) => building.player === player.id && building.nodeId !== null,
      ).length
      player.barracksCount = world.buildings.filter(
        (building) =>
          building.player === player.id &&
          building.nodeId === null &&
          (world.defs.buildings[building.defId]?.produces.length ?? 0) > 0,
      ).length
    }
  }
}

/**
 * 跑一個 tick 的戰鬥（在移動之後、下一 tick 的經濟之前，見 SPEC §11 順序）。
 */
export function stepCombat(world: World): void {
  for (const unit of world.units) {
    if (unit.hp <= 0) continue
    const def = world.defs.units[unit.defId]
    if (def === undefined) throw new Error(`未知單位定義：${unit.defId}`)

    unit.attackAcc += def.stats.attackSpeed / TICK_RATE_HZ
    if (unit.attackAcc < 1) continue

    const rangeFixed = Math.round(def.stats.range * UNITS_PER_TILE)
    const target = explicitTargetInRange(world, unit, rangeFixed) ?? acquireTarget(world, unit, rangeFixed)

    if (target === null) {
      // 射程內沒有目標：冷卻封頂在 1，開火當刻立即生效（SPEC §2.2）。
      unit.attackAcc = Math.min(unit.attackAcc, 1)
      continue
    }

    unit.attackAcc -= 1
    if (target.kind === 'unit') {
      const victim = world.units.find((candidate) => candidate.id === target.unit.id)
      if (victim !== undefined) victim.hp = Math.max(0, victim.hp - def.stats.dmg)
    } else {
      damageBuilding(world, target.building.id, def.stats.dmg)
    }
  }

  removeDead(world)
}
