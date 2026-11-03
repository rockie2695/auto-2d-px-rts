import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_POLICIES } from './ai/policy.ts'
import { matchEnded, resolveMatchResult, startGameSession } from './session.ts'
import type { GameSession, UnitInfo } from './session.ts'
import { POLICY_COOLDOWN_TICKS } from './session.ts'
import { addBuilding } from './sim/economy.ts'
import { createTestWorld, makeBuildingDef } from './sim/testFixtures.ts'

/** 內容來源改讀 public/data 目錄（避免相對 fetch 依賴 dev server）。 */
vi.mock('./data/loadFromFetch.ts', () => ({
  loadContentPackFromFetch: vi.fn(async () => {
    const { loadContentPackFromDir } = await import('./data/loadFromDir.ts')
    return loadContentPackFromDir(fileURLToPath(new URL('../public/data/', import.meta.url)))
  }),
}))

/**
 * 組合根整合測試（Prompt 9.4 / 9.5）：
 * 用假 Pixi Application（手動驅動 ticker）+ 真實內容跑對局，
 * 驗證 `getUnitInfo` 的微操決策／小隊任務欄位與 `getBattleStats` 的
 * 日誌、小隊、戰力產出。
 */

function makeFakeApp() {
  const onFrameFns: Array<(ticker: { deltaMS: number }) => void> = []
  return {
    ticker: {
      add: vi.fn((fn: (ticker: { deltaMS: number }) => void) => {
        onFrameFns.push(fn)
      }),
      remove: vi.fn(),
    },
    screen: { width: 1024, height: 1024 },
    onFrame: async (deltaMS: number): Promise<void> => {
      await Promise.all(onFrameFns.map((fn) => fn({ deltaMS })))
    },
  }
}

function makeFakeScene() {
  return {
    initialize: vi.fn(),
    update: vi.fn(),
    setSelected: vi.fn(),
  }
}

describe('組合根 getUnitInfo / getBattleStats（Prompt 9.5）', () => {
  it('跑 240 tick：單位帶「當下決策」與小隊任務；戰況有日誌、小隊與戰力', async () => {
    const app = makeFakeApp()
    const session: GameSession = await startGameSession(app as never, makeFakeScene() as never)
    expect(app.ticker.add).toHaveBeenCalledOnce()

    // 240 tick = 12 秒：戰略（40）/戰術（10）/微操（2）各跑多輪。
    for (let frame = 0; frame < 12; frame++) {
      await app.onFrame(1000) // 1000ms ≈ 20 tick
    }

    const stats = session.getBattleStats()
    expect(stats.playerCrystal).toBeGreaterThanOrEqual(0)
    expect(stats.playerPower).toBeGreaterThan(0)
    expect(stats.enemyPower).toBeGreaterThan(0)
    expect(stats.squads.length).toBeGreaterThan(0)
    for (const squad of stats.squads) {
      expect(squad.mission).toMatch(/defend|attack|harass|retreat/)
      expect(squad.memberCount).toBeGreaterThan(0)
      expect(Number.isFinite(squad.distTiles)).toBe(true)
    }
    expect(stats.log.length).toBeGreaterThan(0)
    for (const entry of stats.log) {
      expect(entry.text.length).toBeGreaterThan(0)
      expect(['strategic', 'tactical']).toContain(entry.layer)
    }

    // 有小隊任務的單位，其資訊同時帶「當下微操決策」。
    const info = findSquadMemberUnit(session)
    expect(info).not.toBeNull()
    if (info !== null) {
      expect(info.squadMission).toMatch(/defend|attack|harass|retreat/)
      expect(info.decision !== null && info.decision.length > 0).toBe(true)
    }

      session.stop()
    expect(app.ticker.remove).toHaveBeenCalledOnce()
  })
})

