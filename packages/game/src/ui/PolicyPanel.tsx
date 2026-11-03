import { useState } from 'react'

import type { PolicyValues } from '../ai/policy.ts'
import type { PolicySnapshot } from '../session.ts'

/**
 * 底部中央：AI 政策滑桿（Prompt 10，規則 10：玩家只調這 5 個滑桿，不得直接指揮單位）。
 * - **草稿模型**：拖動只改本地草稿（數值即時顯示、不觸發 session）；
 *   「套用變更」整包送出（session 只對實際變更的 key 記日誌與開 30 秒冷卻），
 *   「還原」把草稿回復為最後生效值（= 變更前）。
 * - 5 個滑桿各顯示名稱／0–1 範圍／數值；冷卻中滑桿與套用鈕禁用並顯示倒數。
 * - 頂部一行顯示「目前 AI 決策摘要」（最後一條戰略日誌）。
 * - 可收合（四角已被 HUD 佔用，本面板放底部中央）；底部「結束並復盤」
 *   手動結束對局進入戰後復盤（Prompt 10.5）。
 */

const SLIDERS: ReadonlyArray<{ key: keyof PolicyValues; label: string }> = [
  { key: 'econMilitary', label: '經濟↔軍事' },
  { key: 'unitSize', label: '單位規模' },
  { key: 'unitRange', label: '單位射程' },
  { key: 'aggression', label: '侵略性' },
  { key: 'clusterSpread', label: '集結密度' },
]

/** 草稿與生效值有差異的滑桿 key 清單。 */
function diffKeys(draft: PolicyValues, committed: PolicyValues): Array<keyof PolicyValues> {
  return (Object.keys(draft) as Array<keyof PolicyValues>).filter(
    (key) => draft[key] !== committed[key],
  )
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
  // 草稿：null = 與最後生效值一致（拖動才建立）。生效值只會被本面板的
  // 「套用變更」改動，所以在該事件裡重置草稿即可（不用 effect 同步）。
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
  const changes = base !== undefined && committed !== undefined ? diffKeys(base, committed) : []
  const hasChanges = changes.length > 0
  const applyDisabled = policy === null || cooling || !hasChanges

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
            value={base === undefined ? 0.5 : base[key]}
            disabled={cooling || base === undefined}
            data-testid={`slider-${key}`}
            aria-label={label}
            onChange={(event) => {
              const value = Number(event.target.value)
              const source = draft ?? committed
              if (source === undefined) return
              setDraft({ ...source, [key]: value })
            }}
          />
          <output className="policy-slider-value">
            {base === undefined ? '—' : base[key].toFixed(2)}
          </output>
        </label>
      ))}
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
          {hasChanges ? `套用變更（${changes.length} 項）` : '套用變更'}
        </button>
        <button
          type="button"
          data-testid="policy-reset"
          disabled={!hasChanges}
          onClick={() => setDraft(null)}
        >
          還原
        </button>
      </div>
      <div className="policy-cooldown" data-testid="policy-cooldown">
        {cooling ? `冷卻中 ${countdownSec}s（30 秒可改一次）` : '可調整（30 秒可改一次）'}
      </div>
      <button type="button" className="policy-end" data-testid="policy-end-match" onClick={onEndMatch}>
        結束並復盤
      </button>
    </aside>
  )
}
