import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  assignMissions,
  computeTacticalPlan,
  countSquads,
  FOCUS_RADIUS_TILES,
  lerp,
  REGROUP_DISTANCE_TILES,
  RETREAT_POWER_RATIO,
  squadSizing,
  TACTICAL_INTERVAL_TICKS,
} from './tactics.ts'
import type { TacticalPlan } from './tactics.ts'
import { MICRO_INTERVAL_TICKS, runMicroCycle } from './micro.ts'
import { DEFENSE_RADIUS_TILES, pickMostUrgentThreat } from './influence.ts'
import { DEFAULT_POLICIES, resolvePolicies } from './policy.ts'
import type { PolicyValues } from './policy.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './strategy.ts'
import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import { addBuilding } from '../sim/economy.ts'
import { createWorld, stepWorld } from '../sim/world.ts'
import { tileOf } from '../sim/types.ts'
import { createTestWorld, makeBuildingDef, makeUnitDef, putUnit } from '../sim/testFixtures.ts'
import type { PlayerId, TilePos, World } from '../sim/types.ts'

/**
 * 戰術層測試（Prompt 7 驗收）：
 * - clusterSpread=1 → 少數大隊；clusterSpread=0 → 多數小隊分散
 * - aggression 決定 attack / defend 比例
 * - 進攻目標：價值高 × 敵防守弱 × 距離近
 * - 戰力劣勢時小隊撤退；個體 hp < retreatHpPct 脫離戰鬥
 */

const UNIT = makeUnitDef({ id: 'u' })
const KEEP = makeBuildingDef({ id: 'keep', size: [3, 3], ai: { value: 1000 } })
const MINE = makeBuildingDef({
  id: 'mine',
  size: [1, 1],
  ai: { value: 300 },
  requiresResourceNode: true,
})

/** 32×32 合成世界（含 player/enemy 雙方基地）。 */
function worldWithBases(): World {
  const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP, MINE] })
  addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
  addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
  return world
}

/** 只有我方基地（避免敵方 keep 的 1000 價值干擾目標選擇測試）。 */
function worldPlayerBaseOnly(): World {
  const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP, MINE] })
  addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
  return world
}

describe('小隊編組（Prompt 7）', () => {
  it('lerp 與 team 大小公式', () => {
    expect(lerp(4, 1, 0)).toBe(4)
    expect(lerp(4, 1, 0.5)).toBe(2.5)
    expect(lerp(4, 1, 1)).toBe(1)

    expect(squadSizing(resolvePolicies({ clusterSpread: 0 }))).toEqual({ count: 4, size: 4 })
    expect(squadSizing(resolvePolicies({ clusterSpread: 0.5 }))).toEqual({ count: 3, size: 11 })
    expect(squadSizing(resolvePolicies({ clusterSpread: 1 }))).toEqual({ count: 1, size: 18 })
  })

  it('實際隊數：不碎隊、必要時擴隊', () => {
    const spread0 = { count: 4, size: 4 }
    const spread1 = { count: 1, size: 18 }
    expect(countSquads(0, spread0)).toBe(0)
    expect(countSquads(3, spread0)).toBe(3) // 隊數不超過兵力（不產生空隊）
    expect(countSquads(8, spread0)).toBe(4)
    expect(countSquads(8, spread1)).toBe(1)
    expect(countSquads(20, spread1)).toBe(2) // 1×18 裝不下 → 擴成 2 隊
  })

  it('clusterSpread=0 → 多數小隊分散；=1 → 少數大隊', () => {
    const planWith = (spread: number): TacticalPlan => {
      const world = worldWithBases()
      for (let index = 0; index < 8; index++) {
        putUnit(world, 'player', 'u', { x: 5 + (index % 4), y: 10 + Math.floor(index / 4) })
      }
      return computeTacticalPlan(world, 'player', resolvePolicies({ clusterSpread: spread }))
    }
    expect(planWith(0).squads).toHaveLength(4)
    expect(planWith(1).squads).toHaveLength(1)
    // 8 個成員都分配到（無遺漏）。
    expect(planWith(0).squads.flatMap((squad) => squad.memberIds)).toHaveLength(8)
  })

  it('aggression 決定 attack / defend 比例', () => {
    const at = (count: number, aggression: number): string =>
      assignMissions(count, resolvePolicies({ aggression })).join(',')
    expect(at(4, 0)).toBe('defend,defend,defend,defend')
    expect(at(4, 1)).toBe('harass,attack,attack,attack')
    expect(at(2, 1)).toBe('attack,attack') // 隊數 < 3 → 不派騷擾
    expect(at(3, 0.5)).toBe('harass,attack,defend')
    expect(at(4, 0.5)).toBe('harass,attack,defend,defend')
  })

  it('節奏 10 tick（500ms）、撤退門檻 0.7', () => {
    expect(TACTICAL_INTERVAL_TICKS).toBe(10)
    expect(RETREAT_POWER_RATIO).toBe(0.7)
  })
})

