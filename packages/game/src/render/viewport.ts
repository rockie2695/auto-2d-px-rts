import { TILE_SIZE } from './constants.ts'

/**
 * 視窗排佈（純函式，Prompt 9 像素完美）：整數縮放 + 置中。
 * 地圖世界 1024×1024 px 按 `floor` 縮放，剩餘空間 floor 後置中；
 * 視窗小於地圖時從左上起（offset 夾在 ≥ 0）。
 */
export interface Viewport {
  /** 整數縮放倍率（≥ 1）。 */
  readonly scale: number
  /** 地圖在畫布中的左上角偏移（px）。 */
  readonly offsetX: number
  /** 地圖在畫布中的上緣偏移（px）。 */
  readonly offsetY: number
  /** 地圖世界邊長（mapSizeTiles × TILE_SIZE）。 */
  readonly worldPx: number
}

/**
 * 計算地圖（正方形）在視窗中的排佈：
 * `scale = max(1, floor(min(viewW, viewH) / worldPx))`。
 */
export function computeViewport(mapSizeTiles: number, viewW: number, viewH: number): Viewport {
  const worldPx = mapSizeTiles * TILE_SIZE
  const scale = Math.max(1, Math.floor(Math.min(viewW / worldPx, viewH / worldPx)))
  const offsetX = Math.max(0, Math.floor((viewW - worldPx * scale) / 2))
  const offsetY = Math.max(0, Math.floor((viewH - worldPx * scale) / 2))
  return { scale, offsetX, offsetY, worldPx }
}
