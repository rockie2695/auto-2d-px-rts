import { describe, expect, it } from 'vitest'

import { MAX_RESOURCE } from '@auto-2d-px-rts/shared'

import {
  addBuilding,
  canAfford,
  getIncome,
  getResource,
  placeBuilding,
  queueTrain,
} from './economy.ts'
import {
  createTestWorld,
  makeBuildingDef,
  makeUnitDef,
  putUnit,
} from './testFixtures.ts'
import { getPlayer, INCOME_WINDOW_TICKS } from './types.ts'
import { stepWorld } from './world.ts'

/**
 * 三資源經濟（階段三 Prompt 5）：三礦並行互不干擾、逐資源扣費、
 * 節點類型匹配、getIncome 統計窗、per-resource 上限 9999。
 */

const CRYSTAL_MINE = makeBuildingDef({
  id: 'crystal_mine',
  cost: { blue_crystal: 0 },
  requiresResourceNode: true,
  incomePerSec: { blue_crystal: 1.0 },
})
const RUBY_MINE = makeBuildingDef({
  id: 'ruby_mine',
  cost: { blue_crystal: 0 },
  requiresResourceNode: true,
  incomePerSec: { red_ruby: 0.5 },
})
const EMERALD_MINE = makeBuildingDef({
  id: 'emerald_sanctuary',
  cost: { blue_crystal: 0 },
  requiresResourceNode: true,
  incomePerSec: { green_emerald: 0.25 },
})

/** 三類節點各一（藍 (2,2)、紅 (4,2)、綠 (6,2)），world 直接擺好完工礦場。 */
function threeMinesWorld() {
  const world = createTestWorld({
    size: 12,
    typedResourceNodes: [
      { x: 2, y: 2, resourceType: 'blue_crystal' },
      { x: 4, y: 2, resourceType: 'red_ruby' },
      { x: 6, y: 2, resourceType: 'green_emerald' },
    ],
    buildings: [CRYSTAL_MINE, RUBY_MINE, EMERALD_MINE],
    startCrystal: 1000,
  })
  addBuilding(world, 'player', 'crystal_mine', { x: 2, y: 2 }, { built: true, nodeId: 0 })
  addBuilding(world, 'player', 'ruby_mine', { x: 4, y: 2 }, { built: true, nodeId: 1 })
  addBuilding(world, 'player', 'emerald_sanctuary', { x: 6, y: 2 }, { built: true, nodeId: 2 })
  return world
}

