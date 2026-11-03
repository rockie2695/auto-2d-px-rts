import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { computeInfluenceMap } from './influence.ts'
import {
  applyMicroPlan,
  computeMicroPlan,
  CHASE_MARGIN,
  KITE_MARGIN,
  MICRO_INTERVAL_TICKS,
  MICRO_REPATH_TICKS,
  runMicroCycle,
} from './micro.ts'
import { DEFAULT_POLICIES } from './policy.ts'
import type { PolicyValues } from './policy.ts'
import { computeTacticalPlan, TACTICAL_INTERVAL_TICKS } from './tactics.ts'
import type { Squad, TacticalPlan } from './tactics.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './strategy.ts'
import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import { createWorld, orderMove, stepWorld } from '../sim/world.ts'
import { tileOf } from '../sim/types.ts'
import { createTestWorld, makeUnitDef, putUnit } from '../sim/testFixtures.ts'
import type { PlayerId, TilePos, World } from '../sim/types.ts'

/**
 * 微操層測試（Prompt 8 驗收）：
 * - 遠程面對近戰會後退保持距離（風箏，邊退邊打）
 * - 同小隊單位攻擊同一目標（集火）
 * - hp 過低會撤退（優先於接戰）
 * 另涵蓋編隊、待機、500ms 路徑重算節流、確定性與真實內容整合。
 */

const MELEE = makeUnitDef({
  id: 'melee',
  role: 'melee',
  stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1.0, moveSpeed: 1.0 },
})

/** 遠程：射程 3 格、preferredRange 3 格（風箏門檻 2.1 格）。 */
const ARCHER = makeUnitDef({
  id: 'archer',
  role: 'ranged',
  stats: { hp: 60, dmg: 8, range: 3.0, attackSpeed: 1.0, moveSpeed: 2.5 },
  ai: { value: 100, preferredRange: 3.0, retreatHpPct: 0.2 },
})

/** 遠程但幾乎不風箏（preferredRange 0.5）：集火測試用，隔離風箏行為。 */
const SIEGE = makeUnitDef({
  id: 'siege',
  role: 'ranged',
  stats: { hp: 60, dmg: 8, range: 3.0, attackSpeed: 1.0, moveSpeed: 2.5 },
  ai: { value: 100, preferredRange: 0.5, retreatHpPct: 0.2 },
})

function microWorld(): World {
  return createTestWorld({ size: 32, units: [MELEE, ARCHER, SIEGE], buildings: [] })
}

/** 手工組一個戰術計畫（微操測試精準控制小隊與集結點）。 */
function planWith(world: World, rallies: TilePos, squads: Squad[]): TacticalPlan {
  return {
    tick: world.tick,
    player: 'player',
    rally: rallies,
    squads,
    disengaged: [],
    influence: computeInfluenceMap(world, 'player'),
  }
}

function makeSquad(
  index: number,
  memberIds: number[],
  target: TilePos,
  centroid: TilePos = target,
): Squad {
  return {
    index,
    mission: 'attack',
    memberIds,
    target,
    targetBuildingId: null,
    power: 100 * memberIds.length,
    centroid,
  }
}

describe('風箏（Prompt 8）', () => {
  it('遠程面對貼身近戰 → 後退且邊退邊打（保持距離）', () => {
    const world = microWorld()
    const archerId = putUnit(world, 'player', 'archer', { x: 10, y: 10 })
    const enemyId = putUnit(world, 'enemy', 'melee', { x: 11, y: 10 }) // 距離 1 格 < 2.1 門檻
    const plan = planWith(world, { x: 2, y: 2 }, [
      makeSquad(0, [archerId], { x: 20, y: 10 }, { x: 10, y: 10 }),
    ])

    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === archerId)
    expect(decision?.action).toBe('kite')
    expect(decision?.attackTargetId).toBe(enemyId) // 邊退邊打
    const dest = decision?.moveDest
    expect(dest).not.toBeNull()
    if (dest === null || dest === undefined) throw new Error('風箏沒有後退目的地')

    // 後退後離敵更遠。
    const enemyTile = tileOf(
      world.units.find((unit) => unit.id === enemyId)?.x ?? 0,
      world.units.find((unit) => unit.id === enemyId)?.y ?? 0,
    )
    const before = Math.hypot(10 - enemyTile.x, 10 - enemyTile.y)
    const after = Math.hypot(dest.x - enemyTile.x, dest.y - enemyTile.y)
    expect(after).toBeGreaterThan(before)
  })

  it('距離在門檻外但仍在射程內 → 站樁攻擊（不後退）', () => {
    const world = microWorld()
    const archerId = putUnit(world, 'player', 'archer', { x: 10, y: 10 })
    putUnit(world, 'enemy', 'melee', { x: 13, y: 10 }) // 3 格：≥ 2.1 門檻、≤ 3.0 射程
    const plan = planWith(world, { x: 2, y: 2 }, [
      makeSquad(0, [archerId], { x: 20, y: 10 }, { x: 10, y: 10 }),
    ])

    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === archerId)
    expect(decision?.action).toBe('attack')
    expect(decision?.moveDest).toBeNull()
  })

  it('近戰不風箏（射程內直接攻擊）', () => {
    const world = microWorld()
    const meleeId = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    putUnit(world, 'enemy', 'melee', { x: 10, y: 10 }) // 同格 → 距離 0，在近戰射程內
    const plan = planWith(world, { x: 2, y: 2 }, [
      makeSquad(0, [meleeId], { x: 20, y: 10 }, { x: 10, y: 10 }),
    ])

    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === meleeId)
    expect(decision?.action).toBe('attack')
    expect(decision?.moveDest).toBeNull()
  })
})

