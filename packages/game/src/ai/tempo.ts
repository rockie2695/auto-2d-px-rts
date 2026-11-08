import { TICK_RATE_HZ } from '@auto-2d-px-rts/shared'
import type { TempoPreset } from '@auto-2d-px-rts/shared'

import type { PolicyValues } from './policy.ts'

/**
 * 節奏預設（階段三 Prompt 6 #3）：`TEMPO_PRESETS[preset]` 是時間窗規則表——
 * 每次決策先找當前時段的 `policyOverrides`，**覆蓋**玩家設定的滑桿後才是生效政策
 * （`effectivePolicies`）。`standard` 無覆蓋（恆等）；時間單位為**秒**（tick ÷ 20）。
 * 敵方固定 `standard`（無覆蓋）——節奏是玩家的戰略選擇，AI 預設不偏側。
 */

export interface TempoRule {
  /** 適用時段 [start, end)（秒；end 可為 Infinity）。 */
  timeRange: readonly [number, number]
  /** 覆蓋玩家滑桿的欄位（只覆蓋列出的鍵）。 */
  policyOverrides: Partial<Omit<PolicyValues, 'resourceBias' | 'tempoPreset'>>
}

export const TEMPO_PRESETS: Record<TempoPreset, readonly TempoRule[]> = {
  rush: [
    { timeRange: [0, 120], policyOverrides: { econMilitary: 0.1, aggression: 1.0 } },
    { timeRange: [120, 300], policyOverrides: { econMilitary: 0.6, aggression: 0.5 } },
    { timeRange: [300, Number.POSITIVE_INFINITY], policyOverrides: { econMilitary: 0.4, aggression: 0.7 } },
  ],
  early_pressure: [
    { timeRange: [0, 240], policyOverrides: { econMilitary: 0.3, aggression: 0.8 } },
    { timeRange: [240, Number.POSITIVE_INFINITY], policyOverrides: { econMilitary: 0.5, aggression: 0.5 } },
  ],
  standard: [],
  late_game: [
    { timeRange: [0, 300], policyOverrides: { econMilitary: 0.8, aggression: 0.2 } },
    { timeRange: [300, Number.POSITIVE_INFINITY], policyOverrides: { econMilitary: 0.2, aggression: 0.8 } },
  ],
  turtle: [{ timeRange: [0, Number.POSITIVE_INFINITY], policyOverrides: { econMilitary: 0.7, aggression: 0.1 } }],
}

/** 當前 tick 的時段覆蓋（無規則命中 → {}；standard 恒 {}）。 */
export function activeTempoOverrides(
  preset: TempoPreset,
  tick: number,
): Partial<Omit<PolicyValues, 'resourceBias' | 'tempoPreset'>> {
  const seconds = tick / TICK_RATE_HZ
  for (const rule of TEMPO_PRESETS[preset]) {
    const [start, end] = rule.timeRange
    if (seconds >= start && seconds < end) return rule.policyOverrides
  }
  return {}
}

/**
 * 生效政策（Prompt 6 #3）：玩家設定 → 節奏覆蓋。純函式、確定性——
 * 戰略／戰術層一律讀這個，用戶原值只存 UI 快照與 replay 事件。
 */
export function effectivePolicies(user: PolicyValues, tick: number): PolicyValues {
  return { ...user, ...activeTempoOverrides(user.tempoPreset, tick) }
}