describe('三礦並行（Prompt 5 驗收 2：互不干擾）', () => {
  it('同時結算：藍 1.0/s、紅 0.5/s、綠 0.25/s，各自獨立入帳', () => {
    const world = threeMinesWorld()
    for (let tick = 0; tick < 400; tick++) stepWorld(world) // 20 秒
    const blue = getResource(world, 'player', 'blue_crystal')
    const ruby = getResource(world, 'player', 'red_ruby')
    const emerald = getResource(world, 'player', 'green_emerald')
    // 20Hz × 20s：藍 ≥ 20 − 結算取整、紅 ≥ 10 − 1、綠 ≥ 5 − 1（下限寬鬆、比例鎖定）。
    expect(blue).toBeGreaterThanOrEqual(19)
    expect(ruby).toBeGreaterThanOrEqual(9)
    expect(emerald).toBeGreaterThanOrEqual(4)
    expect(ruby).toBeLessThan(blue) // 0.5 < 1.0
    expect(emerald).toBeLessThan(ruby) // 0.25 < 0.5
  })

  it('getIncome：60 tick（3 秒）窗口內的總入帳（藍 ≈ 3、紅 ≈ 1.5、綠 ≈ 0.75 之取整）', () => {
    const world = threeMinesWorld()
    for (let tick = 0; tick < 200; tick++) stepWorld(world) // 窗已滿、穩態
    const blue = getIncome(world, 'player', 'blue_crystal')
    const ruby = getIncome(world, 'player', 'red_ruby')
    const emerald = getIncome(world, 'player', 'green_emerald')
    // 3 秒期望：藍 1.0/s × 3 = 3、紅 0.5/s × 3 = 1.5（取整 1~2）、綠 0.25/s × 3 = 0.75（0~1）。
    expect(blue).toBeGreaterThanOrEqual(2)
    expect(blue).toBeLessThanOrEqual(4)
    expect(ruby).toBeGreaterThanOrEqual(1)
    expect(ruby).toBeLessThanOrEqual(2)
    expect(emerald).toBeGreaterThanOrEqual(0)
    expect(emerald).toBeLessThanOrEqual(1)
    // 比例關係（窗口內藍 > 紅 ≥ 綠）。
    expect(blue).toBeGreaterThan(ruby)
    expect(INCOME_WINDOW_TICKS).toBe(60)
  })

  it('紅寶石節點耗盡：紅礦收入歸零，藍礦照常（互不干擾）', () => {
    const world = createTestWorld({
      size: 12,
      typedResourceNodes: [
        { x: 2, y: 2, resourceType: 'blue_crystal' },
        { x: 4, y: 2, resourceType: 'red_ruby' },
      ],
      nodeAmount: 2, // 兩節點同量 2：入帳 2 後各自耗盡
      buildings: [CRYSTAL_MINE, RUBY_MINE],
    })
    addBuilding(world, 'player', 'crystal_mine', { x: 2, y: 2 }, { built: true, nodeId: 0 })
    addBuilding(world, 'player', 'ruby_mine', { x: 4, y: 2 }, { built: true, nodeId: 1 })
    for (let tick = 0; tick < 100; tick++) stepWorld(world)
    expect(getResource(world, 'player', 'blue_crystal')).toBe(1000 + 2)
    expect(getResource(world, 'player', 'red_ruby')).toBe(2)
    for (let tick = 0; tick < 100; tick++) stepWorld(world)
    expect(getResource(world, 'player', 'blue_crystal')).toBe(1000 + 2)
    expect(getResource(world, 'player', 'red_ruby')).toBe(2)
  })
})

describe('多資源扣費（Prompt 5 驗收 3：花三資源生兵後庫存正確扣減）', () => {
  const BALLISTA = makeUnitDef({
    id: 'ballista',
    cost: { blue_crystal: 40, red_ruby: 80 },
    trainTimeSec: 1,
  })
  const RAX = makeBuildingDef({
    id: 'rax',
    size: [2, 2],
    cost: { blue_crystal: 0 },
    produces: ['ballista'],
  })

  function ballistaWorld(rubyStock: number) {
    const world = createTestWorld({
      size: 12,
      units: [BALLISTA],
      buildings: [RAX],
      startCrystal: 100,
    })
    const rax = placeBuilding(world, 'player', 'rax', { x: 4, y: 4 })
    expect(rax).not.toBeNull()
    const player = getPlayer(world, 'player')
    player.resources.red_ruby = rubyStock
    return { world, raxId: rax?.id ?? -1, player }
  }

  it('紅寶石足額：排程扣藍 40 ＋ 紅 80，出生不退費', () => {
    const { world, raxId, player } = ballistaWorld(80)
    expect(queueTrain(world, raxId, 'ballista')).toBe(true)
    expect(player.resources.blue_crystal).toBe(60)
    expect(player.resources.red_ruby).toBe(0)
    for (let tick = 0; tick < 30; tick++) stepWorld(world)
    expect(player.unitCount).toBe(1)
    expect(player.resources.blue_crystal).toBe(60)
    expect(player.resources.red_ruby).toBe(0)
  })

  it('紅寶石不足（79 < 80）：拒絕排程、分毫未扣', () => {
    const { world, raxId, player } = ballistaWorld(79)
    expect(queueTrain(world, raxId, 'ballista')).toBe(false)
    expect(player.resources.blue_crystal).toBe(100)
    expect(player.resources.red_ruby).toBe(79)
  })

  it('建築放置同理：三資源逐一檢查', () => {
    const world = createTestWorld({
      size: 12,
      buildings: [makeBuildingDef({ id: 'vault', size: [2, 2], cost: { blue_crystal: 10, green_emerald: 5 } })],
      startCrystal: 10,
    })
    const player = getPlayer(world, 'player')
    player.resources.green_emerald = 4
    expect(placeBuilding(world, 'player', 'vault', { x: 4, y: 4 })).toBeNull()
    player.resources.green_emerald = 5
    expect(placeBuilding(world, 'player', 'vault', { x: 4, y: 4 })).not.toBeNull()
    expect(player.resources.blue_crystal).toBe(0)
    expect(player.resources.green_emerald).toBe(0)
  })

  it('canAfford：三資源逐一檢查（缺一即 false）', () => {
    expect(canAfford({ blue_crystal: 40, red_ruby: 80, green_emerald: 0 }, { blue_crystal: 40, red_ruby: 80, green_emerald: 0 })).toBe(true)
    expect(canAfford({ blue_crystal: 39, red_ruby: 80, green_emerald: 0 }, { blue_crystal: 40, red_ruby: 80, green_emerald: 0 })).toBe(false)
    expect(canAfford({ blue_crystal: 40, red_ruby: 80, green_emerald: 0 }, { blue_crystal: 0, red_ruby: 0, green_emerald: 1 })).toBe(false)
  })
})

