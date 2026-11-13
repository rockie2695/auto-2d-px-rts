import { useState } from 'react'

import { TICK_RATE_HZ } from '@auto-2d-px-rts/shared'
import type { TempoPreset } from '@auto-2d-px-rts/shared'

import type { PolicyValues, ResourceBias } from '../ai/policy.ts'
import { TEMPO_PRESETS } from '../ai/tempo.ts'
import type { PolicySnapshot } from '../session.ts'
import { useDraggable } from './useDraggable.ts'
import { SLIDERS, TEMPO_OPTIONS } from './policyMeta.ts'
import type { NumericPolicyKey } from './policyMeta.ts'

/**
 * 底部中央：AI 政策面板（規則 10；Prompt 10 完整版：三段式 12+1 維度）。
 * - **三段式佈局**：頂部「節奏」（預設下拉＋**時段覆蓋預覽**——選中預設即列出
 *   各時間窗的覆蓋值，當前所處時間窗高亮，`PolicySnapshot.tick` 提供遊戲時刻）；
 *   中段「方針」（9 支**方向式**滑桿＋tooltip，unitSize 文案含勢力例外聲明）；
 *   底段「資源比例」（三滑桿 **simplex**：總和恆為 1、百分比顯示）。
 * - **simplex 資源比例**：拖任一支，另兩支按剩餘比例重分（另兩支和為 0 → 均分）；
 *   套用送**歸一化**草稿——AI 消費點 max 歸一（`resourceBias` 相對權重），行為等價；
 *   歸一後與生效值相等時 payload **不帶** `resourceBias`（不吃冷卻、不記無意義日誌）；
 *   存量全 0（CLI 邊界）僅顯示為均分，不改存儲。
 * - **草稿模型**：拖動只改本地草稿（數值即時顯示、不觸發 session）；「套用變更」
 *   整包送出（30 秒冷卻，**節奏預設免冷卻**）；「還原」回復最後生效值。
 * - 可收合；底部「結束並復盤」手動結束對局（Prompt 10.5）。
 */

/** 套用 payload（Prompt 10 完整版）：resourceBias 為歸一化後的完整三鍵（或省略）。 */
export type PolicyApplyPayload = Partial<Omit<PolicyValues, 'resourceBias'>> & {
  resourceBias?: ResourceBias
}

type BiasKey = 'blue' | 'red' | 'green'

const BIAS_KEYS: readonly BiasKey[] = ['blue', 'red', 'green']

const BIAS_LABELS: Record<BiasKey, string> = {
  blue: '藍水晶',
  red: '紅寶石',
  green: '綠翡翠',
}

/** 節奏覆蓋預覽的鍵名（Prompt 10 完整版）：覆蓋規則裡只會出現這些滑桿鍵。 */
const OVERRIDE_LABELS: Record<string, string> = {
  econMilitary: '經濟',
  unitSize: '體型',
  unitRange: '射程',
  clusterSpread: '集群',
  aggression: '侵略',
  expansion: '擴張',
  techRush: '科技',
  reserve: '留守',
  retreatThreshold: '撤退閾',
}

/** 時間窗文字：有限 → 「起–迄s」；無限 → 「起s 之後」。 */
function windowText(start: number, end: number): string {
  return end === Number.POSITIVE_INFINITY
    ? `${Math.round(start)}s 之後`
    : `${Math.round(start)}–${Math.round(end)}s`
}

/**
 * 資源比例歸一（Prompt 10 完整版 simplex）：三鍵總和 = 1；總和為 0 → 均分。
 * 顯示與套用一律走歸一值——AI 消費點（max 歸一）只看相對比例，行為等價。
 */
function normalizeBias(bias: ResourceBias): ResourceBias {
  const sum = bias.blue + bias.red + bias.green
  if (sum <= 0) return { blue: 1 / 3, red: 1 / 3, green: 1 / 3 }
  return { blue: bias.blue / sum, red: bias.red / sum, green: bias.green / sum }
}

/** 兩組歸一比例是否語義相等（誤差 < 0.005 = 半格滑桿步進）。 */
function biasEquals(a: ResourceBias, b: ResourceBias): boolean {
  return (
    Math.abs(a.blue - b.blue) < 0.005 &&
    Math.abs(a.red - b.red) < 0.005 &&
    Math.abs(a.green - b.green) < 0.005
  )
}