describe('進攻目標選擇（Prompt 7）', () => {
  it('敵防守弱勝過距離近（遠但無人防守的礦場優先）', () => {
    const world = worldPlayerBaseOnly()
    const near = addBuilding(world, 'enemy', 'mine', { x: 12, y: 2 }, { built: true, nodeId: null })
    const far = addBuilding(world, 'enemy', 'mine', { x: 28, y: 2 }, { built: true, nodeId: null })
    putUnit(world, 'player', 'u', { x: 2, y: 2 })
    // 近處礦場旁堆 3 個敵方單位 → 防守強。
    for (const tile of [
      { x: 12, y: 2 },
      { x: 13, y: 2 },
      { x: 12, y: 3 },
    ]) {
      putUnit(world, 'enemy', 'u', tile)
    }

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1 }))
    expect(plan.squads[0]?.mission).toBe('attack')
    expect(plan.squads[0]?.targetBuildingId).toBe(far.id)
    expect(plan.squads[0]?.targetBuildingId).not.toBe(near.id)
  })

  it('同價值同防守時選近者', () => {
    const world = worldPlayerBaseOnly()
    const near = addBuilding(world, 'enemy', 'mine', { x: 12, y: 2 }, { built: true, nodeId: null })
    const far = addBuilding(world, 'enemy', 'mine', { x: 28, y: 2 }, { built: true, nodeId: null })
    putUnit(world, 'player', 'u', { x: 2, y: 2 })
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1 }))
    expect(plan.squads[0]?.targetBuildingId).toBe(near.id)
    expect(far.id).not.toBe(near.id)
  })

  it('騷擾任務優先打敵方經濟建築', () => {
    const world = worldWithBases()
    addBuilding(world, 'enemy', 'mine', { x: 20, y: 20 }, { built: true, nodeId: null })
    for (let index = 0; index < 8; index++) {
      putUnit(world, 'player', 'u', { x: 5 + (index % 4), y: 10 + Math.floor(index / 4) })
    }
    // clusterSpread=0 → 4 隊（≥ 3 隊才有騷擾隊）。
    const plan = computeTacticalPlan(
      world,
      'player',
      resolvePolicies({ aggression: 1, clusterSpread: 0 }),
    )
    const harass = plan.squads.find((squad) => squad.mission === 'harass')
    expect(harass).toBeDefined()
    const def = world.defs.buildings[
      world.buildings.find((building) => building.id === harass?.targetBuildingId)?.defId ?? ''
    ]
    expect(def?.requiresResourceNode).toBe(true)
  })
})

