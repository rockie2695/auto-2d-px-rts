import { describe, expect, it } from 'vitest'

import { parseReplay, ReplayRecorder, REPLAY_SAMPLE_INTERVAL_TICKS } from './replay.ts'
import type { ReplayRecord } from './replay.ts'

/**
 * 戰後復盤紀錄測試（Prompt 10.5，MVP）：
 * - 紀錄器：20 tick 取樣、finish 產出不可變複本
 * - parseReplay：合法 JSON fixture 可讀；缺欄位／壞型別擲錯
 */

const FIXTURE: ReplayRecord = {
  seed: 42,
  result: 'player',
  durationTicks: 2400,
  finalCrystal: { player: 830, enemy: 410 },
  resourceSeries: [
    { tick: 0, player: 600, enemy: 600 },
    { tick: 20, player: 605, enemy: 605 },
  ],
  unitCountSeries: [
    { tick: 0, player: 3, enemy: 3 },
    { tick: 20, player: 3, enemy: 4 },
  ],
  powerSeries: [
    { tick: 0, player: 4320, enemy: 4320 },
    { tick: 20, player: 4320, enemy: 5280 },
  ],
  policyEvents: [{ tick: 600, key: 'aggression', from: 0.5, to: 1 }],
}

describe('ReplayRecorder', () => {
  it('取樣累積；finish 產出完整紀錄（陣列為複本）', () => {
    const recorder = new ReplayRecorder()
    recorder.sample(0, 600, 600, 3, 3, 1440, 1440)
    recorder.sample(20, 605, 610, 3, 4, 1440, 1920)
    recorder.recordPolicy({ tick: 10, key: 'aggression', from: 0.5, to: 0.8 })
    const record = recorder.finish(42, 'player', { player: 605, enemy: 610 }, 20)

    expect(record.seed).toBe(42)
    expect(record.result).toBe('player')
    expect(record.durationTicks).toBe(20)
    expect(record.finalCrystal).toEqual({ player: 605, enemy: 610 })
    expect(record.resourceSeries).toEqual([
      { tick: 0, player: 600, enemy: 600 },
      { tick: 20, player: 605, enemy: 610 },
    ])
    expect(record.unitCountSeries).toEqual([
      { tick: 0, player: 3, enemy: 3 },
      { tick: 20, player: 3, enemy: 4 },
    ])
    expect(record.powerSeries).toEqual([
      { tick: 0, player: 1440, enemy: 1440 },
      { tick: 20, player: 1440, enemy: 1920 },
    ])
    expect(record.policyEvents).toEqual([{ tick: 10, key: 'aggression', from: 0.5, to: 0.8 }])

    // finish 之後再取樣不影響已產出的紀錄（複本語意）。
    recorder.sample(40, 700, 700, 5, 5, 3000, 3000)
    expect(record.resourceSeries).toHaveLength(2)
    expect(record.powerSeries).toHaveLength(2)
  })

  it('取樣間隔常數：20 tick（1 秒）', () => {
    expect(REPLAY_SAMPLE_INTERVAL_TICKS).toBe(20)
  })
})

describe('投降事件（Prompt 8.6）', () => {
  it('recordSurrender：先投方入冊、後投不覆蓋；finish 附帶 surrender', () => {
    const recorder = new ReplayRecorder()
    recorder.recordSurrender({
      tick: 2400,
      player: 'enemy',
      type: 'ai_surrender',
      despairAtSurrender: 0.81,
      powerRatio: 0.4,
      incomeRatio: 0.5,
    })
    recorder.recordSurrender({
      tick: 2401,
      player: 'player',
      type: 'ai_surrender',
      despairAtSurrender: 0.9,
      powerRatio: 0.2,
      incomeRatio: 0.3,
    })
    const record = recorder.finish(7, 'player', { player: 100, enemy: 900 }, 2400)
    expect(record.surrender).toEqual({
      tick: 2400,
      player: 'enemy',
      type: 'ai_surrender',
      despairAtSurrender: 0.81,
      powerRatio: 0.4,
      incomeRatio: 0.5,
    })
  })
})