describe('集火（Prompt 8）', () => {
  it('同小隊單位攻擊同一目標（優先打離小隊重心最近者）', () => {
    const world = microWorld()
    const p1 = putUnit(world, 'player', 'siege', { x: 5, y: 5 })
    const p2 = putUnit(world, 'player', 'siege', { x: 9, y: 5 })
    const e1 = putUnit(world, 'enemy', 'melee', { x: 6, y: 5 })
    const e2 = putUnit(world, 'enemy', 'melee', { x: 8, y: 5 })
    // 重心 (7,5)：兩敵等距 → 平手取 id 小者（e1）。
    const plan = planWith(world, { x: 2, y: 2 }, [
      makeSquad(0, [p1, p2], { x: 5, y: 5 }, { x: 7, y: 5 }),
    ])

    const decisions = computeMicroPlan(world, 'player', plan)
    const d1 = decisions.find((d) => d.unitId === p1)
    const d2 = decisions.find((d) => d.unitId === p2)
    expect(d1?.attackTargetId).toBe(e1)
    expect(d2?.attackTargetId).toBe(e1) // 即使最近的是 e2，仍跟小隊集火 e1
    expect(d1?.attackTargetId).toBe(d2?.attackTargetId)
    expect(e2).not.toBe(e1)
  })

  it('未編隊單位各自接戰（無集火目標）', () => {
    const world = microWorld()
    const p1 = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    const enemyId = putUnit(world, 'enemy', 'melee', { x: 10, y: 10 })
    const plan = planWith(world, { x: 2, y: 2 }, [])

    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === p1)
    expect(decision?.squadIndex).toBeNull()
    expect(decision?.attackTargetId).toBe(enemyId) // 自動接戰最近的敵單位
  })
})

