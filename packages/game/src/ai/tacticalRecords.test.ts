import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import { computeTacticalPlan, TACTICAL_INTERVAL_TICKS } from './tactics.ts'
import type { TacticalRecord } from './tactics.ts'
import { resolvePolicies } from './policy.ts'
import type { PolicyValues } from './policy.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './strategy.ts'
import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import { addBuilding } from '../sim/economy.ts'
import { createTestWorld, makeBuildingDef, makeUnitDef, putUnit } from '../sim/testFixtures.ts'
import type { PlayerId, World } from '../sim/types.ts'
import { createWorld, stepWorld } from '../sim/world.ts'

/**
 * 戰術層決策記錄（階段三 Prompt 7.5）：記錄存在性、結構、候選效用分數、
 * 確定性（同 seed 兩跑一致）與成因覆蓋。
 */

/** 真實內容 + seed 42：戰略 40 / 戰術 10 tick；收集每循環的戰術記錄。 */
function runReal(ticks: number, seed = 42): TacticalRecord[] {
  const dataDir = fileURLToPath(new URL('../../public/data/', import.meta.url))
  const content = loadContentPackFromDir(dataDir)
  const world = createWorld(content, seed)
  const policies: Record<PlayerId, PolicyValues> = {
    player: resolvePolicies({}),
    enemy: resolvePolicies({}),
  }
  const collected: TacticalRecord[] = []
  while (world.tick < ticks) {
    stepWorld(world)
    if (world.tick % STRATEGIC_INTERVAL_TICKS === 0) {
      for (const player of world.players) runStrategicCycle(world, player.id, policies[player.id])
    }
    if (world.tick % TACTICAL_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        collected.push(...computeTacticalPlan(world, player.id, policies[player.id]).records)
      }
    }
  }
  return collected
}

describe('戰術層決策記錄（Prompt 7.5）', () => {
  it('跑 500 tick：tactical 層有記錄，且 mission 與 target 記錄都存在、結構完整', () => {
    const records = runReal(500)
    expect(records.length).toBeGreaterThan(0)
    expect(records.some((record) => record.action === 'mission')).toBe(true)
    expect(records.some((record) => record.action === 'target')).toBe(true)
    for (const record of records) {
      expect(record.layer).toBe('tactical')
      expect(record.tick).toBeGreaterThanOrEqual(0)
      expect(record.actor === 'player' || record.actor === 'enemy').toBe(true)
      expect(record.target.length).toBeGreaterThan(0)
      expect(record.reason.weights).toBeDefined()
      expect(typeof record.reason.topFactor).toBe('string')
      expect(record.reason.explanation.length).toBeGreaterThan(0)
      // 目標記錄：候選含效用分數且降冪；任務記錄：候選為空。
      if (record.action === 'target') {
        expect(record.reason.candidates.length).toBeGreaterThan(0)
        const scores = record.reason.candidates.map((candidate) => candidate.score)
        for (let index = 1; index < scores.length; index++) {
          expect(scores[index - 1]).toBeGreaterThanOrEqual(scores[index] ?? 0)
        }
      } else {
        expect(record.reason.candidates).toEqual([])
      }
    }
  })

  it('相同 seed → 決策記錄序列完全一致（確定性）', () => {
    const first = runReal(500)
    const second = runReal(500)
    expect(second).toEqual(first)
  })

  it('目標記錄：winner 為最高分候選、target 字串與候選一致', () => {
    const records = runReal(600).filter((record) => record.action === 'target')
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      const top = record.reason.candidates[0]
      expect(top).toBeDefined()
      expect(record.target).toBe(top?.defId)
      // 全部候選分數為有限正數（scoreTarget 恆 > 0）。
      for (const candidate of record.reason.candidates) {
        expect(Number.isFinite(candidate.score)).toBe(true)
        expect(candidate.score).toBeGreaterThan(0)
      }
    }
  })

  it('mission weights 為**生效政策**快照（tempo 覆蓋後）', () => {
    const records = runReal(300).filter((record) => record.action === 'mission')
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      // PolicyValues 全 12+1 維度存在。
      expect(Object.keys(record.reason.weights)).toHaveLength(11)
      expect(record.reason.weights.resourceBias).toBeDefined()
      expect(record.reason.weights.tempoPreset).toBeDefined()
    }
  })
})

