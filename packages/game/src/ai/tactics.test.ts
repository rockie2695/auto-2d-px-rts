import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  assignMissions,
  computeTacticalPlan,
  countSquads,
  ENGAGE_POWER_RATIO,
  FOCUS_RADIUS_TILES,
  groupByProximity,
  lerp,
  REGROUP_DISTANCE_TILES,
  RETREAT_POWER_RATIO,
  squadSizing,
  SUDDEN_DEATH_HARD_TICK,
  SUDDEN_DEATH_PHASE_WINDOW_TICKS,
  SUDDEN_DEATH_START_TICK,
  SUDDEN_DEATH_STEP_TICKS,
  suddenDeathMultiplierMilli,
  suddenDeathPhaseTicks,
  suddenDeathStage,
  TACTICAL_INTERVAL_TICKS,
  waveRatioMilli,
} from './tactics.ts'
import type { TacticalPlan } from './tactics.ts'
import { MICRO_INTERVAL_TICKS, runMicroCycle } from './micro.ts'
import { DEFENSE_RADIUS_TILES, pickMostUrgentThreat } from './influence.ts'
import { rallyPoint } from './tactics.ts'
import { DEFAULT_POLICIES, resolvePolicies } from './policy.ts'
import type { PolicyValues } from './policy.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './strategy.ts'
import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import { addBuilding } from '../sim/economy.ts'
import { createWorld, stepWorld } from '../sim/world.ts'
import { tileOf, UNITS_PER_TILE } from '../sim/types.ts'
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
const BARRACKS = makeBuildingDef({ id: 'barracks', size: [3, 3], produces: ['u'], ai: { value: 400 } })

/** 32×32 合成世界（含 player/enemy 雙方基地）。 */
function worldWithBases(): World {
  const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP, MINE] })
  addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
  addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
  return world
}

/** 雙方基地＋各一間兵營（出廠集合格測試用，Prompt 10.19）。 */
function worldWithSpawns(): World {
  const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP, MINE, BARRACKS] })
  addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
  addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
  addBuilding(world, 'player', 'barracks', { x: 6, y: 2 }, { built: true, nodeId: null })
  // 紅兵營 = 藍兵營的 180° 點鏡射（佔地 [6..8]×[2..4] ↔ [23..25]×[27..29]）。
  addBuilding(world, 'enemy', 'barracks', { x: 23, y: 27 }, { built: true, nodeId: null })
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
    // 視野（9.5b）：近礦守軍需在視野內才構成「已知防守」——加一名斥候貼近
    //（(9,2) 距守軍 3–4 格 ≤ 6，距 (2,2) 7 格不併隊干擾）。
    putUnit(world, 'player', 'u', { x: 9, y: 2 })
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
    // 敵我兵力對等（Prompt 10.18 攻勢加成 = 0）→ 純守備編制可測。
    putUnit(world, 'enemy', 'u', { x: 28, y: 28 })
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

    // reserve 0：本測試驗證威脅攔截（Prompt 10.6），與 Prompt 6 戰力留守無關。
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1, reserve: 0 }))
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

