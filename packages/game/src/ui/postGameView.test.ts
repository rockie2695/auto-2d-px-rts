import { describe, expect, it } from 'vitest'

import {
  counterfactualPoints,
  endTypeOf,
  headerCopyOf,
  lostMoments,
  policiesAt,
  replayPoliciesOf,
  sliceWindow,
} from './postGameView.ts'
import type { ReplayDecision, ReplayRecord } from '../replay.ts'

/**
 * 戰後復盤三視圖純邏輯（Prompt 10.5c）單元測試：
 * - endTypeOf／headerCopyOf：三種結束狀態與文案（中性分析性）；
 * - sliceWindow／lostMoments：切片與關鍵時刻排序；
 * - counterfactualPoints：投降局用投降 tick、正常局用全場三等分；
 * - policiesAt／replayPoliciesOf：時間線重建與「重玩」政策（缺快照 → null）。
 */

function surrenderReplay(surrenderPlayer: 'player' | 'enemy'): ReplayRecord {
  return {
    seed: 42,
    result: surrenderPlayer === 'player' ? 'enemy' : 'player',
    durationTicks: 300,
    finalCrystal: { player: 100, enemy: 500 },
    resourceSeries: [],
    unitCountSeries: [],
    powerSeries: [],
    policyEvents: [],
    surrender: {
      tick: 240,
      player: surrenderPlayer,
      type: surrenderPlayer === 'player' ? 'player_surrender' : 'ai_surrender',
      despairAtSurrender: 0.5,
      powerRatio: 0.3,
      incomeRatio: 0.4,
      buildingCount: { player: 4, enemy: 5 },
    },
  }
}

describe('endTypeOf／headerCopyOf（三視圖）', () => {
  it('投降方 = player → player_surrender；enemy → ai_surrender；無投降 → normal_end', () => {
    expect(endTypeOf(surrenderReplay('player'))).toBe('player_surrender')
    expect(endTypeOf(surrenderReplay('enemy'))).toBe('ai_surrender')
    const normal = { ...surrenderReplay('player') } as ReplayRecord & { surrender?: unknown }
    delete normal.surrender
    expect(endTypeOf(normal as unknown as ReplayRecord)).toBe('normal_end')
  })

  it('文案：不羞辱（投降局）、不假裝鼓勵（勝利局＝中性分析）', () => {
    const lost = headerCopyOf('player_surrender', 'enemy')
    expect(lost.title).toBe('你投降了')
    expect(lost.subtitle).not.toContain('沒關係')
    expect(lost.subtitle).toContain('如果當時')
    const won = headerCopyOf('ai_surrender', 'player')
    expect(won.title).toBe('對手投降了')
    expect(won.accent).not.toBe(lost.accent)
    const victory = headerCopyOf('normal_end', 'player')
    expect(victory.title).toBe('勝利')
    const defeat = headerCopyOf('normal_end', 'enemy')
    expect(defeat.title).toBe('失敗')
    const draw = headerCopyOf('normal_end', 'draw')
    expect(draw.title).toBe('平手')
  })
})

describe('sliceWindow／lostMoments', () => {
  it('sliceWindow：保留 [before − windowTicks, before]', () => {
    const series = [
      { tick: 0, player: 1, enemy: 1 },
      { tick: 100, player: 2, enemy: 2 },
      { tick: 700, player: 3, enemy: 3 },
      { tick: 900, player: 4, enemy: 4 },
    ]
    expect(sliceWindow(series, 800).map((sample) => sample.tick)).toEqual([700]) // 窗口 200–800
    expect(sliceWindow(series, 900).map((sample) => sample.tick)).toEqual([700, 900]) // 窗口 300–900
  })

  it('lostMoments：僅我方＋有備選；分差小在前；上限 5', () => {
    const decisions: ReplayDecision[] = []
    for (let index = 0; index < 7; index++) {
      decisions.push({
        tick: 40 * (index + 1),
        actor: 'player',
        action: 'train',
        target: `unit${index}`,
        score: 2,
        cost: 50,
        explanation: `d${index}`,
        alternatives: [
          { defId: `unit${index}`, score: 2 },
          { defId: `alt${index}`, score: 2 - index * 0.1 }, // 分差 = index * 0.1
        ],
      })
    }
    decisions.push({ tick: 50, actor: 'enemy', action: 'train', target: 'enemy_unit', score: 1, cost: 1, explanation: 'x', alternatives: [{ defId: 'a', score: 1 }, { defId: 'b', score: 0.9 }] })
    decisions.push({ tick: 60, actor: 'player', action: 'train', target: 'no_alt', score: 1, cost: 1, explanation: 'x' })
    const moments = lostMoments(decisions, 300)
    expect(moments).toHaveLength(5)
    expect(moments[0]?.target).toBe('unit0') // 分差 0 最小
    expect(moments[0]?.alternative).toBe('alt0')
    expect(moments[4]?.target).toBe('unit4')
  })

  it('lostMoments：投降 tick 之後的決策不取', () => {
    const decisions: ReplayDecision[] = [
      {
        tick: 500,
        actor: 'player',
        action: 'train',
        target: 'late',
        score: 1,
        cost: 1,
        explanation: 'x',
        alternatives: [
          { defId: 'late', score: 1 },
          { defId: 'alt', score: 0.9 },
        ],
      },
    ]
    expect(lostMoments(decisions, 240)).toEqual([])
  })
})

describe('counterfactualPoints', () => {
  it('投降局：投降 tick 三等分（1/3、2/3、整點）', () => {
    expect(counterfactualPoints(surrenderReplay('player'))).toEqual([80, 160, 240])
  })

  it('正常局：全場時長三等分；無投降且時長 0 → 單點 0', () => {
    const normal = { ...surrenderReplay('player') } as ReplayRecord & { surrender?: unknown }
    delete normal.surrender
    expect(counterfactualPoints(normal as unknown as ReplayRecord)).toEqual([100, 200, 300])
    const zero = { ...(normal as unknown as ReplayRecord), durationTicks: 0 }
    expect(counterfactualPoints(zero)).toEqual([0])
  })
})

describe('policiesAt／replayPoliciesOf（重玩政策）', () => {
  const replay = surrenderReplay('player')

  it('policiesAt：缺 initialPolicies → null；有 → 時間線 at(tick)', () => {
    expect(policiesAt({ ...replay, initialPolicies: undefined }, 0)).toBeNull()
    const withInitial = {
      ...replay,
      initialPolicies: {
        sliders: { aggression: 0.5, 'resourceBias.blue': 0.5 },
        tempoPreset: 'standard',
      },
    }
    expect(policiesAt(withInitial, 0)?.aggression).toBe(0.5)
  })

  it('replayPoliciesOf：快照時刻政策＋單一維度覆寫；未知鍵原樣返回', () => {
    const withInitial = {
      ...replay,
      initialPolicies: {
        sliders: { aggression: 0.5, econMilitary: 0.4 },
        tempoPreset: 'rush',
      },
    }
    const tuned = replayPoliciesOf(withInitial, 240, 'aggression', 0.75)
    expect(tuned?.aggression).toBe(0.75)
    expect(tuned?.econMilitary).toBe(0.4)
    expect(tuned?.tempoPreset).toBe('rush')
    expect(replayPoliciesOf(withInitial, 240, 'unknownKey', 1)?.aggression).toBe(0.5)
    // 缺快照 → null（App 端不觸發重玩）。
    expect(replayPoliciesOf({ ...replay, initialPolicies: undefined }, 0, 'aggression', 1)).toBeNull()
  })
})