describe('主動防禦（保護建築與水晶，Prompt 10.6）', () => {
  it('守備半徑常數 6 格', () => {
    expect(DEFENSE_RADIUS_TILES).toBe(6)
  })

  it('敵軍進入守備半徑 → 守備隊目標改為來襲敵軍重心（攔截點，不再窩在集結點）', () => {
    const world = worldWithBases()
    addBuilding(world, 'player', 'mine', { x: 8, y: 8 }, { built: true, nodeId: null })
    putUnit(world, 'enemy', 'u', { x: 11, y: 8 }) // 距礦場中心 3 格 < 6
    putUnit(world, 'enemy', 'u', { x: 11, y: 9 })
    putUnit(world, 'player', 'u', { x: 3, y: 3 })
    putUnit(world, 'player', 'u', { x: 3, y: 4 })

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    const defendSquads = plan.squads.filter((squad) => squad.mission === 'defend')
    expect(defendSquads.length).toBeGreaterThan(0)
    for (const squad of defendSquads) {
      expect(squad.target).not.toEqual(plan.rally) // 不再窩在集結點
      // 攔截點 = 來襲敵軍重心附近（(11,8)–(11,9)）。
      expect(Math.abs(squad.target.x - 11)).toBeLessThanOrEqual(1)
      expect(Math.abs(squad.target.y - 8)).toBeLessThanOrEqual(1)
    }
  })

  it('敵軍在守備半徑外 → 無威脅，守備隊留在集結點', () => {
    const world = worldWithBases()
    addBuilding(world, 'player', 'mine', { x: 8, y: 8 }, { built: true, nodeId: null })
    putUnit(world, 'enemy', 'u', { x: 16, y: 8 }) // 距礦場 8 格 > 6
    putUnit(world, 'player', 'u', { x: 3, y: 3 })
    putUnit(world, 'player', 'u', { x: 3, y: 4 })

    expect(pickMostUrgentThreat(world, 'player')).toBeNull()
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    for (const squad of plan.squads) {
      expect(squad.target).toEqual(plan.rally)
    }
  })

  it('全軍出擊（無守備隊）→ 離受威脅建築最近的一支攻擊隊轉守備攔截', () => {
    const world = worldWithBases()
    addBuilding(world, 'player', 'mine', { x: 8, y: 8 }, { built: true, nodeId: null })
    putUnit(world, 'enemy', 'u', { x: 11, y: 8 })
    putUnit(world, 'player', 'u', { x: 3, y: 3 })
    putUnit(world, 'player', 'u', { x: 3, y: 4 }) // 離礦場較近 → 這隊被拉回

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1 }))
    const defenders = plan.squads.filter((squad) => squad.mission === 'defend')
    expect(defenders).toHaveLength(1)
    expect(defenders[0]?.memberIds).toEqual([3]) // (3,4) 的單位（id 3）被拉回
    const targetX = defenders[0]?.target.x ?? -99
    const targetY = defenders[0]?.target.y ?? -99
    expect(Math.abs(targetX - 11)).toBeLessThanOrEqual(1)
    expect(Math.abs(targetY - 8)).toBeLessThanOrEqual(1)
    // 其餘仍是攻擊隊，照樣鎖定敵方建築。
    const attacks = plan.squads.filter((squad) => squad.mission === 'attack')
    expect(attacks).toHaveLength(1)
    expect(attacks[0]?.targetBuildingId).not.toBeNull()
  })

  it('威脅優先序：來襲戰力高者優先', () => {
    const world = worldPlayerBaseOnly()
    const mine = addBuilding(world, 'player', 'mine', { x: 10, y: 2 }, { built: true, nodeId: null })
    putUnit(world, 'enemy', 'u', { x: 5, y: 2 }) // keep 旁 1 敵
    putUnit(world, 'enemy', 'u', { x: 11, y: 2 }) // mine 旁 3 敵
    putUnit(world, 'enemy', 'u', { x: 11, y: 3 })
    putUnit(world, 'enemy', 'u', { x: 12, y: 2 })

    const threat = pickMostUrgentThreat(world, 'player')
    expect(threat?.buildingId).toBe(mine.id)
    expect(threat?.threatPower).toBeGreaterThan(0)
  })

  it('威脅優先序：同戰力時水晶礦場（經濟）優先於主堡', () => {
    const world = worldPlayerBaseOnly()
    const mine = addBuilding(world, 'player', 'mine', { x: 10, y: 2 }, { built: true, nodeId: null })
    putUnit(world, 'enemy', 'u', { x: 5, y: 2 }) // keep 旁
    putUnit(world, 'enemy', 'u', { x: 11, y: 2 }) // mine 旁

    const threat = pickMostUrgentThreat(world, 'player')
    expect(threat?.buildingId).toBe(mine.id) // 同戰力 → 經濟（水晶）優先
    expect(threat?.isEconomic).toBe(true)
  })
})

