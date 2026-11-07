import { describe, expect, it } from 'vitest'

import { makeUnitDef } from '../sim/testFixtures.ts'
import { survivalScoreOf, unitBalanceStats } from './unitStats.ts'

/**
 * 平衡指標（階段三 Prompt 3.1）：armor / 有效HP / 兩種性價比的純函式回歸。
 * 這些數字是平衡工作的量尺——公式錯了整個平衡都失真，鎖住整數與分母歸零行為。
 */

describe('unitBalanceStats（Prompt 3.1 指標表）', () => {
  it('shield_guard 造型：hp 120 / armor 0.5 / dmg 6 / cost 80', () => {
    const def = makeUnitDef({
      id: 'sg',
      cost: { blue_crystal: 80 },
      stats: { hp: 120, dmg: 6, range: 0.8, attackSpeed: 1.0, moveSpeed: 2.0, armor: 0.5 },
    })
    const stats = unitBalanceStats(def)
    expect(stats.armor).toBe(0.5)
    expect(stats.effectiveHpValue).toBe(240)
    expect(stats.effectiveHpPerCost).toBeCloseTo(3, 10)
    expect(stats.dps).toBe(6)
    expect(stats.dpsPerCost).toBeCloseTo(0.075, 10)
  })

  it('無裝甲（armor 0）：有效 HP = 原始 HP', () => {
    const def = makeUnitDef({ id: 'u', stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 1, armor: 0 } })
    const stats = unitBalanceStats(def)
    expect(stats.effectiveHpValue).toBe(100)
    expect(stats.effectiveHpPerCost).toBe(2)
  })

  it('cost 0（如免費測試單位）：分母為 0 → 性價比回 0 而非 Infinity', () => {
    const def = makeUnitDef({ id: 'free', cost: { blue_crystal: 0 }, stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 1 } })
    const stats = unitBalanceStats(def)
    expect(stats.effectiveHpPerCost).toBe(0)
    expect(stats.dpsPerCost).toBe(0)
  })
})

describe('survivalScoreOf（roster 內正規化有效HP/cost）', () => {
  const TANK = makeUnitDef({
    id: 'tank',
    cost: { blue_crystal: 80 },
    stats: { hp: 120, dmg: 6, range: 0.8, attackSpeed: 1, moveSpeed: 2, armor: 0.5 }, // 240/80 = 3.0
  })
  const GLASS = makeUnitDef({
    id: 'glass',
    cost: { blue_crystal: 50 },
    stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 1, armor: 0 }, // 100/50 = 2.0
  })
  const MID = makeUnitDef({
    id: 'mid',
    cost: { blue_crystal: 50 },
    stats: { hp: 125, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 1, armor: 0.2 }, // 156.25/50 = 3.125
  })

  it('min-max 正規化：最低者 0、最高者 1', () => {
    const roster = [GLASS, TANK]
    expect(survivalScoreOf(GLASS, roster)).toBe(0)
    expect(survivalScoreOf(TANK, roster)).toBe(1)
  })

  it('中間值線性內插：roster [2.0, 3.0, 3.125] → TANK ≈ 0.889、MID = 1', () => {
    const roster = [GLASS, TANK, MID]
    expect(survivalScoreOf(MID, roster)).toBe(1)
    expect(survivalScoreOf(TANK, roster)).toBeCloseTo((3 - 2) / (3.125 - 2), 10)
  })

  it('全平（單一單位）→ 中性 0.5', () => {
    expect(survivalScoreOf(TANK, [TANK])).toBe(0.5)
  })
})
