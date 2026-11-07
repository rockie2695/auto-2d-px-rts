import { describe, expect, it } from 'vitest'

import type { World } from './types.ts'
import { addBuilding } from './economy.ts'
import { applyArmor, effectiveHp, setAttackTarget } from './combat.ts'
import { createTestWorld, makeBuildingDef, makeUnitDef, putUnit } from './testFixtures.ts'
import { stepWorld } from './world.ts'

/**
 * 自動接戰迴歸（Prompt 10.14）：射程內**必定**開火——與 AI 無關。
 *
 * 若干回合曾出現「單位站著、射程內有敵人卻像沒在打」的觀感（成因之一是渲染
 * victimOf 不畫建築受害者），這裡鎖住模擬層本身的三條硬性規則：
 * 1. 射程內有敵方**單位**、不呼叫任何 AI → 一定掉血；
 * 2. 射程內有敵方**建築** → 建築一定掉血；
 * 3. 顯式目標在射程外也不擋自動接戰 → 仍然打射程內的近旁敵人。
 */

const ARCHER = makeUnitDef({
  id: 'archer',
  role: 'ranged',
  stats: { hp: 100, dmg: 10, range: 2.0, attackSpeed: 1.0, moveSpeed: 1.0 },
})

/** 推進直到任一斷言目標受損，或到 tick 上限；回傳實際推進的 tick 數。 */
function stepUntil(world: World, limit: number, damaged: () => boolean): number {
  let ticks = 0
  while (ticks < limit) {
    stepWorld(world)
    ticks += 1
    if (damaged()) break
  }
  return ticks
}

describe('自動接戰（不呼叫任何 AI）', () => {
  it('射程內的敵方單位一定挨打', () => {
    const world = createTestWorld({ units: [ARCHER], seed: 42 })
    const blueId = putUnit(world, 'player', 'archer', { x: 5, y: 5 })
    const redId = putUnit(world, 'enemy', 'archer', { x: 5, y: 7 })
    // 相距 2 格 = 400 固定點 = 射程 2.0（含等於）。

    const ticks = stepUntil(world, 60, () => {
      const a = world.units.find((unit) => unit.id === blueId)
      const b = world.units.find((unit) => unit.id === redId)
      return a !== undefined && a.hp < 100 && b !== undefined && b.hp < 100
    })
    const a = world.units.find((unit) => unit.id === blueId)
    const b = world.units.find((unit) => unit.id === redId)
    expect(a?.hp ?? 0).toBeLessThan(100)
    expect(b?.hp ?? 0).toBeLessThan(100)
    // attackSpeed 1.0 → 首 20 tick 必開火；60 tick = 至少 2 輪，不應拖滿上限。
    expect(ticks).toBeLessThan(60)
  })

  it('射程內的敵方建築一定挨打', () => {
    const world = createTestWorld({
      units: [ARCHER],
      buildings: [makeBuildingDef({ id: 'watchpost', hp: 500 })],
      seed: 7,
    })
    // watchpost 在 (6,5)：單位站 (7,5) 時到外框距離 100 ≤ 400（射程 2.0）。
    const post = addBuilding(world, 'enemy', 'watchpost', { x: 6, y: 5 }, { built: true, nodeId: null })
    putUnit(world, 'enemy', 'archer', { x: 10, y: 10 }) // 遠處保全，確保不是閒置世界
    putUnit(world, 'player', 'archer', { x: 7, y: 5 })
    expect(post.damageTaken).toBe(0)

    const ticks = stepUntil(world, 60, () => post.damageTaken > 0)
    expect(post.damageTaken).toBeGreaterThan(0)
    expect(ticks).toBeLessThan(60)
  })

  it('顯式目標在射程外不擋自動接戰', () => {
    const world = createTestWorld({
      units: [ARCHER],
      buildings: [makeBuildingDef({ id: 'depot' })],
      seed: 7,
    })
    const depot = addBuilding(world, 'enemy', 'depot', { x: 0, y: 0 }, { built: true, nodeId: null })
    const blueId = putUnit(world, 'player', 'archer', { x: 5, y: 5 })
    const redId = putUnit(world, 'enemy', 'archer', { x: 5, y: 7 })
    // 顯式目標指向遠方 depot（射程外）。
    setAttackTarget(world, blueId, depot.id)

    let ticks = 0
    while (ticks < 60) {
      stepWorld(world)
      ticks += 1
      const victim = world.units.find((unit) => unit.id === redId)
      if (victim !== undefined && victim.hp < 100) break
    }
    const victim = world.units.find((unit) => unit.id === redId)
    expect(victim?.hp ?? 0).toBeLessThan(100)
    expect(ticks).toBeLessThan(60)
    // 顯式目標在射程外：depot 完全沒被這條鏈打過。
    expect(depot.damageTaken).toBe(0)
  })
})

