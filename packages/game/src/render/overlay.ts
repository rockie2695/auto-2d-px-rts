/**
 * 影響力熱力圖的顏色映射（Prompt 9.5）：純函數——
 * `influenceCellColor(own, enemy, max)` 把一個 8×8 tile 粗格的我方／敵方
 * 威脅值換成 RGBA。紅 = 敵威脅主導、藍 = 我方控制主導，強度按主導差歸一
 * （max 為全圖最大格值，避免每格各自歸一造成相對強度失真）。
 * 雙方都趨近 0 → 全透明（疊在地圖上不遮內容）。
 */

export interface Rgba {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

/** 熱力圖基色（敵方紅／我方藍；與單位陣營色同色相、更深飽和）。 */
const ENEMY_RGB = { r: 232, g: 64, b: 64 }
const OWN_RGB = { r: 64, g: 156, b: 255 }

/** 最大疊加不透明度（其餘靠 alpha 淡出，保持地圖可讀）。 */
const MAX_ALPHA = 0.55

/**
 * 一格的熱力顏色：
 * - `max <= 0`（全圖無威脅）→ 全透明。
 * - 主導差 = |enemy − own|；主導色 = 敵大於我 ? 紅 : 藍。
 * - 強度 = 主導差 ÷ max（夾 0..1）→ alpha 線性映射；r/g/b 取主導基色。
 */
export function influenceCellColor(own: number, enemy: number, max: number): Rgba {
  const gap = enemy - own
  const magnitude = Math.abs(gap)
  const scale = max > 0 ? Math.min(1, magnitude / max) : 0
  if (scale <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  const rgb = gap > 0 ? ENEMY_RGB : OWN_RGB
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: Math.round(scale * MAX_ALPHA * 255) / 255 }
}
