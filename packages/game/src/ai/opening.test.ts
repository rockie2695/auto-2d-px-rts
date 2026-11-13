import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { simulateOpening } from './opening.ts'
import { resolvePolicies } from './policy.ts'
import { loadContentPackFromDir } from '../data/loadFromDir.ts'

/**
 * 開局預測（Prompt 10.5 完整版）：headless 快照模擬——真 sim＋真戰略層。
 * 驗收：前 60 秒的生產計劃可預測（動作時間線）、確定性（同 seed 同結果）。
 */

const content = loadContentPackFromDir(
  fileURLToPath(new URL('../../public/data/', import.meta.url)),
)

describe('simulateOpening（Prompt 10.5 完整版：戰前頁 60 秒預測）', () => {
  it('前 60 秒有動作：全為 build/train、tick 落在戰略週期邊界、target 是合法 defId', () => {
    const plan = simulateOpening(content, { ticks: 1200, seed: 42 })
    expect(plan.actions.length).toBeGreaterThan(0)
    const unitIds = new Set(content.units.map((unit) => unit.id))
    const buildingIds = new Set(content.buildings.map((building) => building.id))
    for (const action of plan.actions) {
      expect(action.tick % 40).toBe(0) // 戰略循環每 40 tick
      expect(action.tick).toBeLessThanOrEqual(1200)
      if (action.action === 'train') expect(unitIds.has(action.target)).toBe(true)
      else expect(buildingIds.has(action.target)).toBe(true)
      expect(action.explanation.length).toBeGreaterThan(0)
    }
    // 預測以我方為對象：水晶統計存在。
    expect(plan.finalCrystal).toBeGreaterThanOrEqual(0)
  })

  it('確定性：同 seed 同滑桿 → 同時間線；60 秒內以默認滑桿持續生產', () => {
    const a = simulateOpening(content, { ticks: 1200, seed: 42 })
    const b = simulateOpening(content, { ticks: 1200, seed: 42 })
    expect(a.actions).toEqual(b.actions)
    expect(a.finalCrystal).toBe(b.finalCrystal)
  })

  it('trainCounts 與動作時間線一致；生兵統計非空（開局兵營已就緒）', () => {
    const plan = simulateOpening(content, { ticks: 1200, seed: 42 })
    const fromActions: Record<string, number> = {}
    for (const action of plan.actions) {
      if (action.action === 'train') {
        fromActions[action.target] = (fromActions[action.target] ?? 0) + 1
      }
    }
    expect(plan.trainCounts).toEqual(fromActions)
    expect(Object.keys(plan.trainCounts).length).toBeGreaterThan(0)
  })

  it('滑桿影響預測：econMilitary 0（全力軍事）的計劃與默認不同', () => {
    const defaults = simulateOpening(content, { ticks: 1200, seed: 42 })
    const military = simulateOpening(content, {
      ticks: 1200,
      seed: 42,
      policies: resolvePolicies({ econMilitary: 0 }),
    })
    // 不假設單調（建築預備金可能讓軍事傾向先蓋塔）——但計劃必須可觀察地不同：
    // 動作時間線或生產統計至少一項改變（滑桿真的被預測消費）。
    const sameTimeline =
      JSON.stringify(military.actions) === JSON.stringify(defaults.actions)
    const sameCounts = JSON.stringify(military.trainCounts) === JSON.stringify(defaults.trainCounts)
    expect(sameTimeline && sameCounts).toBe(false)
  })
})
