import { describe, expect, it } from 'vitest'

import { assignMissions, computeTacticalPlan } from './tactics.ts'
import { DEFAULT_POLICIES, resolvePolicies } from './policy.ts'
import type { PolicyValues } from './policy.ts'
import { effectivePolicies } from './tempo.ts'
import { runStrategicCycle } from './strategy.ts'
import { addBuilding } from '../sim/economy.ts'
import {
  createTestWorld,
  makeBuildingDef,
  makeUnitDef,
  putUnit,
} from '../sim/testFixtures.ts'
import type { World } from '../sim/types.ts'

/**
 * 全滑桿生效回歸（階段三 Prompt 6 驗收 #2 的永久化）：12+1 維度逐一驗證
 * 「0 vs 1（或關鍵兩檔）產生**可觀測的不同對局產出**」——防止未來重構把某個
 * 維度靜默斷線（例如 tempo 值漏傳：曾實測 waveRatioMilli 用了用戶原值而非
 * 生效值）。每個維度一個 it，觀測點選該維度的**主作用點**。
 */

const UNIT = makeUnitDef({ id: 'u' })
const KEEP = makeBuildingDef({ id: 'keep', size: [3, 3], ai: { value: 1000 } })
const RAX = makeBuildingDef({ id: 'barracks', size: [2, 2], cost: { blue_crystal: 200 }, produces: ['small', 'large', 'sniper'] })
const CRYSTAL_MINE = makeBuildingDef({ id: 'crystal_mine', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { blue_crystal: 1.0 } })

/** 三單位 roster：small/large（tier 維度）、sniper（range 維度），同價。 */
function rosterDefs() {
  return [
    makeUnitDef({ id: 'small', tier: 'small', role: 'melee' }),
    makeUnitDef({ id: 'large', tier: 'large', role: 'melee' }),
    makeUnitDef({ id: 'sniper', tier: 'small', role: 'ranged', stats: { hp: 60, dmg: 8, range: 3.0, attackSpeed: 1.0, moveSpeed: 2.0 } }),
  ]
}

/** keep 放後場（遠離前場節點行 y=2）、兵營緊鄰；附 3 藍節點供 econMilitary 維度。 */
function trainWorld(startCrystal: number, units = rosterDefs()): World {
  const world = createTestWorld({
    size: 32,
    units,
    buildings: [KEEP, RAX, CRYSTAL_MINE],
    resourceNodes: [
      { x: 8, y: 20 },
      { x: 10, y: 20 },
      { x: 12, y: 20 },
    ],
    startCrystal,
    mineCap: 5,
  })
  addBuilding(world, 'player', 'keep', { x: 2, y: 28 }, { built: true, nodeId: null })
  addBuilding(world, 'player', 'barracks', { x: 6, y: 28 }, { built: true, nodeId: null })
  return world
}

/** 跑 n 次戰略循環，回傳 train 動作的 defId 序列。 */
function trainedIds(world: World, policies: PolicyValues, n: number): string[] {
  const ids: string[] = []
  for (let cycle = 0; cycle < n; cycle++) {
    for (const action of runStrategicCycle(world, 'player', policies).actions) {
      if (action.kind === 'train') ids.push(action.defId)
    }
  }
  return ids
}

