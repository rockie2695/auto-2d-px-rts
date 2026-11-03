import type { DecisionLogEntry } from '../session.ts'

/** tick（20Hz）→ `m:ss`時鐘。 */
export function formatClock(tick: number): string {
  const seconds = Math.floor(tick / 20)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** 層級標籤。 */
export function layerLabel(layer: DecisionLogEntry['layer']): string {
  return layer === 'strategic' ? '戰略' : '戰術'
}

/**
 * 左下：AI 決策日誌（Prompt 9.5）。
 * 最新 5 條（新的在上）：時間 + 層級 + 動作 + 原因。
 */
export function DecisionLogPanel({ entries }: { entries: readonly DecisionLogEntry[] }) {
  // 最新 5 條、新的在上。
  const latest = entries.slice(-5).reverse()
  return (
    <aside className="hud-panel panel-bottom-left" data-testid="decision-log-panel">
      <div className="hud-panel-title">AI 決策日誌</div>
      {latest.length === 0 ? (
        <div className="hud-empty">尚未有決策</div>
      ) : (
        <ol className="decision-log">
          {latest.map((entry) => (
            <li key={`${entry.tick}-${entry.text}`}>
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
