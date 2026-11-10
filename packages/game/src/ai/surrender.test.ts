import { describe, expect, it } from 'vitest'

import { DEFAULT_AI_SURRENDER_CONFIG, TICK_RATE_HZ } from '@auto-2d-px-rts/shared'
import type { AiSurrenderConfig } from '@auto-2d-px-rts/shared'

import {
  checkSurrender,
  despairOf,
  surrenderConfigOf,
  surrenderPowerOf,
  surrenderThresholdOf,
} from './surrender.ts'
import { resolvePolicies } from './policy.ts'
import { addBuilding, getIncome } from '../sim/economy.ts'
import { INCOME_WINDOW_TICKS } from '../sim/types.ts'
import type { PlayerId, TrainJob, World } from '../sim/types.ts'
import { stepWorld } from '../sim/world.ts'
import { createTestWorld, makeBuildingDef, makeUnitDef, putUnit } from '../sim/testFixtures.ts'
import { rebuildSpatialHash } from '../sim/spatialHash.ts'

/**
 * AI 投降判定（階段三 Prompt 8.6）：
 * - 絕望指數公式（五成分加權）；
 * - 閾值修正（attitude sliders）；
 * - 持續性（連續 sustainSec 才投、反轉重置）；
 * - JSON 配置生效與缺省回退；
 * - 投降行為閘門（sim 停火／停走／停產／停採）與定案動作（清佇列／斷令）。
 *
 * 數值錨點（受控世界）：敵方 1 隻 brute（戰力 100）、敵方收入 6000／我 0、
 * 我方 3 座開局建築全毀（territoryLoss = 1）、tick 3360（elapsed 168 秒 →
 * timePressure = 0.1）→ despair = 0.35×(100/101) + 0.25×1 + 0.15 + 0.15×0.1
 * ≈ 0.7615：剛好 > 默認裸閾 0.75、< 默認狀態修正後的 0.865／0.895。
 */

/* ------------------------------------------------------------------ */
/* 受控世界                                                            */
/* ------------------------------------------------------------------ */

/** 一兵：戰力 = (100/100)×10×1 = 10／隻。 */
const SOLDIER = makeUnitDef({ id: 'soldier', role: 'melee' })
/** 重兵：戰力 100／隻（對我方純兵力壓制放大 powerGap）。 */
const BRUTE = makeUnitDef({ id: 'brute', role: 'melee', stats: { hp: 100, dmg: 100, range: 0.8, attackSpeed: 1.0, moveSpeed: 1.0 } })

const MINE = makeBuildingDef({
  id: 'mine',
  size: [1, 1],
  ai: { value: 300 },
  incomePerSec: { blue_crystal: 10 },
})

const TOWER = makeBuildingDef({
  id: 'tower',
  size: [1, 1],
  ai: { value: 400 },
  defense: { dmg: 10, range: 4.0, attackSpeed: 0.5 },
})

/** tick 3360 = elapsed 168 秒（> minGameTimeSec 120，時間成分恰好 0.1）。 */
const LATE_TICK = 168 * TICK_RATE_HZ

function baseWorld(): World {
  return createTestWorld({
    size: 32,
    units: [SOLDIER, BRUTE],
    buildings: [MINE, TOWER],
  })
}

/** 覆蓋陣營投降配置（受控測試）。 */
function withConfig(world: World, config: AiSurrenderConfig): void {
  world.faction = { ...world.faction, aiSurrenderConfig: config }
}

/** 把藍水晶收入環直填（窗口總入帳 = amount），收入差距可控。 */
function fillIncome(world: World, playerId: PlayerId, amount: number): void {
  const player = world.players.find((candidate) => candidate.id === playerId)
  if (player === undefined) throw new Error('找不到玩家')
  const ring = player.incomeRing.blue_crystal
  if (ring === undefined) throw new Error('找不到收入環')
  player.incomeRing.blue_crystal = new Array<number>(INCOME_WINDOW_TICKS).fill(
    amount / INCOME_WINDOW_TICKS,
  )
}