/**
 * 拖動一支滑桿後重分另兩支（Prompt 10 完整版）：總和恆為 1。
 * 另兩支按原比例縮放到剩餘額度；另兩支和為 0 → 均分剩餘；拖滿 1 → 另兩支歸 0。
 */
function renormalizeBias(bias: ResourceBias, key: BiasKey, value: number): ResourceBias {
  const v = Math.min(1, Math.max(0, value))
  const rest = 1 - v
  const others = BIAS_KEYS.filter((candidate) => candidate !== key)
  const first = others[0]
  const second = others[1]
  if (first === undefined || second === undefined) {
    return { blue: 1 / 3, red: 1 / 3, green: 1 / 3 } // 不可達（BIAS_KEYS 恆三鍵）
  }
  const otherSum = bias[first] + bias[second]
  const firstShare = otherSum <= 0 ? rest / 2 : bias[first] * (rest / otherSum)
  const secondShare = otherSum <= 0 ? rest / 2 : bias[second] * (rest / otherSum)
  if (key === 'blue') return { blue: v, red: firstShare, green: secondShare }
  if (key === 'red') return { blue: firstShare, red: v, green: secondShare }
  return { blue: firstShare, red: secondShare, green: v }
}

/** 草稿與生效值是否有差異（滑桿逐鍵、bias 比歸一值、tempo 逐值）。 */
function hasDiff(draft: PolicyValues, committed: PolicyValues): boolean {
  for (const { key } of SLIDERS) {
    if (draft[key] !== committed[key]) return true
  }
  if (!biasEquals(normalizeBias(draft.resourceBias), normalizeBias(committed.resourceBias))) {
    return true
  }
  return draft.tempoPreset !== committed.tempoPreset
}

/**
 * 套用 payload（Prompt 10 完整版）：resourceBias 送**歸一化**完整三鍵；
 * 歸一後與生效值相等 → 整個鍵省略（不吃冷卻、不記無意義的 `政策變更` 日誌）。
 */
function applyPayloadOf(draft: PolicyValues, committed: PolicyValues): PolicyApplyPayload {
  const payload: PolicyApplyPayload = {
    econMilitary: draft.econMilitary,
    unitSize: draft.unitSize,
    unitRange: draft.unitRange,
    clusterSpread: draft.clusterSpread,
    aggression: draft.aggression,
    expansion: draft.expansion,
    techRush: draft.techRush,
    reserve: draft.reserve,
    retreatThreshold: draft.retreatThreshold,
    tempoPreset: draft.tempoPreset,
  }
  if (!biasEquals(normalizeBias(draft.resourceBias), normalizeBias(committed.resourceBias))) {
    payload.resourceBias = normalizeBias(draft.resourceBias)
  }
  return payload
}

