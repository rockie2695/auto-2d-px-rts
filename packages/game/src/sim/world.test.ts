import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import { GameLoop } from './gameLoop.ts'
import { addBuilding, placeBuilding, queueTrain } from './economy.ts'
import {
  centerOf,
  createTestWorld,
  crystalOf,
  makeBuildingDef,
  makeUnitDef,
  putUnit,
} from './testFixtures.ts'
import { snapshotWorld, createWorld, orderMove, stepWorld } from './world.ts'
import { getPlayer, isBlockedAt, tileOf } from './types.ts'

/* ------------------------------------------------------------------ */
/* 移動                                                                */
/* ------------------------------------------------------------------ */

describe('移動（SPEC §2.2 固定點）', () => {
  it('moveSpeed 20 的單位 10 tick 走 10 格（整數精確）', () => {
    // 20 格/秒 × 200 ÷ 20Hz = 200 單位/tick = 1 格/tick。
    const world = createTestWorld({
      size: 12,
      units: [makeUnitDef({ id: 'fast', stats: { hp: 100, dmg: 1, range: 0.1, attackSpeed: 1, moveSpeed: 20 } })],
    })
    const id = putUnit(world, 'player', 'fast', { x: 0, y: 0 })
    expect(orderMove(world, id, { x: 10, y: 0 })).toBe(true)

    for (let tick = 0; tick < 10; tick++) stepWorld(world)

    const unit = world.units[0]
    expect(unit).toBeDefined()
    expect(unit?.x).toBe(centerOf({ x: 10, y: 0 }).x)
    expect(unit?.y).toBe(centerOf({ x: 10, y: 0 }).y)
    expect(unit?.path).toBeNull() // 抵達後清除路徑
  })

  it('路徑被建築擋住時重算，仍能抵達目的地', () => {
    const world = createTestWorld({
      size: 12,
      units: [makeUnitDef({ id: 'fast', stats: { hp: 100, dmg: 1, range: 0.1, attackSpeed: 1, moveSpeed: 20 } })],
      buildings: [makeBuildingDef({ id: 'wall', size: [1, 1] })],
    })
    const id = putUnit(world, 'player', 'fast', { x: 0, y: 0 })
    orderMove(world, id, { x: 10, y: 0 })
    for (let tick = 0; tick < 3; tick++) stepWorld(world) // 前進到 (3,0)

    // 敵方建築落在下一個路徑格 (4,0)。
    addBuilding(world, 'enemy', 'wall', { x: 4, y: 0 }, { built: true, nodeId: null })

    for (let tick = 0; tick < 20; tick++) stepWorld(world)

    const unit = world.units.find((candidate) => candidate.id === id)
    expect(unit).toBeDefined()
    expect(unit?.x).toBe(centerOf({ x: 10, y: 0 }).x)
    expect(unit?.y).toBe(centerOf({ x: 10, y: 0 }).y)
  })
})

/* ------------------------------------------------------------------ */
/* 戰鬥                                                                */
/* ------------------------------------------------------------------ */

