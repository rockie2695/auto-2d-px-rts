import { describe, expect, it } from 'vitest'

import { DEFAULT_POLICIES, resolvePolicies } from './policy.ts'
import { activeTempoOverrides, effectivePolicies, TEMPO_PRESETS } from './tempo.ts'

/**
 * 節奏預設（階段三 Prompt 6 #3）：時間窗覆蓋、standard 恒等、合成正確。
 */

describe('TEMPO_PRESETS 時段覆蓋（Prompt 6 #3）', () => {
  it('standard：任何時刻無覆蓋（恆等）', () => {
    expect(TEMPO_PRESETS.standard).toHaveLength(0)
    for (const tick of [0, 2400, 7200, 12000]) {
      expect(activeTempoOverrides('standard', tick)).toEqual({})
      expect(effectivePolicies(DEFAULT_POLICIES, tick)).toEqual(DEFAULT_POLICIES)
    }
  })

  it('rush 前 2 分鐘全力軍事（econMilitary 0.1、aggression 1.0）', () => {
    const user = resolvePolicies({ tempoPreset: 'rush' })
    const at = (tick: number): number => effectivePolicies(user, tick).econMilitary
    expect(at(0)).toBe(0.1) // t=0 秒
    expect(at(2399)).toBe(0.1) // 119.95 秒（窗內）
    expect(at(2400)).toBe(0.6) // 120 秒整 → 下一窗
    expect(at(6001)).toBe(0.4) // 300 秒後
    // aggression 同步覆蓋。
    expect(effectivePolicies(user, 0).aggression).toBe(1.0)
    expect(effectivePolicies(user, 2400).aggression).toBe(0.5)
  })

  it('turtle：全程龜縮（econMilitary 0.7、aggression 0.1）', () => {
    const user = resolvePolicies({ tempoPreset: 'turtle' })
    for (const tick of [0, 2400, 12000]) {
      const eff = effectivePolicies(user, tick)
      expect(eff.econMilitary).toBe(0.7)
      expect(eff.aggression).toBe(0.1)
    }
  })

  it('late_game：前期重經濟（0.8）、300 秒起轉強攻（0.2/aggression 0.8）', () => {
    const user = resolvePolicies({ tempoPreset: 'late_game' })
    expect(effectivePolicies(user, 0).econMilitary).toBe(0.8)
    expect(effectivePolicies(user, 5999).econMilitary).toBe(0.8) // 299.95 秒仍在首窗
    expect(effectivePolicies(user, 6000).econMilitary).toBe(0.2) // 300 秒整 → 轉段
    expect(effectivePolicies(user, 6000).aggression).toBe(0.8)
  })

  it('early_pressure：240 秒後回落到 0.5/0.5', () => {
    const user = resolvePolicies({ tempoPreset: 'early_pressure' })
    expect(effectivePolicies(user, 0).econMilitary).toBe(0.3)
    expect(effectivePolicies(user, 4800).econMilitary).toBe(0.5)
    expect(effectivePolicies(user, 4800).aggression).toBe(0.5)
  })

  it('覆蓋只蓋列出的鍵——其餘沿用用戶設定；用戶原值不被改寫', () => {
    const user = resolvePolicies({ econMilitary: 0.9, reserve: 0.2, tempoPreset: 'rush' })
    const eff = effectivePolicies(user, 0)
    expect(eff.econMilitary).toBe(0.1) // 被覆蓋
    expect(eff.reserve).toBe(0.2) // 未列 → 沿用
    expect(user.econMilitary).toBe(0.9) // 用戶原值不變
  })
})

describe('resolvePolicies 深合併（Prompt 6：resourceBias 子鍵）', () => {
  it('bias 只給部分子鍵 → 其餘用預設', () => {
    const values = resolvePolicies({ resourceBias: { red: 1 } })
    expect(values.resourceBias).toEqual({ blue: 0.5, red: 1, green: 0.5 })
  })

  it('9 個數值滑桿 + tempoPreset 全部可覆寫、夾限 [0,1]', () => {
    const values = resolvePolicies({
      econMilitary: 2,
      reserve: -1,
      retreatThreshold: 0.7,
      expansion: 0.3,
      techRush: 0.9,
      tempoPreset: 'turtle',
    })
    expect(values.econMilitary).toBe(1)
    expect(values.reserve).toBe(0)
    expect(values.retreatThreshold).toBe(0.7)
    expect(values.expansion).toBe(0.3)
    expect(values.techRush).toBe(0.9)
    expect(values.tempoPreset).toBe('turtle')
  })
})