describe('地緣重編組與集結再攻（Prompt 10.7）', () => {
  it('就近聚類：地理群不混編（k 由 clusterSpread 決定）', () => {
    const world = worldWithBases()
    // A 群在左下、B 群在中上，兩群相距 12 格。
    putUnit(world, 'player', 'u', { x: 4, y: 4 })
    putUnit(world, 'player', 'u', { x: 5, y: 4 })
    putUnit(world, 'player', 'u', { x: 16, y: 4 })
    putUnit(world, 'player', 'u', { x: 17, y: 4 })

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ clusterSpread: 0.5 }))
    // clusterSpread 0.5 → k = 3（滑桿決定隊數）；每隊成員都在同一地理群（不混編）。
    expect(plan.squads.length).toBe(3)
    for (const squad of plan.squads) {
      expect(squad.memberIds.length).toBeGreaterThan(0)
      const xs = squad.memberIds.map((id) => {
        const unit = world.units.find((candidate) => candidate.id === id)
        return unit === undefined ? -99 : tileOf(unit.x, unit.y).x
      })
      const inA = xs.every((x) => x <= 10)
      const inB = xs.every((x) => x > 10)
      expect(inA || inB).toBe(true)
    }
    // 全部 4 個成員都有隊。
    expect(plan.squads.flatMap((squad) => squad.memberIds)).toHaveLength(4)
  })

  it('就近聚類尊重容量上限（超過 squadSize 時溢出擴隊）', () => {
    const world = worldWithBases()
    for (let index = 0; index < 20; index++) {
      putUnit(world, 'player', 'u', { x: 4 + (index % 5), y: 4 + Math.floor(index / 5) })
    }
    // clusterSpread 1 → 1 隊上限 18；20 個單位 → 擴成 2 隊（18 + 2）。
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ clusterSpread: 1 }))
    expect(plan.squads).toHaveLength(2)
    expect(plan.squads[0]?.memberIds.length).toBeLessThanOrEqual(18)
    expect(plan.squads.flatMap((squad) => squad.memberIds)).toHaveLength(20)
  })

  it('集結再攻：成員鬆散的攻擊隊先設集結點（重心往目標方向）', () => {
    const world = worldWithBases()
    putUnit(world, 'player', 'u', { x: 4, y: 4 })
    putUnit(world, 'player', 'u', { x: 16, y: 4 }) // 兩成員相距 12 格 → 鬆散

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1, clusterSpread: 1 }))
    const squad = plan.squads[0]
    expect(squad?.mission).toBe('attack')
    expect(squad?.targetBuildingId).not.toBeNull() // 目標已鎖定（聚攏後進攻）
    // 集結點在重心 (10,4) 與敵方目標之間：比重心更靠近目標、距重心 ≤ 6 格。
    const targetX = squad?.target.x ?? -99
    expect(targetX).toBeGreaterThan(10)
    expect(Math.abs(targetX - 10)).toBeLessThanOrEqual(6)
  })

  it('成員聚攏 → 直接鎖定敵方建築（不設集結點）', () => {
    const world = worldWithBases()
    putUnit(world, 'player', 'u', { x: 4, y: 4 })
    putUnit(world, 'player', 'u', { x: 5, y: 4 }) // 相距 1 格 → 聚攏

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1, clusterSpread: 1 }))
    const squad = plan.squads[0]
    expect(squad?.mission).toBe('attack')
    // 目標 = 敵方 keep（(28,28) 佔地）旁可走格。
    const targetX = squad?.target.x ?? -99
    const targetY = squad?.target.y ?? -99
    expect(Math.abs(targetX - 28)).toBeLessThanOrEqual(3)
    expect(Math.abs(targetY - 28)).toBeLessThanOrEqual(3)
  })

  it('常數：集結門檻 5 格、集火半徑 8 格', () => {
    expect(REGROUP_DISTANCE_TILES).toBe(5)
    expect(FOCUS_RADIUS_TILES).toBe(8)
  })
})

