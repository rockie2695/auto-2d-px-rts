import { ratioTone } from './collector.ts'
import type { RatioTone } from './collector.ts'

/** 戰力比顯示色。 */
function toneColor(tone: RatioTone): string {
  if (tone === 'red') return '#ff7a7a'
  if (tone === 'yellow') return '#ffd866'
  return '#7ce38b'
}

/**
 * 右上：雙方三資源＋戰力比（Prompt 9.5 ＋ Prompt 5 三資源）。
 * 戰力比 < 0.7 紅、0.7–1.4 黃、> 1.4 綠（門檻在 `ratioTone`）。
 */
export function ResourcePanel({
  playerResources,
  enemyResources,
  playerIncomes,
  ratio,
}: {
  playerResources: { blue_crystal: number; red_ruby: number; green_emerald: number }
  enemyResources: { blue_crystal: number; red_ruby: number; green_emerald: number }
  playerIncomes: { blue_crystal: number; red_ruby: number; green_emerald: number }
  enemyIncomes?: { blue_crystal: number; red_ruby: number; green_emerald: number }
  ratio: number
}) {
  const tone = ratioTone(ratio)
  const incomeLabel = (income: number | null): string =>
    income === null ? '--' : `+${income.toFixed(1)}/s`
  const rows: ReadonlyArray<{ label: string; key: 'blue_crystal' | 'red_ruby' | 'green_emerald' }> = [
    { label: '藍水晶', key: 'blue_crystal' },
    { label: '紅寶石', key: 'red_ruby' },
    { label: '綠翡翠', key: 'green_emerald' },
  ]
  return (
    <aside className="hud-panel" data-testid="resource-panel">
      <div className="hud-panel-title">資源</div>
      {rows.map((row) => (
        <div className="resource-row" key={row.key} data-testid={`resource-${row.key}`}>
          <span>{row.label}</span>
          <span>
            {playerResources[row.key]}（{incomeLabel(playerIncomes[row.key])}）
          </span>
        </div>
      ))}
      <div className="resource-row">
        <span>敵方三資源</span>
        <span>
          {enemyResources.blue_crystal}/{enemyResources.red_ruby}/{enemyResources.green_emerald}
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
