import { useEffect, useRef } from 'react'

import { chartDomain, chartPoints } from './collector.ts'
import {
  drawEndDot,
  drawSeriesLine,
  drawYAxis,
  ENEMY_LINE_COLOR,
  PLAYER_LINE_COLOR,
} from './chartDraw.ts'
import type { PlotGeometry } from './chartDraw.ts'
import type { SamplePoint } from './collector.ts'

/**
 * 左上：資源曲線（Prompt 9.5 / 10 / 10.5 修正）。
 * 雙陣營水晶各一條 60 秒滾動折線、共用同一絕對值域（y 軸標數字）；
 * 純 canvas 2D 手繪——敵方紅 3px 墊底、我方藍 2px 疊上（重疊段藍芯紅邊）、
 * 線尾色點、右上角圖例（藍=我方、紅=敵方）。繪圖工具在 `chartDraw.ts`。
 */
export function ResourceChart({ samples }: { samples: readonly SamplePoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

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
    const domain = chartDomain(samples)
    const plot: PlotGeometry = { left: 34, right: width - 6, top: 8, bottom: height - 8 }
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
  }, [samples])

  return (
    <aside className="hud-panel panel-top-left" data-testid="resource-chart">
      <div className="hud-panel-title">資源曲線（60 秒）</div>
      <canvas ref={canvasRef} width={240} height={64} className="resource-chart-canvas" />
    </aside>
  )
}