describe('全滑桿生效回歸（Prompt 6 驗收 #2：12+1 維度逐一可觀測）', () => {
  it('econMilitary：1 → 補礦場；0 → 補兵營（建築軌方向相反）', () => {
    const run = (econMilitary: number): { mines: number; rax: number } => {
      const world = trainWorld(3000)
      for (let cycle = 0; cycle < 6; cycle++) {
        runStrategicCycle(world, 'player', resolvePolicies({ econMilitary, reserve: 0.5 }))
      }
      return {
        mines: world.buildings.filter((b) => b.player === 'player' && b.nodeId !== null).length,
        rax: world.buildings.filter((b) => b.player === 'player' && b.defId === 'barracks').length,
      }
    }
    const econ = run(1)
    const military = run(0)
    expect(econ.mines).toBeGreaterThan(military.mines)
    expect(military.rax).toBeGreaterThan(econ.rax)
  })

  it('unitSize：1 → 先生 small；0 → 先生 large', () => {
    const smallFirst = trainedIds(trainWorld(1000), resolvePolicies({ unitSize: 1 }), 1)
    const largeFirst = trainedIds(trainWorld(1000), resolvePolicies({ unitSize: 0 }), 1)
    expect(smallFirst[0]).toBe('small')
    expect(largeFirst[0]).toBe('large')
  })

  it('unitRange：1 → 先生 sniper（遠程）；0 → 先生 small（近戰）', () => {
    const ranged = trainedIds(trainWorld(1000), resolvePolicies({ unitRange: 1 }), 1)
    const melee = trainedIds(trainWorld(1000), resolvePolicies({ unitRange: 0 }), 1)
    expect(ranged[0]).toBe('sniper')
    expect(melee[0]).toBe('small')
  })

  it('clusterSpread：0 → 4 隊；1 → 1 隊（8 兵同世界）', () => {
    const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP] })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    for (let index = 0; index < 8; index++) {
      putUnit(world, 'player', 'u', { x: 3 + (index % 4), y: 3 + Math.floor(index / 4) })
    }
    const dispersed = computeTacticalPlan(world, 'player', resolvePolicies({ clusterSpread: 0 }))
    const massed = computeTacticalPlan(world, 'player', resolvePolicies({ clusterSpread: 1 }))
    expect(dispersed.squads.length).toBeGreaterThan(massed.squads.length)
  })

  it('aggression：1 → 全軍出擊；0 → 全隊守備', () => {
    const attack = assignMissions(4, resolvePolicies({ aggression: 1, reserve: 0.5 }))
    const defend = assignMissions(4, resolvePolicies({ aggression: 0, reserve: 0.5 }))
    expect(attack.join(',')).toBe('harass,attack,attack,attack')
    expect(defend.join(',')).toBe('defend,defend,defend,defend')
  })

  it('expansion：1 → 藍礦 1 座即解鎖紅礦；0 → 藍礦滿 3 座才解鎖', () => {
    const mineDefs = [
      makeBuildingDef({ id: 'crystal_mine', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { blue_crystal: 1.0 } }),
      makeBuildingDef({ id: 'ruby_mine', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { red_ruby: 0.5 } }),
    ]
    const mineRun = (expansion: number): { crystal: number; ruby: number } => {
      const world = createTestWorld({
        size: 32,
        resourceNodes: [
          { x: 2, y: 2 },
          { x: 4, y: 2 },
          { x: 6, y: 2 },
        ],
        typedResourceNodes: [{ x: 8, y: 2, resourceType: 'red_ruby' }],
        units: [makeUnitDef({ id: 'u' })],
        buildings: [KEEP, ...mineDefs],
        startCrystal: 20000,
        mineCap: 5,
      })
      addBuilding(world, 'player', 'keep', { x: 2, y: 28 }, { built: true, nodeId: null })
      const policies = resolvePolicies({ econMilitary: 1, expansion })
      // 3 循環：conservative 剛好補滿 3 藍礦（紅礦仍鎖）；expanded 已提前蓋紅礦。
      for (let cycle = 0; cycle < 3; cycle++) runStrategicCycle(world, 'player', policies)
      const count = (defId: string): number =>
        world.buildings.filter((b) => b.player === 'player' && b.defId === defId).length
      return { crystal: count('crystal_mine'), ruby: count('ruby_mine') }
    }
    const expanded = mineRun(1)
    const conservative = mineRun(0)
    expect(expanded.ruby).toBeGreaterThanOrEqual(1)
    expect(conservative.ruby).toBe(0)
    expect(expanded.crystal).toBeLessThan(conservative.crystal)
  })

  it('techRush：1 → 無紅礦節點也可解鎖綠礦；0 → 綠礦鎖死（需紅礦）', () => {
    const mineDefs = [
      makeBuildingDef({ id: 'crystal_mine', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { blue_crystal: 1.0 } }),
      makeBuildingDef({ id: 'emerald_sanctuary', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { green_emerald: 0.25 } }),
    ]
    // 世界**無紅礦節點**：techRush 0 → 綠礦永遠鎖（gate 要 rubyCount ≥ 1）；
    // techRush 1（≥ 0.75）→ 跳過紅礦直上綠礦。gate 差異純粹可觀測。
    const greenRun = (techRush: number): number => {
      const world = createTestWorld({
        size: 32,
        resourceNodes: [
          { x: 2, y: 2 },
          { x: 4, y: 2 },
          { x: 6, y: 2 },
        ],
        typedResourceNodes: [{ x: 10, y: 2, resourceType: 'green_emerald' }],
        units: [makeUnitDef({ id: 'u' })],
        buildings: [KEEP, ...mineDefs],
        startCrystal: 20000,
        mineCap: 5,
      })
      addBuilding(world, 'player', 'keep', { x: 2, y: 28 }, { built: true, nodeId: null })
      const policies = resolvePolicies({ econMilitary: 1, expansion: 1, techRush })
      for (let cycle = 0; cycle < 3; cycle++) runStrategicCycle(world, 'player', policies)
      return world.buildings.filter(
        (b) => b.player === 'player' && b.defId === 'emerald_sanctuary',
      ).length
    }
    expect(greenRun(1)).toBeGreaterThanOrEqual(1)
    expect(greenRun(0)).toBe(0)
  })

  it('reserve：1 → 全軍留守；0.5 → 與 aggression 編制一致（全出擊）', () => {
    const turtle = assignMissions(4, resolvePolicies({ aggression: 1, reserve: 1 }))
    const neutral = assignMissions(4, resolvePolicies({ aggression: 1, reserve: 0.5 }))
    expect(turtle.join(',')).toBe('defend,defend,defend,defend')
    expect(neutral.join(',')).toBe('harass,attack,attack,attack')
  })

  it('retreatThreshold：0/1 → 小隊撤退比 0.35/1.05（臨界劣勢行為不同）', () => {
    const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP] })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
    putUnit(world, 'player', 'u', { x: 10, y: 10 })
    putUnit(world, 'enemy', 'u', { x: 11, y: 10 })
    putUnit(world, 'enemy', 'u', { x: 10, y: 11 })
    const brave = computeTacticalPlan(
      world,
      'player',
      resolvePolicies({ aggression: 1, clusterSpread: 1, reserve: 0, retreatThreshold: 0 }),
    )
    const timid = computeTacticalPlan(
      world,
      'player',
      resolvePolicies({ aggression: 1, clusterSpread: 1, reserve: 0, retreatThreshold: 1 }),
    )
    expect(brave.squadRetreatRatio).toBeCloseTo(0.35, 10)
    expect(timid.squadRetreatRatio).toBeCloseTo(1.05, 10)
    // 臨界（威脅≈我方戰力）：timid 撤、brave 戰。
    expect(timid.squads[0]?.mission).toBe('retreat')
    expect(brave.squads[0]?.mission).not.toBe('retreat')
  })

  it('resourceBias：全偏紅 → 藍礦止步強制首座；預設 → 藍礦照常補滿', () => {
    const mineDefs = [
      makeBuildingDef({ id: 'crystal_mine', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { blue_crystal: 1.0 } }),
      makeBuildingDef({ id: 'ruby_mine', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { red_ruby: 0.5 } }),
    ]
    const mineRun = (bias: PolicyValues['resourceBias']): number => {
      const world = createTestWorld({
        size: 32,
        resourceNodes: [
          { x: 2, y: 2 },
          { x: 4, y: 2 },
          { x: 6, y: 2 },
        ],
        typedResourceNodes: [{ x: 8, y: 2, resourceType: 'red_ruby' }],
        units: [makeUnitDef({ id: 'u' })],
        buildings: [KEEP, ...mineDefs],
        startCrystal: 20000,
        mineCap: 5,
      })
      addBuilding(world, 'player', 'keep', { x: 2, y: 28 }, { built: true, nodeId: null })
      const policies = resolvePolicies({ econMilitary: 1, expansion: 1, resourceBias: bias })
      for (let cycle = 0; cycle < 4; cycle++) runStrategicCycle(world, 'player', policies)
      return world.buildings.filter((b) => b.player === 'player' && b.defId === 'crystal_mine').length
    }
    expect(mineRun({ blue: 0, red: 1, green: 0 })).toBe(1) // 強制首座後不再蓋藍
    expect(mineRun({ blue: 0.5, red: 0.5, green: 0.5 })).toBeGreaterThan(1)
  })

  it('tempoPreset：rush 在 t=0 覆蓋 aggression 1.0（standard 恆等）→ 任務編制不同', () => {
    const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP] })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
    // 敵我戰力**對等**（8 vs 8）→ 10.18 攻勢加成 = 0，才能觀察 aggression 差異。
    for (let index = 0; index < 8; index++) {
      putUnit(world, 'enemy', 'u', { x: 25 + (index % 4), y: 25 + Math.floor(index / 4) })
    }
    for (let index = 0; index < 8; index++) {
      putUnit(world, 'player', 'u', { x: 3 + (index % 4), y: 3 + Math.floor(index / 4) })
    }
    // 用戶 aggression 0.5：standard → 半數攻擊；rush（t=0 覆蓋 1.0）→ 全軍出擊。
    const standard = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0.5, clusterSpread: 0 }))
    const rush = computeTacticalPlan(
      world,
      'player',
      resolvePolicies({ aggression: 0.5, clusterSpread: 0, tempoPreset: 'rush' }),
    )
    expect(standard.squads.some((squad) => squad.mission === 'defend')).toBe(true)
    expect(rush.squads.every((squad) => squad.mission !== 'defend')).toBe(true)
    // 合成函數本身也驗證（雙保險）。
    expect(effectivePolicies(resolvePolicies({ tempoPreset: 'rush' }), 0).aggression).toBe(1.0)
    expect(DEFAULT_POLICIES.tempoPreset).toBe('standard')
  })
})