describe('戰鬥（SPEC §10）', () => {
  const fighter = (id: string, hp: number) =>
    makeUnitDef({
      id,
      stats: { hp, dmg: 10, range: 1.2, attackSpeed: 20, moveSpeed: 1 },
    })

  it('同傷害同攻速：弱者先死', () => {
    const world = createTestWorld({ size: 12, units: [fighter('strong', 100), fighter('weak', 60)] })
    // 兩格相鄰 = 200 固定點 ≤ 射程 240，開打。
    const strongId = putUnit(world, 'player', 'strong', { x: 4, y: 4 })
    const weakId = putUnit(world, 'enemy', 'weak', { x: 5, y: 4 })

    for (let tick = 0; tick < 6; tick++) stepWorld(world)

    // 60hp ÷ 10dmg = 6 下死；依單位陣列順序结算，第 6 下出招前已被擊殺者不再反擊，
    // 所以存活者只挨了 5 下 → 剩 50。
    expect(world.units.some((unit) => unit.id === weakId)).toBe(false)
    const survivor = world.units.find((unit) => unit.id === strongId)
    expect(survivor?.hp).toBe(50)
    expect(getPlayer(world, 'enemy').unitCount).toBe(0)
  })

  it('射程內同時有單位與建築：優先打單位，建築無傷', () => {
    const world = createTestWorld({
      size: 12,
      units: [fighter('atk', 100), fighter('victim', 500)],
      buildings: [makeBuildingDef({ id: 'mine', hp: 500, incomePerSec: { blue_crystal: 1 } })],
    })
    putUnit(world, 'player', 'atk', { x: 4, y: 4 })
    const victimId = putUnit(world, 'enemy', 'victim', { x: 5, y: 4 }) // 距離 200 ≤ 240
    const mine = addBuilding(world, 'enemy', 'mine', { x: 4, y: 5 }, { built: true, nodeId: null }) // 距離 200 也在射程內

    for (let tick = 0; tick < 10; tick++) stepWorld(world)

    // 單位被打（10 × 10 = 100 傷害），建築完好。
    const victim = world.units.find((unit) => unit.id === victimId)
    expect(victim?.hp).toBe(400)
    expect(mine.hp).toBe(500)
  })

  it('最近敵方單位優先；距離平手取 id 較小者', () => {
    const world = createTestWorld({
      size: 12,
      units: [
        makeUnitDef({ id: 'atk', stats: { hp: 200, dmg: 50, range: 1.2, attackSpeed: 20, moveSpeed: 1 } }),
        makeUnitDef({ id: 'bystander', stats: { hp: 50, dmg: 1, range: 0.1, attackSpeed: 1, moveSpeed: 1 } }),
      ],
    })
    putUnit(world, 'player', 'atk', { x: 4, y: 4 })
    const first = putUnit(world, 'enemy', 'bystander', { x: 4, y: 5 }) // 先加入 = id 較小，距離 200
    const second = putUnit(world, 'enemy', 'bystander', { x: 5, y: 4 }) // 距離同為 200，id 較大

    stepWorld(world) // 一發 50 傷害

    expect(world.units.some((unit) => unit.id === first)).toBe(false) // 50hp 一發死
    const secondUnit = world.units.find((unit) => unit.id === second)
    expect(secondUnit?.hp).toBe(50) // 未被波及
  })

  it('建築被打到 0 hp 移除、釋放資源點、扣礦場計數', () => {
    const world = createTestWorld({
      size: 12,
      resourceNodes: [{ x: 4, y: 4 }],
      units: [makeUnitDef({ id: 'gun', stats: { hp: 100, dmg: 50, range: 1.2, attackSpeed: 20, moveSpeed: 1 } })],
      buildings: [makeBuildingDef({ id: 'mine', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { blue_crystal: 1 } })],
    })
    const mine = placeBuilding(world, 'enemy', 'mine', { x: 4, y: 4 })
    expect(mine).not.toBeNull()
    expect(getPlayer(world, 'enemy').mineCount).toBe(1)

    putUnit(world, 'player', 'gun', { x: 4, y: 5 }) // 距離建築外框 200 ≤ 240

    for (let tick = 0; tick < 10; tick++) stepWorld(world)

    expect(world.buildings.some((building) => building.id === mine?.id)).toBe(false)
    expect(world.resourceNodes[0]?.buildingId).toBeNull()
    expect(getPlayer(world, 'enemy').mineCount).toBe(0)
  })

  it('未完工建築按完成比例承受傷害（SPEC §5）', () => {
    const world = createTestWorld({
      size: 12,
      units: [makeUnitDef({ id: 'gun', stats: { hp: 100, dmg: 10, range: 1.2, attackSpeed: 20, moveSpeed: 1 } })],
      buildings: [makeBuildingDef({ id: 'rax', size: [2, 2], hp: 600, buildTimeSec: 1 })],
    })
    const rax = placeBuilding(world, 'enemy', 'rax', { x: 4, y: 4 })
    expect(rax).not.toBeNull()
    expect(rax?.hp).toBe(1) // 進度 0 → 折算至少 1 hp
    expect(rax?.totalTicks).toBe(20)

    putUnit(world, 'player', 'gun', { x: 4, y: 6 }) // 在 2x2 外框下方一格
    for (let tick = 0; tick < 20; tick++) stepWorld(world)

    // 完工後 hp = 600 − 累計傷害（20 tick × 每 tick 1 下 × 10 傷害）。
    expect(rax?.builtTicks).toBe(20)
    expect(rax?.hp).toBe(600 - 200)
  })
})

/* ------------------------------------------------------------------ */
/* 經濟                                                                */
/* ------------------------------------------------------------------ */

