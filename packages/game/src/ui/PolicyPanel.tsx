import { useState } from 'react'

import type { TempoPreset } from '@auto-2d-px-rts/shared'

import type { PolicyValues } from '../ai/policy.ts'
import type { PolicySnapshot } from '../session.ts'
import { useDraggable } from './useDraggable.ts'

/**
 * 底部中央：AI 政策面板（規則 10，階段三 Prompt 6：9 數值滑桿＋三資源偏重＋節奏預設）。
 * - **草稿模型**：拖動只改本地草稿（數值即時顯示、不觸發 session）；
 *   「套用變更」整包送出（session 對實際變更的鍵記日誌；滑桿變更開 30 秒冷卻，
 *   **節奏預設免冷卻**）；「還原」把草稿回復為最後生效值。
 * - 頂部節奏預設下拉（rush / early_pressure / standard / late_game / turtle）；
 *   9 滑杆兩列網格；三資源偏重三滑杆。
 * - 可收合；底部「結束並復盤」手動結束對局（Prompt 10.5）。
 */

const TEMPO_OPTIONS: ReadonlyArray<{ value: TempoPreset; label: string }> = [
  { value: 'rush', label: '快攻 rush' },
  { value: 'early_pressure', label: '前期壓制' },
  { value: 'standard', label: '標準' },
  { value: 'late_game', label: '後期決戰' },
  { value: 'turtle', label: '龜縮' },
]

const SLIDERS: ReadonlyArray<{ key: NumericPolicyKey; label: string }> = [
  { key: 'econMilitary', label: '經濟↔軍事' },
  { key: 'aggression', label: '侵略性' },
  { key: 'unitSize', label: '單位規模' },
  { key: 'unitRange', label: '單位射程' },
  { key: 'clusterSpread', label: '集結密度' },
  { key: 'expansion', label: '擴張' },
  { key: 'techRush', label: '科技' },
  { key: 'reserve', label: '留守' },
  { key: 'retreatThreshold', label: '撤退閾' },
]

const BIAS_SLIDERS: ReadonlyArray<{ key: BiasKey; label: string }> = [
  { key: 'blue', label: '偏藍礦' },
  { key: 'red', label: '偏紅礦' },
  { key: 'green', label: '偏綠礦' },
]

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

type BiasKey = 'blue' | 'red' | 'green'

/** 草稿與生效值是否有差異（滑桿逐鍵、bias 逐子鍵、tempo 逐值）。 */
function hasDiff(draft: PolicyValues, committed: PolicyValues): boolean {
  for (const { key } of SLIDERS) {
    if (draft[key] !== committed[key]) return true
  }
  for (const { key } of BIAS_SLIDERS) {
    if (draft.resourceBias[key] !== committed.resourceBias[key]) return true
  }
  return draft.tempoPreset !== committed.tempoPreset
}

