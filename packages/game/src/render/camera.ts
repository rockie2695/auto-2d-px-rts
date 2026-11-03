import { TILE_SIZE } from './constants.ts'

/**
 * 視角相機（Prompt 10.12）：地圖**預設完整入鏡**，可拖曳平移、以游標為中心滾輪縮放。
 *
 * - `fitScale`：視窗足夠大（≥ 1 倍）時走**整數倍**（像素完美）；
 *   視窗小於地圖時縮到**剛好入鏡**（允許 < 1 的非整數倍，確保整張地圖看得見）。
 * - `clampCamera`：地圖比視窗大時，邊緣不得脫離視窗；比視窗小時置中（不可拖離）。
 * - `zoomAt`：縮放時**游標下的世界點固定**；下限為 fit（永遠看不到比自己更遠的縮放）。
 *
 * 全部純函式、整數輸出（offset 取整避免亞像素抖動），確定性可測。
 */

export interface Camera {
  /** 縮放倍率。 */
  readonly scale: number
  /** 地圖左上角在畫布中的偏移（px，可為負＝地圖被拖出視窗左／上緣）。 */
  readonly offsetX: number
  readonly offsetY: number
}

/** 縮放上限（下限＝完整入鏡的 fit scale，見 `zoomAt`；不另設下限，
 *  視窗再小也一定縮到整張地圖可見）。 */
export const MAX_SCALE = 4

/** 地圖世界邊長（px）。 */
export function worldPxOf(mapSizeTiles: number): number {
  return mapSizeTiles * TILE_SIZE
}

/**
 * 完整入鏡的縮放：`min(viewW, viewH) / worldPx`。
 * ≥ 1 時取整數倍（像素完美）；< 1 時取原值（縮到剛好入鏡，視窗再小也完整可見）。
 * 上限 `MAX_SCALE`；**不設下限**——「整張地圖看得見」是硬保證。
 */
export function fitScale(worldPx: number, viewW: number, viewH: number): number {
  const raw = Math.min(viewW / worldPx, viewH / worldPx)
  if (raw >= 1) return Math.max(1, Math.min(MAX_SCALE, Math.floor(raw)))
  return Math.min(MAX_SCALE, raw)
}

/** 夾限相機：地圖大於視窗 → 邊緣不脫離視窗；小於 → 置中。 */
export function clampCamera(
  camera: Camera,
  worldPx: number,
  viewW: number,
  viewH: number,
): Camera {
  const scaled = worldPx * camera.scale
  const axis = (offset: number, view: number): number => {
    if (scaled <= view) return Math.round((view - scaled) / 2)
    const min = view - scaled
    return Math.round(Math.min(0, Math.max(min, offset)))
  }
  return {
    scale: camera.scale,
    offsetX: axis(camera.offsetX, viewW),
    offsetY: axis(camera.offsetY, viewH),
  }
}

/** 預設相機：完整入鏡＋置中。 */
export function fitCamera(worldPx: number, viewW: number, viewH: number): Camera {
  return clampCamera(
    { scale: fitScale(worldPx, viewW, viewH), offsetX: 0, offsetY: 0 },
    worldPx,
    viewW,
    viewH,
  )
}

/** 平移（含夾限）。 */
export function panBy(
  camera: Camera,
  dx: number,
  dy: number,
  worldPx: number,
  viewW: number,
  viewH: number,
): Camera {
  return clampCamera(
    { scale: camera.scale, offsetX: camera.offsetX + dx, offsetY: camera.offsetY + dy },
    worldPx,
    viewW,
    viewH,
  )
}

/**
 * 以螢幕點為中心縮放：游標下的世界點固定不變。
 * 縮放範圍 `[fitScale, MAX_SCALE]`——縮到最小即完整入鏡。
 */
export function zoomAt(
  camera: Camera,
  screenX: number,
  screenY: number,
  factor: number,
  worldPx: number,
  viewW: number,
  viewH: number,
): Camera {
  const minScale = fitScale(worldPx, viewW, viewH)
  const scale = Math.min(MAX_SCALE, Math.max(minScale, camera.scale * factor))
  if (scale === camera.scale) return clampCamera(camera, worldPx, viewW, viewH)
  // 游標下的世界座標（舊）：wx = (screenX − offset) / scale。
  const worldX = (screenX - camera.offsetX) / camera.scale
  const worldY = (screenY - camera.offsetY) / camera.scale
  // 新 offset 讓同一世界點仍落在游標下：offset = screen − world × scale。
  return clampCamera(
    { scale, offsetX: screenX - worldX * scale, offsetY: screenY - worldY * scale },
    worldPx,
    viewW,
    viewH,
  )
}
