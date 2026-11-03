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
})
