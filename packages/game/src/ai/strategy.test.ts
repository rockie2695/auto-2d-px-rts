import { describe, expect, it } from 'vitest'

import type { UnitDef } from '@auto-2d-px-rts/shared'

import { DEFAULT_POLICIES, resolvePolicies } from './policy.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './strategy.ts'
import type { StrategicAction } from './strategy.ts'
import {
  createTestWorld,
  makeBuildingDef,
  makeUnitDef,
  putUnit,
} from '../sim/testFixtures.ts'
import { addBuilding } from '../sim/economy.ts'
import type { TestWorldOptions } from '../sim/testFixtures.ts'
import type { PolicyValues } from './policy.ts'
import type { PlayerId, World } from '../sim/types.ts'

/**
 * AI 戰略層測試（Prompt 6 驗收）：
 * - econMilitary=0 → 主要蓋軍事建築
 * - econMilitary=1 → 主要蓋經濟建築
 * - unitSize=1 → 主要生小型單位
 * - unitRange=1 → 主要生遠程單位
 *
 * 策略層只「下單」（placeBuilding / queueTrain），不推進世界；
 * 因此單位數量以「已排程佇列 + 已出生」計算（生產決策的直接產出）。
 */

/** 跑 n 次戰略循環，攤平所有動作。 */
function runCycles(
  world: World,
  playerId: PlayerId,
  policies: PolicyValues,
  n: number,
): StrategicAction[] {
  const actions: StrategicAction[] = []
  for (let cycle = 0; cycle < n; cycle++) {
    actions.push(...runStrategicCycle(world, playerId, policies))
  }
  return actions
}

function countBuildings(world: World, playerId: PlayerId, defId: string): number {
  return world.buildings.filter((b) => b.player === playerId && b.defId === defId).length
}

/** 某單位的「已出生 + 已排程」數量（策略層決策的可觀測產出）。 */
function countUnits(world: World, playerId: PlayerId, defId: string): number {
  const alive = world.units.filter(
    (u) => u.player === playerId && u.defId === defId && u.hp > 0,
  ).length
  let queued = 0
  for (const building of world.buildings) {
    if (building.player !== playerId) continue
    queued += building.queue.filter((job) => job.defId === defId).length
  }
  return alive + queued
}

/** 建築測試世界：3 節點 + mine(150) + barracks(200, produces 'u')。 */
function buildingWorld(startCrystal = 2000): World {
  return createTestWorld({
    size: 12,
    resourceNodes: [
      { x: 2, y: 2 },
      { x: 6, y: 6 },
      { x: 9, y: 3 },
    ],
    units: [makeUnitDef({ id: 'u', cost: { blue_crystal: 50 } })],
    buildings: [
      makeBuildingDef({
        id: 'mine',
        cost: { blue_crystal: 150 },
        requiresResourceNode: true,
        incomePerSec: { blue_crystal: 1 },
      }),
      makeBuildingDef({ id: 'barracks', size: [2, 2], cost: { blue_crystal: 200 }, produces: ['u'] }),
    ],
    startCrystal,
  })
}

describe('econMilitary 滑桿 → 建築選擇', () => {
  it('econMilitary=0：主要蓋軍事建築（礦場僅強制的 1 座）', () => {
    const world = buildingWorld()
    runCycles(world, 'player', resolvePolicies({ econMilitary: 0 }), 10)

    // 強制下限：一礦都沒有時補 1 礦（SPEC §8.1）；其餘全投兵營（上限 3）。
    expect(countBuildings(world, 'player', 'mine')).toBe(1)
    expect(countBuildings(world, 'player', 'barracks')).toBe(3)
    expect(countBuildings(world, 'player', 'barracks')).toBeGreaterThan(
      countBuildings(world, 'player', 'mine'),
    )
  })

  it('econMilitary=1：主要蓋經濟建築（3 礦滿產才停，不蓋兵營）', () => {
    const world = buildingWorld()
    const actions = runCycles(world, 'player', resolvePolicies({ econMilitary: 1 }), 6)

    expect(countBuildings(world, 'player', 'mine')).toBe(3)
    expect(countBuildings(world, 'player', 'barracks')).toBe(0)
    // 前 3 個建築動作全是礦場。
    const builds = actions.filter((action) => action.kind === 'build')
    expect(builds).toHaveLength(3)
    expect(builds.every((action) => action.kind === 'build' && action.defId === 'mine')).toBe(true)
  })

  it('econMilitary=0.5：經濟與軍事交替興建', () => {
    const world = buildingWorld()
    runCycles(world, 'player', DEFAULT_POLICIES, 6)

    expect(countBuildings(world, 'player', 'mine')).toBeGreaterThanOrEqual(1)
    expect(countBuildings(world, 'player', 'barracks')).toBeGreaterThanOrEqual(1)
  })

  it('無空閒資源點時不硬蓋礦場（候選直接剔除，轉投軍事）', () => {
    const world = createTestWorld({
      size: 12,
      resourceNodes: [], // 無節點 → mine 候選不可行
      units: [makeUnitDef({ id: 'u', cost: { blue_crystal: 50 } })],
      buildings: [
        makeBuildingDef({ id: 'mine', cost: { blue_crystal: 150 }, requiresResourceNode: true }),
        makeBuildingDef({ id: 'barracks', size: [2, 2], cost: { blue_crystal: 200 }, produces: ['u'] }),
      ],
      startCrystal: 2000,
    })
    runCycles(world, 'player', DEFAULT_POLICIES, 4)

    expect(countBuildings(world, 'player', 'mine')).toBe(0)
    expect(countBuildings(world, 'player', 'barracks')).toBeGreaterThan(0)
  })
})

