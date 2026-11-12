import { describe, expect, it } from 'vitest'

import { armorBarRatio, armorTierColorOf, armorTierOf } from './armor.ts'

/**
 * 裝甲色階測試（Prompt 9.5 完整版驗收「裝甲條顏色按等級正確顯示」）：
 * - 輕 0.1–0.29 綠 `#4aff9e`、中 0.3–0.49 藍 `#4a9eff`、
 *   重 0.5–0.69 紫 `#b44aff`、超重 0.7–0.8 金 `#ffd24a`
 * - 條寬 = armor / 0.8（夾 0..1）
 */

describe('armorTierOf（裝甲分檔邊界）', () => {
  it('0 → none；檔界 0.1/0.3/0.5/0.7 與上界 0.8', () => {
    expect(armorTierOf(0)).toBe('none')
    expect(armorTierOf(-0.5)).toBe('none') // 負值夾 0
    expect(armorTierOf(0.1)).toBe('light')
    expect(armorTierOf(0.2)).toBe('light')
    expect(armorTierOf(0.29)).toBe('light')
    expect(armorTierOf(0.3)).toBe('medium')
    expect(armorTierOf(0.49)).toBe('medium')
    expect(armorTierOf(0.5)).toBe('heavy')
    expect(armorTierOf(0.69)).toBe('heavy')
    expect(armorTierOf(0.7)).toBe('ultra')
    expect(armorTierOf(0.8)).toBe('ultra')
    expect(armorTierOf(1.2)).toBe('ultra') // 超界仍歸超重（schema 上限 0.8 之上不會出現）
  })
})

describe('armorTierColorOf（Prompt 9.5 指定色階）', () => {
  it('四檔顏色精確對應；none 不畫（null）', () => {
    expect(armorTierColorOf(0)).toBeNull()
    expect(armorTierColorOf(0.2)).toBe('#4aff9e') // 輕＝綠
    expect(armorTierColorOf(0.4)).toBe('#4a9eff') // 中＝藍
    expect(armorTierColorOf(0.5)).toBe('#b44aff') // 重＝紫
    expect(armorTierColorOf(0.75)).toBe('#ffd24a') // 超重＝金
  })
})

describe('armorBarRatio（條寬 = armor / 0.8）', () => {
  it('比例與夾限', () => {
    expect(armorBarRatio(0)).toBe(0)
    expect(armorBarRatio(0.2)).toBeCloseTo(0.25)
    expect(armorBarRatio(0.4)).toBeCloseTo(0.5)
    expect(armorBarRatio(0.8)).toBe(1)
    expect(armorBarRatio(1.6)).toBe(1) // 夾上限
  })
})