describe('撤退（Prompt 8 / Prompt 10 邊退邊打）', () => {
  it('hp < retreatHpPct → 撤回集結點且邊退邊打（射程內敵人保持為攻擊目標）', () => {
    const world = microWorld()
    const hurtId = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    const enemyId = putUnit(world, 'enemy', 'melee', { x: 10, y: 10 }) // 敵就在射程內
    const hurt = world.units.find((unit) => unit.id === hurtId)
    if (hurt === undefined) throw new Error('找不到受傷單位')
    hurt.hp = 15 // 15% < 20%

    const rally: TilePos = { x: 2, y: 2 }
    const plan = planWith(world, rally, [makeSquad(0, [hurtId], { x: 20, y: 20 })])
    const decisions = computeMicroPlan(world, 'player', plan)
    const decision = decisions.find((d) => d.unitId === hurtId)
    expect(decision?.action).toBe('retreat')
    expect(decision?.moveDest).toEqual(rally) // 仍朝集結點後撤
    expect(decision?.attackTargetId).toBe(enemyId) // 邊退邊打
    expect(decision?.reason).toContain('邊退邊打')

    applyMicroPlan(world, decisions)
    expect(hurt.dest).toEqual(rally)
    expect(hurt.targetId).toBe(enemyId)
  })

  it('撤退途中射程內無敵人 → 純撤退（不亂認目標）', () => {
    const world = microWorld()
    const hurtId = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    putUnit(world, 'enemy', 'melee', { x: 15, y: 10 }) // 距 5 格：射程外
    const hurt = world.units.find((unit) => unit.id === hurtId)
    if (hurt === undefined) throw new Error('找不到受傷單位')
    hurt.hp = 15

    const rally: TilePos = { x: 2, y: 2 }
    const plan = planWith(world, rally, [makeSquad(0, [hurtId], { x: 20, y: 20 })])
    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === hurtId)
    expect(decision?.action).toBe('retreat')
    expect(decision?.moveDest).toEqual(rally)
    expect(decision?.attackTargetId).toBeNull()
    expect(decision?.reason).not.toContain('邊退邊打')
  })

  it('撤退中每循環改打最近的射程內敵人（路過誰打誰）', () => {
    const world = microWorld()
    const hurtId = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    putUnit(world, 'enemy', 'melee', { x: 11, y: 10 }) // 距 1 格
    const closer = putUnit(world, 'enemy', 'melee', { x: 10, y: 10 }) // 同格：最近
    const hurt = world.units.find((unit) => unit.id === hurtId)
    if (hurt === undefined) throw new Error('找不到受傷單位')
    hurt.hp = 15

    const rally: TilePos = { x: 2, y: 2 }
    const plan = planWith(world, rally, [makeSquad(0, [hurtId], { x: 20, y: 20 })])
    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === hurtId)
    expect(decision?.attackTargetId).toBe(closer) // 打最近者（同格距 0 < 相鄰 1 格）
  })

  it('hp 充足 → 不撤退（照常接戰）', () => {
    const world = microWorld()
    const unitId = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    putUnit(world, 'enemy', 'melee', { x: 10, y: 10 })
    const plan = planWith(world, { x: 2, y: 2 }, [makeSquad(0, [unitId], { x: 20, y: 20 })])
    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === unitId)
    expect(decision?.action).toBe('attack')
  })

  it('傷兵已抵達集結點 → 落回行為樹（守備隊佔位，不再永久停擺）', () => {
    const world = microWorld()
    const rally: TilePos = { x: 10, y: 10 }
    const hurtId = putUnit(world, 'player', 'melee', rally)
    const hurt = world.units.find((unit) => unit.id === hurtId)
    if (hurt === undefined) throw new Error('找不到受傷單位')
    hurt.hp = 15 // 15% < 20%，已退到集結點

    const defendSquad: Squad = { ...makeSquad(0, [hurtId], rally), mission: 'defend' }
    const plan = planWith(world, rally, [defendSquad])
    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === hurtId)
    expect(decision?.action).toBe('formation')
    expect(decision?.moveDest).toBeNull() // 已在 slot 上：不再反覆下令（省 A*）
  })

  it('撤退決策附帶中文 reason（資訊面板顯示用）', () => {
    const world = microWorld()
    const hurtId = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    const hurt = world.units.find((unit) => unit.id === hurtId)
    if (hurt === undefined) throw new Error('找不到受傷單位')
    hurt.hp = 15 // 15% < 20%

    const rally: TilePos = { x: 2, y: 2 }
    const plan = planWith(world, rally, [makeSquad(0, [hurtId], { x: 20, y: 20 })])
    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === hurtId)
    expect(decision?.reason).toContain('15%')
    expect(decision?.reason).toContain('20%')
    expect(decision?.reason).toContain('集結點')
  })

  it('攻擊／風箏／編隊決策也附帶 reason（資訊面板顯示用）', () => {
    const world = microWorld()
    const meleeId = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    putUnit(world, 'enemy', 'melee', { x: 10, y: 10 })
    const attackPlan = planWith(world, { x: 2, y: 2 }, [makeSquad(0, [meleeId], { x: 20, y: 20 })])
    const attack = computeMicroPlan(world, 'player', attackPlan).find((d) => d.unitId === meleeId)
    expect(attack?.action).toBe('attack')
    expect(attack?.reason).not.toBe('')

    const archerId = putUnit(world, 'player', 'archer', { x: 9, y: 10 }) // 離敵 1 格 → 風箏
    const kitePlan = planWith(world, { x: 2, y: 2 }, [makeSquad(1, [archerId], { x: 20, y: 20 })])
    const kite = computeMicroPlan(world, 'player', kitePlan).find((d) => d.unitId === archerId)
    expect(kite?.action).toBe('kite')
    expect(kite?.reason).toContain('邊退邊打')

    const freshId = putUnit(world, 'player', 'melee', { x: 1, y: 1 })
    const formationPlan = planWith(world, { x: 2, y: 2 }, [makeSquad(0, [freshId], { x: 8, y: 8 })])
    const formation = computeMicroPlan(world, 'player', formationPlan).find((d) => d.unitId === freshId)
    expect(formation?.action).toBe('formation')
    expect(formation?.reason).toContain('隊形')
  })
})

