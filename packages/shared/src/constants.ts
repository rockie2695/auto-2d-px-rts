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

/**
 * 單一玩家的資源庫存上限（Prompt 5：藍水晶 9999）。
 * 收入結算時 clamp，超額部分直接丟棄（不溢位）。
 */
export const MAX_RESOURCE = 9999
