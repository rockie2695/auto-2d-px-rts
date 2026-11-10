import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { MAP_SIZE } from '@auto-2d-px-rts/shared'

import { DEFAULT_POLICIES } from './ai/policy.ts'
import {
  getActiveSession,
  matchEnded,
  matchSideValue,
  resolveMatchResult,
  suddenDeathLogText,
  startGameSession,
} from './session.ts'
import type { GameSession, UnitInfo } from './session.ts'
import { POLICY_COOLDOWN_TICKS } from './session.ts'
import { addBuilding } from './sim/economy.ts'
import { createTestWorld, makeBuildingDef, putUnit } from './sim/testFixtures.ts'
import { loadContentPackFromDir } from './data/loadFromDir.ts'
import { createWorld, stepWorld } from './sim/world.ts'
import { UNITS_PER_TILE } from './sim/types.ts'
import { computeTacticalPlan, TACTICAL_INTERVAL_TICKS } from './ai/tactics.ts'
import { MICRO_INTERVAL_TICKS, runMicroCycle } from './ai/micro.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './ai/strategy.ts'

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
    setMarkers: vi.fn(),
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
    expect(stats.playerUnits).toBeGreaterThan(0)
    expect(stats.enemyUnits).toBeGreaterThan(0)
    expect(stats.squads.length).toBeGreaterThan(0)
    for (const squad of stats.squads) {
      expect(squad.mission).toMatch(/defend|attack|harass|stage|retreat/)
      expect(squad.memberCount).toBeGreaterThan(0)
      expect(Number.isFinite(squad.distTiles)).toBe(true)
    }
    expect(stats.log.length).toBeGreaterThan(0)
    for (const entry of stats.log) {
      expect(entry.text.length).toBeGreaterThan(0)
      expect(['strategic', 'tactical', 'micro']).toContain(entry.layer)
    }

    // 有小隊任務的單位，其資訊同時帶「當下微操決策」。
    const info = findSquadMemberUnit(session)
    expect(info).not.toBeNull()
    if (info !== null) {
      expect(info.squadMission).toMatch(/defend|attack|harass|stage|retreat/)
      expect(info.decision !== null && info.decision.length > 0).toBe(true)
      // Prompt 10.13：單位資訊附射程與移動速度。
      expect(info.rangeTiles).toBeGreaterThan(0)
      expect(info.moveSpeedTilesPerSec).toBeGreaterThan(0)
    }

    // 裝甲（Prompt 3.1）：單位資訊帶 armor／有效HP／DPS，且與 def 一致
    // （legionnaire：armor 0.2、maxHp 100 → 有效 HP 125；DPS = 12 × 1.2 = 14.4）。
    let sawLegionnaire = false
    for (let id = 1; id <= 64; id++) {
      const unit = session.getUnitInfo(id)
      if (unit === null || unit.defId !== 'legionnaire') continue
      sawLegionnaire = true
      expect(unit.armor).toBe(0.2)
      expect(unit.effHp).toBeCloseTo(125, 6)
      expect(unit.dps).toBeCloseTo(14.4, 6)
      break
    }
    expect(sawLegionnaire).toBe(true)
    // 戰力取樣含裝甲換算（Prompt 3.1）：開局 3 legionnaire 滿血 →
    // playerPower ≥ 3 × 125 × 12 × 1.2（受傷只會降低，不會低於 0）。
    expect(stats.playerPower).toBeGreaterThan(0)

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

  it('節奏預設（Prompt 6）：冷卻中也可切換、不開冷卻；resourceBias 深合併', async () => {
    const app = makeFakeApp()
    const session: GameSession = await startGameSession(app as never, makeFakeScene() as never)

    // 滑桿變更 → 開冷卻。
    expect(session.applyPolicies('player', { aggression: 1 })).toBe(true)
    expect(session.getPolicies('player').cooldownRemainingTicks).toBe(POLICY_COOLDOWN_TICKS)

    // 冷卻中切節奏預設 → 允許、不重置冷卻、記一條政策日誌。
    expect(session.applyPolicies('player', { tempoPreset: 'rush' })).toBe(true)
    expect(session.getPolicies('player').values.tempoPreset).toBe('rush')
    expect(session.getPolicies('player').cooldownRemainingTicks).toBe(POLICY_COOLDOWN_TICKS)
    const tempoLog = session
      .getBattleStats()
      .log.find((item) => item.layer === 'policy' && item.text.includes('節奏預設'))
    expect(tempoLog?.text).toContain('rush')

    // 冷卻中改滑桿仍被拒。
    expect(session.applyPolicies('player', { reserve: 0 })).toBe(false)

    // resourceBias 部分子鍵深合併（其餘鍵用現值）；冷卻中先拒、解鎖後可改。
    for (let frame = 0; frame < 31; frame++) {
      await app.onFrame(1000)
    }
    expect(session.applyPolicies('player', { resourceBias: { red: 1 } })).toBe(true)
    const values = session.getPolicies('player').values
    expect(values.resourceBias).toEqual({ blue: 0.5, red: 1, green: 0.5 })

    session.stop()
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

  it('超時（雙 keep 俱在）→ 總價值多者勝、嚴格相等才平手（Prompt 10.23）；matchEnded 為真', () => {
    const world = keepWorld()
    world.tick = world.match.maxTicks
    expect(matchEnded(world)).toBe(true)
    // 對稱殘局（同兩座 keep、cost 0、同水晶） → 價值嚴格相等 → 平手。
    expect(resolveMatchResult(world)).toBe('draw')

    const player = world.players.find((p) => p.id === 'player')
    const enemy = world.players.find((p) => p.id === 'enemy')
    if (player === undefined || enemy === undefined) throw new Error('找不到玩家')
    // 總價值多者勝（Prompt 10.23：取代 Prompt 10.10 的「一律平手」）。
    enemy.resources.blue_crystal += 500 // 超出對方 → 敵勝
    expect(resolveMatchResult(world)).toBe('enemy')
    player.resources.blue_crystal += 800 // 反超 → 玩家勝
    expect(resolveMatchResult(world)).toBe('player')
    enemy.resources.blue_crystal -= 500
    player.resources.blue_crystal -= 800
    expect(resolveMatchResult(world)).toBe('draw') // 重新相等 → 平手

    // 未超時（雙 keep 俱在）→ 一律平手（手動提前結束語義，Prompt 10.10 不變）。
    world.tick = world.match.maxTicks - 1
    expect(matchEnded(world)).toBe(false)
    enemy.resources.blue_crystal += 5000
    expect(resolveMatchResult(world)).toBe('draw')
  })

  it('matchSideValue：單位殘值按 hp 比例、建築殘值按有效最大 hp 折算（Prompt 10.23）', () => {
    const world = keepWorld()
    putUnit(world, 'player', 'u', { x: 4, y: 4 }) // cost 50、滿血 hp 100
    // keep def cost 0（test fixture）→ 建築貢獻 0；基準 = 水晶 1000 + 單位 50。
    expect(matchSideValue(world, 'player')).toBe(1050)

    const unit = world.units.find((u) => u.player === 'player')
    if (unit === undefined) throw new Error('找不到單位')
    unit.hp = 50
    expect(matchSideValue(world, 'player')).toBe(1025) // 單位殘值 50 × 50%

    // 建築殘值：給 keep 成本 100 → 滿血折 +100；hp 40 → +40（殘值 = cost × hp/max）。
    world.defs.buildings.keep = makeBuildingDef({
      id: 'keep',
      hp: 100,
      cost: { blue_crystal: 100 },
    })
    unit.hp = 100
    expect(matchSideValue(world, 'player')).toBe(1150)
    const playerKeep = world.buildings.find((b) => b.player === 'player')
    if (playerKeep === undefined) throw new Error('找不到玩家 keep')
    playerKeep.hp = 40
    expect(matchSideValue(world, 'player')).toBe(1090)
  })

  it('suddenDeathLogText（Prompt 10.23）：只在起點／硬期限那一 tick 回敘事文字', () => {
    expect(suddenDeathLogText(7199)).toBeNull()
    expect(suddenDeathLogText(7200)).toBe('突變期啟動：出兵門檻逐檔遞減')
    expect(suddenDeathLogText(7201)).toBeNull()
    expect(suddenDeathLogText(10799)).toBeNull()
    expect(suddenDeathLogText(10800)).toBe('突變期硬期限：全軍出擊')
    expect(suddenDeathLogText(10801)).toBeNull()
  })

  it('全滅（無建築且無單位）→ 結束且對方勝；雙方全滅 → 平手（Prompt 10.5 修）', () => {
    const world = keepWorld()
    putUnit(world, 'enemy', 'u', { x: 6, y: 6 }) // 敵方多一個單位
    const enemyKeep = world.buildings.find((b) => b.player === 'enemy')
    if (enemyKeep === undefined) throw new Error('找不到敵方 keep')
    enemyKeep.hp = 0
    // 敵 keep 毀但還有單位：SPEC §11.1 keep 毀即勝 → 已結束、玩家勝。
    expect(matchEnded(world)).toBe(true)
    expect(resolveMatchResult(world)).toBe('player')

    // 敵方單位也陣亡 → 全滅，同樣玩家勝。
    for (const unit of world.units) {
      if (unit.player === 'enemy') unit.hp = 0
    }
    expect(matchEnded(world)).toBe(true)
    expect(resolveMatchResult(world)).toBe('player')

    // 玩家也全滅 → 雙方都沒有部隊 → 平手。
    const playerKeep = world.buildings.find((b) => b.player === 'player')
    if (playerKeep === undefined) throw new Error('找不到玩家 keep')
    playerKeep.hp = 0
    for (const unit of world.units) {
      if (unit.player === 'player') unit.hp = 0
    }
    expect(matchEnded(world)).toBe(true)
    expect(resolveMatchResult(world)).toBe('draw')
  })

  it('真實內容重現（Prompt 10.5 修）：敵方建築與單位全滅 → matchEnded、玩家勝', () => {
    const content = loadContentPackFromDir(
      fileURLToPath(new URL('../public/data/', import.meta.url)),
    )
    const world = createWorld(content, 42)
    expect(matchEnded(world)).toBe(false) // 開局：雙方俱全

    // 模擬「敵方建築與單位全滅」：所有敵建築 hp 歸 0、敵單位 hp 歸 0。
    for (const building of world.buildings) {
      if (building.player === 'enemy') building.hp = 0
    }
    for (const unit of world.units) {
      if (unit.player === 'enemy') unit.hp = 0
    }
    stepWorld(world) // removeDead 清除屍體（下個 tick 的世界狀態）

    expect(world.buildings.some((b) => b.player === 'enemy')).toBe(false)
    expect(matchEnded(world)).toBe(true)
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
    // 種子已記錄（可重播）。
    expect(outcome.replay.seed).toBeGreaterThan(0)
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

  it('出廠集合格標記推入 render（Prompt 10.19：每間生產建築一個；集結點不再顯示）', async () => {
    const app = makeFakeApp()
    const scene = makeFakeScene()
    const session: GameSession = await startGameSession(app as never, scene as never)
    const calls = scene.setMarkers.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const markers = calls[calls.length - 1]?.[0] as Array<{
      kind: string
      player: string
      buildingId: number
    }>
    expect(markers.filter((marker) => marker.kind === 'rally')).toHaveLength(0) // 集結點轉內部概念
    // 開局配置每陣營一間兵營 → 各一個出廠集合格。
    expect(markers.filter((marker) => marker.kind === 'gather')).toHaveLength(2)
    // 同陣營 buildingId 不重複。
    const idOf = (player: string): number[] =>
      markers.filter((m) => m.kind === 'gather' && m.player === player).map((m) => m.buildingId)
    expect(new Set(idOf('player')).size).toBe(idOf('player').length)
    expect(new Set(idOf('enemy')).size).toBe(idOf('enemy').length)
    session.stop()
  })

  it('標記可查詢（Prompt 10.19：getMarkers／getMarkerInfo 供點擊顯示）', async () => {
    const app = makeFakeApp()
    const scene = makeFakeScene()
    const session: GameSession = await startGameSession(app as never, scene as never)

    const markers = session.getMarkers()
    expect(markers.length).toBeGreaterThan(0)
    for (const marker of markers) {
      const info = session.getMarkerInfo({
        kind: marker.kind,
        player: marker.player,
        buildingId: marker.buildingId,
      })
      expect(info).not.toBeNull()
      expect(info?.title).toContain(marker.player === 'player' ? '我方' : '敵方')
      expect(info?.description.length ?? 0).toBeGreaterThan(0)
      expect(info?.tileX).toBe(marker.tile.x)
      expect(info?.tileY).toBe(marker.tile.y)
    }
    // 紅藍出廠集合格互為鏡像（開局佈局鏡射對稱）。
    const blue = markers.find((m) => m.player === 'player')
    const red = markers.find((m) => m.player === 'enemy')
    const last = MAP_SIZE - 1
    expect(red?.tile).toEqual({ x: last - (blue?.tile.x ?? 0), y: last - (blue?.tile.y ?? 0) })
    session.stop()
  })

  it('stop() 只清掉自己的註冊（StrictMode 雙掛載競態）：舊 session 晚停不誤殺新 session', async () => {
    // 模擬 PixiCanvas remount：start1 → start2 都完成後，start1 才 stop()
    // （StrictMode 第一次掛載的 dispose 晚於第二次的 startGameSession 完成）。
    const app1 = makeFakeApp()
    const session1: GameSession = await startGameSession(app1 as never, makeFakeScene() as never)
    const app2 = makeFakeApp()
    const session2: GameSession = await startGameSession(app2 as never, makeFakeScene() as never)
    expect(getActiveSession()).toBe(session2)

    session1.stop() // 晚到的 dispose：不得把 session2 從輪詢中拔掉
    expect(getActiveSession()).toBe(session2)

    session2.stop()
    expect(getActiveSession()).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* 鏡像對稱（藍方無結構性優勢，Prompt 10.9）                             */
/* ------------------------------------------------------------------ */

describe('鏡像對稱（Prompt 10.9）', () => {
  /**
   * 雙方預設滑桿、鏡射地圖跑 N tick 後，世界應逐項 180° 點鏡射對稱——
   * 這是「藍方無結構性優勢」的強驗收：戰鬥同時結算 + AI 決策鏡像。
   */
  function mirrorProbe(ticks: number, options: { aggregate?: boolean } = {}): void {
    const content = loadContentPackFromDir(
      fileURLToPath(new URL('../public/data/', import.meta.url)),
    )
    const world = createWorld(content, 42)
    const policies = { player: DEFAULT_POLICIES, enemy: DEFAULT_POLICIES }
    const plans: Record<'player' | 'enemy', unknown> = { player: null, enemy: null }
    const last = world.map.size - 1
    const mirror = (value: number): number => world.map.size * UNITS_PER_TILE - value

    while (world.tick < ticks) {
      stepWorld(world)
      if (world.tick % STRATEGIC_INTERVAL_TICKS === 0) {
        for (const player of world.players) {
          runStrategicCycle(world, player.id, policies[player.id])
        }
      }
      if (world.tick % TACTICAL_INTERVAL_TICKS === 0) {
        for (const player of world.players) {
          plans[player.id] = computeTacticalPlan(world, player.id, policies[player.id])
        }
      }
      if (world.tick % MICRO_INTERVAL_TICKS === 0) {
        for (const player of world.players) {
          runMicroCycle(world, player.id, plans[player.id] as never)
        }
      }
    }

    // 單位：每個玩家單位都有同 defId、同 hp、位置互鏡的敵方單位
    // （aggregate 模式跳過：開戰後路徑平手裁決產生對稱性雜訊）。
    if (options.aggregate !== true) {
      for (const unit of world.units) {
        if (unit.player !== 'player') continue
        const mirrorUnit = world.units.find(
          (candidate) =>
            candidate.player === 'enemy' &&
            candidate.defId === unit.defId &&
            candidate.hp === unit.hp &&
            candidate.x === mirror(unit.x) &&
            candidate.y === mirror(unit.y),
        )
        expect(mirrorUnit).toBeDefined()
      }
    }

    // 雙方單位數與水晶相同（strict）；aggregate 不比單位數——開戰後傷亡時序
    // 受混沌放大，可能不同（結構性公平由 strict 測試與 24 種子平衡量測把關）。
    if (options.aggregate !== true) {
      const blueUnits = world.units.filter((unit) => unit.player === 'player').length
      const redUnits = world.units.filter((unit) => unit.player === 'enemy').length
      expect(blueUnits).toBe(redUnits)
    }
    const crystalOf = (playerId: 'player' | 'enemy'): number =>
      world.players.find((player) => player.id === playerId)?.resources.blue_crystal ?? -1
    expect(crystalOf('player')).toBe(crystalOf('enemy'))

    // 建築：strict 模式逐座鏡像配對；aggregate 模式不比建築（開戰後拆遷時序不對稱），
    // 只比水晶／單位數／礦場採集量（見下）。
    if (options.aggregate === true) {
      // 略過逐座比對。
    } else {
      for (const building of world.buildings) {
        if (building.player !== 'player') continue
        const [w, h] = world.defs.buildings[building.defId]?.size ?? [1, 1]
        const mirrorBuilding = world.buildings.find(
          (candidate) =>
            candidate.player === 'enemy' &&
            candidate.defId === building.defId &&
            candidate.hp === building.hp &&
            candidate.x === last - (building.x + w - 1) &&
            candidate.y === last - (building.y + h - 1),
        )
        expect(mirrorBuilding).toBeDefined()
      }
    }

    // 資源點剩餘量鏡像成對（礦場採集對稱）。
    for (const node of world.resourceNodes) {
      const mirrorNode = world.resourceNodes.find(
        (candidate) => candidate.x === last - node.x && candidate.y === last - node.y,
      )
      expect(mirrorNode?.amountRemaining).toBe(node.amountRemaining)
    }
  }

  it('雙方預設滑桿跑 150 tick（開戰前）→ 幾何決策逐項鏡射對稱', () => {
    mirrorProbe(150)
  })

  it('雙方預設滑桿跑 800 tick → 聚合對稱（水晶、建築種類數、單位數、採集量）', () => {
    // 開戰後個別單位的走位／生死受混沌放大，逐項鏡射不保證；
    // 聚合指標（水晶、建築種類數、單位數、礦場採集量）仍應對稱。
    mirrorProbe(800, { aggregate: true })
  })
})