describe('追擊（SPEC §9.3 第 4 節，Prompt 10）', () => {
  it('行軍中敵人在射程外但極近（0.9 格 < 0.8 射程 + 1.0 追擊距）→ 前壓接戰', () => {
    const world = microWorld()
    const meleeId = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    const enemyId = putUnit(world, 'enemy', 'melee', { x: 11, y: 10 }) // 距 1.0 格：> 0.8 射程、< 1.8 追擊距
    // 模擬行軍中：下了往 (20,20) 的路徑。
    expect(orderMove(world, meleeId, { x: 20, y: 20 })).toBe(true)
    const plan = planWith(world, { x: 2, y: 2 }, [makeSquad(0, [meleeId], { x: 20, y: 20 })])

    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === meleeId)
    expect(decision?.action).toBe('chase')
    expect(decision?.moveDest).toEqual({ x: 11, y: 10 }) // 前壓到敵人所在格
    expect(decision?.attackTargetId).toBe(enemyId)
    expect(decision?.reason).toContain(String(enemyId))
  })

  it('敵人在追擊距之外（2.0 格 > 1.8）→ 不追擊（照常編隊）', () => {
    const world = microWorld()
    const meleeId = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    putUnit(world, 'enemy', 'melee', { x: 12, y: 10 }) // 距 2.0 格
    const plan = planWith(world, { x: 2, y: 2 }, [makeSquad(0, [meleeId], { x: 20, y: 20 })])

    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === meleeId)
    expect(decision?.action).toBe('formation')
  })

  it('遠程也會追擊：敵距 4.0 格（< 3.0 射程 + 1.0）→ 前壓縮短射程差', () => {
    const world = microWorld()
    const archerId = putUnit(world, 'player', 'archer', { x: 10, y: 10 })
    const enemyId = putUnit(world, 'enemy', 'melee', { x: 14, y: 10 }) // 距 4.0 格
    const plan = planWith(world, { x: 2, y: 2 }, [makeSquad(0, [archerId], { x: 20, y: 20 })])

    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === archerId)
    expect(decision?.action).toBe('chase')
    expect(decision?.attackTargetId).toBe(enemyId)
  })

  it('撤退優先於追擊：傷兵（hp 15% < 20%）近旁有可追擊的敵人 → 仍撤退', () => {
    const world = microWorld()
    const hurtId = putUnit(world, 'player', 'melee', { x: 10, y: 10 })
    putUnit(world, 'enemy', 'melee', { x: 11, y: 10 }) // 追擊距內但射程外
    const hurt = world.units.find((unit) => unit.id === hurtId)
    if (hurt === undefined) throw new Error('找不到受傷單位')
    hurt.hp = 15

    const rally: TilePos = { x: 2, y: 2 }
    const plan = planWith(world, rally, [makeSquad(0, [hurtId], { x: 20, y: 20 })])
    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === hurtId)
    expect(decision?.action).toBe('retreat')
    expect(decision?.moveDest).toEqual(rally)
  })

  it('常數：追擊門檻 1.0 格', () => {
    expect(CHASE_MARGIN).toBe(1.0)
  })
})

