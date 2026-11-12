/**
 * 裝甲視覺（Prompt 9.5）：色階與裝甲條繪製參數的**單一真相來源**。
 * render（scene 裝甲條）與 ui（決策日誌裝甲標籤）共用同一組分檔與顏色——
 * 純函數、無 Pixi 依賴，測試直接驗證邊界。
 */

/** 裝甲分檔：無／輕／中／重／超重（0.8 為 schema 上限）。 */
export type ArmorTier = 'none' | 'light' | 'medium' | 'heavy' | 'ultra'

/** 裝甲條色階（Prompt 9.5 指定 hex；輕綠／中藍／重紫／超重金）。 */
export const ARMOR_TIER_COLORS = {
  light: '#4aff9e',
  medium: '#4a9eff',
  heavy: '#b44aff',
  ultra: '#ffd24a',
} as const

/** Pixi 用整數色（scene 裝甲條）；查表不含 none——呼叫端先排 armor ≤ 0。 */
export const ARMOR_TIER_COLORS_PIXI = {
  light: 0x4aff9e,
  medium: 0x4a9eff,
  heavy: 0xb44aff,
  ultra: 0xffd24a,
} as const

/** 裝甲值 → Pixi 條色；無裝甲回 null（呼叫端不畫條）。 */
export function armorTierColorPixiOf(armor: number): number | null {
  const tier = armorTierOf(armor)
  return tier === 'none' ? null : ARMOR_TIER_COLORS_PIXI[tier]
}

/** 裝甲值 → 分檔（0 = 無；0.1–0.29 輕、0.3–0.49 中、0.5–0.69 重、0.7+ 超重；負值夾 0）。 */
export function armorTierOf(armor: number): ArmorTier {
  if (armor <= 0) return 'none'
  if (armor < 0.3) return 'light'
  if (armor < 0.5) return 'medium'
  if (armor < 0.7) return 'heavy'
  return 'ultra'
}

/**
 * 裝甲值 → 裝甲條色（CSS hex）；無裝甲回 null（呼叫端不畫條）。
 * 邊界語義與 `armorTierOf` 一致（schema 保證 ≤ 0.8，超出仍歸超重金色）。
 */
export function armorTierColorOf(armor: number): string | null {
  const tier = armorTierOf(armor)
  return tier === 'none' ? null : ARMOR_TIER_COLORS[tier]
}

/** 裝甲值 → 裝甲條填充分數（寬度 = armor / 0.8；夾 0..1）。 */
export function armorBarRatio(armor: number): number {
  if (armor <= 0) return 0
  return Math.min(1, Math.max(0, armor / 0.8))
}