/** 我方開局建築 3 座全部打掉（territoryLoss → 1）。 */
function ruinPlayerBuildings(world: World): void {
  const tiles = [
    { x: 2, y: 2 },
    { x: 4, y: 2 },
    { x: 2, y: 4 },
  ] as const
  for (const tile of tiles) {
    addBuilding(world, 'player', 'mine', tile, { built: true, nodeId: null })
  }
  world.initialBuildingCount.player = tiles.length
  for (const building of world.buildings) {
    if (building.player === 'player') building.hp = 0
  }
}

/** 數值錨點場景（見上註釋）：組裝後斷言 despair ≈ 0.7615 的前提成立。 */
function desperateWorld(config: AiSurrenderConfig): World {
  const world = baseWorld()
  withConfig(world, config)
  putUnit(world, 'enemy', 'brute', { x: 20, y: 20 })
  fillIncome(world, 'enemy', 6000)
  ruinPlayerBuildings(world)
  world.tick = LATE_TICK
  const check = despairOf(world, 'player')
  expect(check.despair).toBeGreaterThan(0.75)
  expect(check.despair).toBeLessThan(0.8)
  return world
}

/** 所有滑桿歸零（→ 裸閾 = base，最易觸發投降的政策組合）。 */
const CALM = resolvePolicies({ aggression: 0, reserve: 0, techRush: 0 })

describe('絕望指數（Prompt 8.6 公式）', () => {
  it('極端劣勢：五成分加權和 > 裸閾 0.75，各成分符合場景', () => {
    const world = desperateWorld(DEFAULT_AI_SURRENDER_CONFIG)
    const { components, despair } = despairOf(world, 'player')
    // powerGap = 100/(100+1)（我方無兵）。
    expect(components.powerGap).toBeGreaterThan(0.95)
    // incomeGap = 6000/6000.01（我方零收入）。
    expect(components.incomeGap).toBeGreaterThan(0.999)
    // 領土：3 座開局建築全毀。
    expect(components.territoryLoss).toBe(1)
    // 時間：168 秒 → (168−120)/(600−120) = 0.1。
    expect(components.timePressure).toBeCloseTo(0.1, 10)
    // 科技：雙方都沒有翡翠聖所。
    expect(components.techGap).toBe(0)
    expect(despair).toBeGreaterThan(0.75)
    expect(despair).toBeLessThanOrEqual(1)
  })

  it('完全均勢（tick 0）→ despair = 0；輕微劣勢 → < 0.1', () => {
    const world = baseWorld()
    putUnit(world, 'player', 'soldier', { x: 3, y: 3 })
    putUnit(world, 'enemy', 'soldier', { x: 20, y: 20 })
    expect(surrenderPowerOf(world, 'player')).toBe(surrenderPowerOf(world, 'enemy'))
    expect(despairOf(world, 'player').despair).toBe(0)

    // 輕微劣勢：敵 3 兵（1 隻半血）vs 我 2 兵；其餘成分為 0（tick 3360 只剩時間 0.1）。
    const mild = baseWorld()
    for (const tile of [
      { x: 20, y: 20 },
      { x: 21, y: 20 },
    ]) {
      putUnit(mild, 'enemy', 'soldier', tile)
    }
    const halfHp = putUnit(mild, 'enemy', 'soldier', { x: 22, y: 20 })
    const halfUnit = mild.units.find((unit) => unit.id === halfHp)
    if (halfUnit === undefined) throw new Error('找不到半血單位')
    halfUnit.hp = 40 // 戰力 4（兩隻滿血 10 + 半血 4 = 敵 24）
    putUnit(mild, 'player', 'soldier', { x: 3, y: 3 })
    putUnit(mild, 'player', 'soldier', { x: 4, y: 3 })
    mild.tick = LATE_TICK
    const { components, despair } = despairOf(mild, 'player')
    // powerGap = (24−20)/45 ≈ 0.089、時間 0.1 → despair ≈ 0.046。
    expect(components.powerGap).toBeCloseTo(4 / 45, 10)
    expect(despair).toBeLessThan(0.1)
  })

  it('powerGap 邊界：我方全滅 → 貼近 1（clamp01 內）', () => {
    const world = baseWorld()
    for (const tile of [
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 10 },
      { x: 13, y: 10 },
    ]) {
      putUnit(world, 'enemy', 'brute', tile)
    }
    expect(despairOf(world, 'player').components.powerGap).toBeGreaterThan(0.95)
  })
})

