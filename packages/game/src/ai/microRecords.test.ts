import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import { computeInfluenceMap } from './influence.ts'
import { computeMicroPlan, microRecords, runMicroCycle } from './micro.ts'
import type {
  MicroDecision,
  MicroRecord,
  MicroRecordState,
  MicroTopFactor,
} from './micro.ts'
import { resolvePolicies } from './policy.ts'
import type { PolicyValues } from './policy.ts'
import { computeTacticalPlan, TACTICAL_INTERVAL_TICKS } from './tactics.ts'
import type { Squad, TacticalPlan } from './tactics.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './strategy.ts'
import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import { createWorld, stepWorld } from '../sim/world.ts'
import { createTestWorld, makeUnitDef, putUnit } from '../sim/testFixtures.ts'
import type { PlayerId, TilePos, World } from '../sim/types.ts'

/**
 * 微操層決策記錄（階段三 Prompt 8.5）：只在戰鬥狀態切換時產生、防抖、
 * 觸發原因標注、同 seed 一致性與數量合理。
 */

/** 手工決策（純函式測試用；topFactor 為必填欄位）。 */
function decision(
  unitId: number,
  action: MicroDecision['action'],
  topFactor: MicroTopFactor,
): MicroDecision {
  return {
    unitId,
    action,
    squadIndex: 0,
    moveDest: null,
    attackTargetId: null,
    reason: `測試決策 ${action}`,
    topFactor,
  }
}

/** 純函式包裝：cycle（微操循環序號）→ microRecords（tick = cycle × 2）。 */
function record(
  playerId: PlayerId,
  dpi: readonly MicroDecision[],
  state: MicroRecordState,
  cycle: number,
  cooldown = 20,
): MicroRecord[] {
  return microRecords(playerId, cycle * 2, dpi, state, cycle, cooldown)
}

describe('microRecords：只在戰鬥狀態切換時記錄（純函式）', () => {
  it('首次進入戰鬥態（formation→retreat）→ 記錄；之後不變不記', () => {
    const state: MicroRecordState = new Map()
    expect(record('player', [decision(1, 'formation', 'formation')], state, 0)).toEqual([])
    const second = record('player', [decision(1, 'retreat', 'hpThreshold')], state, 1)
    expect(second).toHaveLength(1)
    expect(second[0]?.action).toBe('retreat')
    expect(second[0]?.reason.topFactor).toBe('hpThreshold')
    expect(second[0]?.layer).toBe('micro')
    expect(second[0]?.actor).toBe('player')
    expect(second[0]?.target).toBe('u1')
    // action 不變 → 無記錄（不會每微操循環一條）。
    expect(record('player', [decision(1, 'retreat', 'hpThreshold')], state, 2)).toEqual([])
  })

  it('formation↔rally 常規切換 → 零記錄（兩端皆非戰鬥態）', () => {
    const state: MicroRecordState = new Map()
    expect(record('player', [decision(1, 'formation', 'formation')], state, 0)).toEqual([])
    expect(record('player', [decision(1, 'rally', 'rally')], state, 1)).toEqual([])
    expect(record('player', [decision(1, 'formation', 'formation')], state, 2)).toEqual([])
  })

  it('防抖：戰鬥態切換但間隔 < 20 循環 → 壓制；≥ 20（以最後一次記錄為錨）→ 記錄', () => {
    const state: MicroRecordState = new Map()
    expect(record('player', [decision(1, 'attack', 'inRange')], state, 0)).toHaveLength(1) // 入場
    expect(record('player', [decision(1, 'retreat', 'hpThreshold')], state, 2)).toEqual([]) // 間隔 2 < 20
    expect(record('player', [decision(1, 'attack', 'inRange')], state, 3)).toEqual([]) // 震盪同樣被壓
    // 冷卻錨 = 入場記錄的 cycle 0（被壓切的切換不重置）→ cycle 22 有切換即記。
    const due = record('player', [decision(1, 'retreat', 'hpThreshold')], state, 22)
    expect(due).toHaveLength(1)
    expect(due[0]?.action).toBe('retreat')
    // 記錄後錨推進到 22 → 隔 19 循環的切換再被壓。
    expect(record('player', [decision(1, 'attack', 'inRange')], state, 41)).toEqual([])
  })

  it('explanation 格式（「撤退。理由：<規則原因>」）且 target 帶攻擊目標 id', () => {
    const state: MicroRecordState = new Map()
    const d: MicroDecision = {
      ...decision(7, 'retreat', 'hpCritical'),
      attackTargetId: 42,
      reason: 'hp 22% 殘血（< 20%）：一律撤回集結點',
    }
    const records = record('player', [d], state, 0)
    expect(records).toHaveLength(1)
    expect(records[0]?.target).toBe('u7←t42')
    expect(records[0]?.reason.explanation).toBe('撤退。理由：hp 22% 殘血（< 20%）：一律撤回集結點')
  })
})

