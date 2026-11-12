import { describe, expect, it } from 'vitest'

import { influenceCellColor } from './overlay.ts'

/**
 * 影響力熱力圖顏色映射測試（Prompt 9.5 完整版驗收
 * 「熱力圖在敵方單位附近顯示紅色」的純函數部分）：
 * 敵方主導 → 紅；我方主導 → 藍；雙方皆 0 → 全透明。
 */

describe('influenceCellColor（熱力圖格顏色）', () => {
  it('敵方主導 → 紅通道最強；我方主導 → 藍通道最強', () => {
    const red = influenceCellColor(0, 1000, 1000)
    expect(red.r).toBeGreaterThan(red.g)
    expect(red.r).toBeGreaterThan(red.b)
    expect(red.a).toBeGreaterThan(0)

    const blue = influenceCellColor(1000, 0, 1000)
    expect(blue.b).toBeGreaterThan(blue.r)
    expect(blue.b).toBeGreaterThan(blue.g)
    expect(blue.a).toBeGreaterThan(0)
  })

  it('雙方皆 0（或全圖 max = 0）→ 全透明；強度隨主導差遞增', () => {
    const zero = influenceCellColor(0, 0, 1000)
    expect(zero.a).toBe(0)

    const nothing = influenceCellColor(5, 5, 0)
    expect(nothing.a).toBe(0)

    const weak = influenceCellColor(0, 300, 1000)
    const strong = influenceCellColor(0, 900, 1000)
    expect(strong.a).toBeGreaterThan(weak.a)
    // 強度封頂不超過 MAX_ALPHA。
    expect(weak.a).toBeLessThanOrEqual(0.56)
    expect(strong.a).toBeLessThanOrEqual(0.56)
  })

  it('強度按全圖 max 歸一（相對強度不隨單格縮放失真）', () => {
    const small = influenceCellColor(0, 100, 1000)
    const big = influenceCellColor(0, 1000, 1000)
    expect(big.a).toBeGreaterThan(small.a)
    // r/g/b 只由主導方決定，與強度無關。
    expect(small.r).toBe(big.r)
    expect(small.g).toBe(big.g)
    expect(small.b).toBe(big.b)
  })
})
