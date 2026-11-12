import { TICK_RATE_HZ } from '@auto-2d-px-rts/shared'
import type { UnitDef } from '@auto-2d-px-rts/shared'

import { queryNear } from './spatialHash.ts'
import { buildingEffectiveMaxHp, isConstructed, UNITS_PER_TILE } from './types.ts'
import type { Building, CombatTarget, Unit, World } from './types.ts'

/**
 * 自動接戰（SPEC §10）：每個 tick 對每個單位嘗試攻擊一次。
 *
 * - 攻擊冷卻用累積器：`acc += attackSpeed / TICK_RATE_HZ`，
 *   `acc ≥ 1` 才實際攻擊一次並 `acc -= 1`（SPEC §2.2）。
 * - 射程判定用**固定點平方距離**（避免開方、跨平台一致）。
 * - 目標選擇：顯式 `targetId` 優先；否則「射程內最近的敵人單位，
 *   平手取 id 較小者；射程內無單位時才打最近的敵方建築」。
 * - 未完工建築可被打，承受傷害照算（SPEC §5）。
 * - 裝甲（階段三 Prompt 3.1）：單位受害者傷害 ×（1 − armor）、最少 1 點
 *   （地板保證任何攻勢都能磨死高防目標）；**建築受害者不套**（建築無 armor）。
 */

/** 單位定義的有效 HP（Prompt 3.1）：`hp / (1 − armor)`——裝甲把傷害攤薄的等價總量。 */
export function effectiveHp(def: Pick<UnitDef, 'stats'>): number {
  return def.stats.hp / (1 - def.stats.armor)
}

/** 套用防禦者裝甲的實際傷害：`max(1, round(dmg × (1 − armor)))`（最少 1 點地板）。 */
export function applyArmor(defender: Pick<UnitDef, 'stats'>, baseDamage: number): number {
  return Math.max(1, Math.round(baseDamage * (1 - defender.stats.armor)))
}

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

/** 單位固定點座標到建築外框的平方距離（點在框內為 0）。
 *  第一參數只需 `{x, y}`（Prompt 10.24 D：戰術層以小隊重心 px 查塔火覆蓋）。 */
