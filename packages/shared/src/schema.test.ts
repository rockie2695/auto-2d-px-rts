import { describe, expect, it } from 'vitest'

import { UnitFileSchema } from './schema.ts'

/**
 * UnitDef.armor 驗證（階段三 Prompt 3.1）：範圍 0~0.8、缺欄預設 0。
 * 欄位名固定 "armor"（中文標籤「裝甲」屬 UI 層，schema 不帶語言）。
 */

/** 通過其余欄位驗證的最小單位檔。 */
function unitFile(stats: Record<string, unknown>): unknown {
  return {
    schemaVersion: 1,
    unit: {
      id: 'u',
      faction: 'f',
      tier: 'small',
      role: 'melee',
      cost: { blue_crystal: 50 },
      stats,
      requires: [],
      sprite: { color: '#ffffff', size: 8 },
      ai: { value: 100, preferredRange: 0.8, retreatHpPct: 0.5 },
      trainTimeSec: 5,
    },
  }
}

describe('UnitDef.stats.armor（Prompt 3.1）', () => {
  it('合法值 0 / 0.2 / 0.8 通過', () => {
    for (const armor of [0, 0.2, 0.8]) {
      const parsed = UnitFileSchema.parse(unitFile({ hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 1, armor }))
      expect(parsed.unit.stats.armor).toBe(armor)
    }
  })

  it('缺欄 → 預設 0（舊 replay／舊內容檔不用改）', () => {
    const parsed = UnitFileSchema.parse(unitFile({ hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 1 }))
    expect(parsed.unit.stats.armor).toBe(0)
  })

  it('超出上限 0.8 拒絕（0.81 拋錯）', () => {
    expect(() => UnitFileSchema.parse(unitFile({ hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 1, armor: 0.81 }))).toThrow()
  })

  it('負值拒絕', () => {
    expect(() => UnitFileSchema.parse(unitFile({ hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 1, armor: -0.1 }))).toThrow()
  })
})