describe('撤退（Prompt 7）', () => {
  /** 在 (4,4) 附近堆 4 個敵方單位（威脅 ≈ 233333 milli）。 */
  function surroundWithEnemies(world: World): void {
    for (const tile of [
      { x: 4, y: 4 },
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 5, y: 4 },
    ]) {
      putUnit(world, 'enemy', 'u', tile)
    }
  }

  it('戰力劣勢（1 單位 vs 大量敵軍）→ 全隊撤退回集結點', () => {
    const world = worldWithBases()
    putUnit(world, 'player', 'u', { x: 4, y: 4 })
    surroundWithEnemies(world)

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    const squad = plan.squads[0]
    expect(squad?.mission).toBe('retreat')
    expect(squad?.target).toEqual(plan.rally)
    expect(squad?.targetBuildingId).toBeNull()
  })

  it('戰力充足（6 單位）→ 不撤退', () => {
    const world = worldWithBases()
    for (let index = 0; index < 6; index++) putUnit(world, 'player', 'u', { x: 4, y: 4 })
    surroundWithEnemies(world)

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    expect(plan.squads[0]?.mission).toBe('defend')
  })

  it('附近無敵方 → 弱小隊也不撤退', () => {
    const world = worldWithBases()
    putUnit(world, 'player', 'u', { x: 4, y: 4 })
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    expect(plan.squads[0]?.mission).toBe('defend')
  })

  it('個體 hp < retreatHpPct（JSON 0.2）→ 脫離戰鬥、補進守備隊（Prompt 9.4 傷兵補位）', () => {
    const world = worldWithBases()
    const hurt = putUnit(world, 'player', 'u', { x: 4, y: 4 })
    const fine = putUnit(world, 'player', 'u', { x: 5, y: 4 })
    const fine2 = putUnit(world, 'player', 'u', { x: 6, y: 4 })
    const hurtUnit = world.units.find((unit) => unit.id === hurt)
    if (hurtUnit === undefined) throw new Error('找不到受傷單位')
    hurtUnit.hp = 15 // 15% < 20%

    const plan = computeTacticalPlan(world, 'player', DEFAULT_POLICIES)
    expect(plan.disengaged).toEqual([hurt])
    // 傷兵 round-robin 補進守備隊；attack／harass 隊不收傷兵。
    const members = plan.squads.flatMap((squad) => squad.memberIds)
    expect(members).toContain(fine)
    expect(members).toContain(hurt)
    for (const squad of plan.squads.filter((s) => s.mission === 'attack' || s.mission === 'harass')) {
      expect(squad.memberIds).not.toContain(hurt)
    }
    expect(plan.squads.some((s) => s.mission === 'defend' && s.memberIds.includes(hurt))).toBe(true)
    expect(members).toContain(fine2)
  })

  it('只有守備隊時傷兵補位；無守備隊（全攻勢）時不補', () => {
    const world = worldWithBases()
    const hurt = putUnit(world, 'player', 'u', { x: 4, y: 4 })
    const fine = putUnit(world, 'player', 'u', { x: 5, y: 4 })
    const hurtUnit = world.units.find((unit) => unit.id === hurt)
    if (hurtUnit === undefined) throw new Error('找不到受傷單位')
    hurtUnit.hp = 5

    // 全攻勢：唯一小隊是 attack，傷兵不補位、留在 disengaged 清單。
    const attackPlan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1, clusterSpread: 1 }))
    expect(attackPlan.disengaged).toEqual([hurt])
    expect(attackPlan.squads.flatMap((squad) => squad.memberIds)).toEqual([fine])
  })
})

