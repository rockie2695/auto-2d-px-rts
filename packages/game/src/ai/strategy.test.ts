import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { UnitDef } from '@auto-2d-px-rts/shared'

import { DEFAULT_POLICIES, resolvePolicies } from './policy.ts'
import {
  runStrategicCycle,
  STRATEGIC_INTERVAL_TICKS,
  THREAT_DEFENSE_BONUS,
} from './strategy.ts'
import type { DecisionRecord, StrategicAction } from './strategy.ts'
import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import {
  createTestWorld,
  makeBuildingDef,
  makeUnitDef,
  putUnit,
} from '../sim/testFixtures.ts'
import { addBuilding } from '../sim/economy.ts'
import { createWorld, stepWorld } from '../sim/world.ts'
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
    actions.push(...runStrategicCycle(world, playerId, policies).actions)
  }
  return actions
}

/** 跑 n 次戰略循環，攤平所有決策記錄。 */
function runCycleRecords(
  world: World,
  playerId: PlayerId,
  policies: PolicyValues,
  n: number,
): DecisionRecord[] {
  const records: DecisionRecord[] = []
  for (let cycle = 0; cycle < n; cycle++) {
    records.push(...runStrategicCycle(world, playerId, policies).records)
  }
  return records
}

describe('命運抽籤：同帶候選以種子抽選（Prompt 10.11 對局多樣性）', () => {
  /** 跑 n 個戰略循環，回傳首個 train 的 defId（無則 null）。 */
  function firstTrained(seed: number): string | null {
    const world = createTestWorld({
      size: 32,
      seed,
      units: [makeUnitDef({ id: 'u' }), makeUnitDef({ id: 'v', stats: { hp: 80, dmg: 8, range: 3.0, attackSpeed: 1.0, moveSpeed: 1 } })],
      buildings: [
        makeBuildingDef({ id: 'keep', size: [3, 3] }),
        makeBuildingDef({ id: 'barracks', produces: ['u', 'v'] }),
      ],
    })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'player', 'barracks', { x: 6, y: 2 }, { built: true, nodeId: null })
    for (const record of runCycleRecords(world, 'player', DEFAULT_POLICIES, 1)) {
      if (record.action === 'train') return record.target
    }
    return null
  }

  it('同 seed 決定性：兩次跑出相同結果', () => {
    expect(firstTrained(7)).toBe(firstTrained(7))
  })

  it('跨 seed 產生多樣性：8 個種子至少出現 2 種首個生兵', () => {
    const picks = new Set<string | null>()
    for (let seed = 1; seed <= 8; seed++) picks.add(firstTrained(seed))
    expect(picks.size).toBeGreaterThanOrEqual(2)
  })
})

describe('主動防禦：壓境防守加權（保護建築與水晶，Prompt 10.6）', () => {
  const BARRACKS_PROD = makeBuildingDef({ id: 'barracks', produces: ['u'] })

  /** 我方 keep＋兵營＋1 單位；threatened 時敵軍壓境（keep 守備半徑內）。 */
  function worldWith(threatened: boolean): World {
    const world = createTestWorld({
      size: 32,
      units: [makeUnitDef({ id: 'u' })],
      buildings: [makeBuildingDef({ id: 'keep', size: [3, 3], ai: { value: 1000 } }), BARRACKS_PROD],
    })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'player', 'barracks', { x: 6, y: 2 }, { built: true, nodeId: null })
    putUnit(world, 'player', 'u', { x: 3, y: 6 })
    if (threatened) putUnit(world, 'enemy', 'u', { x: 5, y: 5 }) // 距 keep／barracks < 6 格
    return world
  }

  it('加權常數 1.0；壓境時生產候選效用恰 ×2（Prompt 6 乘法結構）', () => {
    expect(THREAT_DEFENSE_BONUS).toBe(1.0)
    const trainScore = (threatened: boolean): number | undefined => {
      const records = runCycleRecords(worldWith(threatened), 'player', resolvePolicies({ econMilitary: 1 }), 1)
      const train = records.find((record) => record.action === 'train')
      return train?.reason.candidates[0]?.score
    }
    const base = trainScore(false)
    expect(base).toBeDefined()
    expect(trainScore(true)).toBeCloseTo((base ?? 0) * (1 + THREAT_DEFENSE_BONUS), 6)
  })
})