describe('集結點／生產點與編組遲滯（Prompt 10.13）', () => {
  it('集結點：無威脅＝W4 前移點；有威脅＝更往前壓近受威脅建築', () => {
    const world = worldWithBases()
    // 受威脅礦場放在前線（比 W4 預設點更靠敵方）。
    addBuilding(world, 'player', 'mine', { x: 14, y: 14 }, { built: true, nodeId: null })
    putUnit(world, 'enemy', 'u', { x: 15, y: 14 }) // 礦場旁來襲
    const home = rallyPoint(world, 'player')
    const threat = pickMostUrgentThreat(world, 'player')
    expect(threat).not.toBeNull()
    const forward = rallyPoint(world, 'player', threat)
    const dist = (a: TilePos, b: TilePos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
    // 有威脅的集結點比無威脅預設點更靠近受威脅建築（往中點前移）。
    expect(dist(forward, { x: 14, y: 14 })).toBeLessThan(dist(home, { x: 14, y: 14 }))
  })

  it('集結點前移（Prompt 10.17 W4）：無威脅＝往雙方 keep 中點 1/3、紅藍互為鏡像', () => {
    // 精確鏡射的世界：藍 keep (2,2)、紅 keep = mirror (27,27)。
    const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP, MINE] })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 27, y: 27 }, { built: true, nodeId: null })

    const blue = rallyPoint(world, 'player')
    const red = rallyPoint(world, 'enemy')
    const last = world.map.size - 1
    expect(red).toEqual({ x: last - blue.x, y: last - blue.y }) // 鏡射對稱

    const home = { x: 3, y: 3 } // 自家 keep 中心
    const enemyKeep = { x: 28, y: 28 }
    const dist = (a: TilePos, b: TilePos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
    // 前移：比自家門口更靠近敵堡，但未過半（無威脅不衝中線）。
    expect(dist(blue, enemyKeep)).toBeLessThan(dist(home, enemyKeep))
    expect(dist(blue, home)).toBeLessThan(dist(home, enemyKeep) / 2)
  })

  it('出廠集合格：每間生產建築一個、往主目標方向前移（Prompt 10.19）', () => {
    const world = worldWithSpawns()
    putUnit(world, 'player', 'u', { x: 5, y: 5 })
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1, clusterSpread: 1 }))
    expect(plan.spawns).toHaveLength(1)
    const spawn = plan.spawns[0]
    if (spawn === undefined) throw new Error('缺少出廠集合格')
    const barracks = world.buildings.find((building) => building.id === spawn.buildingId)
    expect(barracks).toBeDefined()
    const dist = (a: TilePos, b: TilePos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
    const enemyKeep = { x: 29, y: 29 } // 敵 keep（28,28）3×3 的中心
    const barracksCenter = { x: 7, y: 3 } // (6,2) 3×3 的中心
    // 往主目標前移：比兵營中心更近敵 keep，但不貼著 keep（只前移約 4 格）。
    expect(dist(spawn.tile, enemyKeep)).toBeLessThan(dist(barracksCenter, enemyKeep))
    expect(dist(spawn.tile, enemyKeep)).toBeGreaterThan(dist(enemyKeep, barracksCenter) - 10)
  })

  it('出廠集合格鏡射對稱：紅藍互為鏡像（Prompt 10.19）', () => {
    const world = worldWithSpawns()
    putUnit(world, 'player', 'u', { x: 5, y: 5 })
    putUnit(world, 'enemy', 'u', { x: 26, y: 26 })
    const policies = resolvePolicies({ aggression: 1, clusterSpread: 1 })
    const blue = computeTacticalPlan(world, 'player', policies)
    const red = computeTacticalPlan(world, 'enemy', policies)
    expect(blue.spawns).toHaveLength(1)
    expect(red.spawns).toHaveLength(1)
    const last = world.map.size - 1
    const bTile = blue.spawns[0]?.tile
    const rTile = red.spawns[0]?.tile
    if (bTile === undefined || rTile === undefined) throw new Error('缺少出廠集合格')
    expect(rTile).toEqual({ x: last - bTile.x, y: last - bTile.y })
  })

  it('編組遲滯：邊界單位小幅移動不換隊；大幅移動才換', () => {
    const buildWorld = () => {
      const world = worldWithBases()
      // 兩群（k=2）：左群 (4,4)(4,5)(5,4)、右群 (12,4)(12,5)(13,4) + 邊界單位 (8,4)。
      for (const tile of [{ x: 4, y: 4 }, { x: 4, y: 5 }, { x: 5, y: 4 }]) {
        putUnit(world, 'player', 'u', tile)
      }
      for (const tile of [{ x: 12, y: 4 }, { x: 12, y: 5 }, { x: 13, y: 4 }]) {
        putUnit(world, 'player', 'u', tile)
      }
      const boundaryId = putUnit(world, 'player', 'u', { x: 8, y: 4 })
      return { world, boundaryId }
    }
    const indexOfUnit = (plan: TacticalPlan, id: number): number | null =>
      plan.squads.find((squad) => squad.memberIds.includes(id))?.index ?? null
    const policies = resolvePolicies({ clusterSpread: 0.67 }) // k=2

    // 小幅朝右群移 1 格：遲滯裕度內 → 留原隊。
    const a = buildWorld()
    const firstA = computeTacticalPlan(a.world, 'player', policies)
    const beforeA = indexOfUnit(firstA, a.boundaryId)
    expect(beforeA).not.toBeNull()
    const boundaryA = a.world.units.find((unit) => unit.id === a.boundaryId)
    if (boundaryA === undefined) throw new Error('找不到邊界單位')
    boundaryA.x += UNITS_PER_TILE // 右移 1 格
    const secondA = computeTacticalPlan(a.world, 'player', policies, firstA)
    expect(indexOfUnit(secondA, a.boundaryId)).toBe(beforeA) // 不換隊

    // 大幅移入右群（距原隊很遠）→ 允許換隊。
    const b = buildWorld()
    const firstB = computeTacticalPlan(b.world, 'player', policies)
    const boundaryB = b.world.units.find((unit) => unit.id === b.boundaryId)
    if (boundaryB === undefined) throw new Error('找不到邊界單位')
    boundaryB.x += 4 * UNITS_PER_TILE // 右移 4 格
    const secondB = computeTacticalPlan(b.world, 'player', policies, firstB)
    expect(indexOfUnit(secondB, b.boundaryId)).not.toBe(indexOfUnit(firstB, b.boundaryId))
  })

  it('聚類索引空間：空群不位移非空群的索引（warm start／遲滯跨循環對齊）', () => {
    const world = worldWithBases()
    // 6 單位分兩團（左 (4,4) 附近、右 (20,20) 附近）；群 1 的種子在遠處 → 必為空群。
    const leftIds = [
      putUnit(world, 'player', 'u', { x: 4, y: 4 }),
      putUnit(world, 'player', 'u', { x: 4, y: 5 }),
      putUnit(world, 'player', 'u', { x: 5, y: 4 }),
    ]
    const rightIds = [
      putUnit(world, 'player', 'u', { x: 20, y: 20 }),
      putUnit(world, 'player', 'u', { x: 20, y: 21 }),
      putUnit(world, 'player', 'u', { x: 21, y: 20 }),
    ]
    const ready = [...leftIds, ...rightIds].map(
      (id) => world.units.find((unit) => unit.id === id)!,
    )
    const seedCenters: TilePos[] = [
      { x: 4, y: 4 },
      { x: 30, y: 30 }, // 附近無兵 → 群 1 空
      { x: 20, y: 20 },
    ]
    const previousIndex = new Map<number, number>()
    for (const id of leftIds) previousIndex.set(id, 0)
    for (const id of rightIds) previousIndex.set(id, 2)
    const groups = groupByProximity(ready, 3, 18, seedCenters, previousIndex)
    // 回傳群數＝請求數（保留群索引空間）：群 1 空、右群留在索引 2（不壓縮成 1）——
    // 這是 warm start／遲滯跨循環對齊的前提（先前版本會把非空群重新編號而失準）。
    expect(groups).toHaveLength(3)
    expect(groups[1]).toHaveLength(0)
    expect(groups[0]?.length).toBeGreaterThan(0)
    expect(groups[2]?.length).toBeGreaterThan(0)
  })

  it('空群不位移小隊索引（warm start 對齊、紅藍公平性回歸）', () => {
    // 三團（左／中／右）、clusterSpread=1/3 → 目標隊數 3。
    const world = worldWithBases()
    for (const tile of [{ x: 4, y: 4 }, { x: 4, y: 5 }]) {
      putUnit(world, 'player', 'u', tile)
    }
    const midIds = [
      putUnit(world, 'player', 'u', { x: 12, y: 12 }),
      putUnit(world, 'player', 'u', { x: 12, y: 13 }),
    ]
    const rightIds = [
      putUnit(world, 'player', 'u', { x: 20, y: 20 }),
      putUnit(world, 'player', 'u', { x: 20, y: 21 }),
    ]
    const policies = resolvePolicies({ clusterSpread: 1 / 3 })
    const indexOfUnit = (plan: TacticalPlan, id: number): number | null =>
      plan.squads.find((squad) => squad.memberIds.includes(id))?.index ?? null

    const first = computeTacticalPlan(world, 'player', policies)
    // 中團與右團的索引（應為 1 與 2）。
    const rightBefore = indexOfUnit(first, rightIds[0]!)
    expect(indexOfUnit(first, midIds[0]!)).toBe(1)
    expect(rightBefore).toBe(2)

    // 把中團移到左團旁 → 下一循環中群變空群。
    for (const id of midIds) {
      const unit = world.units.find((candidate) => candidate.id === id)
      if (unit === undefined) throw new Error('找不到中團單位')
      unit.x = 5 * UNITS_PER_TILE
      unit.y = 4 * UNITS_PER_TILE
    }
    const second = computeTacticalPlan(world, 'player', policies, first)
    // 右團仍應留在索引 2（不因空群被壓縮成 1）；沒有任何小隊佔用空群的索引 1。
    expect(indexOfUnit(second, rightIds[0]!)).toBe(rightBefore)
    expect(second.squads.some((squad) => squad.index === 1)).toBe(false)
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

describe('交戰評估（打不贏就騷擾／守家，Prompt 10.8）', () => {
  it('評估比例常數 0.9', () => {
    expect(ENGAGE_POWER_RATIO).toBe(0.9)
  })

  it('攔截打不贏（1 守 vs 3 來襲）→ 守在受威脅建築旁（不前出攔截）', () => {
    const world = worldWithBases()
    addBuilding(world, 'player', 'mine', { x: 8, y: 8 }, { built: true, nodeId: null })
    putUnit(world, 'player', 'u', { x: 3, y: 3 })
    putUnit(world, 'enemy', 'u', { x: 11, y: 8 })
    putUnit(world, 'enemy', 'u', { x: 11, y: 9 })
    putUnit(world, 'enemy', 'u', { x: 12, y: 8 })

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    const squad = plan.squads[0]
    expect(squad?.mission).toBe('defend')
    const tx = squad?.target.x ?? -99
    const ty = squad?.target.y ?? -99
    // 守在礦場 (8,8) 旁（1 v 3 殺不掉，等待支援），不是攔截點 (11,8)。
    expect(Math.abs(tx - 8)).toBeLessThanOrEqual(2)
    expect(Math.abs(ty - 8)).toBeLessThanOrEqual(2)
    expect(squad?.target).not.toEqual({ x: 11, y: 8 })
  })

  it('全近戰 vs 全遠程來襲 → 殺不掉（會被風箏），守建築等待遠程支援', () => {
    const RAIDER = makeUnitDef({ id: 'raider', role: 'ranged' })
    const world = createTestWorld({ size: 32, units: [UNIT, RAIDER], buildings: [KEEP, MINE] })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'player', 'mine', { x: 8, y: 8 }, { built: true, nodeId: null })
    putUnit(world, 'player', 'u', { x: 3, y: 3 })
    putUnit(world, 'player', 'u', { x: 3, y: 4 })
    putUnit(world, 'enemy', 'raider', { x: 11, y: 8 })
    putUnit(world, 'enemy', 'raider', { x: 11, y: 9 })

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    expect(plan.squads.length).toBeGreaterThan(0)
    for (const squad of plan.squads) {
      expect(squad.mission).toBe('defend')
      expect(Math.abs(squad.target.x - 8)).toBeLessThanOrEqual(2) // 守在礦場旁
      expect(Math.abs(squad.target.y - 8)).toBeLessThanOrEqual(2)
      expect(squad.target).not.toEqual({ x: 11, y: 8 }) // 不前出攔截
    }
  })

  it('已投入戰場（貼近目標）的攻擊隊打不贏 → 降級 harass（不中途翻 stage，Prompt 10.8）', () => {
    const RAIDER = makeUnitDef({ id: 'raider', role: 'ranged' })
    const world = createTestWorld({ size: 32, units: [UNIT, RAIDER], buildings: [KEEP, MINE] })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    const econMine = addBuilding(world, 'enemy', 'mine', { x: 20, y: 20 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
    // 敵主堡守軍 = 全遠程 raider（近戰殺不掉）。我方 6 兵聚攏在 (24,24)：
    // 重心離主堡重心 (29,29) 約 7 格 ≤ 8 → 視為已投入戰場，跳過波次門檻，
    // 走 10.8 降級鏈（攻不動 → 改打敵方經濟），不翻 stage 開打一半掉頭。
    for (const tile of [
      { x: 23, y: 24 },
      { x: 24, y: 23 },
      { x: 24, y: 24 },
      { x: 24, y: 25 },
      { x: 25, y: 24 },
      { x: 25, y: 25 },
    ]) {
      putUnit(world, 'player', 'u', tile)
    }
    // 守軍全部在小隊重心 6 格（接觸注意半徑）**之外** → 不觸發接觸重評估覆寫目標。
    for (const tile of [{ x: 30, y: 28 }, { x: 31, y: 28 }, { x: 31, y: 29 }]) {
      putUnit(world, 'enemy', 'raider', tile)
    }
    // 敵礦場旁 2 守軍（第一目標評分仍選高價值主堡，評估後降級改打礦場）。
    // 視野（9.5b）：守軍位置改放 (20,19)/(19,20)——距我方 (23,24) 單位 5–6 格
    // 可見（不可見時礦場在目標評分「看似無防守」反而搶走高價值主堡）、
    // 距小隊重心 6.6 格仍在接觸半徑外、距礦場中心 2.2 格仍在守備半徑內。
    putUnit(world, 'enemy', 'u', { x: 20, y: 19 })
    putUnit(world, 'enemy', 'u', { x: 19, y: 20 })

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1, clusterSpread: 1 }))
    const squad = plan.squads[0]
    expect(squad?.mission).toBe('harass')
    expect(squad?.targetBuildingId).toBe(econMine.id) // 改打敵方經濟（水晶）
  })

  it('未達攻擊波次門檻（無生產建築）→ stage 集結待戰（退回集結點錨，Prompt 10.21）', () => {
    const world = worldWithBases()
    putUnit(world, 'player', 'u', { x: 6, y: 6 }) // 1 兵 vs 主堡守軍 3 名：門檻不過、非決定性
    for (const tile of [{ x: 26, y: 26 }, { x: 27, y: 26 }, { x: 26, y: 27 }]) {
      putUnit(world, 'enemy', 'u', tile)
    }

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1, clusterSpread: 1 }))
    const squad = plan.squads[0]
    expect(squad?.mission).toBe('stage')
    expect(squad?.target).toEqual(plan.rally) // 無生產建築 → 集結點即蓄兵錨
    expect(squad?.targetBuildingId).toBeNull()
  })

  it('多點蓄兵：stage 隊回最近生產建築的蓄兵錨格（不湧回單一集結點，Prompt 10.21 B 版）', () => {
    const world = worldWithSpawns()
    // 敵主堡守軍 5 名 → 2 兵過不了門檻也殺不掉 → stage。
    for (const tile of [
      { x: 26, y: 26 },
      { x: 27, y: 26 },
      { x: 26, y: 27 },
      { x: 27, y: 27 },
      { x: 25, y: 26 },
    ]) {
      putUnit(world, 'enemy', 'u', tile)
    }
    // 新兵在自家兵營（6,2）附近出爐。
    putUnit(world, 'player', 'u', { x: 5, y: 5 })
    putUnit(world, 'player', 'u', { x: 5, y: 6 })

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1, clusterSpread: 1 }))
    const squad = plan.squads[0]
    expect(squad?.mission).toBe('stage')
    // 自家產生單位的建築只有兵營 → 蓄兵錨 = 兵營的出廠集合格（非集結點）。
    expect(plan.spawns).toHaveLength(1)
    expect(squad?.target).toEqual(plan.spawns[0]?.tile)
    expect(squad?.target).not.toEqual(plan.rally)
  })

  it('蓄兵 cohort 共享門檻：個別隊殺不掉、合軍成軍 → 同循環全部出擊（消單隊上限死鎖）', () => {
    const world = worldWithBases()
    // 12 個我方新兵（clusterSpread 0 → 單隊上限 4 → 拆成多支 3~4 兵小隊）。
    for (let index = 0; index < 12; index++) {
      putUnit(world, 'player', 'u', { x: 4 + (index % 3), y: 4 + Math.floor(index / 3) })
    }
    // 敵主堡守軍 12 名：個別 3~4 兵隊殺不掉；cohort 12 兵（≥ 0.9 × 12 守）成軍 → 全部出擊。
    for (const tile of [
      { x: 26, y: 26 },
      { x: 27, y: 26 },
      { x: 26, y: 27 },
      { x: 27, y: 27 },
      { x: 25, y: 26 },
      { x: 25, y: 27 },
      { x: 25, y: 25 },
      { x: 26, y: 25 },
      { x: 25, y: 24 },
      { x: 26, y: 24 },
      { x: 27, y: 24 },
      { x: 27, y: 25 },
    ]) {
      putUnit(world, 'enemy', 'u', tile)
    }

    // reserve 0：本測試驗證 cohort 出擊（Prompt 10.21），與 Prompt 6 戰力留守無關。
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1, clusterSpread: 0, reserve: 0 }))
    expect(plan.squads.length).toBeGreaterThanOrEqual(3)
    for (const squad of plan.squads) {
      expect(squad.mission).toBe('attack')
      expect(squad.targetBuildingId).not.toBeNull()
    }
  })

  it('cohort 未成軍 → 多支小隊全部 stage 在同一蓄兵錨（等支援，不添油）', () => {
    const world = worldWithBases()
    for (let index = 0; index < 6; index++) {
      putUnit(world, 'player', 'u', { x: 4 + (index % 3), y: 4 + Math.floor(index / 3) })
    }
    // 敵主堡守軍 18 名：6 兵 cohort 仍殺不掉（0.9 × 18 > 6）→ 全體 stage 等支援。
    for (const tile of [
      { x: 26, y: 26 },
      { x: 27, y: 26 },
      { x: 26, y: 27 },
      { x: 27, y: 27 },
      { x: 25, y: 26 },
      { x: 25, y: 27 },
      { x: 25, y: 25 },
      { x: 26, y: 25 },
      { x: 25, y: 24 },
      { x: 26, y: 24 },
      { x: 27, y: 24 },
      { x: 27, y: 25 },
      { x: 25, y: 28 },
      { x: 26, y: 28 },
      { x: 25, y: 29 },
      { x: 26, y: 29 },
      { x: 27, y: 28 },
      { x: 27, y: 29 },
    ]) {
      putUnit(world, 'enemy', 'u', tile)
    }

    // reserve 0：本測試驗證 stage 蓄兵（Prompt 10.21），與 Prompt 6 戰力留守無關。
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1, clusterSpread: 0, reserve: 0 }))
    expect(plan.squads.length).toBeGreaterThanOrEqual(2)
    for (const squad of plan.squads) {
      expect(squad.mission).toBe('stage')
      expect(squad.target).toEqual(plan.rally) // 無生產建築 → 集結點即蓄兵錨
      expect(squad.targetBuildingId).toBeNull()
    }
  })

  it('波次門檻公式（Prompt 10.21）：clusterSpread 內插 550..1100 milli', () => {
    expect(waveRatioMilli(resolvePolicies({ clusterSpread: 0 }))).toBe(550)
    expect(waveRatioMilli(resolvePolicies({ clusterSpread: 0.5 }))).toBe(825)
    expect(waveRatioMilli(resolvePolicies({ clusterSpread: 1 }))).toBe(1100)
  })

  it('戰力過波次門檻且殺得掉守軍 → 正常進攻（不 stage）', () => {
    const world = worldWithBases()
    for (let index = 0; index < 6; index++) {
      putUnit(world, 'player', 'u', { x: 4 + (index % 3), y: 4 + Math.floor(index / 3) })
    }
    for (const tile of [{ x: 26, y: 26 }, { x: 27, y: 26 }, { x: 26, y: 27 }]) {
      putUnit(world, 'enemy', 'u', tile)
    }

    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1, clusterSpread: 1 }))
    const squad = plan.squads[0]
    expect(squad?.mission).toBe('attack')
    expect(squad?.targetBuildingId).not.toBeNull()
  })
})

