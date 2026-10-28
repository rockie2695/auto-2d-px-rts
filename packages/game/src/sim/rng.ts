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
