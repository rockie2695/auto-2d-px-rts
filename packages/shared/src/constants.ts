/**
 * 模擬固定 tick 頻率（規則 8：確定性模擬）。
 * 所有模擬推進都以這個節拍進行，不得使用 wall-clock  delta。
 */
export const TICK_RATE_HZ = 20

/** 相鄰兩個 tick 之間的毫秒數。 */
export const TICK_INTERVAL_MS = 1000 / TICK_RATE_HZ

/**
 * MVP 唯一地圖的邊長（規則 11：32x32 單張地圖）。
 * 地圖為正方形，座標範圍是 [0, MAP_SIZE)。
 */
export const MAP_SIZE = 32
