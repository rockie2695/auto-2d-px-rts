import { describe, expect, it } from 'vitest'

import { firedThisTick } from './attackFx.ts'

/**
 * 攻擊特效偵測測試（Prompt 10.24）：
 * - 開火判據：attackAcc 只在開火 tick 下降（持續交戰逐發可偵測）
 * （9.5c：受害者端點改由 sim 同源 `computeEngageLines` 提供，測試移至 combat.test.ts）
 */

describe('開火判據 firedThisTick（Prompt 10.24 修：持續交戰逐發偵測）', () => {
  it('開火 tick：attackAcc 下降 → true（0.95 → 0.0）', () => {
    expect(firedThisTick(0.95, 0)).toBe(true)
  })

  it('蓄力 tick：attackAcc 上升 → false（0.9 → 0.95）——舊判據 before ≥ 1 恆假', () => {
    expect(firedThisTick(0.9, 0.95)).toBe(false)
    expect(firedThisTick(0.05, 0.1)).toBe(false)
  })

  it('閒置封頂後首發（1.0 → 0.0）仍偵測得到', () => {
    expect(firedThisTick(1, 0)).toBe(true)
  })

  it('同值不誤報', () => {
    expect(firedThisTick(0.5, 0.5)).toBe(false)
    expect(firedThisTick(0, 0)).toBe(false)
  })
})
