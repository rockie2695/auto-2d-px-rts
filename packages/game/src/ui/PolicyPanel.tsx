import { useState } from 'react'

import type { PolicyValues } from '../ai/policy.ts'
import type { PolicySnapshot } from '../session.ts'

/**
 * 底部中央：AI 政策滑桿（Prompt 10，規則 10：玩家只調這 5 個滑桿，不得直接指揮單位）。
 * - 5 個滑桿（名稱／0–1 範圍／數值顯示），拖動即呼叫 `onSliderChange`。
 * - 30 秒冷卻（600 tick）：冷卻中滑桿禁用並顯示倒數秒數。
 * - 頂部一行顯示「目前 AI 決策摘要」（最後一條戰略日誌）。
 * - 可收合（四角已被 HUD 佔用，本面板放底部中央）。
 */

const SLIDERS: ReadonlyArray<{ key: keyof PolicyValues; label: string }> = [
  { key: 'econMilitary', label: '經濟↔軍事' },
  { key: 'unitSize', label: '單位規模' },
  { key: 'unitRange', label: '單位射程' },
  { key: 'aggression', label: '侵略性' },
  { key: 'clusterSpread', label: '集結密度' },
]

export function PolicyPanel({
  policy,
  onSliderChange,
}: {
  /** 目前政策快照（輪詢取得）；尚未有對局為 null。 */
  policy: PolicySnapshot | null
  /** 拖動滑桿：呼叫端負責 `applyPolicies`（冷卻中被禁用不會觸發）。 */
  onSliderChange: (key: keyof PolicyValues, value: number) => void
}) {
  const [open, setOpen] = useState(true)

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

  const values = policy?.values
  const cooling = (policy?.cooldownRemainingTicks ?? 0) > 0
  const countdownSec = Math.ceil((policy?.cooldownRemainingTicks ?? 0) / 20)

  return (
    <aside className="hud-panel panel-bottom-center" data-testid="policy-panel">
      <div className="hud-panel-title">
        <span>AI 政策滑桿</span>
        <button type="button" aria-label="收合政策面板" onClick={() => setOpen(false)}>
          ▾
        </button>
      </div>
      <div className="policy-summary" data-testid="policy-summary">
        {policy?.summary ?? '尚未有戰略決策'}
      </div>
      {SLIDERS.map(({ key, label }) => (
        <label className="policy-slider" key={key}>
          <span className="policy-slider-label">{label}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={values === undefined ? 0.5 : values[key]}
            disabled={cooling || values === undefined}
            data-testid={`slider-${key}`}
            aria-label={label}
            onChange={(event) => onSliderChange(key, Number(event.target.value))}
          />
          <output className="policy-slider-value">
            {values === undefined ? '—' : values[key].toFixed(2)}
          </output>
        </label>
      ))}
      <div className="policy-cooldown" data-testid="policy-cooldown">
        {cooling
          ? `冷卻中 ${countdownSec}s（30 秒可改一次）`
          : '可調整（30 秒可改一次）'}
      </div>
    </aside>
  )
}