describe('投降閾值修正（Prompt 8.6）', () => {
  it('公式：base + 0.1×aggression + 0.05×reserve + 0.08×techRush（夾 ≤ 1）', () => {
    // 默認滑桿全 0.5 → 0.75 + 0.05 + 0.025 + 0.04 = 0.865。
    expect(surrenderThresholdOf(DEFAULT_AI_SURRENDER_CONFIG, resolvePolicies({}))).toBeCloseTo(
      0.865,
      10,
    )
    // 全 0 → 裸閾；全 1 → 0.98（不觸夾）。
    expect(surrenderThresholdOf(DEFAULT_AI_SURRENDER_CONFIG, CALM)).toBe(0.75)
    expect(
      surrenderThresholdOf(
        DEFAULT_AI_SURRENDER_CONFIG,
        resolvePolicies({ aggression: 1, reserve: 1, techRush: 1 }),
      ),
    ).toBeCloseTo(0.98, 10)
    // 夾 1：低 base + 高修正。
    expect(
      surrenderThresholdOf(
        { ...DEFAULT_AI_SURRENDER_CONFIG, surrenderThreshold: 0.9 },
        resolvePolicies({ aggression: 1, reserve: 1, techRush: 1 }),
      ),
    ).toBe(1)
  })

  it('同等劣勢：aggression=1（閾 0.915）不投；中性（0.865）不投；全 0（0.75）投', () => {
    const world = desperateWorld(DEFAULT_AI_SURRENDER_CONFIG)

    // aggression=1（其餘默認 0.5）：0.75+0.1+0.025+0.04 = 0.915；despair ≈ 0.7615 < 閾。
    world.despairBreachSince.player = world.tick - 15 * TICK_RATE_HZ
    const aggressive = checkSurrender(world, 'player', resolvePolicies({ aggression: 1 }))
    expect(aggressive.threshold).toBeCloseTo(0.915, 10)
    expect(aggressive.surrendered).toBe(false)
    expect(world.surrender).toBeNull()

    // 中性（默認滑桿 0.5）：0.7615 < 0.865。
    world.despairBreachSince.player = world.tick - 15 * TICK_RATE_HZ
    const neutral = checkSurrender(world, 'player', resolvePolicies({}))
    expect(neutral.threshold).toBeCloseTo(0.865, 10)
    expect(neutral.surrendered).toBe(false)
    expect(world.surrender).toBeNull()

    // 全 0 滑桿：0.7615 > 0.75，持續已 15 秒 → 投降定案。
    world.despairBreachSince.player = world.tick - 15 * TICK_RATE_HZ
    const calm = checkSurrender(world, 'player', CALM)
    expect(calm.threshold).toBe(0.75)
    expect(calm.surrendered).toBe(true)
    expect(world.surrender?.player).toBe('player')
  })
})

