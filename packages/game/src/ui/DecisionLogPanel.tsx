import { useState, type JSX } from 'react'

import type { DecisionLogEntry } from '../session.ts'
import { formatClock, layerLabel } from './collector.ts'
import { ARMOR_TIER_COLORS } from '../render/armor.ts'
import { useDraggable } from './useDraggable.ts'

/**
 * 左下：AI 決策日誌（Prompt 9.5 / 9.5 完整版 / 10.10 / 10.20）。
 * 顯示緩衝區內最近 **10 條**（新的在上），**可捲動**；標題列可拖曳移動面板。
 *
 * Prompt 9.5 完整版：
 * - **點擊展開**：戰略條目（帶 candidates）展開候選分數柱狀圖——最高分高亮；
 *   CSS transition 展開動畫；同時顯示 topFactor。
 * - **政策標記**：最近一次政策變更（layer = policy）之後的條目掛「受政策影響」小標。
 * - **裝甲標籤**：裝甲相關決策（train 重／超重裝甲單位）按色階標記
 *   （輕綠／中藍／重紫 `#b44aff`／超重金 `#ffd24a`）。
 *
 * Prompt 10.20：陣營色帶（藍＝我方、紅＝敵方）＋篩選片（先篩選再取最新 10 條）。
 */
const LOG_SHOWN = 10

/** 陣營篩選（藍／紅；null＝全部）。 */
type TeamFilter = 'all' | 'player' | 'enemy'

/** 層級篩選（戰略／戰術／政策／微操；null＝全部）。 */
type LayerFilter = DecisionLogEntry['layer'] | 'all'

const TEAM_CHIPS: readonly { key: TeamFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'player', label: '藍' },
  { key: 'enemy', label: '紅' },
]

const LAYER_CHIPS: readonly { key: LayerFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'strategic', label: '戰略' },
  { key: 'tactical', label: '戰術' },
  { key: 'policy', label: '政策' },
  { key: 'micro', label: '微操' },
]

/** 裝甲分檔中文標籤。 */
const ARMOR_LABEL: Record<NonNullable<DecisionLogEntry['armorTier']>, string> = {
  none: '',
  light: '輕甲',
  medium: '中甲',
  heavy: '重甲',
  ultra: '超重甲',
}

/** 候選柱狀圖（Prompt 9.5 完整版）：最高分高亮、寬度按分數歸一。 */
function CandidateBars({ entry }: { entry: DecisionLogEntry }): JSX.Element | null {
  const candidates = entry.candidates
  if (candidates === undefined || candidates.length === 0) return null
  const max = Math.max(...candidates.map((candidate) => candidate.score), 1)
  return (
    <div className="decision-candidates" data-testid="decision-candidates">
      <div className="decision-candidates-factor">主導：{entry.topFactor ?? '--'}</div>
      {candidates.map((candidate) => {
        const isTop = candidate.score === Math.max(...candidates.map((item) => item.score))
        return (
          <div
            key={candidate.defId}
            className={`decision-candidate${isTop ? ' top' : ''}`}
            data-testid={`decision-candidate-${candidate.defId}`}
          >
            <span className="decision-candidate-name">{candidate.defId}</span>
            <span className="decision-candidate-bar-track">
              <span
                className="decision-candidate-bar"
                style={{ width: `${Math.max(2, (candidate.score / max) * 100)}%` }}
              />
            </span>
            <span className="decision-candidate-score">{candidate.score.toFixed(2)}</span>
          </div>
        )
      })}
    </div>
  )
}

export function DecisionLogPanel({ entries }: { entries: readonly DecisionLogEntry[] }) {
  const { position, panelRef, handleProps } = useDraggable()
  const [team, setTeam] = useState<TeamFilter>('all')
  const [layer, setLayer] = useState<LayerFilter>('all')
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())

  // 先篩選、再取最新 10 條、新的在上（捲動看較舊的）。
  const latest = entries
    .filter((entry) => (team === 'all' || entry.actor === team) && (layer === 'all' || entry.layer === layer))
    .slice(-LOG_SHOWN)
    .reverse()

  // 政策標記：最近一次政策變更之後的條目都掛「受政策影響」（Prompt 9.5 完整版）。
  let lastPolicySequence = 0
  for (const entry of entries) {
    if (entry.layer === 'policy') lastPolicySequence = entry.sequence
  }

  const toggle = (sequence: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(sequence)) next.delete(sequence)
      else next.add(sequence)
      return next
    })
  }

  return (
    <aside
      ref={panelRef}
      className="hud-panel panel-bottom-left draggable"
      data-testid="decision-log-panel"
      style={position === null ? undefined : { left: position.x, top: position.y, bottom: 'auto' }}
    >
      <div className="hud-panel-title drag-handle" {...handleProps}>
        <span>AI 決策日誌</span>
      </div>
      <div className="decision-log-filters">
        {TEAM_CHIPS.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={`decision-log-chip team-${chip.key}${team === chip.key ? ' active' : ''}`}
            data-testid={`decision-log-chip-team-${chip.key}`}
            onClick={() => setTeam(chip.key)}
          >
            {chip.label}
          </button>
        ))}
        <span className="decision-log-chip-sep" aria-hidden="true" />
        {LAYER_CHIPS.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={`decision-log-chip layer-${chip.key}${layer === chip.key ? ' active' : ''}`}
            data-testid={`decision-log-chip-layer-${chip.key}`}
            onClick={() => setLayer(chip.key)}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {latest.length === 0 ? (
        <div className="hud-empty">尚未有決策</div>
      ) : (
        <ol className="decision-log">
          {latest.map((entry) => {
            const hasCandidates = entry.candidates !== undefined && entry.candidates.length > 0
            const armorTier = entry.armorTier ?? 'none'
            const armorColor = armorTier === 'none' ? undefined : ARMOR_TIER_COLORS[armorTier]
            return (
              <li key={entry.sequence} className={`actor-${entry.actor}`}>
                <div
                  className={`decision-log-row${hasCandidates ? ' expandable' : ''}`}
                  onClick={hasCandidates ? () => toggle(entry.sequence) : undefined}
                  role={hasCandidates ? 'button' : undefined}
                  data-testid={`decision-log-row-${entry.sequence}`}
                >
                  <span className="decision-log-time">{formatClock(entry.tick)}</span>
                  <span className="decision-log-layer">[{layerLabel(entry.layer)}]</span>
                  <span className="decision-log-text">{entry.text}</span>
                  {armorTier !== 'none' ? (
                    <span
                      className="decision-log-armor"
                      data-testid={`decision-armor-${entry.sequence}`}
                      style={{ color: armorColor ?? undefined }}
                    >
                      {ARMOR_LABEL[armorTier]}
                    </span>
                  ) : null}
                  {entry.sequence > lastPolicySequence && lastPolicySequence > 0 ? (
                    <span className="decision-log-policy" data-testid="decision-policy-mark">
                      受政策影響
                    </span>
                  ) : null}
                </div>
                <div className={`decision-candidates-wrap${expanded.has(entry.sequence) ? ' open' : ''}`}>
                  {expanded.has(entry.sequence) ? <CandidateBars entry={entry} /> : null}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </aside>
  )
}
