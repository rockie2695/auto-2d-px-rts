import { useEffect, useRef } from 'react'

import { chartPoints } from './collector.ts'
import type { SamplePoint } from './collector.ts'

/**
 * 左上：資源曲線（Prompt 9.5）。
 * 我方水晶的 60 秒滾動折線；純 canvas 2D 手繪——2px 硬邊折線、不引入套件。
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
    const points = chartPoints(samples)
    if (points.length === 0) {
      ctx.fillStyle = '#808a96'
      ctx.fillText('等待資料…', 8, height / 2 + 4)
      return
    }
    ctx.strokeStyle = '#7ec7ff'
    ctx.lineWidth = 2 // 硬邊 2px 折線
    ctx.beginPath()
    points.forEach((point, index) => {
      const px = Math.round(point.x * (width - 8)) + 4
      const py = Math.round((1 - point.y) * (height - 12)) + 6
      if (index === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.stroke()
  }, [samples])

  return (
    <aside className="hud-panel panel-top-left" data-testid="resource-chart">
      <div className="hud-panel-title">資源曲線（60 秒）</div>
      <canvas ref={canvasRef} width={240} height={64} className="resource-chart-canvas" />
    </aside>
  )
}