describe('持續性判定（連續 sustainSec 超閾才投）', () => {
  const CONFIG: AiSurrenderConfig = {
    ...DEFAULT_AI_SURRENDER_CONFIG,
    surrenderThreshold: 0.7, // despair ≈ 0.7615 過閾，留餘度
    sustainSec: 15,
  }

  it('首次超閾只計時；劣勢反轉重置；連續滿 15 秒才投', () => {
    const world = desperateWorld(CONFIG)

    // 首次超閾：開始計時，不投。
    const first = checkSurrender(world, 'player', CALM)
    expect(first.surrendered).toBe(false)
    expect(world.despairBreachSince.player).toBe(world.tick)

    // 反轉：我方添重兵（powerGap → 0）→ despair 回落 → 計時重置。
    putUnit(world, 'player', 'brute', { x: 4, y: 4 })
    world.tick += 10 * TICK_RATE_HZ
    const recovered = checkSurrender(world, 'player', CALM)
    expect(recovered.surrendered).toBe(false)
    expect(world.despairBreachSince.player).toBeNull()

    // 重新劣勢（我方重兵陣亡）→ 重新計時。
    const myBrute = world.units.find((unit) => unit.player === 'player')
    if (myBrute === undefined) throw new Error('找不到我方重兵')
    myBrute.hp = 0
    world.tick += 2 * TICK_RATE_HZ
    const restarted = checkSurrender(world, 'player', CALM)
    expect(restarted.surrendered).toBe(false)
    expect(world.despairBreachSince.player).toBe(world.tick)

    // 連續超閾滿 15 秒 → 投降。
    world.tick += 15 * TICK_RATE_HZ
    const sustained = checkSurrender(world, 'player', CALM)
    expect(sustained.surrendered).toBe(true)
    expect(world.surrender?.player).toBe('player')
    expect(world.surrender?.despairAtSurrender).toBeCloseTo(sustained.despair, 10)
    // 事件值是「我方 / 敵方」視角：我方全滅全啞 → 兩個比值趨近 0。
    expect(world.surrender?.powerRatio).toBe(0)
    expect(world.surrender?.incomeRatio).toBeCloseTo(0, 4)
  })

  it('對局 < minGameTimeSec 不判投；達 120 秒整才開始', () => {
    const world = desperateWorld(CONFIG)
    world.tick = 120 * TICK_RATE_HZ - 1
    const early = checkSurrender(world, 'player', CALM)
    expect(early.surrendered).toBe(false)
    expect(world.despairBreachSince.player).toBeNull()

    // 邊界：tick 恰 = 120 秒 → 開始判定（despair 0.7465 > 0.7，計時啟動）。
    world.tick = 120 * TICK_RATE_HZ
    const boundary = checkSurrender(world, 'player', CALM)
    expect(boundary.surrendered).toBe(false)
    expect(world.despairBreachSince.player).toBe(world.tick)
  })
})

describe('JSON 配置生效（調 threshold 改投降意願）', () => {
  it('surrenderConfigOf：缺省回退 DEFAULT；陣營配置覆蓋後生效', () => {
    const world = baseWorld()
    expect(surrenderConfigOf(world)).toBe(DEFAULT_AI_SURRENDER_CONFIG)
    withConfig(world, { ...DEFAULT_AI_SURRENDER_CONFIG, surrenderThreshold: 0.5 })
    expect(surrenderConfigOf(world).surrenderThreshold).toBe(0.5)
  })

  it('閾 0.5 → 同劣勢投降；閾 0.9 → 同劣勢不投', () => {
    // 閾 0.5：持續 15 秒後投。
    const low = desperateWorld({ ...DEFAULT_AI_SURRENDER_CONFIG, surrenderThreshold: 0.5 })
    const first = checkSurrender(low, 'player', CALM)
    expect(first.surrendered).toBe(false)
    expect(low.despairBreachSince.player).not.toBeNull()
    low.tick += 15 * TICK_RATE_HZ
    expect(checkSurrender(low, 'player', CALM).surrendered).toBe(true)
    expect(low.surrender?.player).toBe('player')

    // 閾 0.9：同一劣勢不投、計時不啟動。
    const high = desperateWorld({ ...DEFAULT_AI_SURRENDER_CONFIG, surrenderThreshold: 0.9 })
    const refuse = checkSurrender(high, 'player', CALM)
    expect(refuse.surrendered).toBe(false)
    expect(high.surrender).toBeNull()
    expect(high.despairBreachSince.player).toBeNull()
  })
})

