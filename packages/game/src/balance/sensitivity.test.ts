import { describe, expect, it } from 'vitest'

import { createTestWorld, makeUnitDef, putUnit } from '../sim/testFixtures.ts'
import { stepWorld } from '../sim/world.ts'

/**
 * 裝甲靈敏度掃描（階段三 Prompt 3.1 #7；原規劃在 server——本 workspace 無
 * server 包，落地為 game 內建、限定規模的對局掃描，控制在數秒內）。
 *
 * 方法：等規模等屬性的兩支小隊對撞，**唯一差異**是藍方裝甲 0→0.8（每 0.1 一格）。
 * 健康屬性判據：
 * 1. 藍方勝場隨裝甲**單調不減**（裝甲有非負效益、無病態反轉）；
 * 2. 滿甲（0.8）時藍方全勝（減傷 80% 的等價總量 5 倍，等兵必勝）；
 * 3. 0 裝甲時為鏡像 → 全平（同時結算下等兵互滅，裝甲沒有偷跑先手）。
 */

const BASE = { hp: 100, dmg: 10, range: 2.0, attackSpeed: 1.0, moveSpeed: 1.0 }
const BLUE_FIGHTER = (armor: number): ReturnType<typeof makeUnitDef> =>
  makeUnitDef({ id: 'blue_fighter', stats: { ...BASE, armor } })
const RED_FIGHTER = makeUnitDef({ id: 'red_fighter', stats: { ...BASE, armor: 0 } })

/** 藍（可變裝甲）vs 紅（armor 0）各 5 兵對撞；回傳 'player' | 'enemy' | 'draw'。 */
function clash(armor: number, seed: number): 'player' | 'enemy' | 'draw' {
  const world = createTestWorld({
    size: 32,
    seed,
    units: [BLUE_FIGHTER(armor), RED_FIGHTER],
    buildings: [], // 純戰鬥：無經濟建築
    startCrystal: 0,
  })
  for (const x of [14, 15, 16, 17, 18]) {
    putUnit(world, 'player', 'blue_fighter', { x, y: 14 })
    putUnit(world, 'enemy', 'red_fighter', { x, y: 15 })
  }
  for (let tick = 0; tick < 2000; tick++) {
    stepWorld(world)
    const blue = world.units.filter((unit) => unit.player === 'player' && unit.hp > 0).length
    const red = world.units.filter((unit) => unit.player === 'enemy' && unit.hp > 0).length
    if (blue === 0 || red === 0) {
      if (blue > 0) return 'player'
      if (red > 0) return 'enemy'
      return 'draw'
    }
  }
  return 'draw'
}

const SEEDS = [42, 1, 7, 123, 999] as const
const ARMOR_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] as const

describe('裝甲靈敏度掃描（Prompt 3.1：等兵對撞、唯一變因 = 裝甲）', () => {
  const wins = ARMOR_STEPS.map((armor) => ({
    armor,
    blue: SEEDS.filter((seed) => clash(armor, seed) === 'player').length,
    red: SEEDS.filter((seed) => clash(armor, seed) === 'enemy').length,
  }))

  it('0 裝甲 = 鏡像 → 全平（裝甲機制沒有偷跑先手）', () => {
    expect(wins[0]).toMatchObject({ armor: 0, blue: 0, red: 0 })
  })

  it('勝場隨裝甲單調不減（健康屬性：無病態反轉）', () => {
    for (let index = 1; index < wins.length; index++) {
      const previous = wins[index - 1]
      const current = wins[index]
      if (previous === undefined || current === undefined) continue
      expect(current.blue).toBeGreaterThanOrEqual(previous.blue)
      expect(current.red).toBeLessThanOrEqual(previous.red)
    }
  })

  it('滿甲 0.8 → 藍方全勝（減傷 80% 的等價總量 = 5 倍）', () => {
    expect(wins[wins.length - 1]).toMatchObject({ armor: 0.8, blue: SEEDS.length })
  })

  it('半甲 0.5 → 藍方全勝（等價總量 2 倍，提示詞「受到傷害減半」情景）', () => {
    const step = wins.find((entry) => entry.armor === 0.5)
    expect(step).toMatchObject({ blue: SEEDS.length, red: 0 })
  })
})