describe('計畫與確定性（Prompt 7 / 8）', () => {
  it('進攻隊：任務為 attack 並鎖定敵方目標建築', () => {
    const world = worldWithBases()
    putUnit(world, 'player', 'u', { x: 4, y: 4 })
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1 }))
    const squad = plan.squads[0]
    expect(squad?.mission).toBe('attack')
    expect(squad?.targetBuildingId).not.toBeNull()
  })

  it('低血單位脫離戰鬥但補進守備隊（下單改由微操層負責）', () => {
    const world = worldWithBases()
    const hurt = putUnit(world, 'player', 'u', { x: 6, y: 6 })
    const fine = putUnit(world, 'player', 'u', { x: 7, y: 6 })
    const hurtUnit = world.units.find((unit) => unit.id === hurt)
    if (hurtUnit === undefined) throw new Error('找不到受傷單位')
    hurtUnit.hp = 10

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    expect(plan.disengaged).toEqual([hurt])
    // 全守備時唯一的隊收下健康單位後再補入傷兵。
    expect(plan.squads[0]?.mission).toBe('defend')
    expect(plan.squads[0]?.memberIds).toEqual([fine, hurt])
  })

  it('相同世界 → 相同戰術計畫（確定性）', () => {
    const build = (): string => {
      const world = worldWithBases()
      putUnit(world, 'player', 'u', { x: 5, y: 5 })
      putUnit(world, 'player', 'u', { x: 6, y: 5 })
      putUnit(world, 'enemy', 'u', { x: 20, y: 20 })
      return JSON.stringify(computeTacticalPlan(world, 'player', DEFAULT_POLICIES))
    }
    expect(build()).toBe(build())
  })
})

/* ------------------------------------------------------------------ */
/* 真實內容整合                                                        */
/* ------------------------------------------------------------------ */

interface RealRun {
  world: World
  /** 玩家單位在整段模擬中「最北推進」的格數（相對出生點）。 */
  maxPlayerAdvance: number
  /** 實際產生小隊的戰術循環次數。 */
  squadsSeen: number
  positions: string
}

/** 真實內容 + seed 42：戰略層每 40、戰術層每 10、微操層每 2 tick 各跑一次。 */
function runReal(ticks: number): RealRun {
  const dataDir = fileURLToPath(new URL('../../public/data/', import.meta.url))
  const content = loadContentPackFromDir(dataDir)
  const world = createWorld(content, 42)
  const policies: Record<PlayerId, PolicyValues> = {
    player: DEFAULT_POLICIES,
    enemy: DEFAULT_POLICIES,
  }
  const spawnY = world.players.find((player) => player.id === 'player')?.spawn.y ?? 0
  let maxPlayerAdvance = 0
  let squadsSeen = 0
  const plans: Record<PlayerId, TacticalPlan | null> = { player: null, enemy: null }

  while (world.tick < ticks) {
    stepWorld(world)
    if (world.tick % STRATEGIC_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        runStrategicCycle(world, player.id, policies[player.id])
      }
    }
    if (world.tick % TACTICAL_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        const plan = computeTacticalPlan(world, player.id, policies[player.id])
        plans[player.id] = plan
        if (player.id === 'player' && plan.squads.length > 0) squadsSeen += 1
      }
    }
    if (world.tick % MICRO_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        runMicroCycle(world, player.id, plans[player.id])
      }
    }
    for (const unit of world.units) {
      if (unit.player !== 'player') continue
      const tile: TilePos = tileOf(unit.x, unit.y)
      maxPlayerAdvance = Math.max(maxPlayerAdvance, spawnY - tile.y)
    }
  }

  return {
    world,
    maxPlayerAdvance,
    squadsSeen,
    positions: JSON.stringify(world.units.map((unit) => [unit.id, unit.x, unit.y])),
  }
}

describe('戰術層整合（真實內容、seed 42）', () => {
  it('300 tick：小隊成形並推進（遠離出生點 ≥ 4 格）', () => {
    const run = runReal(300)
    expect(run.squadsSeen).toBeGreaterThanOrEqual(1)
    expect(run.maxPlayerAdvance).toBeGreaterThanOrEqual(4)
  })

  it('相同 seed → 單位位置一致', () => {
    expect(runReal(200).positions).toBe(runReal(200).positions)
  })
})
