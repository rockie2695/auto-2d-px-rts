import { useEffect, useRef } from 'react'

import { chartPoints } from './collector.ts'
import type { SamplePoint } from './collector.ts'

/** 線色：我方藍、敵方紅（與面板／小地圖配色一致）。 */
const PLAYER_COLOR = '#7ec7ff'
const ENEMY_COLOR = '#ff7a7a'

/** 畫一條 2px 硬邊折線。 */
function drawLine(
  ctx: CanvasRenderingContext2D,
  points: ReturnType<typeof chartPoints>,
  width: number,
  height: number,
  color: string,
): void {
  ctx.strokeStyle = color
  ctx.lineWidth = 2 // 硬邊 2px 折線
  ctx.beginPath()
  points.forEach((point, index) => {
    const px = Math.round(point.x * (width - 8)) + 4
    const py = Math.round((1 - point.y) * (height - 12)) + 6
    if (index === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  })
  ctx.stroke()
}

/**
 * 左上：資源曲線（Prompt 9.5 / Prompt 10）。
 * 雙陣營水晶各一條 60 秒滾動折線、共用同一絕對值域（同一軸直接比較）；
 * 純 canvas 2D 手繪——2px 硬邊折線、不引入套件。右上角圖例：藍=我方、紅=敵方。
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
    // 背景格線（淺色）。
    ctx.fillStyle = '#2a2f38'
    ctx.fillRect(0, 0, width, height)
    if (samples.length === 0) {
      ctx.fillStyle = '#808a96'
      ctx.fillText('等待資料…', 8, height / 2 + 4)
      return
    }
    // 兩條線共用值域（chartPoints 內部取雙值 min..max）。
    const player = chartPoints(samples, (point) => point.player)
    const enemy = chartPoints(samples, (point) => point.enemy)
    drawLine(ctx, enemy, width, height, ENEMY_COLOR)
    drawLine(ctx, player, width, height, PLAYER_COLOR)

    // 圖例（右上角）：色塊 + 名稱。
    ctx.font = '10px sans-serif'
    ctx.fillStyle = PLAYER_COLOR
    ctx.fillRect(width - 52, 6, 6, 6)
    ctx.fillText('我方', width - 43, 12)
    ctx.fillStyle = ENEMY_COLOR
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