describe('突變期（Prompt 10.23：對稱局的確定破局壓力）', () => {
  it('階段邊界：7199 none ／ 7200 ramp ／ 10799 ramp ／ 10800 allin', () => {
    expect(suddenDeathStage(SUDDEN_DEATH_START_TICK - 1)).toBe('none')
    expect(suddenDeathStage(SUDDEN_DEATH_START_TICK)).toBe('ramp')
    expect(suddenDeathStage(SUDDEN_DEATH_HARD_TICK - 1)).toBe('ramp')
    expect(suddenDeathStage(SUDDEN_DEATH_HARD_TICK)).toBe('allin')
  })

  it('門檻乘數遞減：1000 → 750 → 563 → 422（每 1200 tick ×0.75，全整數 milli）', () => {
    expect(suddenDeathMultiplierMilli(SUDDEN_DEATH_START_TICK - 1)).toBe(1000)
    expect(suddenDeathMultiplierMilli(SUDDEN_DEATH_START_TICK)).toBe(750)
    expect(suddenDeathMultiplierMilli(SUDDEN_DEATH_START_TICK + SUDDEN_DEATH_STEP_TICKS - 1)).toBe(750)
    expect(suddenDeathMultiplierMilli(SUDDEN_DEATH_START_TICK + SUDDEN_DEATH_STEP_TICKS)).toBe(563)
    expect(suddenDeathMultiplierMilli(SUDDEN_DEATH_START_TICK + 2 * SUDDEN_DEATH_STEP_TICKS)).toBe(422)
    expect(suddenDeathMultiplierMilli(12000)).toBe(422) // 封頂（硬期限由 stage 停用接手）
  })

  it('門檻遞減破局（Prompt 10.23）：同戰力未成軍隊跨該陣營 ramp 相位出擊、相前一 tick 仍 stage', () => {
    // 1 攻擊兵（戰力 100 = 100000 milli）vs 敵主堡旁 1 守軍（100000 milli）：
    // clusterSpread 1 → 門檻 1100 milli 需戰力×1.1 —— 相位前一 tick 未過 → stage；
    // 相位 tick 起乘數 ×0.75 → 門檻 825 milli —— 100000 ≥ 100000×0.825 → attack
    // （且殺得掉守軍：100000 ≥ 100000×0.9）。相位由 hashFate(種子×7200×陣營) 抽出。
    const build = () => {
      const world = worldWithBases()
      putUnit(world, 'player', 'u', { x: 4, y: 4 })
      putUnit(world, 'enemy', 'u', { x: 26, y: 26 })
      return world
    }
    const policies = resolvePolicies({ aggression: 1, clusterSpread: 1 })

    const before = build()
    before.tick = SUDDEN_DEATH_START_TICK - 1
    const beforePlan = computeTacticalPlan(before, 'player', policies)
    expect(beforePlan.squads[0]?.mission).toBe('stage')

    const amp = suddenDeathPhaseTicks(before.seed, SUDDEN_DEATH_START_TICK, 'player')
    expect(amp).toBeGreaterThanOrEqual(0)
    expect(amp).toBeLessThan(SUDDEN_DEATH_PHASE_WINDOW_TICKS)
    const started = build()
    started.tick = SUDDEN_DEATH_START_TICK + amp
    const startedPlan = computeTacticalPlan(started, 'player', policies)
    expect(startedPlan.squads[0]?.mission).toBe('attack')
    expect(startedPlan.squads[0]?.targetBuildingId).not.toBeNull()
  })

  it('破局相位差（Prompt 10.23）：hashFate 抽籤——同種子必同值、窗內、跨陣營可不同', () => {
    const seed = 42
    const blue = suddenDeathPhaseTicks(seed, SUDDEN_DEATH_START_TICK, 'player')
    const red = suddenDeathPhaseTicks(seed, SUDDEN_DEATH_START_TICK, 'enemy')
    expect(suddenDeathPhaseTicks(seed, SUDDEN_DEATH_START_TICK, 'player')).toBe(blue) // 確定
    expect(suddenDeathPhaseTicks(seed, SUDDEN_DEATH_HARD_TICK, 'player')).toBe(
      suddenDeathPhaseTicks(seed, SUDDEN_DEATH_HARD_TICK, 'player'),
    )
    expect(blue).toBeGreaterThanOrEqual(0)
    expect(red).toBeLessThan(SUDDEN_DEATH_PHASE_WINDOW_TICKS)
    // 至少一個錨點上兩陣相位不同（否則破局失效——hashFate avalanche 保證常見）。
    const differingAnchors =
      (suddenDeathPhaseTicks(seed, SUDDEN_DEATH_START_TICK, 'player') !==
        suddenDeathPhaseTicks(seed, SUDDEN_DEATH_START_TICK, 'enemy') ? 1 : 0) +
      (suddenDeathPhaseTicks(seed, SUDDEN_DEATH_HARD_TICK, 'player') !==
        suddenDeathPhaseTicks(seed, SUDDEN_DEATH_HARD_TICK, 'enemy') ? 1 : 0)
    expect(differingAnchors).toBeGreaterThanOrEqual(1)
  })

  it('硬期限（按本陣營 hard 相位）：stage 停用——未成軍隊不再轉蓄兵、全軍壓上', () => {
    // 6 兵 vs 敵主堡 18 守軍：任何乘數都過不了「殺得掉守軍」→ 7199 全體 stage；
    // 硬期限後 gate 與殺傷評估全跳過（未 committed）→ 各隊 attack。
    const build = () => {
      const world = worldWithBases()
      for (let index = 0; index < 6; index++) {
        putUnit(world, 'player', 'u', { x: 4 + (index % 3), y: 4 + Math.floor(index / 3) })
      }
      for (const tile of [
        { x: 26, y: 26 },
        { x: 27, y: 26 },
        { x: 26, y: 27 },
        { x: 27, y: 27 },
        { x: 25, y: 26 },
        { x: 25, y: 27 },
        { x: 25, y: 25 },
        { x: 26, y: 25 },
        { x: 25, y: 24 },
        { x: 26, y: 24 },
        { x: 27, y: 24 },
        { x: 27, y: 25 },
        { x: 25, y: 28 },
        { x: 26, y: 28 },
        { x: 25, y: 29 },
        { x: 26, y: 29 },
        { x: 27, y: 28 },
        { x: 27, y: 29 },
      ]) {
        putUnit(world, 'enemy', 'u', tile)
      }
      return world
    }
    const policies = resolvePolicies({ aggression: 1, clusterSpread: 0, reserve: 0 })

    const before = build()
    before.tick = SUDDEN_DEATH_START_TICK - 1
    const beforePlan = computeTacticalPlan(before, 'player', policies)
    expect(beforePlan.squads.length).toBeGreaterThanOrEqual(2)
    for (const squad of beforePlan.squads) expect(squad.mission).toBe('stage')

    const deadline = build()
    deadline.tick = SUDDEN_DEATH_HARD_TICK + suddenDeathPhaseTicks(deadline.seed, SUDDEN_DEATH_HARD_TICK, 'player')
    const deadlinePlan = computeTacticalPlan(deadline, 'player', policies)
    for (const squad of deadlinePlan.squads) {
      expect(squad.mission).toBe('attack')
      expect(squad.targetBuildingId).not.toBeNull()
    }
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
    // 遠方敵軍（敵我 1:1，加成 0）——測「附近無敵不撤退」，不是「全圖無敵」。
    putUnit(world, 'enemy', 'u', { x: 28, y: 28 })
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    expect(plan.squads[0]?.mission).toBe('defend')
  })

  it('個體 hp < retreatHpPct（JSON 0.2）→ 脫離戰鬥、補進守備隊（Prompt 9.4 傷兵補位）', () => {
    const world = worldWithBases()
    const hurt = putUnit(world, 'player', 'u', { x: 4, y: 4 })
    const fine = putUnit(world, 'player', 'u', { x: 5, y: 4 })
    const fine2 = putUnit(world, 'player', 'u', { x: 6, y: 4 })
    // 遠方敵軍（3 名 ≥ 我方有效戰力 2.15，加成 0）→ 維持平衡編制可測補位。
    for (const tile of [{ x: 28, y: 28 }, { x: 29, y: 28 }, { x: 30, y: 29 }]) {
      putUnit(world, 'enemy', 'u', tile)
    }
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
    // 遠方敵軍（2 名 ≥ 我方有效戰力 1.1，加成 0）→ 維持純守備編制可測補位。
    putUnit(world, 'enemy', 'u', { x: 28, y: 28 })
    putUnit(world, 'enemy', 'u', { x: 29, y: 29 })
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

describe('塔火接觸與求援（Prompt 10.24 D：塔對舊版 AI 是隱形的）', () => {
  const TOWER = makeBuildingDef({
    id: 'tower',
    size: [2, 2],
    ai: { value: 400 },
    defense: { dmg: 10, range: 4.0, attackSpeed: 0.5 },
  })
  /** 巨塔：dmg 5000 → 威脅 2500 戰力，6 兵（600）殺不掉。 */
  const BIG_TOWER = makeBuildingDef({
    id: 'tower',
    size: [2, 2],
    ai: { value: 400 },
    defense: { dmg: 5000, range: 4.0, attackSpeed: 0.5 },
  })

  function towerWorld(tower: typeof TOWER): { world: World; tower: ReturnType<typeof addBuilding> } {
    const world = createTestWorld({
      size: 32,
      units: [UNIT],
      buildings: [KEEP, MINE, tower],
    })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
    const placed = addBuilding(world, 'enemy', 'tower', { x: 8, y: 4 }, { built: true, nodeId: null })
    // 藍 6 兵聚在塔射程邊（重心距塔外框 ~1.5 格）
    for (const tile of [
      { x: 5, y: 4 },
      { x: 5, y: 5 },
      { x: 6, y: 4 },
      { x: 6, y: 5 },
      { x: 6, y: 6 },
      { x: 5, y: 6 },
    ]) {
      putUnit(world, 'player', 'u', tile)
    }
    return { world, tower: placed }
  }

  it('塔火覆蓋小隊重心 → 視為接觸；殺得掉 → 迎戰目標改塔（targetBuildingId = 塔 id）', () => {
    const { world, tower } = towerWorld(TOWER)
    world.tick = 200 // 越過接觸重評冷卻（60 tick），首個接觸循環才能評估
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 1 }))
    const sieging = plan.squads.find((squad) => squad.targetBuildingId === tower.id)
    expect(sieging).toBeDefined()
    expect(sieging?.engaging).toBe(true)
    expect(sieging?.target.x).toBeGreaterThanOrEqual(6) // 攻城接近格貼著塔（8,4）
    expect(sieging?.target.x).toBeLessThanOrEqual(10)
    expect((plan.events ?? []).some((event) => event.outcome === 'engage')).toBe(true)
  })

  it('塔火殺不掉且無友隊響應 → 小隊撤退重整（不再維持原命令站樁）', () => {
    const { world } = towerWorld(BIG_TOWER)
    // 敵 12 兵守後場 → 我方戰力劣勢 → 預設任務 defend（撤退改判只對 defend/stage 適用）
    for (const tile of [
      { x: 25, y: 26 }, { x: 26, y: 26 }, { x: 27, y: 26 }, { x: 28, y: 26 },
      { x: 25, y: 27 }, { x: 26, y: 27 }, { x: 27, y: 27 }, { x: 28, y: 27 },
      { x: 25, y: 28 }, { x: 26, y: 28 }, { x: 27, y: 28 }, { x: 28, y: 28 },
    ]) {
      putUnit(world, 'enemy', 'u', tile)
    }
    world.tick = 200
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    expect(plan.squads.length).toBeGreaterThanOrEqual(1)
    for (const squad of plan.squads) {
      expect(squad.mission).toBe('retreat')
    }
    expect((plan.events ?? []).some((event) => event.outcome === 'keep')).toBe(true)
  })

  it('防守隊也響應夾擊呼叫（受襲點就在隔壁時不再袖手旁觀）', () => {
    const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP, MINE] })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
    // 受襲小隊 A：1 兵在 (10,10)，敵 3 兵貼著（戰力 100 vs 300 → 殺不掉）
    const aId = putUnit(world, 'player', 'u', { x: 10, y: 10 })
    for (const tile of [{ x: 8, y: 10 }, { x: 8, y: 11 }, { x: 9, y: 10 }]) {
      putUnit(world, 'enemy', 'u', tile)
    }
    // 接應小隊 B：6 兵在 (19..20,10..11)（重心距 A ~11.5 格 < 接應半徑 12、
    // 殺得掉 300 戰力）
    for (const tile of [
      { x: 19, y: 10 },
      { x: 20, y: 10 },
      { x: 19, y: 11 },
      { x: 20, y: 11 },
      { x: 19, y: 10 },
      { x: 20, y: 11 },
    ]) {
      putUnit(world, 'player', 'u', tile)
    }
    world.tick = 200
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    expect((plan.events ?? []).some((event) => event.outcome === 'pincer')).toBe(true)
    expect(plan.squads.some((squad) => squad.engaging === true)).toBe(true)
    // A 已有響應 → 不誤觸「無響應撤退」
    const lone = plan.squads.find((squad) => squad.memberIds.includes(aId))
    expect(lone?.mission).not.toBe('retreat')
  })
})

