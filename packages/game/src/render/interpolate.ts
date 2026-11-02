import { UNITS_PER_TILE } from '../sim/types.ts'

import { TILE_SIZE } from './constants.ts'

/**
 * 渲染插值（純函式，Prompt 9）：邏輯 20Hz、渲染 60fps。
 * 單位位置在前後兩份 `snapshotWorld` 之間線性插值，alpha 取自
 * `GameLoop.progressToNextTick`（0 剛 tick 完 → 接近 1 快 tick 下一次）。
 */

/** 線性插值。 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 把 t 夾在 [0, 1]（ticker 供給的進度理論上已在範圍內，此處僅防呆）。 */
export function clamp01(t: number): number {
  if (t < 0) return 0
  if (t > 1) return 1
  return t
}

/** 世界座標（固定點）→ 世界像素（1 格 = TILE_SIZE px）。 */
export function fixedToPx(fixed: number): number {
  return (fixed / UNITS_PER_TILE) * TILE_SIZE
}

/** 插值後的顯示座標（世界 px；呼叫端負責取整以維持像素精确）。 */
export interface DisplayPos {
  x: number
  y: number
}

/**
 * 在前後兩份快照的同一實體之間插值顯示位置。
 * 前一快照缺該實體（剛生產／剛載入）→ 直接用當前位置。
 * alpha 夾限 [0, 1]。
 */
export function interpolateDisplay(
  prev: DisplayPos | null,
  curr: DisplayPos,
  alpha: number,
): DisplayPos {
  const t = clamp01(alpha)
  if (prev === null) return { x: curr.x, y: curr.y }
  return { x: lerp(prev.x, curr.x, t), y: lerp(prev.y, curr.y, t) }
}
