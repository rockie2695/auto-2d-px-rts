import { describe, expect, it } from 'vitest'

import { factionRawStats, radarStats } from './factionStats.ts'
import type { BuildingDef, FactionDef, UnitDef } from '@auto-2d-px-rts/shared'
import { makeBuildingDef, makeUnitDef } from '../sim/testFixtures.ts'
import type { BuildingDefTest, UnitDefTest } from '../sim/testFixtures.ts'

/**
 * 勢力六軸畫像（Prompt 10.5 完整版）：裝甲水平 = 成本加權平均 armor（指定口徑）、
 * 韌性/機動 = 成本加權平均、歸一按兩陣營同軸最大值。
 */

function unit(overrides: Partial<UnitDefTest> & { id: string }): UnitDef {
  return makeUnitDef(overrides)
}

function building(overrides: Partial<BuildingDefTest> & { id: string }): BuildingDef {
  return makeBuildingDef(overrides)
}

function faction(overrides: Partial<FactionDef>): FactionDef {
  // 測試只需要 roster/buildings 兩個欄位被 factionRawStats 讀取。
  return {
    id: 'f',
    name: 'F',
    startUnits: {},
    startBuildings: [],
    roster: [],
    buildings: [],
    startResources: { blue_crystal: 0, red_ruby: 0, green_emerald: 0 },
    counterMatrix: {
      melee: { melee: 1, ranged: 1 },
      ranged: { melee: 1, ranged: 1 },
    },
    ...overrides,
  } as FactionDef
}

describe('factionRawStats（Prompt 10.5 完整版：六軸畫像）', () => {
  it('裝甲水平 = 成本加權平均 armor（重成本高裝甲拉高均值）', () => {
    const units = [
      unit({ id: 'cheap', cost: { blue_crystal: 50 }, stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 2, armor: 0 } }),
      unit({ id: 'pricy', cost: { blue_crystal: 150 }, stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 2, armor: 0.5 } }),
    ]
    const stats = factionRawStats(faction({ roster: ['cheap', 'pricy'] }), units, [])
    // (50×0 + 150×0.5) / (50+150) = 75/200 = 0.375。
    expect(stats.裝甲).toBeCloseTo(0.375, 12)
  })

  it('韌性 = 成本加權平均有效 HP；機動性 = 成本加權平均 moveSpeed；軍事 = Σ DPS', () => {
    const units = [
      unit({ id: 'a', cost: { blue_crystal: 100 }, stats: { hp: 90, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 3, armor: 0.1 } }),
    ]
    const stats = factionRawStats(faction({ roster: ['a'] }), units, [])
    expect(stats.韌性).toBeCloseTo(90 / (1 - 0.1), 12)
    expect(stats.機動性).toBeCloseTo(3, 12)
    expect(stats.軍事).toBeCloseTo(10, 12)
  })

  it('經濟 = Σ 藍水晶收入；科技 = 高級收入建築×0.5 ＋ 高級資源單位佔比', () => {
    const units = [
      unit({ id: 'basic', cost: { blue_crystal: 50 }, stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 2 } }),
      unit({ id: 'techy', cost: { blue_crystal: 40, red_ruby: 80 }, stats: { hp: 100, dmg: 10, range: 3, attackSpeed: 1, moveSpeed: 1 } }),
    ]
    const buildings = [
      building({ id: 'mine', incomePerSec: { blue_crystal: 10 } }),
      building({ id: 'ruby', incomePerSec: { red_ruby: 3 } }),
    ]
    const stats = factionRawStats(faction({ roster: ['basic', 'techy'], buildings: ['mine', 'ruby'] }), units, buildings)
    expect(stats.經濟).toBe(10)
    // 高級收入建築 1 座（×0.5）＋高級資源單位佔比 1/2 → 0.5 + 0.5 = 1.0（clamp 上限）。
    expect(stats.科技).toBe(1)
  })
})

describe('radarStats（歸一）', () => {
  it('單陣營鏡像：兩側同形；無資料軸（經濟=0）不歸一、其餘滿格', () => {
    const units = [unit({ id: 'u', cost: { blue_crystal: 50 }, stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 2, armor: 0.2 } })]
    const entry = { faction: faction({ roster: ['u'] }), units, buildings: [] }
    const sides = radarStats([entry, entry])
    expect(sides).toHaveLength(2)
    for (const side of sides) {
      for (const axis of side.values) {
        // 無資料軸（經濟：無收入建築；科技：無高級資源消費）→ 原始 0、最大 0 → 歸一 0。
        if (axis.axis === '經濟' || axis.axis === '科技') expect(axis.value).toBe(0)
        else expect(axis.value).toBeCloseTo(1, 12)
      }
    }
  })

  it('兩陣營強弱不同 → 按同軸最大值歸一（弱方 < 1、強方 = 1）', () => {
    const strong = [unit({ id: 'big', cost: { blue_crystal: 50 }, stats: { hp: 200, dmg: 20, range: 0.8, attackSpeed: 1, moveSpeed: 2, armor: 0.4 } })]
    const weak = [unit({ id: 'small', cost: { blue_crystal: 50 }, stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1, moveSpeed: 2, armor: 0.2 } })]
    const sides = radarStats([
      { faction: faction({ roster: ['big'] }), units: strong, buildings: [] },
      { faction: faction({ roster: ['small'] }), units: weak, buildings: [] },
    ])
    const strongSide = sides[0]
    const weakSide = sides[1]
    expect(strongSide?.values.find((entry) => entry.axis === '軍事')?.value).toBe(1)
    expect(weakSide?.values.find((entry) => entry.axis === '軍事')?.value).toBeCloseTo(0.5, 12)
    expect(weakSide?.values.find((entry) => entry.axis === '裝甲')?.value).toBeCloseTo(0.5, 12)
  })
})