/* ------------------------------------------------------------------ */
/* 戰力留守與撤退閾值（階段三 Prompt 6）                                  */
/* ------------------------------------------------------------------ */

describe('戰力留守（Prompt 6 reserve：攻擊份額乘數 ×2×(1−reserve)）', () => {
  const UNIT = makeUnitDef({ id: 'u' })
  const KEEP = makeBuildingDef({ id: 'keep', size: [3, 3], ai: { value: 1000 } })

  /** 對稱世界（無攻勢加成）：玩家 8 兵、clusterSpread 0 → 4 隊 2 兵。 */
  function fourSquadWorld(): World {
    const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP] })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
    // 敵我戰力對等（加成 0）。
    putUnit(world, 'enemy', 'u', { x: 27, y: 27 })
    for (let index = 0; index < 8; index++) {
      putUnit(world, 'player', 'u', { x: 3 + (index % 4), y: 3 + Math.floor(index / 4) })
    }
    return world
  }

  it('reserve=0.5（預設）：與 aggression 編制一致（aggression 1 → 全軍出擊）', () => {
    const plan = computeTacticalPlan(
      fourSquadWorld(),
      'player',
      resolvePolicies({ aggression: 1, clusterSpread: 0, reserve: 0.5 }),
    )
    // 乘數 ×2×0.5 = 1 → attackCount = 4×1 = 4（零偏移）。
    expect(plan.squads.every((squad) => squad.mission !== 'defend')).toBe(true)
  })

  it('reserve=1：全軍留守（attackCount 歸 0）', () => {
    const plan = computeTacticalPlan(
      fourSquadWorld(),
      'player',
      resolvePolicies({ aggression: 1, clusterSpread: 0, reserve: 1 }),
    )
    expect(plan.squads.every((squad) => squad.mission === 'defend')).toBe(true)
  })

  it('reserve=0：攻擊份額 ×2（aggression 0.5 → 全軍出擊）', () => {
    const plan = computeTacticalPlan(
      fourSquadWorld(),
      'player',
      resolvePolicies({ aggression: 0.5, clusterSpread: 0, reserve: 0 }),
    )
    expect(plan.squads.every((squad) => squad.mission !== 'defend')).toBe(true)
  })

  it('敵方無單位（全軍出擊加成）→ reserve 不削減（10.18 語義保留）', () => {
    const world = createTestWorld({ size: 32, units: [UNIT], buildings: [KEEP] })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
    for (const tile of [
      { x: 3, y: 3 },
      { x: 4, y: 3 },
    ]) {
      putUnit(world, 'player', 'u', tile)
    }
    const plan = computeTacticalPlan(
      world,
      'player',
      resolvePolicies({ aggression: 0.2, clusterSpread: 0, reserve: 0.9 }),
    )
    expect(plan.squads.every((squad) => squad.mission !== 'defend')).toBe(true)
  })

  it('純函數：aggression 1 × reserve 0.75 → 份額 0.5（2/4 隊出擊，其一為騷擾）', () => {
    // share = 1 × 2×(1−0.75) = 0.5 → attackCount = round(4×0.5) = 2；≥2 → 派 1 騷擾。
    expect(assignMissions(4, resolvePolicies({ aggression: 1, reserve: 0.75 })).join(',')).toBe(
      'harass,attack,defend,defend',
    )
  })
})