/** 生產測試世界：預先蓋好 3 座兵營（built），只驗生產軌。 */
function productionWorld(units: UnitDef[], counterMatrix?: TestWorldOptions['counterMatrix']): World {
  const world = createTestWorld({
    size: 12,
    units,
    buildings: [
      makeBuildingDef({
        id: 'rax',
        size: [2, 2],
        cost: { blue_crystal: 0 },
        produces: units.map((unit) => unit.id),
      }),
    ],
    startCrystal: 5000,
    counterMatrix,
  })
  // 兵營已就緒；palette 只有 rax 且已飽和（3/3）→ 建築軌不會動作。
  addBuilding(world, 'player', 'rax', { x: 4, y: 4 }, { built: true, nodeId: null })
  addBuilding(world, 'player', 'rax', { x: 7, y: 4 }, { built: true, nodeId: null })
  addBuilding(world, 'player', 'rax', { x: 4, y: 7 }, { built: true, nodeId: null })
  return world
}

/** 同費用同射程、只有 tier 不同的三單位。 */
function tierUnits(): UnitDef[] {
  return [
    makeUnitDef({ id: 's', tier: 'small' }),
    makeUnitDef({ id: 'm', tier: 'medium' }),
    makeUnitDef({ id: 'l', tier: 'large' }),
  ]
}

describe('unitSize 滑桿 → tier 選擇', () => {
  it('unitSize=1：主要生小型單位', () => {
    const world = productionWorld(tierUnits())
    runCycles(world, 'player', resolvePolicies({ unitSize: 1 }), 10)

    expect(countUnits(world, 'player', 's')).toBeGreaterThan(countUnits(world, 'player', 'm'))
    expect(countUnits(world, 'player', 's')).toBeGreaterThan(countUnits(world, 'player', 'l'))
  })

  it('unitSize=0：主要生大型單位', () => {
    const world = productionWorld(tierUnits())
    runCycles(world, 'player', resolvePolicies({ unitSize: 0 }), 10)

    expect(countUnits(world, 'player', 'l')).toBeGreaterThan(countUnits(world, 'player', 'm'))
    expect(countUnits(world, 'player', 'l')).toBeGreaterThan(countUnits(world, 'player', 's'))
  })
})

/** 同費用同 tier、只有射程不同的兩單位。 */
function rangeUnits(): UnitDef[] {
  return [
    makeUnitDef({ id: 'meleeU', role: 'melee', stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 1 } }),
    makeUnitDef({ id: 'rangedU', role: 'ranged', stats: { hp: 100, dmg: 10, range: 3.0, attackSpeed: 1, moveSpeed: 1 } }),
  ]
}

describe('unitRange 滑桿 → 射程選擇', () => {
  it('unitRange=1：主要生遠程單位', () => {
    const world = productionWorld(rangeUnits())
    runCycles(world, 'player', resolvePolicies({ unitRange: 1 }), 10)

    expect(countUnits(world, 'player', 'rangedU')).toBeGreaterThan(
      countUnits(world, 'player', 'meleeU'),
    )
  })

  it('unitRange=0：主要生近戰單位', () => {
    const world = productionWorld(rangeUnits())
    runCycles(world, 'player', resolvePolicies({ unitRange: 0 }), 10)

    expect(countUnits(world, 'player', 'meleeU')).toBeGreaterThan(
      countUnits(world, 'player', 'rangedU'),
    )
  })
})

describe('克制與稀缺性', () => {
  it('counterMatrix：敵方全近戰時，ranged→melee 高權重使遠程單位勝出', () => {
    const world = productionWorld(
      rangeUnits(),
      { melee: { melee: 1.0, ranged: 1.0 }, ranged: { melee: 2.0, ranged: 1.0 } },
    )
    // 敵方 4 個近戰（放遠方，不接戰）。
    for (let index = 0; index < 4; index++) putUnit(world, 'enemy', 'meleeU', { x: 11, y: index })

    // 兩單位同 tier 同射程（0.8 → 正規化 0.5）→ 只剩克制分差決勝。
    runCycles(world, 'player', resolvePolicies({ unitRange: 0.5 }), 8)

    expect(countUnits(world, 'player', 'rangedU')).toBeGreaterThan(
      countUnits(world, 'player', 'meleeU'),
    )
  })

  it('同分候選：稀缺性懲罰使生產自然均攤', () => {
    const twin = (id: string): UnitDef => makeUnitDef({ id })
    const world = productionWorld([twin('a'), twin('b')])
    runCycles(world, 'player', DEFAULT_POLICIES, 10)

    // 完全同分 → 交替生產 5/5。
    expect(countUnits(world, 'player', 'a')).toBe(5)
    expect(countUnits(world, 'player', 'b')).toBe(5)
  })
})

describe('決策節奏與確定性（規則 8）', () => {
  it('戰略間隔為 40 tick（2 秒）', () => {
    expect(STRATEGIC_INTERVAL_TICKS).toBe(40)
  })

  it('相同世界 + 相同滑桿 → 相同決策序列', () => {
    const actionsOf = (): string => {
      const world = buildingWorld()
      return JSON.stringify(runCycles(world, 'player', DEFAULT_POLICIES, 8))
    }
    expect(actionsOf()).toBe(actionsOf())
  })

  it('滑桿不同 → 決策序列不同', () => {
    const worldA = buildingWorld()
    const worldB = buildingWorld()
    const a = JSON.stringify(runCycles(worldA, 'player', resolvePolicies({ econMilitary: 0 }), 5))
    const b = JSON.stringify(runCycles(worldB, 'player', resolvePolicies({ econMilitary: 1 }), 5))
    expect(a).not.toBe(b)
  })
})
