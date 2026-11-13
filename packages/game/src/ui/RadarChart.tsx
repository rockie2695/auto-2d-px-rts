import { useEffect, useRef } from 'react'

import { RADAR_AXES } from './factionStats.ts'
import type { RadarAxis } from './factionStats.ts'

/**
 * 勢力對比雷達圖（Prompt 10.5 完整版：戰前頁）：自繪 canvas 六邊形——
 * 6 軸（經濟/軍事/科技/機動性/韌性/裝甲）、0..1 歸一值、雙陣營疊畫
 * （我方藍、敵方紅半透明填充＋邊線）；MVP 單陣營鏡像 → 兩側同形。
 */

export type RadarSide = { label: string; side: 'player' | 'enemy'; values: ReadonlyArray<{ axis: RadarAxis; value: number }> }

const SIZE = 240

export function RadarChart({ sides }: { sides: readonly RadarSide[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const cx = SIZE / 2
    const cy = SIZE / 2
    const radius = SIZE / 2 - 26
    const angleOf = (axisIndex: number): number =>
      -Math.PI / 2 + (axisIndex / RADAR_AXES.length) * Math.PI * 2

    ctx.clearRect(0, 0, SIZE, SIZE)
    // 網格：3 圈同心六邊形＋軸線。
    ctx.strokeStyle = '#3a4048'
    ctx.lineWidth = 1
    for (const ring of [1 / 3, 2 / 3, 1]) {
      ctx.beginPath()
      for (let index = 0; index < RADAR_AXES.length; index++) {
        const angle = angleOf(index)
        const x = cx + Math.cos(angle) * radius * ring
        const y = cy + Math.sin(angle) * radius * ring
        if (index === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.stroke()
    }
    for (let index = 0; index < RADAR_AXES.length; index++) {
      const axis = RADAR_AXES[index]
      if (axis === undefined) continue
      const angle = angleOf(index)
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)
      ctx.stroke()
      // 軸標籤。
      ctx.fillStyle = '#9aa5b1'
      ctx.font = '11px "Courier New", monospace'
      ctx.textAlign = 'center'
      ctx.fillText(
        axis,
        cx + Math.cos(angle) * (radius + 14),
        cy + Math.sin(angle) * (radius + 14) + 4,
      )
    }
    // 各陣營多邊形（我方藍、敵方紅；半透明填充）。
    for (const side of sides) {
      ctx.beginPath()
      side.values.forEach((entry, index) => {
        const angle = angleOf(index)
        const x = cx + Math.cos(angle) * radius * Math.min(1, Math.max(0, entry.value))
        const y = cy + Math.sin(angle) * radius * Math.min(1, Math.max(0, entry.value))
        if (index === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.closePath()
      ctx.fillStyle = side.side === 'player' ? 'rgba(111, 142, 207, 0.25)' : 'rgba(224, 92, 92, 0.25)'
      ctx.fill()
      ctx.strokeStyle = side.side === 'player' ? '#6f8ecf' : '#e05c5c'
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }, [sides])

  return (
    <canvas ref={canvasRef} width={SIZE} height={SIZE} data-testid="pre-game-radar" className="pre-game-radar" />
  )
}
