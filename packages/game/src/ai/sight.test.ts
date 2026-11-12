import { describe, expect, it } from 'vitest'

import {
  BUILDING_SIGHT_TILES,
  UNIT_SIGHT_TILES,
  buildingSightTiles,
  isVisibleTo,
  visibleTileMask,
} from './sight.ts'
import { DEFENSE_RADIUS_TILES } from './influence.ts'
import {
  createTestWorld,
  makeBuildingDef,
  makeUnitDef,
  putUnit,
} from '../sim/testFixtures.ts'
import { addBuilding } from '../sim/economy.ts'
import type { World } from '../sim/types.ts'

/**
 * 視野測試（Prompt 9.5b 驗收）：
 * - 單位 6 格（= DEFENSE_RADIUS_TILES）、塔 = 防禦射程 + 2、其餘建築 6 格
 * - 整數距離平方幾何、邊界精確
 * - 無記憶：純函式、同世界重算一致
 * - 鏡像對稱：鏡射位置的可見性互為鏡像
 */

/** 合成世界：一個 1×1 建築定義 + 一個單位定義；地圖 32×32（與正式對局同）。 */
function sightWorld(): World {
  return createTestWorld({
    size: 32,
    units: [makeUnitDef({ id: 'u' })],
    buildings: [makeBuildingDef({ id: 'b' })],
  })
}

describe('視野半徑（Prompt 9.5b）', () => {
  it('單位視野 = 6 = DEFENSE_RADIUS_TILES（守得住 = 看得到）', () => {
    expect(UNIT_SIGHT_TILES).toBe(6)
    expect(UNIT_SIGHT_TILES).toBe(DEFENSE_RADIUS_TILES)
    expect(BUILDING_SIGHT_TILES).toBe(6)
  })

  it('帶 defense 的建築（塔）視野 = 射程 + 2；無 defense = 6', () => {
    const world = sightWorld()
    world.defs.buildings.b = makeBuildingDef({
      id: 'b',
      defense: { dmg: 10, range: 4.0, attackSpeed: 0.5 },
    })
    expect(buildingSightTiles(world, 'b')).toBe(6) // 4 + 2
    world.defs.buildings.b = makeBuildingDef({
      id: 'b',
      defense: { dmg: 10, range: 5.5, attackSpeed: 0.5 },
    })
    expect(buildingSightTiles(world, 'b')).toBe(8) // round(5.5) + 2
    world.defs.buildings.b = makeBuildingDef({ id: 'b' }) // 無 defense
    expect(buildingSightTiles(world, 'b')).toBe(6)
  })
})