describe('節點類型匹配（Prompt 5：礦場只能蓋在對應類型節點上）', () => {
  it('ruby_mine 蓋在藍節點 → 拒絕；蓋在紅節點 → 成功且入帳紅寶石', () => {
    const world = createTestWorld({
      size: 12,
      typedResourceNodes: [
        { x: 2, y: 2, resourceType: 'blue_crystal' },
        { x: 4, y: 2, resourceType: 'red_ruby' },
      ],
      buildings: [CRYSTAL_MINE, RUBY_MINE],
    })
    expect(placeBuilding(world, 'player', 'ruby_mine', { x: 2, y: 2 })).toBeNull()
    const mine = placeBuilding(world, 'player', 'ruby_mine', { x: 4, y: 2 })
    expect(mine).not.toBeNull()
    for (let tick = 0; tick < 100; tick++) stepWorld(world)
    expect(getResource(world, 'player', 'red_ruby')).toBeGreaterThan(0)
    expect(getResource(world, 'player', 'blue_crystal')).toBe(1000)
  })
})

describe('per-resource 上限（Prompt 5：每種資源各自 9999）', () => {
  it('紅寶石滿 9999 不再入帳；藍水晶不受影響', () => {
    const world = createTestWorld({
      size: 12,
      typedResourceNodes: [
        { x: 2, y: 2, resourceType: 'blue_crystal' },
        { x: 4, y: 2, resourceType: 'red_ruby' },
      ],
      buildings: [CRYSTAL_MINE, RUBY_MINE],
      startCrystal: 0,
    })
    addBuilding(world, 'player', 'crystal_mine', { x: 2, y: 2 }, { built: true, nodeId: 0 })
    addBuilding(world, 'player', 'ruby_mine', { x: 4, y: 2 }, { built: true, nodeId: 1 })
    const player = getPlayer(world, 'player')
    player.resources.red_ruby = MAX_RESOURCE
    for (let tick = 0; tick < 100; tick++) stepWorld(world)
    expect(player.resources.red_ruby).toBe(MAX_RESOURCE)
    expect(player.resources.blue_crystal).toBeGreaterThan(0)
  })
})

describe('單位放置（putUnit 不涉資源；回歸確認三資源世界可正常擺兵）', () => {
  it('typedResourceNodes 世界擺兵 + 戰鬥照常', () => {
    const world = createTestWorld({
      size: 12,
      typedResourceNodes: [{ x: 6, y: 6, resourceType: 'green_emerald' }],
      buildings: [],
      units: [makeUnitDef({ id: 'u', stats: { hp: 100, dmg: 10, range: 2.0, attackSpeed: 1.0, moveSpeed: 1.0 } })],
    })
    const blue = putUnit(world, 'player', 'u', { x: 4, y: 4 })
    const red = putUnit(world, 'enemy', 'u', { x: 4, y: 5 })
    expect(blue).toBeGreaterThan(0)
    expect(red).toBeGreaterThan(0)
    for (let tick = 0; tick < 30; tick++) stepWorld(world)
    const victim = world.units.find((unit) => unit.id === red)
    expect(victim === undefined || victim.hp < 100).toBe(true)
  })
})