export function distanceSquaredToBuilding(
  unit: { x: number; y: number },
  building: { x: number; y: number; w: number; h: number },
): number {
  // 距離以佔地格外框**邊緣**計算：把單位固定點座標 clamp 到建築矩形
  // `[x*200, (x+w)*200) × [y*200, (y+h)*200)` 上取實測平方距離。
  // （舊版以佔地格中心近似：相鄰 1×1 建築中心距 = 250² 固定，近戰射程
  //   0.8×200 = 160 永遠打不到、站外緣原地空轉；貼邊量測後相鄰距離 = 100。）
  const x0 = building.x * UNITS_PER_TILE
  const y0 = building.y * UNITS_PER_TILE
  const x1 = (building.x + building.w) * UNITS_PER_TILE
  const y1 = (building.y + building.h) * UNITS_PER_TILE
  const closestX = Math.min(Math.max(unit.x, x0), x1)
  const closestY = Math.min(Math.max(unit.y, y0), y1)
  const dx = unit.x - closestX
  const dy = unit.y - closestY
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

/** 單位本 tick 的實際攻擊目標（顯式射程內優先，否則自動接戰）——stepCombat 與
 *  渲染層 `computeEngageLines` 共用同一解析，接戰線與實際傷害結構上不可能漂移。 */
function resolveUnitTarget(world: World, unit: Unit, rangeFixed: number): CombatTarget | null {
  return explicitTargetInRange(world, unit, rangeFixed) ?? acquireTarget(world, unit, rangeFixed)
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

/**
 * 塔的防禦攻擊（Prompt 10.16，邊注在 §2.2）：**僅帶 `def.defense` 且已完工**
 * 的建築攻擊，且**只打單位**（不打建築——其他建築永遠不攻擊）。
 * 目標：顯式 `targetId`（敵方存活單位）優先，需在 `defense.range` 內；
 * 否則射程內最近敵方單位（平手取 id 較小者）。
 * 射程量測與 §2.2 同：單位固定點座標到建築**佔地外框**的距離。
 */
function acquireBuildingTarget(world: World, building: Building, rangeFixed: number): Unit | null {
  const explicit =
    building.targetId === null
      ? null
      : (world.units.find(
          (candidate) =>
            candidate.id === building.targetId &&
            candidate.player !== building.player &&
            candidate.hp > 0,
        ) ?? null)
  if (explicit !== null) {
    return distanceSquaredToBuilding(explicit, building) <= rangeFixed * rangeFixed ? explicit : null
  }

  let best: Unit | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of world.units) {
    if (candidate.player === building.player || candidate.hp <= 0) continue
    const distance = distanceSquaredToBuilding(candidate, building)
    if (distance <= rangeFixed * rangeFixed && distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
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
    // 塔的防禦目標（Prompt 10.16）同樣指向單位 id：目標陣亡即回到自動接戰。
    for (const building of world.buildings) {
      if (building.targetId !== null && deadUnitIds.has(building.targetId)) building.targetId = null
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
 * 跑一個 tick 的戰鬥（在移動之後、下一 tick 的經濟之前，見 SPEC §2.3 順序）。
 *
 * **同時結算（Prompt 10.9）**：先以 tick 開始時的狀態收集本 tick 所有攻擊
 * （攻擊者 → 目標 → 傷害），最後統一結算——消除 unit id 順序帶來的先手優勢
 * （藍方 id 較小、每 tick 先開火的結構性偏誤；被擊殺的單位在死亡 tick 仍能還手）。
 */
export function stepCombat(world: World): void {
  const pending: Array<{ attackerId: number; targetUnitId: number | null; targetBuildingId: number | null; dmg: number }> = []
  const surrenderedPlayer = world.surrender?.player ?? null
  for (const unit of world.units) {
    if (unit.hp <= 0) continue
    // AI 投降（Prompt 8.6）：投降方單位不再開火（仍可被打）。
    if (unit.player === surrenderedPlayer) continue
    const def = world.defs.units[unit.defId]
    if (def === undefined) throw new Error(`未知單位定義：${unit.defId}`)

    unit.attackAcc += def.stats.attackSpeed / TICK_RATE_HZ
    if (unit.attackAcc < 1) continue

    const rangeFixed = Math.round(def.stats.range * UNITS_PER_TILE)
    const target = resolveUnitTarget(world, unit, rangeFixed)

    if (target === null) {
      // 射程內沒有目標：冷卻封頂在 1，開火當刻立即生效（SPEC §2.2）。
      unit.attackAcc = Math.min(unit.attackAcc, 1)
      continue
    }

    unit.attackAcc -= 1
    // 出手即交戰（脫戰回血計時重置；Prompt 10.8）。
    unit.lastCombatTick = world.tick
    if (target.kind === 'unit') {
      pending.push({ attackerId: unit.id, targetUnitId: target.unit.id, targetBuildingId: null, dmg: def.stats.dmg })
    } else {
      pending.push({ attackerId: unit.id, targetUnitId: null, targetBuildingId: target.building.id, dmg: def.stats.dmg })
    }
  }

  // 塔的防禦攻擊（Prompt 10.16）：同一批 pending（建築與單位同時結算，
  // 建築攻擊也受「被擊殺者死亡當 tick 仍能還手」的公平性保護涵蓋）。
  for (const building of world.buildings) {
    if (building.hp <= 0 || !isConstructed(building)) continue
    // AI 投降（Prompt 8.6）：投降方建築（含塔）停火。
    if (building.player === surrenderedPlayer) continue
    const def = world.defs.buildings[building.defId]
    const defense = def?.defense
    if (def === undefined || defense === undefined) continue

    building.attackAcc += defense.attackSpeed / TICK_RATE_HZ
    if (building.attackAcc < 1) continue

    const rangeFixed = Math.round(defense.range * UNITS_PER_TILE)
    const target = acquireBuildingTarget(world, building, rangeFixed)
    if (target === null) {
      // 無目標：冷卻封頂在 1（開火當刻立即生效，與單位語義一致）。
      building.attackAcc = Math.min(building.attackAcc, 1)
      continue
    }
    building.attackAcc -= 1
    pending.push({ attackerId: building.id, targetUnitId: target.id, targetBuildingId: null, dmg: defense.dmg })
  }

  for (const attack of pending) {
    if (attack.targetUnitId !== null) {
      const victim = world.units.find((candidate) => candidate.id === attack.targetUnitId)
      if (victim === undefined) continue
      // 裝甲（Prompt 3.1）：單位受害者套防禦方裝甲；建築受害者不套。
      const victimDef = world.defs.units[victim.defId]
      if (victimDef === undefined) throw new Error(`未知單位定義：${victim.defId}`)
      victim.hp = Math.max(0, victim.hp - applyArmor(victimDef, attack.dmg))
      // 受傷也是交戰（被打的單位同樣不回血）。
      victim.lastCombatTick = world.tick
    } else if (attack.targetBuildingId !== null) {
      damageBuilding(world, attack.targetBuildingId, attack.dmg)
    }
  }

  removeDead(world)
}

/* ------------------------------------------------------------------ */
/* 接戰線資料（Prompt 9.5c：渲染層用，與實際攻擊計算同一解析）           */
/* ------------------------------------------------------------------ */

/** 一條接戰線的受害者端點（固定點座標＋目標 id）。 */
export interface EngageEndpoint {
  /** 單位受害者 = 中心；建築受害者 = 佔地外框最近點。 */
  x: number
  y: number
  targetUnitId: number | null
  targetBuildingId: number | null
}

/** 本 tick 的接戰線資料（攻擊者 → 實際會被打到的受害者）。 */
export interface EngageLines {
  /** 單位攻擊者（key = 攻擊者單位 id）。 */
  units: Map<number, EngageEndpoint>
  /** 塔攻擊者（key = 塔建築 id；受害者恆為單位）。 */
  towers: Map<number, EngageEndpoint>
}

/**
 * 本 tick 的接戰線資料（Prompt 9.5c）：對每個存活單位／塔用**與 `stepCombat`
 * 完全相同**的目標解析（`resolveUnitTarget`／`acquireBuildingTarget`）現算
 * 「現在開火會打到誰」——無論冷卻是否到（接戰線語義是持續交戰，不只開火瞬間）。
 *
 * - 渲染層 250ms 快照近似的受害者**不含射程檢查**（追擊中把線畫到射程外目標）
 *   ——本函式與 sim 同碼，結構上不可能漂移。
 * - session onTick 每 tick 呼叫並推入場景（20Hz），線的延遲從 250ms → ≤50ms。
 * - 純函式、零 sim 狀態污染（不寫 world；空間哈希由 stepWorld 戰鬥前重建，
 *   此時仍新鮮）。投降方單位不開火 → 不畫（與 stepCombat 同門檻）。
 */
export function computeEngageLines(world: World): EngageLines {
  const units = new Map<number, EngageEndpoint>()
  const towers = new Map<number, EngageEndpoint>()
  const surrenderedPlayer = world.surrender?.player ?? null

  for (const unit of world.units) {
    if (unit.hp <= 0 || unit.player === surrenderedPlayer) continue
    const def = world.defs.units[unit.defId]
    if (def === undefined) continue
    const rangeFixed = Math.round(def.stats.range * UNITS_PER_TILE)
    const target = resolveUnitTarget(world, unit, rangeFixed)
    if (target === null) continue
    if (target.kind === 'unit') {
      units.set(unit.id, {
        x: target.unit.x,
        y: target.unit.y,
        targetUnitId: target.unit.id,
        targetBuildingId: null,
      })
    } else {
      const point = closestBuildingPointFixed(unit, target.building)
      units.set(unit.id, {
        x: point.x,
        y: point.y,
        targetUnitId: null,
        targetBuildingId: target.building.id,
      })
    }
  }

  for (const building of world.buildings) {
    if (building.hp <= 0 || !isConstructed(building) || building.player === surrenderedPlayer) {
      continue
    }
    const def = world.defs.buildings[building.defId]
    const defense = def?.defense
    if (def === undefined || defense === undefined) continue
    const rangeFixed = Math.round(defense.range * UNITS_PER_TILE)
    const victim = acquireBuildingTarget(world, building, rangeFixed)
    if (victim === null) continue
    towers.set(building.id, {
      x: victim.x,
      y: victim.y,
      targetUnitId: victim.id,
      targetBuildingId: null,
    })
  }

  return { units, towers }
}

/** 建築佔地外框上離單位最近的點（固定點；點在框內回傳自身）。 */
function closestBuildingPointFixed(
  unit: { x: number; y: number },
  building: Building,
): { x: number; y: number } {
  const x0 = building.x * UNITS_PER_TILE
  const y0 = building.y * UNITS_PER_TILE
  const x1 = (building.x + building.w) * UNITS_PER_TILE
  const y1 = (building.y + building.h) * UNITS_PER_TILE
  return {
    x: Math.min(Math.max(unit.x, x0), x1),
    y: Math.min(Math.max(unit.y, y0), y1),
  }
}
