import { describe, expect, it } from 'vitest'

import type { World } from './types.ts'
import { addBuilding } from './economy.ts'
import { createTestWorld, makeBuildingDef, makeUnitDef, putUnit } from './testFixtures.ts'
import { stepWorld } from './world.ts'

/**
 * 塔的防禦攻擊（Prompt 10.16）：**只有帶 `defense` 且已完工的建築**攻擊、
 * **只打單位**；keep/barracks 等被動建築永遠不攻擊。全程不呼叫 AI。
 */

const RAID = makeUnitDef({
  id: 'raider',
  role: 'melee',
  stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1.0, moveSpeed: 1.0 },
})

const TOWER = makeBuildingDef({
  id: 'tower',
  hp: 700,
  buildTimeSec: 1,
  defense: { dmg: 10, range: 4.0, attackSpeed: 0.5 },
})

const KEEP = makeBuildingDef({ id: 'keep', hp: 1000 })

/** 推進 n tick。 */
function stepN(world: World, n: number): void {
  for (let i = 0; i < n; i++) stepWorld(world)
}

describe('塔的防禦攻擊（不呼叫任何 AI）', () => {
  it('完工的塔：射程內敵單位掉血；自動接戰不寫顯式 targetId（與單位語義一致）', () => {
    const world = createTestWorld({ units: [RAID], buildings: [TOWER], seed: 42 })
    const tower = addBuilding(world, 'player', 'tower', { x: 5, y: 5 }, { built: true, nodeId: null })
    const raiderId = putUnit(world, 'enemy', 'raider', { x: 8, y: 6 }) // 外框距 150 ≤ 400

    stepN(world, 40) // attackSpeed 0.5 → 40 tick 至少一輪

    const victim = world.units.find((unit) => unit.id === raiderId)
    expect(victim?.hp ?? 0).toBeLessThan(100)
    expect(tower.targetId).toBeNull()
  })

  it('未完工的塔不攻擊', () => {
    const world = createTestWorld({ units: [RAID], buildings: [TOWER], seed: 42 })
    addBuilding(world, 'player', 'tower', { x: 5, y: 5 }, { built: false, nodeId: null })
    const raiderId = putUnit(world, 'enemy', 'raider', { x: 8, y: 6 })

    stepN(world, 15) // buildTimeSec 1 = 20 tick：觀察窗在完工之前

    const victim = world.units.find((unit) => unit.id === raiderId)
    expect(victim?.hp ?? 100).toBe(100)
  })

  it('無 defense 的建築（keep）永遠不攻擊', () => {
    const world = createTestWorld({ units: [RAID], buildings: [KEEP], seed: 42 })
    const keep = addBuilding(world, 'player', 'keep', { x: 5, y: 5 }, { built: true, nodeId: null })
    const raiderId = putUnit(world, 'enemy', 'raider', { x: 6, y: 5 }) // 貼著 keep 外框

    stepN(world, 60)

    const victim = world.units.find((unit) => unit.id === raiderId)
    expect(victim?.hp ?? 100).toBe(100)
    expect(keep.targetId).toBeNull()
    expect(keep.attackAcc).toBe(0)
  })

  it('射程外目標不攻擊；塔不會打建築（只打單位）', () => {
    const world = createTestWorld({ units: [RAID], buildings: [TOWER, KEEP], seed: 42 })
    const tower = addBuilding(world, 'player', 'tower', { x: 5, y: 5 }, { built: true, nodeId: null })
    const enemyKeep = addBuilding(world, 'enemy', 'keep', { x: 8, y: 5 }, { built: true, nodeId: null })
    putUnit(world, 'enemy', 'raider', { x: 12, y: 12 }) // 距塔約 7 格 > 4 格射程

    stepN(world, 60)

    expect(enemyKeep.damageTaken).toBe(0)
    expect(world.units.every((unit) => unit.hp === 100)).toBe(true)
    expect(tower.targetId).toBeNull()
  })
})