export function PolicyPanel({
  policy,
  onApply,
  onEndMatch,
}: {
  /** 目前政策快照（輪詢取得）；尚未有對局為 null。 */
  policy: PolicySnapshot | null
  /** 按下「套用變更」：呼叫端負責 `applyPolicies`（冷卻中按鈕已禁用）。 */
  onApply: (values: PolicyApplyPayload) => void
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
  // 投降後不能再調 Policy（Prompt 10.6）：投降方政策鎖定（session 也拒絕）。
  const surrendered = policy?.surrendered ?? false
  const base = draft ?? committed
  const changed =
    base !== undefined && committed !== undefined ? hasDiff(base, committed) : false
  const applyDisabled = policy === null || !changed || surrendered
  const displayBias = base === undefined ? null : normalizeBias(base.resourceBias)

  const setSlider = (key: NumericPolicyKey, value: number): void => {
    const source = draft ?? committed
    if (source === undefined) return
    setDraft({ ...source, [key]: value })
  }
  const setBias = (key: BiasKey, value: number): void => {
    const source = draft ?? committed
    if (source === undefined) return
    // simplex（Prompt 10 完整版）：從歸一值出發重分——生效值可能是未歸一的相對權重。
    const norm = normalizeBias(source.resourceBias)
    setDraft({ ...source, resourceBias: renormalizeBias(norm, key, value) })
  }
  const setTempo = (value: TempoPreset): void => {
    const source = draft ?? committed
    if (source === undefined) return
    setDraft({ ...source, tempoPreset: value })
  }

  const apply = (): void => {
    if (draft !== null && committed !== undefined) {
      onApply(applyPayloadOf(draft, committed))
      setDraft(null) // 已送出：草稿歸零（生效值由輪詢/立即讀取更新）
    }
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

      {/* 頂段：節奏（Prompt 10 完整版：下拉＋時段覆蓋預覽） */}
      <div className="policy-section" data-testid="policy-section-tempo">
        <div className="policy-section-title">節奏</div>
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
        {base !== undefined && (
          <div className="policy-tempo-preview" data-testid="policy-tempo-preview">
            {TEMPO_PRESETS[base.tempoPreset].length === 0 ? (
              <span className="policy-tempo-none" data-testid="policy-tempo-none">
                無時段覆蓋：玩家滑桿全場生效
              </span>
            ) : (
              TEMPO_PRESETS[base.tempoPreset].map((rule, index) => {
                const [start, end] = rule.timeRange
                const nowSec = (policy?.tick ?? 0) / TICK_RATE_HZ
                const active = nowSec >= start && nowSec < end
                const overrides = Object.entries(rule.policyOverrides)
                  .map(([key, value]) => `${OVERRIDE_LABELS[key] ?? key}→${value.toFixed(2)}`)
                  .join('、')
                return (
                  <div
                    key={index}
                    className={active ? 'policy-tempo-rule is-active' : 'policy-tempo-rule'}
                    data-testid="policy-tempo-rule"
                  >
                    <span className="policy-tempo-window">{windowText(start, end)}</span>
                    <span className="policy-tempo-overrides">{overrides}</span>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* 中段：方針（9 支方向式滑桿） */}
      <div className="policy-section" data-testid="policy-section-sliders">
        <div className="policy-section-title">方針</div>
        <div className="policy-sliders-grid">
          {SLIDERS.map(({ key, label, tooltip }) => (
            <label className="policy-slider" key={key}>
              <span className="policy-slider-label" title={tooltip}>
                {label}
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={base === undefined ? 0.5 : base[key]}
                disabled={base === undefined}
                data-testid={`slider-${key}`}
                aria-label={label}
                title={tooltip}
                onChange={(event) => setSlider(key, Number(event.target.value))}
              />
              <output className="policy-slider-value">
                {base === undefined ? '—' : base[key].toFixed(2)}
              </output>
            </label>
          ))}
        </div>
      </div>

      {/* 底段：資源比例（simplex：總和恆為 1、百分比顯示） */}
      <div className="policy-section" data-testid="policy-section-bias">
        <div className="policy-section-title">資源比例（總和 100%）</div>
        <div className="policy-bias-grid">
          {BIAS_KEYS.map((key) => (
            <label className="policy-slider" key={`bias-${key}`}>
              <span className="policy-slider-label">{BIAS_LABELS[key]}礦</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={displayBias === null ? 0.5 : displayBias[key]}
                disabled={displayBias === null}
                data-testid={`slider-resourceBias-${key}`}
                aria-label={`資源比例：${BIAS_LABELS[key]}`}
                onChange={(event) => setBias(key, Number(event.target.value))}
              />
              <output
                className="policy-slider-value"
                data-testid={`bias-pct-${key}`}
              >
                {displayBias === null ? '—' : `${Math.round(displayBias[key] * 100)}%`}
              </output>
            </label>
          ))}
        </div>
        <div className="policy-bias-note">百分比四捨五入，拖任一支自動重分另兩支</div>
      </div>

      <div className="policy-actions">
        <button
          type="button"
          data-testid="policy-apply"
          disabled={applyDisabled}
          onClick={apply}
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
        {surrendered
          ? '已投降：政策已鎖定（本局不可再調整）'
          : cooling
            ? `冷卻中 ${countdownSec}s（30 秒可改一次；節奏預設不受限）`
            : '可調整（30 秒可改一次；節奏預設不受限）'}
      </div>
      <button type="button" className="policy-end" data-testid="policy-end-match" onClick={onEndMatch}>
        結束並復盤
      </button>
    </aside>
  )
}