/* ------------------------------------------------------------------ */
/* 受控世界：真實 computeMicroPlan → microRecords                       */
/* ------------------------------------------------------------------ */

const MELEE = makeUnitDef({
  id: 'melee',
  role: 'melee',
  stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1.0, moveSpeed: 1.0 },
  ai: { value: 100, preferredRange: 0.8, retreatHpPct: 0.2 },
})

function microWorld(): World {
  return createTestWorld({ size: 32, units: [MELEE], buildings: [] })
}

/** 手工組戰術計畫（與 micro.test 同款；無戰術記錄）。 */
function planWith(world: World, rally: TilePos, squads: Squad[]): TacticalPlan {
  return {
    tick: world.tick,
    player: 'player',
    rally,
    spawns: [],
    squads,
    disengaged: [],
    influence: computeInfluenceMap(world, 'player'),
    retreatHpFactor: 1,
    squadRetreatRatio: 0.7,
    records: [],
  }
}

function makeSquad(index: number, memberIds: number[], target: TilePos): Squad {
  return {
    index,
    mission: 'attack',
    memberIds,
    target,
    targetBuildingId: null,
    power: 100 * memberIds.length,
    centroid: target,
  }
}

describe('微操記錄與真實微操決策（受控世界）', () => {
  it('單位跌破撤退閾值 → 對應 retreat 記錄（topFactor hpCritical、explanation 含 hp）', () => {
    const world = microWorld()
    const hurtId = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    const hurt = world.units.find((unit) => unit.id === hurtId)
    if (hurt === undefined) throw new Error('找不到單位')
    hurt.hp = 8 // 8% < 20%：一律撤退

    const plan = planWith(world, { x: 2, y: 2 }, [makeSquad(0, [hurtId], { x: 20, y: 20 })])
    const decisions = computeMicroPlan(world, 'player', plan)
    expect(decisions.find((d) => d.unitId === hurtId)?.action).toBe('retreat')
    const records = microRecords('player', world.tick, decisions, new Map(), 0)
    expect(records).toHaveLength(1)
    expect(records[0]?.action).toBe('retreat')
    expect(records[0]?.reason.topFactor).toBe('hpCritical')
    expect(records[0]?.reason.explanation).toContain('撤退。理由：hp')
  })
})

/* ------------------------------------------------------------------ */
/* 真實內容整合（seed 42：戰略 40 / 戰術 10 / 微操 2 tick）             */
/* ------------------------------------------------------------------ */

interface RealRun {
  decisions: number
  records: MicroRecord[]
  factors: Set<MicroTopFactor>
  positions: string
}