describe('裝甲（Prompt 3.1：傷害 ×(1−armor)、最少 1 點；建築不套甲）', () => {
  /** dmg 10 攻擊者（armor 0、射程 2.0）。 */
  const ATTACKER = makeUnitDef({
    id: 'atk',
    stats: { hp: 100, dmg: 10, range: 2.0, attackSpeed: 1.0, moveSpeed: 1.0 },
  })

  /**
   * 推進到受害者挨第一擊，回傳該擊掉的血。
   * 受害者 hp 1000、射程 0.1 且距離 1 格 > 0.1 → 全程還不了手，掉血只來自攻擊者。
   */
  function firstHitDamage(victimArmor: number): number {
    const VICTIM = makeUnitDef({
      id: 'vic',
      stats: {
        hp: 1000,
        dmg: 1,
        range: 0.1,
        attackSpeed: 1.0,
        moveSpeed: 0.5,
        armor: victimArmor,
      },
    })
    const world = createTestWorld({ units: [ATTACKER, VICTIM], seed: 11 })
    putUnit(world, 'player', 'atk', { x: 4, y: 4 })
    putUnit(world, 'enemy', 'vic', { x: 4, y: 5 })
    const victimId = world.units.find((unit) => unit.defId === 'vic')?.id
    expect(victimId).toBeDefined()
    let ticks = 0
    while (ticks < 60) {
      stepWorld(world)
      ticks += 1
      const victim = world.units.find((unit) => unit.id === victimId)
      if (victim !== undefined && victim.hp < 1000) {
        return 1000 - victim.hp
      }
    }
    return 0
  }

  it('armor=0.5：dmg 10 → 實掉 5', () => {
    expect(firstHitDamage(0.5)).toBe(5)
  })

  it('armor=0：行為與無裝甲版完全相同（10 全額）', () => {
    expect(firstHitDamage(0)).toBe(10)
  })

  it('取整：armor 0.2、base dmg 12 → round(9.6) = 10', () => {
    const LEGION = makeUnitDef({
      id: 'legion',
      stats: { hp: 100, dmg: 1, range: 0.8, attackSpeed: 1, moveSpeed: 1, armor: 0.2 },
    })
    expect(applyArmor(LEGION, 12)).toBe(10)
  })

  it('地板：dmg 2 × armor 0.8 → max(1, round(0.4)) = 1（任何攻勢都磨得動高防目標）', () => {
    const ARMORED = makeUnitDef({
      id: 'armored',
      stats: { hp: 1000, dmg: 2, range: 2.0, attackSpeed: 1.0, moveSpeed: 1.0, armor: 0.8 },
    })
    expect(applyArmor(ARMORED, 2)).toBe(1)
  })

  it('單位打建築：建築無 armor，攻方 dmg 全額照算（攻方自身 armor 不影響出手）', () => {
    const BRUISER = makeUnitDef({
      id: 'bruiser',
      stats: { hp: 100, dmg: 10, range: 2.0, attackSpeed: 1.0, moveSpeed: 1.0, armor: 0.5 },
    })
    const world = createTestWorld({
      units: [BRUISER],
      buildings: [makeBuildingDef({ id: 'depot' })],
      seed: 13,
    })
    const depot = addBuilding(world, 'enemy', 'depot', { x: 4, y: 6 }, { built: true, nodeId: null })
    putUnit(world, 'player', 'bruiser', { x: 4, y: 4 })
    let ticks = 0
    while (ticks < 60 && depot.damageTaken < 10) {
      stepWorld(world)
      ticks += 1
    }
    expect(depot.damageTaken).toBe(10)
  })

  it('effectiveHp：hp 120 / armor 0.5 → 240', () => {
    const def = makeUnitDef({
      id: 'sg',
      stats: { hp: 120, dmg: 6, range: 0.8, attackSpeed: 1, moveSpeed: 2, armor: 0.5 },
    })
    expect(effectiveHp(def)).toBe(240)
  })
})