describe('撤退閾值映射（Prompt 6 #8：parity 乘法）', () => {
  const UNIT = makeUnitDef({ id: 'u' })

  it('retreatThreshold=0.5 → 小隊比 0.7、個體因子 1.0（與舊常數完全一致）', () => {
    const world = createTestWorld({ size: 12, units: [UNIT], buildings: [] })
    const plan = computeTacticalPlan(world, 'player', DEFAULT_POLICIES)
    expect(plan.squadRetreatRatio).toBeCloseTo(0.7, 10)
    expect(plan.retreatHpFactor).toBeCloseTo(1.0, 10)
  })

  it('retreatThreshold=0 → 更敢戰（比 0.35、因子 0.4）；=1 → 死戰（比 1.05、因子 1.6）', () => {
    const world = createTestWorld({ size: 12, units: [UNIT], buildings: [] })
    const brave = computeTacticalPlan(world, 'player', resolvePolicies({ retreatThreshold: 0 }))
    expect(brave.squadRetreatRatio).toBeCloseTo(0.7 * 0.5, 10)
    expect(brave.retreatHpFactor).toBeCloseTo(0.4, 10)
    const timid = computeTacticalPlan(world, 'player', resolvePolicies({ retreatThreshold: 1 }))
    expect(timid.squadRetreatRatio).toBeCloseTo(0.7 * 1.5, 10)
    expect(timid.retreatHpFactor).toBeCloseTo(1.6, 10)
  })

  it('retreatThreshold 兩端：劣勢邊緣上 timid 撤、brave 戰（映射方向驗證）', () => {
    const world = createTestWorld({
      size: 32,
      units: [UNIT],
      buildings: [makeBuildingDef({ id: 'keep', size: [3, 3], ai: { value: 1000 } })],
    })
    addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 28, y: 28 }, { built: true, nodeId: null })
    putUnit(world, 'player', 'u', { x: 10, y: 10 })
    // 敵 2 兵鄰格 → 重心威脅 ≈ 100（= 我方戰力）：臨界劣勢。
    putUnit(world, 'enemy', 'u', { x: 11, y: 10 })
    putUnit(world, 'enemy', 'u', { x: 10, y: 11 })
    // threshold 1（比 1.05）：100 × 1.05 > 100 → 撤。
    const timid = computeTacticalPlan(
      world,
      'player',
      resolvePolicies({ aggression: 1, clusterSpread: 1, reserve: 0, retreatThreshold: 1 }),
    )
    expect(timid.squads[0]?.mission).toBe('retreat')
    // threshold 0（比 0.35）：100 × 0.35 < 100 → 戰。
    const brave = computeTacticalPlan(
      world,
      'player',
      resolvePolicies({ aggression: 1, clusterSpread: 1, reserve: 0, retreatThreshold: 0 }),
    )
    expect(brave.squads[0]?.mission).not.toBe('retreat')
  })
})