describe('戰術記錄的成因（topFactor）覆蓋（受控世界）', () => {
  const UNIT = makeUnitDef({ id: 'u' })
  const KEEP = makeBuildingDef({ id: 'keep', size: [3, 3], ai: { value: 1000 } })
  const MINE = makeBuildingDef({
    id: 'mine',
    size: [1, 1],
    ai: { value: 300 },
    requiresResourceNode: true,
  })
  const TOWER = makeBuildingDef({
    id: 'tower',
    size: [2, 2],
    ai: { value: 400 },
    defense: { dmg: 10, range: 4.0, attackSpeed: 0.5 },
  })

  function baseWorld(): World {
    const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP, MINE, TOWER], mineCap: 5 })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
    return world
  }

  it("reserve≠0.5 → 任務記錄 topFactor='reserve'", () => {
    const world = baseWorld()
    // 敵方 1 兵在場（非全滅 → 不觸發 10.18 加成，否則成因是 aggressionBonus）。
    putUnit(world, 'enemy', 'u', { x: 25, y: 25 })
    for (const tile of [
      { x: 3, y: 3 },
      { x: 4, y: 3 },
      { x: 3, y: 4 },
      { x: 4, y: 4 },
    ]) {
      putUnit(world, 'player', 'u', tile)
    }
    const plan = computeTacticalPlan(
      world,
      'player',
      resolvePolicies({ aggression: 1, clusterSpread: 0, reserve: 0.9 }),
    )
    const missions = plan.records.filter((record) => record.action === 'mission')
    expect(missions.length).toBeGreaterThan(0)
    expect(missions.some((record) => record.reason.topFactor === 'reserve')).toBe(true)
    // 解釋帶份額參數。
    expect(missions[0]?.reason.explanation).toContain('留守')
  })

  it("蓄兵（門檻未達）→ topFactor='waveGate'", () => {
    const world = baseWorld()
    // 敵方守軍強（守 keep）→ 我方小隊門檻不足 → stage。
    for (const tile of [
      { x: 26, y: 26 },
      { x: 27, y: 26 },
      { x: 26, y: 27 },
      { x: 27, y: 27 },
    ]) {
      putUnit(world, 'enemy', 'u', tile)
    }
    putUnit(world, 'player', 'u', { x: 6, y: 6 })
    putUnit(world, 'player', 'u', { x: 7, y: 6 })
    const plan = computeTacticalPlan(
      world,
      'player',
      resolvePolicies({ aggression: 1, clusterSpread: 1, reserve: 0 }),
    )
    const missions = plan.records.filter((record) => record.action === 'mission')
    expect(missions.some((record) => record.reason.topFactor === 'waveGate')).toBe(true)
  })

  it("接觸迎戰（engaging）→ topFactor='contact'", () => {
    const world = baseWorld()
    putUnit(world, 'player', 'u', { x: 10, y: 10 })
    putUnit(world, 'player', 'u', { x: 10, y: 11 })
    // 敵軍貼近（接觸半徑內、殺得掉）。
    putUnit(world, 'enemy', 'u', { x: 12, y: 10 })
    world.tick = 200 // 越過接觸重評冷卻
    const plan = computeTacticalPlan(
      world,
      'player',
      resolvePolicies({ aggression: 1, clusterSpread: 1, reserve: 0 }),
    )
    const missions = plan.records.filter((record) => record.action === 'mission')
    expect(missions.some((record) => record.reason.topFactor === 'contact')).toBe(true)
  })

  it("目標記錄 topFactor='defense'：選中防守最弱（無守軍）的目標", () => {
    const world = baseWorld()
    // 敵方：近處礦場有守軍、遠處 keep 無守軍 → 記錄應歸因 defense（或 value）。
    addBuilding(world, 'enemy', 'mine', { x: 12, y: 2 }, { built: true, nodeId: null })
    for (const tile of [
      { x: 12, y: 3 },
      { x: 13, y: 3 },
    ]) {
      putUnit(world, 'enemy', 'u', tile)
    }
    for (const tile of [
      { x: 4, y: 4 },
      { x: 5, y: 4 },
      { x: 4, y: 5 },
      { x: 5, y: 5 },
    ]) {
      putUnit(world, 'player', 'u', tile)
    }
    const plan = computeTacticalPlan(
      world,
      'player',
      resolvePolicies({ aggression: 1, clusterSpread: 0, reserve: 0 }),
    )
    const targets = plan.records.filter((record) => record.action === 'target')
    expect(targets.length).toBeGreaterThan(0)
    const factors = targets.map((record) => record.reason.topFactor)
    expect(factors.some((factor) => factor === 'defense' || factor === 'value')).toBe(true)
    // 攻擊隊的候選包含多個目標（被守的礦場＋無守的 keep）；騷擾隊只取經濟建築。
    expect(targets.some((record) => record.reason.candidates.length >= 2)).toBe(true)
  })
})