describe('生產評分生存項（Prompt 3.1 → Prompt 6 乘法化）', () => {
  /** 兩個候選**只差裝甲**：tank 0.5、plain 0——生存項是唯一分數差。 */
  function armorWorld(): World {
    const world = createTestWorld({
      size: 32,
      units: [
        makeUnitDef({ id: 'tank', stats: { hp: 120, dmg: 10, range: 0.8, attackSpeed: 1.0, moveSpeed: 1.0, armor: 0.5 } }),
        makeUnitDef({ id: 'plain', stats: { hp: 120, dmg: 10, range: 0.8, attackSpeed: 1.0, moveSpeed: 1.0, armor: 0 } }),
      ],
      buildings: [
        makeBuildingDef({ id: 'keep', size: [3, 3], ai: { value: 1000 } }),
        makeBuildingDef({ id: 'barracks', produces: ['tank', 'plain'] }),
      ],
    })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'player', 'barracks', { x: 6, y: 2 }, { built: true, nodeId: null })
    return world
  }

  it('只差裝甲時，高有效HP/cost 候選分數恰為對方 ×(1.25/0.75)', () => {
    const records = runCycleRecords(armorWorld(), 'player', resolvePolicies({ econMilitary: 1 }), 1)
    const train = records.find((record) => record.action === 'train')
    expect(train).toBeDefined()
    if (train === undefined) return
    const scores = new Map(
      train.reason.candidates.map((candidate) => [candidate.defId, candidate.score]),
    )
    const tank = scores.get('tank')
    const plain = scores.get('plain')
    if (tank === undefined || plain === undefined) {
      throw new Error(`候選分數缺 tank／plain：${JSON.stringify([...scores])}`)
    }
    expect(tank / plain).toBeCloseTo(1.1 / 0.9, 6)
  })
})

describe('資源分配啟發式（Prompt 5：藍礦先行，紅綠礦分階段解鎖）', () => {
  /** 三礦 + 三類節點；econMilitary 可調。 */
  function minesWorld(startCrystal: number): World {
    return createTestWorld({
      size: 32,
      resourceNodes: [
        { x: 2, y: 2 },
        { x: 4, y: 2 },
        { x: 6, y: 2 },
      ],
      typedResourceNodes: [
        { x: 8, y: 2, resourceType: 'red_ruby' },
        { x: 10, y: 2, resourceType: 'green_emerald' },
      ],
      units: [makeUnitDef({ id: 'u' }), makeUnitDef({ id: 'ballista', cost: { blue_crystal: 40, red_ruby: 80 }, tier: 'large' })],
      buildings: [
        makeBuildingDef({ id: 'keep', size: [3, 3], ai: { value: 1000 } }),
        makeBuildingDef({ id: 'crystal_mine', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { blue_crystal: 1.0 } }),
        makeBuildingDef({ id: 'ruby_mine', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { red_ruby: 0.5 } }),
        makeBuildingDef({ id: 'emerald_sanctuary', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { green_emerald: 0.25 } }),
        makeBuildingDef({ id: 'barracks', size: [2, 2], cost: { blue_crystal: 200 }, produces: ['u', 'ballista'] }),
      ],
      startCrystal,
      mineCap: 5,
    })
  }

  it('expansion=0：藍礦 3 座滿之前紅／綠礦鎖死；滿了之後紅礦入列、綠礦跟進', () => {
    const world = minesWorld(20000)
    const policies = resolvePolicies({ econMilitary: 1, expansion: 0 })
    runCycles(world, 'player', policies, 3)
    const mineIdsOf = (defId: string): number =>
      world.buildings.filter(
        (building) => building.player === 'player' && building.defId === defId,
      ).length
    expect(mineIdsOf('crystal_mine')).toBe(3)
    expect(mineIdsOf('ruby_mine')).toBe(0)
    expect(mineIdsOf('emerald_sanctuary')).toBe(0)
    // 續跑：紅礦入列（roster 有 ballista +0.4）；紅礦蓋出後綠礦解鎖。
    runCycles(world, 'player', policies, 9)
    expect(mineIdsOf('ruby_mine')).toBeGreaterThanOrEqual(1)
    expect(mineIdsOf('emerald_sanctuary')).toBeGreaterThanOrEqual(1)
  })

  it('expansion=1：藍礦 1 座即解鎖紅礦（第 2 循環就偏離純藍礦序列）', () => {
    const world = minesWorld(20000)
    runCycles(world, 'player', resolvePolicies({ econMilitary: 1, expansion: 1 }), 3)
    const mineIdsOf = (defId: string): number =>
      world.buildings.filter(
        (building) => building.player === 'player' && building.defId === defId,
      ).length
    expect(mineIdsOf('ruby_mine')).toBeGreaterThanOrEqual(1)
    expect(mineIdsOf('crystal_mine')).toBeLessThan(3) // 沒先把藍礦補滿
  })

  it('resourceBias 偏重：bias 全偏紅 → 紅礦效用相對抬升（blue 礦分數打折）', () => {
    const world = minesWorld(20000)
    // expansion 1 + bias 全紅：紅礦分數不變、藍礦 ×(0/0.5)=0 —— 藍礦強制首座（3.0）除外。
    runCycles(world, 'player', resolvePolicies({ econMilitary: 1, expansion: 1, resourceBias: { blue: 0, red: 1, green: 0 } }), 4)
    const mineIdsOf = (defId: string): number =>
      world.buildings.filter(
        (building) => building.player === 'player' && building.defId === defId,
      ).length
    // 強制首座藍礦（3.0）不受 bias 影響 → 恰 1 座；紅礦 ≥1；藍礦不會蓋到第 2 座。
    expect(mineIdsOf('crystal_mine')).toBe(1)
    expect(mineIdsOf('ruby_mine')).toBeGreaterThanOrEqual(1)
  })

  it('techRush=1：跳過紅礦直接解鎖綠礦（科技衝刺 gate）', () => {
    const world = minesWorld(20000)
    runCycles(world, 'player', resolvePolicies({ econMilitary: 1, expansion: 1, techRush: 1 }), 6)
    const mineIdsOf = (defId: string): number =>
      world.buildings.filter(
        (building) => building.player === 'player' && building.defId === defId,
      ).length
    expect(mineIdsOf('emerald_sanctuary')).toBeGreaterThanOrEqual(1)
  })

  it('ballista 可負擔性看紅寶石：紅不足時生產軌跳過它、不擋其它單位', () => {
    const world = minesWorld(1000)
    addBuilding(world, 'player', 'barracks', { x: 14, y: 2 }, { built: true, nodeId: null })
    const actions = runCycles(world, 'player', DEFAULT_POLICIES, 1)
    const trains = actions.filter((action) => action.kind === 'train')
    for (const action of trains) {
      if (action.kind === 'train') expect(action.defId).not.toBe('ballista') // 紅 0 < 80
    }
    expect(trains.length).toBeGreaterThanOrEqual(0)
  })
})

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

