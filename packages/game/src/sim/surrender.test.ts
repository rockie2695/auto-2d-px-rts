import { describe, expect, it } from 'vitest'

import type { PlayerId, World } from './types.ts'
import { stepWorld } from './world.ts'
import { createTestWorld, makeBuildingDef, makeUnitDef, putUnit } from './testFixtures.ts'
import { addBuilding } from './economy.ts'
import { applySurrender, surrenderPlayer } from './surrender.ts'

/**
 * sim 層投降定案單元測試（Prompt 10.6）：
 * - `applySurrender`：寫 `world.surrender`（tick／絕望／戰力比／收入比）＋
 *   即時停行動（清生產隊列、斷 path/dest/targetId）；
 * - `surrenderPlayer`：幂等（已投降 → false）、對局已結束 → false；
 *   定案後 stepWorld 不再讓投降方行動（行為閘門兜底）。
 */

const SOLDIER = makeUnitDef({ id: 'soldier', role: 'melee' })
const KEEP = makeBuildingDef({ id: 'keep', size: [2, 2] })

/** 兩側各放一座已建成 keep（避免 matchEnded 因全滅誤判）＋各 1 隻同戰力兵。 */
function baseWorld(): World {
  const world = createTestWorld({ size: 32, units: [SOLDIER], buildings: [KEEP] })
  addBuilding(world, 'player', 'keep', { x: 2, y: 2 }, { built: true, nodeId: null })
  addBuilding(world, 'enemy', 'keep', { x: 20, y: 20 }, { built: true, nodeId: null })
  putUnit(world, 'player', 'soldier', { x: 4, y: 4 })
  putUnit(world, 'enemy', 'soldier', { x: 12, y: 12 })
  return world
}

/** 直填收入環（Prompt 5 口徑）：`perTick` × 窗口長 = 該方三資源收入總和。 */
function setIncome(world: World, playerId: PlayerId, perTick: number): void {
  const player = world.players.find((p) => p.id === playerId)
  if (player === undefined) throw new Error(`未知陣營：${playerId}`)
  for (const ring of Object.values(player.incomeRing)) {
    ring.fill(perTick)
  }
}

describe('applySurrender（Prompt 10.6 共用定案）', () => {
  it('寫入 world.surrender（tick/絕望/戰力比/收入比）並即時停行動', () => {
    const world = baseWorld()
    world.tick = 500
    setIncome(world, 'player', 2)
    setIncome(world, 'enemy', 1)

    // 我方有生產隊列與移動/攻擊令。
    const keep = world.buildings.find((building) => building.player === 'player')
    if (keep === undefined) throw new Error('找不到我方 keep')
    keep.queue = [{ defId: 'soldier', remainingTicks: 50 }]
    const soldier = world.units[0]
    if (soldier === undefined) throw new Error('找不到我方單位')
    soldier.path = [
      { x: 100, y: 100 },
      { x: 200, y: 200 },
    ]
    soldier.dest = { x: 200, y: 200 }
    soldier.targetId = 99

    const event = applySurrender(world, 'player', 0.42)
    expect(world.surrender).toBe(event)
    expect(event.player).toBe('player')
    expect(event.tick).toBe(500)
    expect(event.despairAtSurrender).toBe(0.42)
    // 戰力比：雙方各 1 隻 soldier（同戰力）→ 1；收入比：我 2/tick vs 敵 1/tick → 2。
    expect(event.powerRatio).toBe(1)
    expect(event.incomeRatio).toBe(2)
    // 即時停行動。
    expect(keep.queue).toEqual([])
    expect(soldier.path).toBeNull()
    expect(soldier.dest).toBeNull()
    expect(soldier.targetId).toBeNull()
  })

  it('敵方投降對稱（鏡像安全）：powerRatio / incomeRatio 依投方視角現算', () => {
    const world = baseWorld()
    setIncome(world, 'player', 1)
    setIncome(world, 'enemy', 2)

    const event = applySurrender(world, 'enemy', 0)
    expect(event.player).toBe('enemy')
    expect(event.powerRatio).toBe(1)
    expect(event.incomeRatio).toBe(2) // 敵 2/tick vs 我 1/tick → 2
  })
})

describe('surrenderPlayer（Prompt 10.6 玩家手動）', () => {
  it('首次 true 並定案；重複回 false（幂等）；對局已結束回 false', () => {
    const world = baseWorld()
    world.tick = 100

    expect(surrenderPlayer(world, 'player')).toBe(true)
    expect(world.surrender?.player).toBe('player')
    expect(world.surrender?.despairAtSurrender).toBe(0) // 手動不適用絕望指數
    expect(surrenderPlayer(world, 'player')).toBe(false)
    expect(surrenderPlayer(world, 'enemy')).toBe(false) // 先投方定案不覆蓋

    // 對局已結束（maxTicks 超時）→ false。
    const ended = baseWorld()
    ended.tick = ended.match.maxTicks + 1
    expect(surrenderPlayer(ended, 'enemy')).toBe(false)
    expect(ended.surrender).toBeNull()
  })

  it('定案後 stepWorld：投降方單位原地不動（停火/停走閘門兜底）', () => {
    const world = baseWorld()
    world.tick = 100

    expect(surrenderPlayer(world, 'player')).toBe(true)
    const before = world.units.map((unit) => ({ x: unit.x, y: unit.y }))
    for (let i = 0; i < 20; i += 1) stepWorld(world)
    // 投降方單位原地（敵方無 AI 決策驅動也不動）。
    for (let i = 0; i < world.units.length; i += 1) {
      const unit = world.units[i]
      const prev = before[i]
      expect(unit?.x).toBe(prev?.x)
      expect(unit?.y).toBe(prev?.y)
    }
  })
})
