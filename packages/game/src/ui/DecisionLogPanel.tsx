import type { DecisionLogEntry } from '../session.ts'
import { formatClock, layerLabel } from './collector.ts'
import { useDraggable } from './useDraggable.ts'

/**
 * 左下：AI 決策日誌（Prompt 9.5 / 10.10）。
 * 顯示緩衝區內最近 20 條（新的在上），**可捲動**（max-height + overflow）；
 * 標題列可拖曳移動面板。
 */
const LOG_SHOWN = 20

export function DecisionLogPanel({ entries }: { entries: readonly DecisionLogEntry[] }) {
  const { position, panelRef, handleProps } = useDraggable()
  // 最新 20 條、新的在上（捲動看較舊的）。
  const latest = entries.slice(-LOG_SHOWN).reverse()
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
      {latest.length === 0 ? (
        <div className="hud-empty">尚未有決策</div>
      ) : (
        <ol className="decision-log">
          {latest.map((entry) => (
            <li key={entry.sequence}>
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