export function PolicyPanel({
  policy,
  onApply,
  onEndMatch,
}: {
  /** 目前政策快照（輪詢取得）；尚未有對局為 null。 */
  policy: PolicySnapshot | null
  /** 按下「套用變更」：呼叫端負責 `applyPolicies`（冷卻中按鈕已禁用）。 */
  onApply: (values: PolicyValues) => void
  /** 按下「結束並復盤」：手動結束對局（Prompt 10.5）。 */
  onEndMatch: () => void
}) {
  const [open, setOpen] = useState(true)
  const { position, panelRef, handleProps } = useDraggable()
  // 草稿：null = 與最後生效值一致（拖動才建立）。
  const [draft, setDraft] = useState<PolicyValues | null>(null)
  const committed = policy?.values

  if (!open) {
    return (
      <button
        type="button"
        className="policy-panel-collapsed"
        data-testid="policy-panel-collapsed"
        onClick={() => setOpen(true)}
      >
        AI 政策滑桿（收合中）
      </button>
    )
  }

  const cooling = (policy?.cooldownRemainingTicks ?? 0) > 0
  const countdownSec = Math.ceil((policy?.cooldownRemainingTicks ?? 0) / 20)
  const base = draft ?? committed
  const changed =
    base !== undefined && committed !== undefined ? hasDiff(base, committed) : false
  const applyDisabled = policy === null || !changed

  const setSlider = (key: NumericPolicyKey, value: number): void => {
    const source = draft ?? committed
    if (source === undefined) return
    setDraft({ ...source, [key]: value })
  }
  const setBias = (key: BiasKey, value: number): void => {
    const source = draft ?? committed
    if (source === undefined) return
    setDraft({ ...source, resourceBias: { ...source.resourceBias, [key]: value } })
  }
  const setTempo = (value: TempoPreset): void => {
    const source = draft ?? committed
    if (source === undefined) return
    setDraft({ ...source, tempoPreset: value })
  }

  return (
    <aside
      ref={panelRef}
      className="hud-panel panel-bottom-center draggable policy-panel-grid"
      data-testid="policy-panel"
      style={
        position === null
          ? undefined
          : { left: position.x, top: position.y, bottom: 'auto', transform: 'none' }
      }
    >
      <div className="hud-panel-title drag-handle" {...handleProps}>
        <span>AI 政策（12+1 維度）</span>
        <button type="button" aria-label="收合政策面板" onClick={() => setOpen(false)}>
          ▾
        </button>
      </div>
      <div className="policy-summary" data-testid="policy-summary">
        {policy?.summary ?? '尚未有戰略決策'}
      </div>
      <label className="policy-slider policy-tempo">
        <span className="policy-slider-label">節奏預設</span>
        <select
          data-testid="policy-tempo"
          aria-label="節奏預設"
          value={base === undefined ? 'standard' : base.tempoPreset}
          disabled={base === undefined}
          onChange={(event) => setTempo(event.target.value as TempoPreset)}
        >
          {TEMPO_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="policy-sliders-grid">
        {SLIDERS.map(({ key, label }) => (
          <label className="policy-slider" key={key}>
            <span className="policy-slider-label">{label}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={base === undefined ? 0.5 : base[key]}
              disabled={base === undefined}
              data-testid={`slider-${key}`}
              aria-label={label}
              onChange={(event) => setSlider(key, Number(event.target.value))}
            />
            <output className="policy-slider-value">
              {base === undefined ? '—' : base[key].toFixed(2)}
            </output>
          </label>
        ))}
        {BIAS_SLIDERS.map(({ key, label }) => (
          <label className="policy-slider" key={`bias-${key}`}>
            <span className="policy-slider-label">{label}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={base === undefined ? 0.5 : base.resourceBias[key]}
              disabled={base === undefined}
              data-testid={`slider-resourceBias-${key}`}
              aria-label={label}
              onChange={(event) => setBias(key, Number(event.target.value))}
            />
            <output className="policy-slider-value">
              {base === undefined ? '—' : base.resourceBias[key].toFixed(2)}
            </output>
          </label>
        ))}
      </div>
      <div className="policy-actions">
        <button
          type="button"
          data-testid="policy-apply"
          disabled={applyDisabled}
          onClick={() => {
            if (draft !== null) {
              onApply(draft)
              setDraft(null) // 已送出：草稿歸零（生效值由輪詢/立即讀取更新）
            }
          }}
        >
          套用變更
        </button>
        <button
          type="button"
          data-testid="policy-reset"
          disabled={!changed}
          onClick={() => setDraft(null)}
        >
          還原
        </button>
      </div>
      <div className="policy-cooldown" data-testid="policy-cooldown">
        {cooling ? `冷卻中 ${countdownSec}s（30 秒可改一次；節奏預設不受限）` : '可調整（30 秒可改一次；節奏預設不受限）'}
      </div>
      <button type="button" className="policy-end" data-testid="policy-end-match" onClick={onEndMatch}>
        結束並復盤
      </button>
    </aside>
  )
}