describe('經濟（SPEC §5）', () => {
  const mineDef = makeBuildingDef({
    id: 'mine',
    cost: { blue_crystal: 150 },
    requiresResourceNode: true,
    incomePerSec: { blue_crystal: 1 },
  })

  it('每座礦場 1.0/秒：20 tick 整 +1（整數精確、無浮點漂移）', () => {
    const world = createTestWorld({ size: 12, resourceNodes: [{ x: 4, y: 4 }], buildings: [mineDef] })
    addBuilding(world, 'player', 'mine', { x: 4, y: 4 }, { built: true, nodeId: 0 })
    const before = crystalOf(world, 'player')

    for (let tick = 0; tick < 19; tick++) stepWorld(world)
    expect(crystalOf(world, 'player')).toBe(before) // 第 19 tick 還沒到

    stepWorld(world)
    expect(crystalOf(world, 'player')).toBe(before + 1)
  })

  it('1000 tick 收入恰為 50（1/s × 50s）；無礦方不變', () => {
    const world = createTestWorld({ size: 12, resourceNodes: [{ x: 4, y: 4 }], buildings: [mineDef] })
    addBuilding(world, 'player', 'mine', { x: 4, y: 4 }, { built: true, nodeId: 0 })
    const enemyBefore = crystalOf(world, 'enemy')

    for (let tick = 0; tick < 1000; tick++) stepWorld(world)

    expect(crystalOf(world, 'player')).toBe(1000 + 50)
    expect(crystalOf(world, 'enemy')).toBe(enemyBefore)
  })

  it('小數費率 0.5/秒：每 40 tick +1', () => {
    const world = createTestWorld({
      size: 12,
      resourceNodes: [{ x: 4, y: 4 }],
      buildings: [makeBuildingDef({ id: 'half', requiresResourceNode: true, incomePerSec: { blue_crystal: 0.5 } })],
    })
    addBuilding(world, 'player', 'half', { x: 4, y: 4 }, { built: true, nodeId: 0 })
    for (let tick = 0; tick < 40; tick++) stepWorld(world)
    expect(crystalOf(world, 'player')).toBe(1001)
  })

  it('兩座礦場：20 tick +2', () => {
    const world = createTestWorld({
      size: 12,
      resourceNodes: [{ x: 4, y: 4 }, { x: 8, y: 8 }],
      buildings: [mineDef],
    })
    addBuilding(world, 'player', 'mine', { x: 4, y: 4 }, { built: true, nodeId: 0 })
    addBuilding(world, 'player', 'mine', { x: 8, y: 8 }, { built: true, nodeId: 1 })
    for (let tick = 0; tick < 20; tick++) stepWorld(world)
    expect(crystalOf(world, 'player')).toBe(1002)
  })
})

/* ------------------------------------------------------------------ */
/* 放置與生產                                                          */
/* ------------------------------------------------------------------ */

describe('placeBuilding 規則（SPEC §7）', () => {
  function worldWithPalette() {
    const world = createTestWorld({
      size: 12,
      rocks: [{ x: 3, y: 3 }],
      resourceNodes: [{ x: 8, y: 8 }, { x: 2, y: 2 }],
      buildings: [
        makeBuildingDef({ id: 'keep', hp: 1000 }),
        makeBuildingDef({ id: 'rax', size: [2, 2], cost: { blue_crystal: 200 }, produces: ['u'], buildTimeSec: 1 }),
        makeBuildingDef({ id: 'mine', cost: { blue_crystal: 150 }, requiresResourceNode: true, incomePerSec: { blue_crystal: 1 } }),
      ],
    })
    // keep 不可放置（palette 不含）。
    world.faction.buildings = ['rax', 'mine']
    return world
  }

  it('不在 palette 的建築（keep）不可放置', () => {
    const world = worldWithPalette()
    expect(placeBuilding(world, 'player', 'keep', { x: 5, y: 5 })).toBeNull()
  })

  it('岩石、界外、重疊、缺資源點、資源點占用都拒絕', () => {
    const world = worldWithPalette()
    expect(placeBuilding(world, 'player', 'rax', { x: 3, y: 3 })).toBeNull() // 岩石
    expect(placeBuilding(world, 'player', 'rax', { x: 11, y: 11 })).toBeNull() // 界外（2x2）
    expect(placeBuilding(world, 'player', 'mine', { x: 5, y: 5 })).toBeNull() // mine 必須在資源點上
    expect(placeBuilding(world, 'player', 'rax', { x: 8, y: 8 })).toBeNull() // 一般建築不得壓資源點

    const first = placeBuilding(world, 'player', 'rax', { x: 5, y: 5 })
    expect(first).not.toBeNull()
    expect(placeBuilding(world, 'enemy', 'rax', { x: 6, y: 5 })).toBeNull() // 重疊

    expect(placeBuilding(world, 'player', 'mine', { x: 8, y: 8 })).not.toBeNull()
    expect(placeBuilding(world, 'enemy', 'mine', { x: 8, y: 8 })).toBeNull() // 礦點已被占用
  })

  it('扣費、mineCap 與開始施工', () => {
    const world = worldWithPalette()
    const mine = placeBuilding(world, 'player', 'mine', { x: 8, y: 8 })
    expect(mine).not.toBeNull()
    expect(crystalOf(world, 'player')).toBe(1000 - 150)
    expect(getPlayer(world, 'player').mineCount).toBe(1)
    expect(mine?.nodeId).toBe(0)
    expect(world.resourceNodes[0]?.buildingId).toBe(mine?.id)
    expect(mine?.builtTicks).toBe(0)
    expect(mine?.totalTicks).toBe(0) // mineDef buildTimeSec 0 → 立即完工

    // 費用不足。
    const poorWorld = worldWithPalette()
    getPlayer(poorWorld, 'player').blueCrystal = 10
    expect(placeBuilding(poorWorld, 'player', 'rax', { x: 5, y: 5 })).toBeNull()

    // mineCap = 1（每玩家）：玩家的第二座礦場被拒（敵方不受影響）。
    world.match.mineCap = 1
    expect(placeBuilding(world, 'player', 'mine', { x: 2, y: 2 })).toBeNull()
  })
})

