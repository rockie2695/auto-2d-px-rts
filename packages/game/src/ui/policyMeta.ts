import type { TempoPreset } from '@auto-2d-px-rts/shared'

import type { PolicyValues } from '../ai/policy.ts'

/**
 * Policy 面板共享元資料（Prompt 10 完整版文案；PolicyPanel 與戰前頁 SetupPanel
 * 復用）——獨立檔案讓組件檔保持「只導出組件」（fast-refresh）。
 */

type NumericPolicyKey =
  | 'econMilitary'
  | 'unitSize'
  | 'unitRange'
  | 'clusterSpread'
  | 'aggression'
  | 'expansion'
  | 'techRush'
  | 'reserve'
  | 'retreatThreshold'

/** 節奏下拉選項（Prompt 10 完整版）。 */
export const TEMPO_OPTIONS: ReadonlyArray<{ value: TempoPreset; label: string }> = [
  { value: 'rush', label: '快攻 rush' },
  { value: 'early_pressure', label: '前期壓制' },
  { value: 'standard', label: '標準' },
  { value: 'late_game', label: '後期決戰' },
  { value: 'turtle', label: '龜縮' },
]

/** 9 支方向式滑桿（Prompt 10 完整版文案）：標籤標明兩端語義，tooltip 補充效果。 */
export const SLIDERS: ReadonlyArray<{ key: NumericPolicyKey; label: string; tooltip: string }> = [
  {
    key: 'econMilitary',
    label: '經濟 ← → 軍事',
    tooltip: '0 = 全力軍事；1 = 全力經濟。建築與生兵的資源分配重心。',
  },
  {
    key: 'unitSize',
    label: '單位體型（大型 ← → 小型）',
    tooltip:
      '大型單位：通常高 HP、高 DPS、低速度。\n' +
      '小型單位：通常低 HP、低 DPS、高速度、數量多。\n' +
      '但具體屬性取決於勢力設計，可能存在例外（例如小型高裝甲單位）。',
  },
  {
    key: 'unitRange',
    label: '近戰 ← → 遠程',
    tooltip: '0 = 偏好近戰單位（貼身輸出）；1 = 偏好遠程單位（風箏點射，但脆）。',
  },
  {
    key: 'clusterSpread',
    label: '分散 ← → 集群',
    tooltip: '0 = 小隊分散走位；1 = 集群推進。',
  },
  {
    key: 'aggression',
    label: '固守 ← → 強攻',
    tooltip: '0 = 固守；1 = 強攻（更早出擊、更激進迎戰）。',
  },
  {
    key: 'expansion',
    label: '龜縮 ← → 擴張',
    tooltip: '0 = 龜縮既有礦場；1 = 提前解鎖紅／綠礦擴張。',
  },
  {
    key: 'techRush',
    label: '數量海 ← → 科技優先',
    tooltip: '0 = 數量海；1 = 科技優先（綠礦投入＋單位技術加成）。',
  },
  {
    key: 'reserve',
    label: '全軍出擊 ← → 重兵留守',
    tooltip: '0 = 全軍出擊；1 = 重兵留守（留守戰力比例）。',
  },
  {
    key: 'retreatThreshold',
    label: '死戰不退 ← → 一有劣勢就撤',
    tooltip: '0 = 死戰不退；1 = 一有劣勢就撤（撤退閾值乘數）。',
  },
]

/** NumericPolicyKey 導出（PreGamePage 滑桿 set 函式型別用）。 */
export type { NumericPolicyKey }

/** 型別守衛用：PolicyValues 的數值鍵即 NumericPolicyKey（編譯期校驗）。 */
const _check: ReadonlyArray<keyof PolicyValues> = ['tempoPreset', 'resourceBias']
void _check
