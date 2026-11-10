import { useState } from 'react'

import type { DecisionLogEntry } from '../session.ts'
import { formatClock, layerLabel } from './collector.ts'
import { useDraggable } from './useDraggable.ts'

/**
 * 左下：AI 決策日誌（Prompt 9.5 / 10.10 / 10.20）。
 * 顯示緩衝區內最近 20 條（新的在上），**可捲動**（max-height + overflow）；
 * 標題列可拖曳移動面板。
 *
 * Prompt 10.20：**陣營色 + 篩選**——每列左側以色帶標示陣營（藍＝我方、紅＝敵方），
 * 標題列下方一排篩選片（藍／紅 × 戰略／戰術／政策，可同時各選一組），**先篩選再取
 * 最新 20 條**（篩選後仍只顯示 20 條，避免單一陣營刷版時看不到另一陣營）。
 * 篩選狀態留在元件內（useState）——session／復盤資料結構不變（LOG_LIMIT 仍 32）。
 */
const LOG_SHOWN = 20

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

export function DecisionLogPanel({ entries }: { entries: readonly DecisionLogEntry[] }) {
  const { position, panelRef, handleProps } = useDraggable()
  const [team, setTeam] = useState<TeamFilter>('all')
  const [layer, setLayer] = useState<LayerFilter>('all')

  // 先篩選、再取最新 20 條、新的在上（捲動看較舊的）。
  const latest = entries
    .filter((entry) => (team === 'all' || entry.actor === team) && (layer === 'all' || entry.layer === layer))
    .slice(-LOG_SHOWN)
    .reverse()

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
          {latest.map((entry) => (
            <li key={entry.sequence} className={`actor-${entry.actor}`}>
              <span className="decision-log-time">{formatClock(entry.tick)}</span>
              <span className="decision-log-layer">[{layerLabel(entry.layer)}]</span>
              <span className="decision-log-text">{entry.text}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}
