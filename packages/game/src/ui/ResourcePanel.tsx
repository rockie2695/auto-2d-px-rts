import { ratioTone } from './collector.ts'
import type { RatioTone } from './collector.ts'

/** 戰力比顯示色。 */
function toneColor(tone: RatioTone): string {
  if (tone === 'red') return '#ff7a7a'
  if (tone === 'yellow') return '#ffd866'
  return '#7ce38b'
}

/**
 * 右上：雙方資源＋戰力比（Prompt 9.5）。
 * 戰力比 < 0.7 紅、0.7–1.4 黃、> 1.4 綠（門檻在 `ratioTone`）。
 */
export function ResourcePanel({
  playerCrystal,
  enemyCrystal,
  playerIncome,
  enemyIncome,
  ratio,
}: {
  playerCrystal: number
  enemyCrystal: number
  playerIncome: number | null
  enemyIncome: number | null
  ratio: number
}) {
  const tone = ratioTone(ratio)
  const incomeLabel = (income: number | null): string =>
    income === null ? '--' : `+${income.toFixed(1)}/s`
  return (
    <aside className="hud-panel" data-testid="resource-panel">
      <div className="hud-panel-title">資源</div>
      <div className="resource-row">
        <span>我方水晶</span>
        <span>
          {playerCrystal}（{incomeLabel(playerIncome)}）
        </span>
      </div>
      <div className="resource-row">
        <span>敵方水晶</span>
        <span>
          {enemyCrystal}（{incomeLabel(enemyIncome)}）
        </span>
      </div>
      <div className="resource-row">
        <span>戰力比</span>
        <span style={{ color: toneColor(tone) }} data-testid="ratio-value">
          {ratio.toFixed(2)}
        </span>
      </div>
    </aside>
  )
}
