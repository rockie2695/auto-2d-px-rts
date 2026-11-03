import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { startGameSession } from './session.ts'
import type { GameSession, UnitInfo } from './session.ts'

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
