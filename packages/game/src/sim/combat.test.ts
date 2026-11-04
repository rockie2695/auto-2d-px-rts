import { describe, expect, it } from 'vitest'

import type { World } from './types.ts'
import { addBuilding } from './economy.ts'
import { setAttackTarget } from './combat.ts'
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
