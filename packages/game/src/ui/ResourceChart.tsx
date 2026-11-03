import { useEffect, useRef } from 'react'

import { chartDomain, chartPoints, formatClock } from './collector.ts'
import type { ChartPoint, SamplePoint } from './collector.ts'

/** 線色：我方藍、敵方紅（與面板／小地圖配色一致）。 */
export const PLAYER_LINE_COLOR = '#7ec7ff'
export const ENEMY_LINE_COLOR = '#ff7a7a'

/** 繪圖區幾何：左側留 y 軸標籤欄，底部留 x 軸標籤列（0 = 不留）。 */
export interface PlotGeometry {
  left: number
  right: number
  top: number
  bottom: number
}

/** 0..1 曲線座標 → 像素（x/y 都夾在繪圖區內）。 */
export function toPixel(
  point: ChartPoint,
  plot: PlotGeometry,
): { px: number; py: number } {
  return {
    px: Math.round(plot.left + point.x * (plot.right - plot.left)),
    py: Math.round(plot.bottom - point.y * (plot.bottom - plot.top)),
  }
}

/** 畫一條折線（寬度由呼叫端決定：敵方 3px 墊底、我方 2px 疊上 → 重疊段藍芯紅邊）。 */
export function drawSeriesLine(
  ctx: CanvasRenderingContext2D,
  points: readonly ChartPoint[],
  plot: PlotGeometry,
  color: string,
  lineWidth: number,
): void {
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  points.forEach((point, index) => {
    const { px, py } = toPixel(point, plot)
    if (index === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  })
  ctx.stroke()
}

/** 線末端色點（3×3）：兩線分離時標示各自現值位置。 */
export function drawEndDot(
  ctx: CanvasRenderingContext2D,
  points: readonly ChartPoint[],
  plot: PlotGeometry,
  color: string,
): void {
  const last = points[points.length - 1]
  if (last === undefined) return
  const { px, py } = toPixel(last, plot)
  ctx.fillStyle = color
  ctx.fillRect(px - 1, py - 1, 3, 3)
}

/**
 * y 軸：3 條淡格線（上=最大值、中、下=最小值）＋右對齊整數標籤。
 * 中線標籤與上／下重複時省略（小跨度時避免三個同數字）。
 */
export function drawYAxis(
  ctx: CanvasRenderingContext2D,
  domain: { min: number; max: number; bottom: number; top: number },
  plot: PlotGeometry,
): void {
  const span = domain.top - domain.bottom
  const levels: Array<{ value: number; label: string }> = [
    { value: domain.top, label: String(Math.round(domain.max)) },
    {
      value: (domain.top + domain.bottom) / 2,
      label: String(Math.round((domain.max + domain.min) / 2)),
    },
    { value: domain.bottom, label: String(Math.round(domain.min)) },
  ]
  ctx.font = '9px sans-serif'
  ctx.strokeStyle = '#3a414c'
  ctx.lineWidth = 1
  for (const level of levels) {
    const py = Math.round(
      plot.bottom - ((level.value - domain.bottom) / span) * (plot.bottom - plot.top),
    )
    ctx.beginPath()
    ctx.moveTo(plot.left, py + 0.5)
    ctx.lineTo(plot.right, py + 0.5)
    ctx.stroke()
  }
  ctx.fillStyle = '#9aa5b1'
  ctx.textAlign = 'right'
  const [top, mid, bottom] = levels
  ctx.fillText(top?.label ?? '', plot.left - 3, plot.top + 7)
  ctx.fillText(bottom?.label ?? '', plot.left - 3, plot.bottom)
  if (mid !== undefined && top !== undefined && bottom !== undefined) {
    if (mid.label !== top.label && mid.label !== bottom.label) {
      ctx.fillText(mid.label, plot.left - 3, (plot.top + plot.bottom) / 2 + 3)
    }
  }
}

/** x 軸兩端時間標籤（復盤頁用；左 0:00、右總時長）。 */
export function drawXAxis(
  ctx: CanvasRenderingContext2D,
  durationTicks: number,
  plot: PlotGeometry,
  height: number,
): void {
  if (durationTicks <= 0) return
  ctx.font = '9px sans-serif'
  ctx.fillStyle = '#9aa5b1'
  ctx.textAlign = 'left'
  ctx.fillText('0:00', plot.left, height - 2)
  ctx.textAlign = 'right'
  ctx.fillText(formatClock(durationTicks), plot.right, height - 2)
}

/**
 * 左上：資源曲線（Prompt 9.5 / 10 / 10.5 修正）。
 * 雙陣營水晶各一條 60 秒滾動折線、共用同一絕對值域（y 軸標數字）；
 * 敵方紅 3px 墊底、我方藍 2px 疊上——兩線同值重疊時呈「藍芯紅邊」，
 * 開局雙方經濟完全對稱也能看出有兩條線；線尾各一個 3×3 色點。
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
