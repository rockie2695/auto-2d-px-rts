import { describe, expect, it } from 'vitest'

import { computeViewport } from './viewport.ts'

/**
 * 視窗排佈測試（Prompt 9：像素完美 = 整數縮放 + 置中）。
 */

describe('computeViewport（Prompt 9）', () => {
  const MAP_TILES = 32 // 32×32 格 × 32px = 1024px 世界

  it('整數可整除的視窗 → 精確縮放與置中', () => {
    const viewport = computeViewport(MAP_TILES, 2048, 2048)
    expect(viewport.scale).toBe(2)
    expect(viewport.offsetX).toBe(0)
    expect(viewport.offsetY).toBe(0)
    expect(viewport.worldPx).toBe(1024)
  })

  it('非整數餘數 → floor 縮放、floor 置中（1920×1080 → 1 倍置中）', () => {
    const viewport = computeViewport(MAP_TILES, 1920, 1080)
    expect(viewport.scale).toBe(1)
    expect(viewport.offsetX).toBe(448) // (1920-1024)/2
    expect(viewport.offsetY).toBe(28) // (1080-1024)/2
  })

  it('取 min(viewW, viewH) 決定倍率（寬螢幕不會放大到超出高度）', () => {
    // 高度只容許 2 倍，寬度容許 4 倍 → 取 2
    const viewport = computeViewport(MAP_TILES, 4096, 2100)
    expect(viewport.scale).toBe(2)
    expect(viewport.offsetY).toBe(Math.floor((2100 - 2048) / 2))
  })

  it('視窗小於世界 → 仍維持最整數縮放 1（offset 夾在 ≥ 0，從左上起）', () => {
    const viewport = computeViewport(MAP_TILES, 800, 600)
    expect(viewport.scale).toBe(1)
    expect(viewport.offsetX).toBe(0)
    expect(viewport.offsetY).toBe(0)
  })
})
