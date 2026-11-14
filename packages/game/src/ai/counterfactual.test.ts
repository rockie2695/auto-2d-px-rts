import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { buildPolicyTimeline, policiesFromSliders, replayMatch, surrenderSnapshotTicks, suggestCounterfactuals } from './counterfactual.ts'
import type { CounterfactualSuggestion, ReplayOutcome } from './counterfactual.ts'
import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import type { ReplayRecord } from '../replay.ts'

/**
 * 反事實引擎（Prompt 10.5c）單元測試：
 * - 時間線重建：初始快照＋事件疊加、資源偏重深合併、未來事件不回溯；
 * - 重放確定性：同 seed 同選項 → 同結局；**基線重放復現原局結果**（核心驗收）；
 * - 覆寫生效：改滑桿 → 世界狀態可觀察地改變；
 * - 建議生成：三維度各一條、撞邊界翻轉、快照點取樣。
 */

// 內容來源改讀 public/data 目錄（避免相對 fetch 依賴 dev server）。
vi.mock('../data/loadFromFetch.ts', () => ({
  loadContentPackFromFetch: vi.fn(async () => {
    const { loadContentPackFromDir } = await import('../data/loadFromDir.ts')
    return loadContentPackFromDir(fileURLToPath(new URL('../../public/data/', import.meta.url)))
  }),
}))

const content = loadContentPackFromDir(
  fileURLToPath(new URL('../../public/data/', import.meta.url)),
)

const INITIAL = {
  sliders: {
    econMilitary: 0.5,
    unitSize: 0.5,
    unitRange: 0.5,
    clusterSpread: 0.5,
    aggression: 0.5,
    expansion: 0.5,
    techRush: 0.5,
    reserve: 0.5,
    retreatThreshold: 0.5,
    'resourceBias.blue': 0.5,
    'resourceBias.red': 0.5,
    'resourceBias.green': 0.5,
  },
  tempoPreset: 'standard',
}

describe('buildPolicyTimeline（時間線重建）', () => {
  it('tick 0 = 開局快照；事件按 tick 疊加；未來事件不回溯', () => {
    const timeline = buildPolicyTimeline(
      INITIAL,
      [
        { tick: 600, key: 'aggression', from: 0.5, to: 0.8 },
        { tick: 1200, key: 'aggression', from: 0.8, to: 0.2 },
      ],
      [{ tick: 900, from: 'standard', to: 'rush' }],
    )
    expect(timeline.at(0).aggression).toBe(0.5)
    expect(timeline.at(0).tempoPreset).toBe('standard')
    expect(timeline.at(600).aggression).toBe(0.8)
    expect(timeline.at(899).aggression).toBe(0.8)
    expect(timeline.at(899).tempoPreset).toBe('standard')
    expect(timeline.at(900).tempoPreset).toBe('rush')
    expect(timeline.at(1200).aggression).toBe(0.2)
    // tick 超過所有事件 → 收斂到最終值（與原局尾段一致）。
    expect(timeline.at(5000).aggression).toBe(0.2)
    expect(timeline.at(5000).tempoPreset).toBe('rush')
  })

  it('resourceBias 子鍵深合併；未知鍵忽略；數值夾緊到 [0,1]', () => {
    const timeline = buildPolicyTimeline(INITIAL, [
      { tick: 100, key: 'resourceBias.blue', from: 0.5, to: 1.2 },
      { tick: 100, key: 'unknownKey', from: 0, to: 9 },
    ])
    const at = timeline.at(200)
    expect(at.resourceBias.blue).toBe(1) // 夾緊
    expect(at.resourceBias.red).toBe(0.5) // 未動
    expect(at.aggression).toBe(0.5) // 未知鍵不影響
  })

  it('policiesFromSliders：缺鍵用預設值補齊（partial 快照也安全）', () => {
    const policies = policiesFromSliders({ aggression: 0.1 }, 'rush')
    expect(policies.aggression).toBe(0.1)
    expect(policies.econMilitary).toBe(0.5)
    expect(policies.tempoPreset).toBe('rush')
  })
})

