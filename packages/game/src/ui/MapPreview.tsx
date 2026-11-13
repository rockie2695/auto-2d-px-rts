import { useEffect, useRef } from 'react'

import type { ContentPack } from '@auto-2d-px-rts/shared'

/**
 * 地圖預覽（Prompt 10.5 完整版：戰前頁）：canvas 自繪——地形（岩石）、
 * 資源點（按資源類型著色）、雙方出生點（keep 位置標記）。
 * 資料源是 content pack 靜態定義＋一個 headless world（`createWorld` 純
 * 資料生成、不推進 sim step——開局佈局確定性）。
 */

/** tile 對應 px（32 格地圖 → 320px 畫布）。 */
const TILE_PX = 10

const NODE_COLORS: Record<string, string> = {
  blue_crystal: '#5aa9e6',
  red_ruby: '#e05c5c',
  green_emerald: '#58c08a',
}

export function MapPreview({ content, spawnTiles }: { content: ContentPack; spawnTiles: ReadonlyArray<{ x: number; y: number }> }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const size = content.map.size

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const px = size * TILE_PX
    ctx.clearRect(0, 0, px, px)
    // 底色（可通行）。
    ctx.fillStyle = '#20242c'
    ctx.fillRect(0, 0, px, px)
    // 岩石（不可通行）。
    ctx.fillStyle = '#3a4048'
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (content.map.tiles[y * size + x] !== 0) {
          ctx.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX)
        }
      }
    }
    // 資源點。
    for (const node of content.map.resourceNodes) {
      ctx.fillStyle = NODE_COLORS[node.resourceType] ?? '#8d9aa8'
      ctx.beginPath()
      ctx.arc(node.x * TILE_PX + TILE_PX / 2, node.y * TILE_PX + TILE_PX / 2, TILE_PX / 2 - 1, 0, Math.PI * 2)
      ctx.fill()
    }
    // 雙方出生點（keep 外框＋標記；index 0 = 我方藍、1 = 敵方紅）。
    spawnTiles.forEach((spawn, index) => {
      ctx.strokeStyle = index === 0 ? '#6f8ecf' : '#e05c5c'
      ctx.lineWidth = 2
      ctx.strokeRect(spawn.x * TILE_PX + 1, spawn.y * TILE_PX + 1, 2 * TILE_PX - 2, 2 * TILE_PX - 2)
      ctx.fillStyle = index === 0 ? '#6f8ecf' : '#e05c5c'
      ctx.font = 'bold 10px "Courier New", monospace'
      ctx.fillText(index === 0 ? '藍' : '紅', spawn.x * TILE_PX + 7, spawn.y * TILE_PX + 14)
    })
  }, [content, spawnTiles, size])

  return (
    <canvas
      ref={canvasRef}
      width={size * TILE_PX}
      height={size * TILE_PX}
      data-testid="pre-game-map"
      className="pre-game-map"
    />
  )
}