/** 找任一「已編隊且活著」的單位資訊：MVP 世界 id 從 1 連續編號，掃前 64 個。 */
function findSquadMemberUnit(session: GameSession): UnitInfo | null {
  for (let id = 1; id <= 64; id++) {
    const info = session.getUnitInfo(id)
    if (info !== null && info.squadMission !== null) return info
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 政策滑桿 API（Prompt 10）                                            */
/* ------------------------------------------------------------------ */

describe('政策滑桿 getPolicies / applyPolicies（Prompt 10）', () => {
  it('開局即可套用：值生效、日誌記政策層標記、冷卻中拒絕、600 tick 後解鎖', async () => {
    const app = makeFakeApp()
    const session: GameSession = await startGameSession(app as never, makeFakeScene() as never)

    const initial = session.getPolicies('player')
    expect(initial.values).toEqual(DEFAULT_POLICIES)
    expect(initial.cooldownRemainingTicks).toBe(0)

    expect(session.applyPolicies('player', { aggression: 1 })).toBe(true)
    const after = session.getPolicies('player')
    expect(after.values.aggression).toBe(1)
    expect(after.cooldownRemainingTicks).toBe(POLICY_COOLDOWN_TICKS) // tick 0 套用 → 滿冷卻

    // 日誌有政策層條目（含變更明細與「此後決策受影響」標記）。
    const entry = session.getBattleStats().log.find((item) => item.layer === 'policy')
    expect(entry !== undefined && entry.actor === 'player').toBe(true)
    expect(entry?.text).toContain('政策變更')
    expect(entry?.text).toContain('aggression 0.50→1.00')
    expect(entry?.text).toContain('此後決策受影響')

    // 冷卻中：再改被拒，值不變。
    expect(session.applyPolicies('player', { aggression: 0 })).toBe(false)
    expect(session.getPolicies('player').values.aggression).toBe(1)

    // 跑 31 幀（620 tick ≥ 600）解鎖後可再改。
    for (let frame = 0; frame < 31; frame++) {
      await app.onFrame(1000)
    }
    expect(session.getPolicies('player').cooldownRemainingTicks).toBe(0)
    expect(session.applyPolicies('player', { aggression: 0 })).toBe(true)
    expect(session.getPolicies('player').values.aggression).toBe(0)

    session.stop()
    expect(app.ticker.remove).toHaveBeenCalledOnce()
  })

  it('超出 [0,1] 會被夾限', async () => {
    // 兩個 session：冷卻內只能套用一次實際變更，故各測上界與下界。
    const appHigh = makeFakeApp()
    const sessionHigh: GameSession = await startGameSession(appHigh as never, makeFakeScene() as never)
    expect(sessionHigh.applyPolicies('player', { aggression: 5 })).toBe(true)
    expect(sessionHigh.getPolicies('player').values.aggression).toBe(1)
    sessionHigh.stop()

    const appLow = makeFakeApp()
    const sessionLow: GameSession = await startGameSession(appLow as never, makeFakeScene() as never)
    expect(sessionLow.applyPolicies('player', { clusterSpread: -3 })).toBe(true)
    expect(sessionLow.getPolicies('player').values.clusterSpread).toBe(0)
    sessionLow.stop()
  })

  it('無實際變更：接受但不消耗冷卻', async () => {
    const app = makeFakeApp()
    const session: GameSession = await startGameSession(app as never, makeFakeScene() as never)

    expect(session.applyPolicies('player', { ...DEFAULT_POLICIES })).toBe(true) // 同值
    expect(session.getPolicies('player').cooldownRemainingTicks).toBe(0) // 冷卻沒被吃掉
    expect(session.applyPolicies('player', { unitRange: 1 })).toBe(true) // 立即仍可改
    expect(session.getPolicies('player').values.unitRange).toBe(1)

    session.stop()
  })

  it('滑桿在下一個戰術週期生效：clusterSpread 0.5→1 後小隊合併成 1 隊', async () => {
    const appMerged = makeFakeApp()
    const sessionMerged: GameSession = await startGameSession(
      appMerged as never,
      makeFakeScene() as never,
    )
    expect(sessionMerged.applyPolicies('player', { clusterSpread: 1 })).toBe(true)
    for (let frame = 0; frame < 2; frame++) {
      await appMerged.onFrame(1000) // 40 tick = 2 個戰術週期
    }
    const merged = sessionMerged
      .getBattleStats()
      .squads.filter((squad) => squad.player === 'player')
    expect(merged.length).toBe(1)
    sessionMerged.stop()

    // 對照組：預設 clusterSpread 0.5 → 多隊。
    const appDefault = makeFakeApp()
    const sessionDefault: GameSession = await startGameSession(
      appDefault as never,
      makeFakeScene() as never,
    )
    for (let frame = 0; frame < 2; frame++) {
      await appDefault.onFrame(1000)
    }
    const defaultSquads = sessionDefault
      .getBattleStats()
      .squads.filter((squad) => squad.player === 'player')
    expect(defaultSquads.length).toBeGreaterThan(1)
    sessionDefault.stop()
  })

  it('政策摘要：套用後輪詢可讀到最後一條戰略日誌', async () => {
    const app = makeFakeApp()
    const session: GameSession = await startGameSession(app as never, makeFakeScene() as never)
    expect(session.getPolicies('player').summary).toBeNull() // 尚無戰略決策

    for (let frame = 0; frame < 3; frame++) {
      await app.onFrame(1000) // 60 tick ≥ 戰略週期 40
    }
    const summary = session.getPolicies('player').summary
    expect(summary !== null && summary.length > 0).toBe(true)

    session.stop()
  })
})

/* ------------------------------------------------------------------ */
/* 對局結束、勝負判定與 replay（Prompt 10.5）                            */
/* ------------------------------------------------------------------ */

describe('勝負判定（純函數）', () => {
  /** 合成世界：雙方各一座 keep。 */
  function keepWorld(): ReturnType<typeof createTestWorld> {
    const world = createTestWorld({
      size: 12,
      buildings: [makeBuildingDef({ id: 'keep', hp: 100 })],
    })
    addBuilding(world, 'player', 'keep', { x: 0, y: 0 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 11, y: 11 }, { built: true, nodeId: null })
    return world
  }

  it('雙 keep 俱在且未超時 → draw；一方被毀 → 對方勝；同 tick 雙殺 → draw', () => {
    const world = keepWorld()
    expect(matchEnded(world)).toBe(false)
    expect(resolveMatchResult(world)).toBe('draw')

    const enemyKeep = world.buildings.find((b) => b.player === 'enemy')
    if (enemyKeep === undefined) throw new Error('找不到敵方 keep')
    enemyKeep.hp = 0
    expect(matchEnded(world)).toBe(true)
    expect(resolveMatchResult(world)).toBe('player')

    const playerKeep = world.buildings.find((b) => b.player === 'player')
    if (playerKeep === undefined) throw new Error('找不到玩家 keep')
    playerKeep.hp = 0
    expect(resolveMatchResult(world)).toBe('draw')
  })

  it('超時（雙 keep 俱在）→ 水晶多者勝、同數平手；matchEnded 為真', () => {
    const world = keepWorld()
    world.tick = world.match.maxTicks
    expect(matchEnded(world)).toBe(true)
    expect(resolveMatchResult(world)).toBe('draw') // 起始水晶相同

    const player = world.players.find((p) => p.id === 'player')
    const enemy = world.players.find((p) => p.id === 'enemy')
    if (player === undefined || enemy === undefined) throw new Error('找不到玩家')
    enemy.blueCrystal = 500
    expect(resolveMatchResult(world)).toBe('player')
  })
})

describe('手動結束與 replay 產出（Prompt 10.5）', () => {
  it('endMatch → 停迴圈、outcome.ended、replay 含樣本與政策事件', async () => {
    const app = makeFakeApp()
    const session: GameSession = await startGameSession(app as never, makeFakeScene() as never)
    expect(session.getOutcome().ended).toBe(false)

    // 對局推進 2 秒（含 tick 20/40 的取樣點），並改一次滑桿（記政策事件）。
    await app.onFrame(1000)
    expect(session.applyPolicies('player', { aggression: 1 })).toBe(true)
    await app.onFrame(1000)

    expect(session.endMatch()).toBe(true)
    const outcome = session.getOutcome()
    expect(outcome.ended).toBe(true)
    if (outcome.replay === null) throw new Error('結束後 replay 不應為 null')

    // 勝負：雙 keep 俱在且未超時（手動提前結束）→ 平手（MVP 規則）。
    expect(outcome.replay.result).toBe('draw')
    // tick 0 起的完整樣本（資源與單位數成對等長）。
    expect(outcome.replay.resourceSeries[0]?.tick).toBe(0)
    expect(outcome.replay.resourceSeries[0]?.player).toBe(600)
    expect(outcome.replay.unitCountSeries[0]?.player).toBe(3)
    expect(outcome.replay.resourceSeries.length).toBe(outcome.replay.unitCountSeries.length)
    expect(outcome.replay.resourceSeries.length).toBeGreaterThanOrEqual(2)
    // 政策時間軸：1 筆 aggression 0.5→1。
    expect(outcome.replay.policyEvents).toEqual([
      { tick: expect.any(Number), key: 'aggression', from: 0.5, to: 1 },
    ])
    // 最終資源與時長。
    expect(outcome.replay.durationTicks).toBeGreaterThan(0)
    expect(outcome.replay.finalCrystal.player).toBeGreaterThanOrEqual(0)

    // 對局已停：ticker 移除；重複 endMatch 回 false。
    expect(app.ticker.remove).toHaveBeenCalled()
    expect(session.endMatch()).toBe(false)

    session.stop()
  })
})