describe('生產佇列（SPEC §6）', () => {
  function productionWorld() {
    return createTestWorld({
      size: 12,
      units: [makeUnitDef({ id: 'u', cost: { blue_crystal: 50 }, trainTimeSec: 1 })],
      buildings: [makeBuildingDef({ id: 'rax', size: [2, 2], cost: { blue_crystal: 200 }, produces: ['u'], buildTimeSec: 0 })],
    })
  }

  it('排程扣費、倒數結束在建築外圍生成單位', () => {
    const world = productionWorld()
    const rax = placeBuilding(world, 'player', 'rax', { x: 4, y: 4 })
    expect(rax).not.toBeNull()
    const afterBuild = crystalOf(world, 'player')

    expect(queueTrain(world, rax?.id ?? -1, 'u')).toBe(true)
    expect(crystalOf(world, 'player')).toBe(afterBuild - 50) // 建築 200 已在 placeBuilding 扣，這裡再扣單位 50
    expect(rax?.queue).toEqual([{ defId: 'u', remainingTicks: 20 }])

    for (let tick = 0; tick < 19; tick++) stepWorld(world)
    expect(getPlayer(world, 'player').unitCount).toBe(0)

    stepWorld(world)
    expect(getPlayer(world, 'player').unitCount).toBe(1)
    expect(rax?.queue).toEqual([])
    const spawned = world.units[0]
    // 外圍第一格：上方向 (5,3)。
    expect(spawned && tileOf(spawned.x, spawned.y)).toEqual({ x: 5, y: 3 })
  })

  it('非本建築可生產的單位、未知單位、達 unitCap 都拒絕', () => {
    const world = createTestWorld({
      size: 12,
      units: [makeUnitDef({ id: 'u' }), makeUnitDef({ id: 'other' })],
      buildings: [makeBuildingDef({ id: 'rax', produces: ['u'] }), makeBuildingDef({ id: 'nope' })],
    })
    const rax = addBuilding(world, 'player', 'rax', { x: 4, y: 4 }, { built: true, nodeId: null })
    expect(queueTrain(world, rax.id, 'other')).toBe(false)
    expect(queueTrain(world, rax.id, 'ghost')).toBe(false)
    const nope = addBuilding(world, 'player', 'nope', { x: 7, y: 7 }, { built: true, nodeId: null })
    expect(queueTrain(world, nope.id, 'u')).toBe(false)

    // 已有 1 單位 + unitCap 1 → 排程會超標，拒絕。
    putUnit(world, 'player', 'u', { x: 1, y: 1 })
    world.match.unitCap = 1
    expect(queueTrain(world, rax.id, 'u')).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* GameLoop                                                            */
/* ------------------------------------------------------------------ */

describe('GameLoop（20Hz 固定步長）', () => {
  it('advance 以累加器推進整數個 tick', () => {
    const world = createTestWorld()
    const loop = new GameLoop(world)

    expect(loop.advance(50)).toBe(1)
    expect(world.tick).toBe(1)
    expect(loop.advance(70)).toBe(1) // 20ms 餘數留存
    expect(world.tick).toBe(2)
    expect(loop.progressToNextTick).toBeCloseTo(0.4)
    expect(loop.advance(30)).toBe(1) // 20 + 30 = 50
    expect(world.tick).toBe(3)
    expect(loop.advance(-100)).toBe(0) // 負數忽略
  })

  it('run(n) 與 advance 累計等價且確定性一致', () => {
    const a = createTestWorld({ seed: 7 })
    const b = createTestWorld({ seed: 7 })
    new GameLoop(a).run(100)
    const loop = new GameLoop(b)
    for (let frame = 0; frame < 100; frame++) loop.advance(50)
    expect(JSON.stringify(snapshotWorld(a))).toBe(JSON.stringify(snapshotWorld(b)))
  })
})

/* ------------------------------------------------------------------ */
/* 確定性（規則 8）與真實內容整合                                      */
/* ------------------------------------------------------------------ */

function loadRealContent() {
  const dataDir = fileURLToPath(new URL('../../public/data/', import.meta.url))
  return loadContentPackFromDir(dataDir)
}

describe('確定性與真實內容（規則 8）', () => {
  it('相同種子＋相同命令跑 1000 tick：快照逐位元相同', () => {
    const content = loadRealContent()
    const runOnce = (seed: number): string => {
      const world = createWorld(content, seed)
      for (const unit of world.units) orderMove(world, unit.id, { x: 16, y: 16 })
      for (let tick = 0; tick < 1000; tick++) stepWorld(world)
      return JSON.stringify(snapshotWorld(world))
    }
    expect(runOnce(42)).toBe(runOnce(42))
  })

  it('真實內容開局配置符合 SPEC §7', () => {
    const content = loadRealContent()
    const world = createWorld(content, 42)

    for (const playerId of ['player', 'enemy'] as const) {
      const buildings = world.buildings.filter((building) => building.player === playerId)
      const defIds = buildings.map((building) => building.defId).sort()
      expect(defIds).toEqual(['barracks', 'crystal_mine', 'keep'])

      // 開局建築皆已完工、keep／barracks 不佔資源點、礦場佔一個資源點。
      for (const building of buildings) {
        expect(building.builtTicks).toBe(building.totalTicks)
        if (building.defId === 'crystal_mine') {
          expect(building.nodeId).not.toBeNull()
          expect(world.resourceNodes[building.nodeId ?? -1]?.buildingId).toBe(building.id)
        } else {
          expect(building.nodeId).toBeNull()
        }
      }

      // 佔地不合岩石、不互相重疊。
      for (const building of buildings) {
        for (let y = building.y; y < building.y + building.h; y++) {
          for (let x = building.x; x < building.x + building.w; x++) {
            expect(world.map.tiles[y * world.map.size + x]).toBe(0)
          }
        }
      }

      const units = world.units.filter((unit) => unit.player === playerId)
      expect(units).toHaveLength(3)
      expect(units.every((unit) => unit.defId === 'legionnaire')).toBe(true)
      expect(units.every((unit) => !isBlockedAt(world, tileOf(unit.x, unit.y)))).toBe(true)

      const player = getPlayer(world, playerId)
      expect(player.blueCrystal).toBe(600)
      expect(player.mineCount).toBe(1)
      expect(player.barracksCount).toBe(1)
    }
  })

  it('開局雙方到各自 keep 的距離相等（對稱局）', () => {
    const content = loadRealContent()
    const world = createWorld(content, 42)
    const keepOf = (playerId: 'player' | 'enemy') =>
      world.buildings.find((building) => building.player === playerId && building.defId === 'keep')
    const manhattan = (ax: number, ay: number, bx: number, by: number): number =>
      Math.abs(ax - bx) + Math.abs(ay - by)

    const playerKeep = keepOf('player')
    const enemyKeep = keepOf('enemy')
    expect(playerKeep).toBeDefined()
    expect(enemyKeep).toBeDefined()
    const playerSpawn = getPlayer(world, 'player').spawn
    const enemySpawn = getPlayer(world, 'enemy').spawn
    expect(manhattan(playerSpawn.x, playerSpawn.y, playerKeep?.x ?? 0, playerKeep?.y ?? 0)).toBe(
      manhattan(enemySpawn.x, enemySpawn.y, enemyKeep?.x ?? 0, enemyKeep?.y ?? 0),
    )
  })

  it('真實內容全軍推中心：跑 1000 tick 無例外且有傷亡', () => {
    const content = loadRealContent()
    const world = createWorld(content, 42)
    for (const unit of world.units) orderMove(world, unit.id, { x: 16, y: 16 })
    const hpBefore = world.units.reduce((total, unit) => total + unit.hp, 0)

    for (let tick = 0; tick < 1000; tick++) stepWorld(world)

    const hpAfter = world.units.reduce((total, unit) => total + unit.hp, 0)
    expect(world.tick).toBe(1000)
    expect(hpAfter).toBeLessThan(hpBefore) // 確實發生戰鬥
  })
})