describe('編隊、待機與路徑節流（Prompt 8）', () => {
  it('有小隊目標 → 移往隊形位置（隊形 slot 在目標附近且互不重疊）', () => {
    const world = microWorld()
    const a = putUnit(world, 'player', 'melee', { x: 5, y: 5 })
    const b = putUnit(world, 'player', 'melee', { x: 5, y: 6 })
    const c = putUnit(world, 'player', 'melee', { x: 5, y: 7 })
    const target: TilePos = { x: 20, y: 20 }
    const plan = planWith(world, { x: 2, y: 2 }, [makeSquad(0, [a, b, c], target)])

    const decisions = computeMicroPlan(world, 'player', plan)
    const dests = decisions.map((d) => d.moveDest)
    for (const decision of decisions) {
      expect(decision.action).toBe('formation')
      const dest = decision.moveDest
      expect(dest).not.toBeNull()
      if (dest === null) continue
      expect(Math.abs(dest.x - target.x)).toBeLessThanOrEqual(3)
      expect(Math.abs(dest.y - target.y)).toBeLessThanOrEqual(3)
    }
    // 三個成員不會被塞到同一格。
    expect(new Set(dests.map((dest) => `${dest?.x},${dest?.y}`)).size).toBe(3)
  })

  it('未編隊 → 回集結點待機', () => {
    const world = microWorld()
    const unitId = putUnit(world, 'player', 'melee', { x: 20, y: 20 })
    const rally: TilePos = { x: 3, y: 3 }
    const plan = planWith(world, rally, [])
    const decision = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === unitId)
    expect(decision?.action).toBe('rally')
    expect(decision?.moveDest).toEqual(rally)
  })

  it('路徑節流：非重算 tick 且目的地未變 → 不下新移動令；500ms 到點則重算', () => {
    const world = microWorld()
    world.tick = 3 // 非 10 的倍數
    const unitId = putUnit(world, 'player', 'melee', { x: 5, y: 5 })
    const plan = planWith(world, { x: 2, y: 2 }, [makeSquad(0, [unitId], { x: 20, y: 20 })])

    const first = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === unitId)
    expect(first?.moveDest).not.toBeNull()
    if (first === undefined) throw new Error('缺少決策')
    applyMicroPlan(world, [first])

    // 同一 tick 再算：目的地不變且非重算點 → 不再下移動令。
    const second = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === unitId)
    expect(second?.moveDest).toBeNull()

    // 到 500ms（10 tick）→ 定期重算路徑。
    world.tick = MICRO_REPATH_TICKS
    const third = computeMicroPlan(world, 'player', plan).find((d) => d.unitId === unitId)
    expect(third?.moveDest).not.toBeNull()
  })

  it('常數：100ms 循環、500ms 重算、風箏門檻 0.7', () => {
    expect(MICRO_INTERVAL_TICKS).toBe(2)
    expect(MICRO_REPATH_TICKS).toBe(10)
    expect(KITE_MARGIN).toBe(0.7)
  })

  it('相同世界 → 相同微操決策（確定性）', () => {
    const build = (): string => {
      const world = microWorld()
      const a = putUnit(world, 'player', 'archer', { x: 5, y: 5 })
      putUnit(world, 'player', 'melee', { x: 6, y: 5 })
      putUnit(world, 'enemy', 'melee', { x: 6, y: 6 })
      const plan = planWith(world, { x: 2, y: 2 }, [makeSquad(0, [a], { x: 10, y: 10 }, { x: 5, y: 5 })])
      return JSON.stringify(computeMicroPlan(world, 'player', plan))
    }
    expect(build()).toBe(build())
  })
})

/* ------------------------------------------------------------------ */
/* 真實內容整合                                                        */
/* ------------------------------------------------------------------ */

interface RealRun {
  maxPlayerAdvance: number
  kites: number
  retreats: number
  positions: string
}

/** 真實內容 + seed 42：戰略 40 / 戰術 10 / 微操 2 tick。 */
function runReal(ticks: number): RealRun {
  const dataDir = fileURLToPath(new URL('../../public/data/', import.meta.url))
  const content = loadContentPackFromDir(dataDir)
  const world = createWorld(content, 42)
  const policies: Record<PlayerId, PolicyValues> = {
    player: DEFAULT_POLICIES,
    enemy: DEFAULT_POLICIES,
  }
  const spawnY = world.players.find((player) => player.id === 'player')?.spawn.y ?? 0
  const plans: Record<PlayerId, TacticalPlan | null> = { player: null, enemy: null }
  let maxPlayerAdvance = 0
  let kites = 0
  let retreats = 0

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
    if (world.tick % MICRO_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        for (const decision of runMicroCycle(world, player.id, plans[player.id])) {
          if (decision.action === 'kite') kites += 1
          if (decision.action === 'retreat') retreats += 1
        }
      }
    }
    for (const unit of world.units) {
      if (unit.player !== 'player') continue
      maxPlayerAdvance = Math.max(maxPlayerAdvance, spawnY - tileOf(unit.x, unit.y).y)
    }
  }

  return {
    maxPlayerAdvance,
    kites,
    retreats,
    positions: JSON.stringify(world.units.map((unit) => [unit.id, unit.x, unit.y])),
  }
}

describe('微操層整合（真實內容、seed 42）', () => {
  it('1000 tick：微操層真的運作（有推進、出現風箏與撤退決策）', () => {
    const run = runReal(1000)
    expect(run.maxPlayerAdvance).toBeGreaterThanOrEqual(4)
    expect(run.kites).toBeGreaterThanOrEqual(1)
    expect(run.retreats).toBeGreaterThanOrEqual(1)
  })

  it('相同 seed → 單位位置一致', () => {
    expect(runReal(200).positions).toBe(runReal(200).positions)
  })
})