describe('parseReplay（replay 檔驗證）', () => {
  it('合法 JSON fixture → 完整 ReplayRecord', () => {
    const json = JSON.parse(JSON.stringify(FIXTURE)) as unknown
    expect(parseReplay(json)).toEqual(FIXTURE)
  })

  it('非物件／壞 result → 擲錯', () => {
    expect(() => parseReplay(null)).toThrow()
    expect(() => parseReplay('nope')).toThrow()
    expect(() => parseReplay({ ...FIXTURE, result: 'nobody' })).toThrow()
  })

  it('缺欄位／壞型別 → 擲錯', () => {
    const missingDuration = { ...FIXTURE } as Record<string, unknown>
    delete missingDuration.durationTicks
    expect(() => parseReplay(missingDuration)).toThrow(/durationTicks/)

    expect(() => parseReplay({ ...FIXTURE, resourceSeries: 'nope' })).toThrow(/resourceSeries/)
    expect(() =>
      parseReplay({
        ...FIXTURE,
        resourceSeries: [{ tick: 0, player: 'x', enemy: 1 }],
      }),
    ).toThrow(/player/)
    expect(() => parseReplay({ ...FIXTURE, policyEvents: 'nope' })).toThrow(/policyEvents/)
    expect(() =>
      parseReplay({ ...FIXTURE, policyEvents: [{ tick: 1, key: 3, from: 0, to: 1 }] }),
    ).toThrow(/key/)
    expect(() => parseReplay({ ...FIXTURE, finalCrystal: { player: 1 } })).toThrow(/finalCrystal/)
    expect(() => {
      const missingSeed = { ...FIXTURE } as Record<string, unknown>
      delete missingSeed.seed
      parseReplay(missingSeed)
    }).toThrow(/seed/)
  })

  it('空 policyEvents / 空序列合法（極短局）', () => {
    const record = parseReplay({
      seed: 7,
      result: 'draw',
      durationTicks: 0,
      finalCrystal: { player: 600, enemy: 600 },
      resourceSeries: [],
      unitCountSeries: [],
      powerSeries: [],
      policyEvents: [],
    })
    expect(record.policyEvents).toHaveLength(0)
    expect(record.resourceSeries).toHaveLength(0)
  })

  it('surrender（Prompt 8.6）：可缺（舊檔 undefined）；合法原樣；壞型別擲錯', () => {
    // 舊檔缺欄 → undefined。
    expect(parseReplay(FIXTURE).surrender).toBeUndefined()

    // 合法 → 原樣。
    const event = {
      tick: 2400,
      player: 'enemy',
      type: 'ai_surrender',
      despairAtSurrender: 0.81,
      powerRatio: 0.4,
      incomeRatio: 0.5,
    }
    const record = parseReplay({ ...FIXTURE, surrender: event })
    expect(record.surrender).toEqual(event)

    // 壞型別：player/type 非法、非物件、數值壞。
    expect(() =>
      parseReplay({ ...FIXTURE, surrender: { ...event, player: 'nobody' } }),
    ).toThrow(/surrender\.player/)
    expect(() =>
      parseReplay({ ...FIXTURE, surrender: { ...event, type: 'other' } }),
    ).toThrow(/surrender\.type/)
    expect(() => parseReplay({ ...FIXTURE, surrender: 'nope' })).toThrow(/surrender/)
    expect(() =>
      parseReplay({ ...FIXTURE, surrender: { ...event, despairAtSurrender: 'high' } }),
    ).toThrow(/despairAtSurrender/)
  })

  it('surrender（Prompt 10.6 player_surrender）：type 合法；timestamp 可缺可帶；壞 timestamp 擲錯', () => {
    // 玩家手動投降：type = player_surrender（含 timestamp）。
    const playerEvent = {
      tick: 1500,
      player: 'player',
      type: 'player_surrender',
      despairAtSurrender: 0,
      powerRatio: 0.55,
      incomeRatio: 0.6,
      timestamp: 1760000000000,
    }
    const record = parseReplay({ ...FIXTURE, surrender: playerEvent })
    expect(record.surrender).toEqual(playerEvent)

    // AI 投降/舊檔可缺 timestamp（undefined 原樣省略）。
    const aiEvent = {
      tick: 2400,
      player: 'enemy',
      type: 'player_surrender',
      despairAtSurrender: 0,
      powerRatio: 0.3,
      incomeRatio: 0.4,
    }
    expect(parseReplay({ ...FIXTURE, surrender: aiEvent }).surrender).not.toHaveProperty(
      'timestamp',
    )

    // 壞 timestamp 擲錯。
    expect(() =>
      parseReplay({ ...FIXTURE, surrender: { ...playerEvent, timestamp: 'now' } }),
    ).toThrow(/surrender\.timestamp/)
  })
})