describe('replayMatch（headless 重放）', () => {
  it('確定性：同 seed 同時間線 → 同結局', () => {
    const timeline = buildPolicyTimeline(INITIAL)
    const options = { seed: 42, timeline, maxTicks: 600 } as const
    const a = replayMatch(content, options)
    const b = replayMatch(content, options)
    expect(a).toEqual(b)
  })

  it('基線重放復現原局結果（核心驗收）：session 跑一場 → timeline 重放 → 同 result', async () => {
    const { startGameSession } = await import('../session.ts')
    const app = {
      ticker: {
        add: vi.fn((fn: (ticker: { deltaMS: number }) => void) => {
          frames.push(fn)
        }),
        remove: vi.fn(),
      },
      screen: { width: 1024, height: 1024 },
    }
    const frames: Array<(ticker: { deltaMS: number }) => void> = []
    const scene = {
      initialize: vi.fn(),
      update: vi.fn(),
      setSelected: vi.fn(),
      setMarkers: vi.fn(),
      updateFogMask: vi.fn(),
      setEngageLines: vi.fn(),
    }
    const session = await startGameSession(app as never, scene as never)
    for (let frame = 0; frame < 6; frame += 1) {
      for (const frameFn of frames) frameFn({ deltaMS: 1000 }) // 每次 ≈ 20 tick
    }
    session.endMatch()
    const replay = session.getOutcome().replay
    session.stop()
    if (replay === null) throw new Error('結束後 replay 不應為 null')

    // 用 replay 自帶的資料重建時間線 → 無覆寫重放 → 原局結果。
    const timeline = buildPolicyTimeline(
      replay.initialPolicies ?? INITIAL,
      replay.policyEvents,
      replay.tempoEvents ?? [],
    )
    const outcome = replayMatch(content, {
      seed: replay.seed,
      timeline,
      maxTicks: replay.durationTicks,
    })
    expect(outcome.result).toBe(replay.result)
  })

  it('覆寫生效：自 tick 0 改 aggression 0→1，重放世界狀態可觀察地改變', () => {
    const timeline = buildPolicyTimeline({
      ...INITIAL,
      sliders: { ...INITIAL.sliders, aggression: 0 },
    })
    const baseline = replayMatch(content, { seed: 42, timeline, maxTicks: 600 })
    const aggressive = replayMatch(content, {
      seed: 42,
      timeline,
      overrides: { aggression: 1 },
      overrideTick: 0,
      maxTicks: 600,
    })
    // 不假設優劣方向——但政策被消費：終態（水晶或存活數）必須可觀察地不同。
    const sameState =
      baseline.finalCrystal.player === aggressive.finalCrystal.player &&
      baseline.aliveUnits.player === aggressive.aliveUnits.player
    expect(sameState).toBe(false)
  })

  it('overrideTick：覆寫點之前兩場逐 tick 一致（覆寫不提前生效）', () => {
    const timeline = buildPolicyTimeline(INITIAL)
    // 覆寫自 600 起（含）：跑到 560 為止兩場完全一致；跑到 600 恰在邊界，
    // 終態可能已分歧——前者是本測試要的「不提前生效」證據。
    const before = replayMatch(content, { seed: 42, timeline, maxTicks: 560 })
    const beforeOverridden = replayMatch(content, {
      seed: 42,
      timeline,
      overrides: { aggression: 1 },
      overrideTick: 600,
      maxTicks: 560,
    })
    expect(before).toEqual(beforeOverridden)
  })
})

describe('投降快照點與建議生成', () => {
  /** 矩陣 replay fixture：投降局、時長 1200、預設快照。 */
  function surrenderReplay(): ReplayRecord {
    return {
      seed: 42,
      result: 'enemy',
      durationTicks: 1260, // 投降 1200 + 60 寬限
      finalCrystal: { player: 100, enemy: 900 },
      resourceSeries: [],
      unitCountSeries: [],
      powerSeries: [],
      policyEvents: [],
      surrender: {
        tick: 1200,
        player: 'player',
        type: 'player_surrender',
        despairAtSurrender: 0,
        powerRatio: 0.3,
        incomeRatio: 0.4,
        buildingCount: { player: 4, enemy: 5 },
      },
      initialPolicies: INITIAL,
    }
  }

  it('surrenderSnapshotTicks：1/3、2/3、整點；無投降 → 空陣列', () => {
    expect(surrenderSnapshotTicks(surrenderReplay())).toEqual([400, 800, 1200])
    // 極短局去重：投降 tick 30 → 只留 30（後點取代前點）。
    const shortSurrender = surrenderReplay().surrender
    if (shortSurrender === undefined) throw new Error('fixture 應有 surrender')
    const short: ReplayRecord = { ...surrenderReplay(), surrender: { ...shortSurrender, tick: 30 } }
    expect(surrenderSnapshotTicks(short)).toEqual([30])
    // 無投降 → 空陣列。
    const { surrender: _omitted, ...noSurrender } = surrenderReplay()
    expect(surrenderSnapshotTicks(noSurrender)).toEqual([])
  })

  it('suggestCounterfactuals：三維度各一條（from/to 不同）＋重放結局齊欄', () => {
    const replay = surrenderReplay()
    const timeline = buildPolicyTimeline(INITIAL)
    const suggestions = suggestCounterfactuals(content, replay, timeline, 400)
    expect(suggestions).toHaveLength(3)
    const keys = suggestions.map((suggestion) => suggestion.key)
    expect(keys).toEqual(['aggression', 'econMilitary', 'retreatThreshold'])
    for (const suggestion of suggestions as CounterfactualSuggestion[]) {
      expect(suggestion.to).not.toBe(suggestion.from)
      expect(suggestion.to).toBeGreaterThanOrEqual(0)
      expect(suggestion.to).toBeLessThanOrEqual(1)
      expect(suggestion.label.length).toBeGreaterThan(0)
      const outcome = suggestion.outcome as ReplayOutcome
      expect(outcome.durationTicks).toBeLessThanOrEqual(replay.durationTicks)
      expect(['player', 'enemy', 'draw']).toContain(outcome.result)
    }
  })

  it('suggestCounterfactuals：撞邊界翻轉（aggression 已 1 → 改 0.75）', () => {
    const replay = surrenderReplay()
    const timeline = buildPolicyTimeline({
      ...INITIAL,
      sliders: { ...INITIAL.sliders, aggression: 1 },
    })
    const suggestions = suggestCounterfactuals(content, replay, timeline, 400)
    const aggression = suggestions.find((suggestion) => suggestion.key === 'aggression')
    expect(aggression?.from).toBe(1)
    expect(aggression?.to).toBe(0.75)
  })
})
