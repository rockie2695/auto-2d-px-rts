import { describe, expect, it } from 'vitest'

import { clampCamera, fitCamera, fitScale, MAX_SCALE, panBy, worldPxOf, zoomAt } from './camera.ts'

/**
 * 相機測試（Prompt 10.12）：預設完整入鏡、拖曳平移夾限、游標縮放不變量。
 */

const WORLD = worldPxOf(32) // 1024

describe('fitScale / fitCamera：完整入鏡', () => {
  it('視窗夠大 → 整數倍（像素完美）', () => {
    expect(fitScale(WORLD, 2048, 2048)).toBe(2)
    expect(fitScale(WORLD, 1920, 1080)).toBe(1) // raw 1.05 → floor 1（整數）
    expect(fitScale(WORLD, 4096, 2100)).toBe(2)
  })

  it('視窗小於地圖 → 縮到剛好入鏡（非整數，允許 < 1）', () => {
    expect(fitScale(WORLD, 800, 600)).toBeCloseTo(600 / 1024, 6)
    expect(fitScale(WORLD, 640, 480)).toBeCloseTo(480 / 1024, 6)
  })

  it('極小視窗仍完整入鏡（不設下限）；上限 MAX_SCALE', () => {
    expect(fitScale(WORLD, 100, 100)).toBeCloseTo(100 / 1024, 6)
    expect(fitScale(WORLD, 100000, 100000)).toBe(MAX_SCALE)
  })

  it('fitCamera：整張地圖落在視窗內且置中', () => {
    for (const [viewW, viewH] of [
      [1920, 1080],
      [800, 600],
      [500, 900],
      [2560, 1440],
      [300, 200],
    ] as const) {
      const camera = fitCamera(WORLD, viewW, viewH)
      const scaled = WORLD * camera.scale
      // 完整可見（不超出視窗）。
      expect(scaled).toBeLessThanOrEqual(Math.min(viewW, viewH) + 0.001)
      // 置中（縮小軸）或貼齊（剛好）。offset 不小於「地圖在視窗內」允許的最小值。
      expect(camera.offsetX).toBeGreaterThanOrEqual(0)
      expect(camera.offsetY).toBeGreaterThanOrEqual(0)
      expect(camera.offsetX + scaled).toBeLessThanOrEqual(Math.max(viewW, scaled) + 0.001)
    }
  })
})

describe('clampCamera / panBy：平移夾限', () => {
  it('地圖大於視窗：邊緣不得脫離視窗', () => {
    // scale 2 → 2048 > 800×600；offset 必須 ∈ [view − scaled, 0]。
    const base = { scale: 2, offsetX: 0, offsetY: 0 }
    const clamped = clampCamera(base, WORLD, 800, 600)
    expect(clamped.offsetX).toBe(0) // 想往左看更多 → 夾在 0
    expect(clamped.offsetY).toBe(0)
    const far = clampCamera({ scale: 2, offsetX: -9999, offsetY: -9999 }, WORLD, 800, 600)
    expect(far.offsetX).toBe(800 - 2048)
    expect(far.offsetY).toBe(600 - 2048)
  })

  it('地圖小於視窗：置中（不可拖離）', () => {
    const camera = clampCamera({ scale: 1, offsetX: -500, offsetY: 999 }, WORLD, 1920, 1080)
    expect(camera.offsetX).toBe(448)
    expect(camera.offsetY).toBe(28)
  })

  it('panBy 累積位移並夾限', () => {
    const start = { scale: 2, offsetX: -100, offsetY: -100 }
    const moved = panBy(start, -50, -50, WORLD, 800, 600)
    expect(moved.offsetX).toBe(-150)
    expect(moved.offsetY).toBe(-150)
    const clamped = panBy(start, -99999, -99999, WORLD, 800, 600)
    expect(clamped.offsetX).toBe(800 - 2048)
  })
})

describe('zoomAt：游標下的世界點固定', () => {
  it('放大後，同一螢幕點仍對應同一世界點（地圖填滿兩軸時）', () => {
    const viewW = 1600
    const viewH = 900
    const camera = fitCamera(WORLD, viewW, viewH)
    // 由中心縮放：地圖放大後大於兩軸、夾限不觸發 → 不變量成立。
    const screenX = 800
    const screenY = 450
    const worldBefore = {
      x: (screenX - camera.offsetX) / camera.scale,
      y: (screenY - camera.offsetY) / camera.scale,
    }
    const zoomed = zoomAt(camera, screenX, screenY, 2.5, WORLD, viewW, viewH)
    expect(zoomed.scale).toBeGreaterThan(camera.scale)
    // 縮放後地圖大於兩軸（可自由平移，無置中夾限）。
    expect(WORLD * zoomed.scale).toBeGreaterThan(viewW)
    expect(WORLD * zoomed.scale).toBeGreaterThan(viewH)
    const worldAfter = {
      x: (screenX - zoomed.offsetX) / zoomed.scale,
      y: (screenY - zoomed.offsetY) / zoomed.scale,
    }
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 3)
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 3)
  })

  it('縮放下限＝完整入鏡（縮到底即整張可見）', () => {
    const camera = fitCamera(WORLD, 800, 600)
    const zoomedOut = zoomAt(camera, 400, 300, 0.1, WORLD, 800, 600)
    expect(zoomedOut.scale).toBeCloseTo(fitScale(WORLD, 800, 600), 6)
    // 縮到底仍是完整入鏡（置中、不超過視窗）。
    expect(WORLD * zoomedOut.scale).toBeLessThanOrEqual(600 + 0.001)
  })

  it('縮放上限 MAX_SCALE', () => {
    const camera = fitCamera(WORLD, 1920, 1080)
    const zoomedIn = zoomAt(camera, 900, 500, 100, WORLD, 1920, 1080)
    expect(zoomedIn.scale).toBe(MAX_SCALE)
  })
})