/** 真實內容 + seed：跑 ticks → 決策總數、微操記錄序列、成因覆蓋、終局位置。 */
function runReal(ticks: number, seed = 42): RealRun {
  const dataDir = fileURLToPath(new URL('../../public/data/', import.meta.url))
  const content = loadContentPackFromDir(dataDir)
  const world = createWorld(content, seed)
  const policies: Record<PlayerId, PolicyValues> = {
    // reserve 0：讓微操層的推進／風箏／撤退真的發生（→有戰鬥態切換）。
    player: resolvePolicies({ reserve: 0 }),
    enemy: resolvePolicies({ reserve: 0 }),
  }
  const plans: Record<PlayerId, TacticalPlan | null> = { player: null, enemy: null }
  const states: Record<PlayerId, MicroRecordState> = {
    player: new Map(),
    enemy: new Map(),
  }
  const records: MicroRecord[] = []
  const factors = new Set<MicroTopFactor>()
  let decisions = 0
  let cycleIndex = 0

  while (world.tick < ticks) {
    stepWorld(world)
    if (world.tick % STRATEGIC_INTERVAL_TICKS === 0) {
      for (const player of world.players) runStrategicCycle(world, player.id, policies[player.id])
    }
    if (world.tick % TACTICAL_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        plans[player.id] = computeTacticalPlan(world, player.id, policies[player.id])
      }
    }
    if (world.tick % 2 === 0) {
      cycleIndex += 1
      for (const player of world.players) {
        const cycleDecisions = runMicroCycle(world, player.id, plans[player.id])
        decisions += cycleDecisions.length
        const produced = microRecords(
          player.id,
          world.tick,
          cycleDecisions,
          states[player.id],
          cycleIndex,
        )
        records.push(...produced)
        for (const r of produced) factors.add(r.reason.topFactor)
      }
    }
  }
  return {
    decisions,
    records,
    factors,
    positions: JSON.stringify(world.units.map((unit) => [unit.id, unit.x, unit.y])),
  }
}

describe('微操記錄整合（真實內容）', () => {
  it('500 tick：有記錄、數量合理（≪ 決策總數）、結構完整', () => {
    const run = runReal(500)
    expect(run.records.length).toBeGreaterThan(0)
    // 數量合理：約 40 單位 × 每 2 tick 一條決策；記錄只在切換時 → 遠小於 1/10。
    expect(run.records.length).toBeLessThan(run.decisions / 10)
    for (const r of run.records) {
      expect(r.layer).toBe('micro')
      expect(r.tick).toBeGreaterThanOrEqual(0)
      expect(r.target).toMatch(/^u\d+(←t\d+)?$/)
      expect(r.reason.explanation.length).toBeGreaterThan(0)
    }
  })

  it('同一單位相鄰記錄：動作不同，或相同動作時間隔 ≥ 40 tick（防抖硬下限）', () => {
    const run = runReal(500)
    const lastByUnit = new Map<string, MicroRecord>()
    for (const r of run.records) {
      const unitId = /^u(\d+)/.exec(r.target)?.[1] ?? ''
      const key = `${r.actor}:${unitId}`
      const before = lastByUnit.get(key)
      if (before !== undefined) {
        if (before.action === r.action) {
          // freeze 語義：被壓制的中間切換不重置錨 → 相同動作相鄰記錄間隔 ≥ 冷卻。
          expect(r.tick - before.tick).toBeGreaterThanOrEqual(40)
        }
      }
      lastByUnit.set(key, r)
    }
  })

  it('同 seed → 記錄序列完全一致（記錄不打 sim：位置也一致）', () => {
    const first = runReal(400)
    const second = runReal(400)
    expect(second.records).toEqual(first.records)
    expect(second.positions).toBe(first.positions)
  })

  it('不同 seed → 記錄序列不同（記錄反映對局過程）', () => {
    expect(runReal(300, 7).records).not.toEqual(runReal(300, 8).records)
  })

  it('成因覆蓋（seed 42 實證分布）：retreat／chaseMargin／inRange 皆出現過', () => {
    const run = runReal(1000)
    // 實證分布（1000 tick、seed 42、若改動微操邏輯會在此處亮起）：
    // chase×34 attack×14 retreat×14 formation×6; chaseMargin/inRange/
    // hpCritical/hpThreshold/underFire/formation/rally 皆有。
    const factors = run.factors
    // retreat 成因 ∈ {hpCritical, hpThreshold}（動作 retreat 的成因）。
    expect(factors.has('hpCritical') || factors.has('hpThreshold')).toBe(true)
    expect(factors.has('inRange')).toBe(true)
    expect(factors.has('chaseMargin')).toBe(true)
    expect(factors.size).toBeGreaterThanOrEqual(4)
  })
})
