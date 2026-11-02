import { describe, expect, it } from 'vitest'

import { UNITS_PER_TILE } from '../sim/types.ts'

import { clamp01, fixedToPx, interpolateDisplay, lerp } from './interpolate.ts'
import { TILE_SIZE } from './constants.ts'

/**
 * 渲染插值測試（Prompt 9）：邏輯 20Hz、渲染 60fps 的位置插值是純計算，
 * 在 node 環境即可鎖定行為（Pixi 顯示物件由 `pnpm dev` 驗收）。
 */

describe('lerp / clamp01', () => {
  it('lerp：t=0 → a、t=1 → b、t=0.5 → 中點', () => {
    expect(lerp(10, 20, 0)).toBe(10)
    expect(lerp(10, 20, 1)).toBe(20)
    expect(lerp(10, 20, 0.5)).toBe(15)
  })

  it('alpha 夾限 [0, 1]', () => {
    expect(clamp01(-0.3)).toBe(0)
    expect(clamp01(0.4)).toBe(0.4)
    expect(clamp01(1.7)).toBe(1)
  })
})

describe('interpolateDisplay（Prompt 9）', () => {
  const PREV = { x: 100, y: 200 }
  const CURR = { x: 200, y: 320 }

  it('alpha=0 → 前一快照位置；alpha=1 → 當前快照位置', () => {
    expect(interpolateDisplay(PREV, CURR, 0)).toEqual(PREV)
    expect(interpolateDisplay(PREV, CURR, 1)).toEqual(CURR)
  })

  it('alpha=0.5 → 中點（20Hz 狀態在 60fps 下平滑滑動）', () => {
    expect(interpolateDisplay(PREV, CURR, 0.5)).toEqual({ x: 150, y: 260 })
  })

  it('前一快照缺該實體（剛生產）→ 直接用當前位置', () => {
    expect(interpolateDisplay(null, CURR, 0.3)).toEqual(CURR)
  })

  it('超出範圍的 alpha 也夾限（防呆）', () => {
    expect(interpolateDisplay(PREV, CURR, -1)).toEqual(PREV)
    expect(interpolateDisplay(PREV, CURR, 2)).toEqual(CURR)
  })
})

describe('fixedToPx', () => {
  it('固定點 → 世界像素：1 格（200 單位）= TILE_SIZE px', () => {
    expect(fixedToPx(0)).toBe(0)
    expect(fixedToPx(UNITS_PER_TILE)).toBe(TILE_SIZE)
    expect(fixedToPx(UNITS_PER_TILE * 3.5)).toBe(TILE_SIZE * 3.5)
    expect(fixedToPx(UNITS_PER_TILE / 2)).toBe(TILE_SIZE / 2)
  })
})