describe('投降行為閘門（sim 層 Prompt 8.6）', () => {
  /** 已投降方的戰場：我方兵／塔／礦＋排隊工作；敵方在塔射程內＋對照礦。 */
  function surrenderedCombatWorld(): World {
    const world = baseWorld()
    putUnit(world, 'player', 'soldier', { x: 3, y: 3 })
    putUnit(world, 'enemy', 'brute', { x: 11, y: 10 }) // 距塔 ~2.2 格 < range 4：塔若未停火必開火
    addBuilding(world, 'player', 'tower', { x: 9, y: 9 }, { built: true, nodeId: null })
    const mine = addBuilding(world, 'player', 'mine', { x: 2, y: 20 }, { built: true, nodeId: null })
    mine.queue = [{ defId: 'soldier', remainingTicks: 999 } satisfies TrainJob]
    addBuilding(world, 'enemy', 'mine', { x: 2, y: 21 }, { built: true, nodeId: null }) // 對照組
    world.initialBuildingCount.player = world.buildings.filter(
      (building) => building.player === 'player',
    ).length
    world.initialBuildingCount.enemy = world.buildings.filter(
      (building) => building.player === 'enemy',
    ).length
    rebuildSpatialHash(world)
    world.surrender = {
      player: 'player',
      tick: world.tick,
      despairAtSurrender: 0.9,
      powerRatio: 0,
      incomeRatio: 0,
    }
    return world
  }

  it('投降 20 tick：單位與塔停火、不位移、隊列不消耗、收入歸零；對照方如常', () => {
    const world = surrenderedCombatWorld()
    const enemy = world.units.find((unit) => unit.player === 'enemy')
    const soldier = world.units.find((unit) => unit.player === 'player')
    if (enemy === undefined || soldier === undefined) throw new Error('單位缺失')
    const enemyHpBefore = enemy.hp
    const soldierX = soldier.x
    const soldierY = soldier.y

    for (let index = 0; index < 20; index++) stepWorld(world)

    // 塔與單位停火：在塔射程內的敵兵 hp 紋風不動。
    expect(enemy.hp).toBe(enemyHpBefore)
    // 停走：我方士兵位置不變。
    expect(soldier.x).toBe(soldierX)
    expect(soldier.y).toBe(soldierY)
    // 停生產：隊列工作未被消耗。
    const myMine = world.buildings.find(
      (building) => building.player === 'player' && building.queue.length > 0,
    )
    expect(myMine?.queue.length).toBe(1)
    expect(myMine?.queue[0]?.remainingTicks).toBe(999)
    // 停採：我方收入 0；敵方對照礦如常入帳（stepWorld 其它部分正常運作的反證）。
    expect(getIncome(world, 'player', 'blue_crystal')).toBe(0)
    expect(getIncome(world, 'enemy', 'blue_crystal')).toBeGreaterThan(0)
  })
})

describe('checkSurrender 定案動作（清佇列、斷單位令）', () => {
  it('觸發投降：生產隊列清空、單位 path/dest/targetId 斷開、world.surrender 置位', () => {
    // sustainSec 0 + 閾 0.5：despair ≈ 0.7615，兩次檢查即定案。
    const world = desperateWorld({
      ...DEFAULT_AI_SURRENDER_CONFIG,
      surrenderThreshold: 0.5,
      sustainSec: 0,
      minGameTimeSec: 120,
    })
    const mine = addBuilding(world, 'player', 'mine', { x: 6, y: 6 }, { built: true, nodeId: null })
    mine.queue = [{ defId: 'soldier', remainingTicks: 50 }]
    const soldierId = putUnit(world, 'player', 'soldier', { x: 8, y: 8 })
    const soldier = world.units.find((unit) => unit.id === soldierId)
    if (soldier === undefined) throw new Error('找不到士兵')
    soldier.path = [{ x: 9, y: 9 }]
    soldier.dest = { x: 9, y: 9 }
    soldier.targetId = 99

    const first = checkSurrender(world, 'player', CALM)
    expect(first.surrendered).toBe(false) // 首檢只計時（sustainSec 0 也需兩次）
    world.tick += 1
    const second = checkSurrender(world, 'player', CALM)
    expect(second.surrendered).toBe(true)

    expect(world.surrender?.player).toBe('player')
    for (const building of world.buildings) {
      if (building.player === 'player') expect(building.queue).toEqual([])
    }
    expect(soldier.path).toBeNull()
    expect(soldier.dest).toBeNull()
    expect(soldier.targetId).toBeNull()
    // 3 秒寬限與判負歸屬（matchEnded／resolveMatchResult）由 session 層測試覆蓋。
  })
})
