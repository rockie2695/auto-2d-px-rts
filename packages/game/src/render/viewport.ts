import { fitCamera, worldPxOf } from './camera.ts'

/**
 * 視窗排佈（Prompt 9 / 10.12）：**預設完整入鏡**（見 `camera.ts`）。
 * 地圖世界 1024×1024 px——視窗足夠大時整數倍（像素完美）、小於地圖時縮到剛好入鏡；
 * 兩軸各自置中。互動（拖曳平移／游標縮放）由 `GameScene` 的相機負責。
 */
export interface Viewport {
  /** 縮放倍率。 */
  readonly scale: number
  /** 地圖在畫布中的左上角偏移（px）。 */
  readonly offsetX: number
  /** 地圖在畫布中的上緣偏移（px）。 */
  readonly offsetY: number
  /** 地圖世界邊長（mapSizeTiles × TILE_SIZE）。 */
  readonly worldPx: number
}

/** 計算地圖（正方形）預設排佈：完整入鏡＋置中。 */
export function computeViewport(mapSizeTiles: number, viewW: number, viewH: number): Viewport {
  const worldPx = worldPxOf(mapSizeTiles)
  const camera = fitCamera(worldPx, viewW, viewH)
  return { scale: camera.scale, offsetX: camera.offsetX, offsetY: camera.offsetY, worldPx }
}
