import { formatClock } from './collector.ts'
import type { ChartPoint } from './collector.ts'

/**
 * 折線圖繪圖工具（Prompt 10 / 10.5）：canvas 2D 自繪、純函式、不含 React 元件。
 * 由 `ResourceChart`（即時 60 秒曲線）與 `PostGamePanel`（復盤全程曲線）共用。
 * 線色語意：我方藍、敵方紅（與面板／小地圖配色一致）。
 * 疊法：敵方紅 3px 墊底、我方藍 2px 疊上——兩線同值重疊時呈「藍芯紅邊」，
 * 開局雙方經濟完全對稱也能看出有兩條線。
 */

export const PLAYER_LINE_COLOR = '#7ec7ff'
export const ENEMY_LINE_COLOR = '#ff7a7a'

/** 三資源曲線的資源色（Prompt 5；與資源 JSON / 地圖節點色一致）。 */
export const RUBY_LINE_COLOR = '#ff6b6b'
export const EMERALD_LINE_COLOR = '#3ecf8e'

/** 繪圖區幾何：左側留 y 軸標籤欄，底部留 x 軸標籤列。 */
export interface PlotGeometry {
  left: number
  right: number
  top: number
  bottom: number
}

/** 0..1 曲線座標 → 像素（x/y 都夾在繪圖區內）。 */
export function toPixel(point: ChartPoint, plot: PlotGeometry): { px: number; py: number } {
  return {
    px: Math.round(plot.left + point.x * (plot.right - plot.left)),
    py: Math.round(plot.bottom - point.y * (plot.bottom - plot.top)),
  }
}

/** 畫一條折線（寬度由呼叫端決定：敵方 3px 墊底、我方 2px 疊上）。 */
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