describe('Prompt 10.5 完整版欄位（可缺；型別壞擲錯；recorder 往返）', () => {
  it('recorder：sampleTiers/recordDeaths/recordTempo/recordDecisions → finish 帶出；空陣列省略', () => {
    const recorder = new ReplayRecorder()
    recorder.sample(0, 600, 600, 3, 3, 100, 100)
    recorder.sampleTiers(0, { small: 2, medium: 1, large: 0 }, { small: 3, medium: 0, large: 0 })
    recorder.recordDeaths([{ tick: 40, player: 'enemy', defId: 'archer', tier: 'small', role: 'ranged' }])
    recorder.recordTempo({ tick: 100, from: 'standard', to: 'rush' })
    recorder.recordDecisions([
      { tick: 40, actor: 'player', action: 'train', target: 'archer', score: 1.8, cost: 50, explanation: '生 archer。理由：unitRange 偏遠程' },
    ])
    const record = recorder.finish(42, 'player', { player: 600, enemy: 600 }, 100)
    expect(record.tierCountSeries).toEqual([
      { tick: 0, player: { small: 2, medium: 1, large: 0 }, enemy: { small: 3, medium: 0, large: 0 } },
    ])
    expect(record.deathEvents).toEqual([
      { tick: 40, player: 'enemy', defId: 'archer', tier: 'small', role: 'ranged' },
    ])
    expect(record.tempoEvents).toEqual([{ tick: 100, from: 'standard', to: 'rush' }])
    expect(record.decisions?.[0]?.score).toBe(1.8)
    expect(record.decisions?.[0]?.outcomeAlive).toBeUndefined() // finalize 前未填

    // 空陣列省略：finish 後欄位 undefined（與舊檔同形）。
    const empty = new ReplayRecorder().finish(42, 'draw', { player: 0, enemy: 0 }, 0)
    expect(empty.deathEvents).toBeUndefined()
    expect(empty.tierCountSeries).toBeUndefined()
    expect(empty.tempoEvents).toBeUndefined()
    expect(empty.decisions).toBeUndefined()
    expect(empty.armorStats).toBeUndefined()
  })

  it('parseReplay：新欄位合法往返＋可缺＋壞型別擲錯', () => {
    // 缺欄（舊檔）→ undefined。
    const bare = parseReplay(FIXTURE)
    expect(bare.deathEvents).toBeUndefined()
    expect(bare.tierCountSeries).toBeUndefined()
    expect(bare.tempoEvents).toBeUndefined()
    expect(bare.decisions).toBeUndefined()
    expect(bare.armorStats).toBeUndefined()

    // 合法 → 原樣往返（含 outcomeAlive 可選）。
    const full = parseReplay({
      ...FIXTURE,
      deathEvents: [{ tick: 40, player: 'enemy', defId: 'archer', tier: 'small', role: 'ranged' }],
      tierCountSeries: [
        { tick: 0, player: { small: 2, medium: 1, large: 0 }, enemy: { small: 3, medium: 0, large: 0 } },
      ],
      tempoEvents: [{ tick: 100, from: 'standard', to: 'rush' }],
      decisions: [
        {
          tick: 40,
          actor: 'player',
          action: 'train',
          target: 'archer',
          score: 1.8,
          cost: 50,
          explanation: '生 archer',
          outcomeAlive: 3,
        },
      ],
      armorStats: { takenRaw: { player: 100, enemy: 60 }, takenActual: { player: 55, enemy: 60 } },
    })
    expect(full.deathEvents).toEqual([
      { tick: 40, player: 'enemy', defId: 'archer', tier: 'small', role: 'ranged' },
    ])
    expect(full.tierCountSeries?.[0]?.player.small).toBe(2)
    expect(full.tempoEvents).toEqual([{ tick: 100, from: 'standard', to: 'rush' }])
    expect(full.decisions?.[0]?.outcomeAlive).toBe(3)
    expect(full.armorStats?.takenRaw.player).toBe(100)

    // 壞型別擲錯。
    expect(() =>
      parseReplay({ ...FIXTURE, deathEvents: [{ tick: 1, player: 'nobody', defId: 'u', tier: 'small', role: 'melee' }] }),
    ).toThrow(/deathEvents\[0\]\.player/)
    expect(() => parseReplay({ ...FIXTURE, deathEvents: 'nope' })).toThrow(/deathEvents/)
    expect(() =>
      parseReplay({ ...FIXTURE, tierCountSeries: [{ tick: 0, player: { small: 'x', medium: 0, large: 0 }, enemy: { small: 0, medium: 0, large: 0 } }] }),
    ).toThrow(/tierCountSeries\[0\]\.player\.small/)
    expect(() =>
      parseReplay({ ...FIXTURE, tempoEvents: [{ tick: 1, from: 1, to: 'rush' }] }),
    ).toThrow(/tempoEvents\[0\]\.from/)
    expect(() =>
      parseReplay({ ...FIXTURE, decisions: [{ tick: 1, actor: 'nobody', action: 'train', target: 'u', score: 1, cost: 1, explanation: 'x' }] }),
    ).toThrow(/decisions\[0\]\.actor/)
    expect(() =>
      parseReplay({ ...FIXTURE, decisions: [{ tick: 1, actor: 'player', action: 'scout', target: 'u', score: 1, cost: 1, explanation: 'x' }] }),
    ).toThrow(/decisions\[0\]\.action/)
    expect(() =>
      parseReplay({ ...FIXTURE, armorStats: { takenRaw: { player: 'x', enemy: 1 }, takenActual: { player: 1, enemy: 1 } } }),
    ).toThrow(/armorStats\.takenRaw\.player/)
    expect(() => parseReplay({ ...FIXTURE, armorStats: 'nope' })).toThrow(/armorStats/)
  })
})