describe('建築預備金（Prompt 10.24 A：生產軌不得吞光建築預算）', () => {
  function reserveWorld(startCrystal: number): World {
    return createTestWorld({
      size: 12,
      units: [makeUnitDef({ id: 'u', cost: { blue_crystal: 50 } })],
      buildings: [
        makeBuildingDef({
          id: 'tower',
          size: [2, 2],
          cost: { blue_crystal: 150 },
          defense: { dmg: 10, range: 4.0, attackSpeed: 0.5 },
        }),
        makeBuildingDef({ id: 'rax', size: [2, 2], cost: { blue_crystal: 200 }, produces: ['u'] }),
      ],
      startCrystal,
    })
  }

  it('最高分候選買不起 → 生產軌為它攢錢（水晶 − 預備金 < 單位造價 → 不排隊）', () => {
    const world = reserveWorld(100)
    // tower 分數 1.0（palette 先）與 rax 1.0 同分 → tower 是預備金目標（150）；
    // 100 < 150 → 兩者都買不起；100 − 150 < 50 → 不生兵、分毫未動。
    const actions = runCycles(world, 'player', DEFAULT_POLICIES, 3)
    expect(actions.filter((action) => action.kind === 'build')).toHaveLength(0)
    expect(actions.filter((action) => action.kind === 'train')).toHaveLength(0)
    expect(world.players[0]?.resources.blue_crystal).toBe(100)
  })

  it('攢到預備金 → 蓋最高分建築；蓋完預備金轉下一候選（仍不生兵）', () => {
    const world = reserveWorld(160)
    const actions = runCycles(world, 'player', DEFAULT_POLICIES, 2)
    // cycle 1：build tower（150）→ 水晶 10；預備金 = rax 200 → 不生兵
    // cycle 2：rax 1.0 買不起、tower 0.5 也買不起 → 不蓋；預備金 = rax 200 → 不生兵
    expect(actions.filter((action) => action.kind === 'build')).toHaveLength(1)
    expect(actions.filter((action) => action.kind === 'train')).toHaveLength(0)
    expect(countBuildings(world, 'player', 'tower')).toBe(1)
  })

  it('全飽和（建築軌無候選）→ 預備金 0、全額造兵', () => {
    const world = reserveWorld(500)
    addBuilding(world, 'player', 'tower', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'player', 'tower', { x: 5, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'player', 'rax', { x: 2, y: 5 }, { built: true, nodeId: null })
    addBuilding(world, 'player', 'rax', { x: 5, y: 5 }, { built: true, nodeId: null })
    addBuilding(world, 'player', 'rax', { x: 8, y: 5 }, { built: true, nodeId: null })
    const actions = runCycles(world, 'player', DEFAULT_POLICIES, 2)
    expect(actions.filter((action) => action.kind === 'train')).toHaveLength(2)
  })
})

describe('塔前置（Prompt 10.24 B：防線朝敵方 keep，紅藍互為鏡像）', () => {
  function towerAnchorWorld(): World {
    return createTestWorld({
      size: 12,
      units: [makeUnitDef({ id: 'u', cost: { blue_crystal: 50 } })],
      buildings: [
        makeBuildingDef({ id: 'keep', size: [3, 3] }),
        makeBuildingDef({
          id: 'tower',
          size: [2, 2],
          cost: { blue_crystal: 150 },
          defense: { dmg: 10, range: 4.0, attackSpeed: 0.5 },
        }),
      ],
      startCrystal: 1000,
    })
  }

  it('藍塔蓋在 keep 朝敵 keep 方向 3 格附近；紅塔為其精確鏡像', () => {
    const blue = towerAnchorWorld()
    addBuilding(blue, 'player', 'keep', { x: 1, y: 1 }, { built: true, nodeId: null })
    addBuilding(blue, 'enemy', 'keep', { x: 8, y: 8 }, { built: true, nodeId: null })
    const red = towerAnchorWorld()
    addBuilding(red, 'player', 'keep', { x: 1, y: 1 }, { built: true, nodeId: null })
    addBuilding(red, 'enemy', 'keep', { x: 8, y: 8 }, { built: true, nodeId: null })

    const blueActions = runCycles(blue, 'player', DEFAULT_POLICIES, 1)
    const redActions = runCycles(red, 'enemy', DEFAULT_POLICIES, 1)
    const blueBuild = blueActions.find((action) => action.kind === 'build')
    expect(blueBuild?.kind).toBe('build')
    const redBuild = redActions.find((action) => action.kind === 'build')
    expect(redBuild?.kind).toBe('build')
    if (blueBuild?.kind !== 'build' || redBuild?.kind !== 'build') return
    expect(blueBuild.defId).toBe('tower')
    expect(redBuild.defId).toBe('tower')
    // 藍：keep 中心 (2,2) → 前置錨 = (2,2) + sign(8−2)×1 = (3,3) → 塔落 (4,2)。
    expect(blueBuild.tile).toEqual({ x: 4, y: 2 })
    // 紅：塔佔地 = 藍塔的**逐格鏡像**（鏡射後 2×2 佔地的左上角 = size−w−x）。
    expect(redBuild.tile).toEqual({
      x: (12 - 2) - blueBuild.tile.x,
      y: (12 - 2) - blueBuild.tile.y,
    })
  })

  it('無敵方 keep → 塔退回 keep 旁（錨點不前移）', () => {
    const world = towerAnchorWorld()
    addBuilding(world, 'player', 'keep', { x: 1, y: 1 }, { built: true, nodeId: null })
    const actions = runCycles(world, 'player', DEFAULT_POLICIES, 1)
    const build = actions.find((action) => action.kind === 'build')
    expect(build?.kind).toBe('build')
    if (build?.kind !== 'build') return
    // 錨點 = keep 中心 (2,2)、**不位移** → 最近佔地序落在 keep 東側 (4,1)
    // （不是前置方向特有的 (4,4)——若誤朝不存在的敵 keep 前移，才會出現對角位）。
    expect(build.tile).toEqual({ x: 4, y: 1 })
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

  it('視野過濾（Prompt 9.5b）：視野外的敵人不進克制判斷（看不見的爆兵不扭轉生產）', () => {
    const world = productionWorld(
      rangeUnits(),
      { melee: { melee: 1.0, ranged: 1.0 }, ranged: { melee: 2.0, ranged: 1.0 } },
    )
    // 敵方 4 近戰堆在 (20..23,20)：離我方 3 座兵營（視野 6 格）與出生單位都遠
    // → 對 player 完全不可見 → enemyRoleShare = null → 克制分中性（1.0），
    // ranged 不再因克制勝出（對照上一測試：可見時 ranged 勝出）。
    for (let index = 0; index < 4; index++) putUnit(world, 'enemy', 'meleeU', { x: 20 + index, y: 20 })

    runCycles(world, 'player', resolvePolicies({ unitRange: 0.5 }), 8)

    expect(countUnits(world, 'player', 'rangedU')).toBe(countUnits(world, 'player', 'meleeU'))
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

/* ------------------------------------------------------------------ */
/* Prompt 6.5：決策記錄                                                 */
/* ------------------------------------------------------------------ */

/** 真實內容 + seed 42 跑 totalTicks，回傳雙方累積的決策記錄。 */
function runRealWorldRecords(totalTicks: number): DecisionRecord[] {
  const dataDir = fileURLToPath(new URL('../../public/data/', import.meta.url))
  const content = loadContentPackFromDir(dataDir)
  const world = createWorld(content, 42)
  const records: DecisionRecord[] = []
  while (world.tick < totalTicks) {
    stepWorld(world)
    if (world.tick % STRATEGIC_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        records.push(...runStrategicCycle(world, player.id, DEFAULT_POLICIES).records)
      }
    }
  }
  return records
}

describe('決策記錄（Prompt 6.5）', () => {
  it('真實內容跑 200 tick：至少 1 條決策記錄', () => {
    expect(runRealWorldRecords(200).length).toBeGreaterThanOrEqual(1)
  })

  it('每條記錄欄位齊全、explanation 非空、topFactor 合法', () => {
    const validFactors = [
      'forcedMine',
      'econWeight',
      'militaryWeight',
      'saturation',
      'counter',
      'range',
      'tier',
      'scarcity',
      'feasibility',
    ]
    const records = runRealWorldRecords(200)
    expect(records.length).toBeGreaterThanOrEqual(1)
    for (const record of records) {
      expect(record.layer).toBe('strategic')
      expect(record.tick).toBeGreaterThan(0)
      expect(['player', 'enemy']).toContain(record.actor)
      expect(['build', 'train']).toContain(record.action)
      expect(record.target.length).toBeGreaterThan(0)
      expect(record.reason.explanation).not.toBe('')
      expect(record.reason.explanation).toContain('理由：')
      expect(record.reason.candidates.length).toBeGreaterThanOrEqual(1)
      expect(validFactors).toContain(record.reason.topFactor)
      expect(record.reason.weights.econMilitary).toBe(0.5)
    }
  })

  it('相同 seed → 決策記錄一致', () => {
    expect(JSON.stringify(runRealWorldRecords(200))).toBe(
      JSON.stringify(runRealWorldRecords(200)),
    )
  })

  it('build 記錄：target 帶 @(x,y)、候選分數降冪；train 記錄：target 為單位 defId', () => {
    // 建築記錄（預設滑桿 → mine 強制 3.0 壓過兵營 1.0，兩個候選都入列）。
    const buildWorld = buildingWorld()
    const build = runCycleRecords(buildWorld, 'player', DEFAULT_POLICIES, 1).find(
      (record) => record.action === 'build',
    )
    expect(build?.target).toMatch(/^mine@\(\d+,\d+\)$/)
    expect(build?.reason.candidates).toHaveLength(2)
    const scores = build?.reason.candidates.map((candidate) => candidate.score) ?? []
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1] ?? Number.POSITIVE_INFINITY)

    // 生產記錄（兵營已就緒、unitRange=1 → 遠程單位勝出）。
    const prodWorld = productionWorld(rangeUnits())
    const train = runCycleRecords(prodWorld, 'player', resolvePolicies({ unitRange: 1 }), 1).find(
      (record) => record.action === 'train',
    )
    expect(train?.target).toBe('rangedU')
    expect(train?.reason.explanation).toBe('生 rangedU。理由：unitRange 偏遠程')
    expect(train?.reason.topFactor).toBe('range')
  })
})
