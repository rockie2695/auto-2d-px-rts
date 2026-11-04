/**
 * 種子化隨機數（mulberry32）—— 規則 8：相同輸入必得相同輸出。
 *
 * AI 層之後會用它做抽籤（例如 unitRange 配額）；
 * `state` 必須能進快照，確定性測試才能比對 RNG 進度。
 */
export interface Rng {
  /** 回傳 [0, 1) 的均勻亂數，並推進狀態。 */
  next(): number
  /** 目前內部狀態（供世界快照比對）。 */
  readonly state: number
}

export function createRng(seed: number): Rng {
  // mulberry32：32-bit 狀態、快速、跨平台一致（純整數位元運算 + 一次除法）。
  let a = seed >>> 0

  return {
    next(): number {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    get state(): number {
      return a >>> 0
    },
  }
}

/**
 * 純函數雜湊 → [0, 1)（Prompt 10.13）：由若干整數（種子、tick、座標…）混出穩定值。
 * 用途：等價路徑抽選（§9.4）與生產抽籤（§8.3）——同一輸入必得同一值；
 * 對鏡射座標輸入**等值**以維持公平性（呼叫端傳正規化座標）。
 * 混雜採 murmur 風格 avalanche（避免只改動低位導致輸出幾乎不變）。
 */
export function hashFate(...values: readonly number[]): number {
  let h = 0x9e3779b9
  for (const value of values) {
    h = (h ^ (value | 0)) >>> 0
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
    h = (h ^ (h >>> 16)) >>> 0
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  return h / 4294967296
}