describe('isVisibleTo（整數距離平方幾何）', () => {
  it('單位 6 格內可見、> 6 格不可見；邊界精確（格中心到格中心）', () => {
    const world = sightWorld()
    putUnit(world, 'player', 'u', { x: 10, y: 10 })
    // 同格 → 可見；恰好 6 格（(16,10) 與 (10,10) 距 6 格）→ 可見；
    // 6.03 格 → 不可見。
    expect(isVisibleTo(world, 'player', 10 * 200 + 100, 10 * 200 + 100)).toBe(true)
    expect(isVisibleTo(world, 'player', 16 * 200 + 100, 10 * 200 + 100)).toBe(true)
    expect(isVisibleTo(world, 'player', 17 * 200 + 100, 10 * 200 + 100)).toBe(false)
    // 邊界：固定點距離 = 6 × 200 = 1200 → 可見；1201 → 不可見。
    expect(isVisibleTo(world, 'player', 10 * 200 + 100 + 1200, 10 * 200 + 100)).toBe(true)
    expect(isVisibleTo(world, 'player', 10 * 200 + 100 + 1201, 10 * 200 + 100)).toBe(false)
  })

  it('死亡單位不提供視野；敵方單位不提供我方視野', () => {
    const world = sightWorld()
    const id = putUnit(world, 'player', 'u', { x: 10, y: 10 })
    const unit = world.units.find((candidate) => candidate.id === id)!
    expect(isVisibleTo(world, 'player', 11 * 200 + 100, 10 * 200 + 100)).toBe(true)
    unit.hp = 0
    expect(isVisibleTo(world, 'player', 11 * 200 + 100, 10 * 200 + 100)).toBe(false)
    // 敵方單位在場（不變更可見性——但放在 (10,11) 驗證不提供我方視野）。
    putUnit(world, 'enemy', 'u', { x: 10, y: 11 })
    expect(isVisibleTo(world, 'player', 10 * 200 + 100, 11 * 200 + 100)).toBe(false)
  })

  it('建築視野：以佔地外框邊緣量測；無 defense 建築 6 格', () => {
    const world = sightWorld()
    addBuilding(world, 'player', 'b', { x: 10, y: 10 }, { built: true, nodeId: null })
    // 外框邊緣 = (10*200, 10*200)：緊貼邊緣 → 距離 0 → 可見。
    expect(isVisibleTo(world, 'player', 10 * 200, 10 * 200)).toBe(true)
    // 外框外 6 格（1200 固定點）→ 可見；1201 → 不可見。
    expect(isVisibleTo(world, 'player', 10 * 200 - 1200, 10 * 200)).toBe(true)
    expect(isVisibleTo(world, 'player', 10 * 200 - 1201, 10 * 200)).toBe(false)
  })

  it('鏡像對稱：鏡射單位 + 鏡射目標 → 可見性互為鏡像', () => {
    const world = sightWorld()
    // player 在 (5,7)、enemy 在鏡射格 (26,24)；目標格也互為鏡射。
    putUnit(world, 'player', 'u', { x: 5, y: 7 })
    putUnit(world, 'enemy', 'u', { x: 26, y: 24 })
    const probeA = { x: 6 * 200 + 100, y: 7 * 200 + 100 } // 靠 player
    const probeB = { x: 25 * 200 + 100, y: 24 * 200 + 100 } // 靠 enemy（鏡射 probeA）
    // 對 player：probeA 可見、probeB 不可見；對 enemy：鏡像反過來。
    expect(isVisibleTo(world, 'player', probeA.x, probeA.y)).toBe(true)
    expect(isVisibleTo(world, 'player', probeB.x, probeB.y)).toBe(false)
    expect(isVisibleTo(world, 'enemy', probeB.x, probeB.y)).toBe(true)
    expect(isVisibleTo(world, 'enemy', probeA.x, probeA.y)).toBe(false)
  })
})

describe('visibleTileMask（UI 迷霧層資料）', () => {
  it('32×32 全地圖遮罩；視野圓內 = true、外 = false', () => {
    const world = sightWorld()
    putUnit(world, 'player', 'u', { x: 16, y: 16 })
    const mask = visibleTileMask(world, 'player')
    expect(mask).toHaveLength(32 * 32)
    // 單位所在格與 6 格內的格可見。
    expect(mask[16 * 32 + 16]).toBe(true)
    expect(mask[16 * 32 + 22]).toBe(true) // 恰 6 格
    expect(mask[16 * 32 + 23]).toBe(false) // 7 格
    // 遠角不可見。
    expect(mask[0]).toBe(false)
    expect(mask[31 * 32 + 31]).toBe(false)
  })

  it('無記憶：同世界重算同一結果；單位移走後原處不再可見', () => {
    const world = sightWorld()
    const id = putUnit(world, 'player', 'u', { x: 4, y: 4 })
    const before = visibleTileMask(world, 'player')
    expect(visibleTileMask(world, 'player')).toEqual(before) // 純函式無狀態
    const unit = world.units.find((candidate) => candidate.id === id)!
    unit.x = 20 * 200 + 100
    unit.y = 20 * 200 + 100
    const after = visibleTileMask(world, 'player')
    expect(after[4 * 32 + 4]).toBe(false) // 原地不再可見（無記憶）
    expect(after[20 * 32 + 20]).toBe(true) // 新位置可見
  })
})
