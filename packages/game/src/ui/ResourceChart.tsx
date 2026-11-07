import { useEffect, useRef, useState } from 'react'

import { chartDomain, chartPoints } from './collector.ts'
import type { SamplePoint } from './collector.ts'
import {
  drawEndDot,
  drawSeriesLine,
  drawYAxis,
  EMERALD_LINE_COLOR,
  ENEMY_LINE_COLOR,
  PLAYER_LINE_COLOR,
  RUBY_LINE_COLOR,
} from './chartDraw.ts'
import type { PlotGeometry } from './chartDraw.ts'

/**
 * 左上：資源／單位數量／戰力 曲線（Prompt 9.5 / 10 / 10.6）。
 * 下拉選單切換三種指標（皆為雙陣營兩線、60 秒滾動窗、共用絕對值域、y 軸標數字）：
 * - 資源曲線：雙方藍水晶存量
 * - 單位數量：雙方存活單位數
 * - 戰力：Σ hp × dmg × attackSpeed（SPEC §12.1）
 * 敵方紅 3px 墊底、我方藍 2px 疊上（重疊段藍芯紅邊）；線尾色點；圖例。
 * 繪圖工具在 `chartDraw.ts`，取樣在 `BattleDashboard`（三個 `ResourceSeries`）。
 */

export type ChartMode = 'crystal' | 'units' | 'power' | 'resources'

const MODES: ReadonlyArray<{ id: ChartMode; label: string }> = [
  { id: 'crystal', label: '資源曲線' },
  { id: 'units', label: '單位數量' },
  { id: 'power', label: '戰力' },
  { id: 'resources', label: '三資源' },
]

export function ResourceChart({
  crystalSamples,
  unitSamples,
  powerSamples,
  rubySamples = [],
  emeraldSamples = [],
}: {
  /** 雙方水晶存量取樣（60 秒滾動窗）。 */
  crystalSamples: readonly SamplePoint[]
  /** 雙方存活單位數取樣。 */
  unitSamples: readonly SamplePoint[]
  /** 雙方戰力取樣。 */
  powerSamples: readonly SamplePoint[]
  /** 雙方紅寶石存量取樣（Prompt 5；三資源模式用 player 值）。 */
  rubySamples?: readonly SamplePoint[]
  /** 雙方綠翡翠存量取樣（Prompt 5）。 */
  emeraldSamples?: readonly SamplePoint[]
}) {
  const [mode, setMode] = useState<ChartMode>('crystal')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const samples = mode === 'crystal' ? crystalSamples : mode === 'units' ? unitSamples : powerSamples

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const width = canvas.width
    const height = canvas.height
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#2a2f38'
    ctx.fillRect(0, 0, width, height)
    const plot: PlotGeometry = { left: 34, right: width - 6, top: 8, bottom: height - 8 }

    // 三資源模式（Prompt 5）：我方藍/紅/綠三線共用值域。
    if (mode === 'resources') {
      const series: ReadonlyArray<{ points: readonly SamplePoint[]; color: string; label: string }> = [
        { points: crystalSamples, color: PLAYER_LINE_COLOR, label: '藍' },
        { points: rubySamples, color: RUBY_LINE_COLOR, label: '紅' },
        { points: emeraldSamples, color: EMERALD_LINE_COLOR, label: '綠' },
      ]
      const values = series.flatMap((entry) => entry.points.map((point) => point.player))
      if (values.length === 0) {
        ctx.fillStyle = '#808a96'
        ctx.textAlign = 'left'
        ctx.fillText('等待資料…', 8, height / 2 + 4)
        return
      }
      let minValue = Number.POSITIVE_INFINITY
      let maxValue = Number.NEGATIVE_INFINITY
      for (const value of values) {
        minValue = Math.min(minValue, value)
        maxValue = Math.max(maxValue, value)
      }
      const span = Math.max(maxValue - minValue, 1)
      const pad = span * 0.1
      const domain = { min: minValue, max: maxValue, bottom: minValue - pad, top: maxValue + pad }
      drawYAxis(ctx, domain, plot)
      const latest = crystalSamples[crystalSamples.length - 1]
      const spanTicks =
        crystalSamples.length > 1
          ? Math.max(1, (latest?.tick ?? 0) - (crystalSamples[0]?.tick ?? 0))
          : 1
      const startX = (latest?.tick ?? 0) - spanTicks
      for (const entry of series) {
        const points = entry.points.map((sample) => ({
          x: Math.max(0, Math.min(1, (sample.tick - startX) / spanTicks)),
          y: Math.max(0, Math.min(1, (sample.player - domain.bottom) / span)),
        }))
        drawSeriesLine(ctx, points, plot, entry.color, 2)
        drawEndDot(ctx, points, plot, entry.color)
      }
      // 圖例（右上角）：三色塊 + 資源名。
      ctx.font = '10px sans-serif'
      ctx.textAlign = 'left'
      let legendX = width - 78
      for (const entry of series) {
        ctx.fillStyle = entry.color
        ctx.fillRect(legendX, 6, 6, 6)
        ctx.fillText(entry.label, legendX + 8, 12)
        legendX += 26
      }
      return
    }

    const domain = chartDomain(samples)
    if (domain === null) {
      ctx.fillStyle = '#808a96'
      ctx.textAlign = 'left'
      ctx.fillText('等待資料…', 8, height / 2 + 4)
      return
    }
    drawYAxis(ctx, domain, plot)
    const enemy = chartPoints(samples, (point) => point.enemy)
    const player = chartPoints(samples, (point) => point.player)
    drawSeriesLine(ctx, enemy, plot, ENEMY_LINE_COLOR, 3)
    drawSeriesLine(ctx, player, plot, PLAYER_LINE_COLOR, 2)
    drawEndDot(ctx, enemy, plot, ENEMY_LINE_COLOR)
    drawEndDot(ctx, player, plot, PLAYER_LINE_COLOR)

    // 圖例（右上角）：色塊 + 名稱。
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillStyle = PLAYER_LINE_COLOR
    ctx.fillRect(width - 52, 6, 6, 6)
    ctx.fillText('我方', width - 43, 12)
    ctx.fillStyle = ENEMY_LINE_COLOR
    ctx.fillRect(width - 52, 18, 6, 6)
    ctx.fillText('敵方', width - 43, 24)
  }, [mode, samples, rubySamples, emeraldSamples, crystalSamples])

  return (
    <aside className="hud-panel panel-top-left" data-testid="resource-chart">
      <div className="hud-panel-title">
        <span>{MODES.find((item) => item.id === mode)?.label ?? ''}（60 秒）</span>
        <select
          className="chart-mode-select"
          data-testid="chart-mode"
          aria-label="切換圖表指標"
          value={mode}
          onChange={(event) => setMode(event.target.value as ChartMode)}
        >
          {MODES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <canvas ref={canvasRef} width={240} height={64} className="resource-chart-canvas" />
    </aside>
  )
}
