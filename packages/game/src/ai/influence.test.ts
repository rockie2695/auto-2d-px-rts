import { describe, expect, it } from 'vitest'

import {
  CELL_TILES,
  cellIndexOf,
  computeInfluenceMap,
  enemyThreatAtPoint,
  enemyThreatAtTile,
  ownThreatAtTile,
  unitThreatMilli,
} from './influence.ts'
import { createTestWorld, makeUnitDef, putUnit } from '../sim/testFixtures.ts'
import type { World } from '../sim/types.ts'
import type { TilePos } from '../sim/types.ts'

/**
 * 影響力地圖測試（Prompt 7 驗收）：
 * - 敵方單位附近威脅值高、遠處低
 * - 精確公式：threat = value × (hp/maxHp) / (1 + dist²)
 * - 我方 / 敵方雙視角
 * - 殘血衰減、確定性
 */

/** 32×32 地圖、8×8 tile 粗格 → 4×4 網格；格中心＝**固定點中點**（cell 0 → (800,800)，見 cellCenterFixed）。 */
function influenceWorld(): World {
  return createTestWorld({ size: 32, units: [makeUnitDef({ id: 'u' })] })
}

describe('影響力地圖（Prompt 7）', () => {
  it('粗格參數：8 tile 一格、32 地圖 → 4×4 網格', () => {
    const map = computeInfluenceMap(influenceWorld(), 'player')
    expect(CELL_TILES).toBe(8)
    expect(map.gridSize).toBe(4)
    expect(map.own).toHaveLength(16)
    expect(map.enemy).toHaveLength(16)
  })

  it('格中心附近的敵方單位 → 精確公式值；遠處格驟降', () => {
    const world = influenceWorld()
    // tile(4,4) 中心 = 固定點 (900,900)；格 0 中心（固定點中點）= (800,800)，
    // 差 (100,100) → 100000 × 200² / (200² + 100² + 100²) = 66667（milli）。
    putUnit(world, 'enemy', 'u', { x: 4, y: 4 })
    const map = computeInfluenceMap(world, 'player')

    expect(map.enemy[0]).toBe(66667)
    // 我方視角沒有任何我方單位。
    expect(map.own[0]).toBe(0)

    // 格 1（中心 (2400,800)）：dx = 1500, dy = 100 → 100000 × 200²/2300000 ≈ 1739。
    expect(map.enemy[1]).toBe(1739)
    // 對角格 5（中心 (2400,2400)）：dx = dy = 1500 → ≈ 881。
    expect(map.enemy[5]).toBe(881)
    // 最遠格 15：近似 1/dist² 衰減 → 90：仍為正但遠低於格 0。
    expect(map.enemy[15]).toBe(90)
    expect(map.enemy[15]).toBeLessThan(map.enemy[1]!)
    expect(map.enemy[1]).toBeLessThan(map.enemy[0]!)
  })

  it('殘血單位威脅按 hp 比例衰減；死亡單位不計', () => {
    const world = influenceWorld()
    const id = putUnit(world, 'enemy', 'u', { x: 4, y: 4 })
    const unit = world.units.find((candidate) => candidate.id === id)!
    unit.hp = 50
    expect(computeInfluenceMap(world, 'player').enemy[0]).toBe(33333)

    unit.hp = 0
    expect(computeInfluenceMap(world, 'player').enemy[0]).toBe(0)
  })

  it('雙視角：我方的威脅記在 own、敵方的記在 enemy', () => {
    const world = influenceWorld()
    putUnit(world, 'player', 'u', { x: 20, y: 4 }) // 格 2
    putUnit(world, 'enemy', 'u', { x: 4, y: 4 }) // 格 0

    const fromPlayer = computeInfluenceMap(world, 'player')
    expect(fromPlayer.own[2]).toBe(66667)
    expect(fromPlayer.enemy[0]).toBe(66667)
    // 遠處那一格只有距離衰減後的小額殘值（不會誤記成自己的強訊號）。
    expect(fromPlayer.own[0]).toBeLessThan(1000)
    expect(fromPlayer.enemy[2]).toBeLessThan(1000)

    const fromEnemy = computeInfluenceMap(world, 'enemy')
    expect(fromEnemy.own[0]).toBe(66667)
    expect(fromEnemy.enemy[2]).toBe(66667)
  })

  it('鏡射對稱（Prompt 10.13）：敵單位在鏡射格 → enemy[c] = own[mirror(c)]（格心固定點對稱）', () => {
    const world = influenceWorld()
    const mirrorTile = (tile: TilePos): TilePos => ({ x: 31 - tile.x, y: 31 - tile.y })
    putUnit(world, 'player', 'u', { x: 5, y: 7 })
    putUnit(world, 'enemy', 'u', mirrorTile({ x: 5, y: 7 })) // (26,24)
    const map = computeInfluenceMap(world, 'player')
    const grid = map.gridSize
    const mirrorIndex = (index: number): number => {
      const cx = index % grid
      const cy = Math.floor(index / grid)
      return (grid - 1 - cy) * grid + (grid - 1 - cx)
    }
    // 兩單位互為 180° 鏡像、各格心亦為固定點鏡像 → 敵方在第 c 格的威脅
    // 必等於我方在第 mirror(c) 格的威脅（否則目標評分會左右不對稱）。
    for (let index = 0; index < map.own.length; index++) {
      expect(map.enemy[index], `cell ${index}`).toBe(map.own[mirrorIndex(index)])
    }
    // 至少有一格為正，確保比對非全零（無效斷言防呆）。
    expect(map.enemy.some((value) => value > 0)).toBe(true)
  })

  it('unitThreatMilli：滿血 = value × 1000', () => {
    const world = influenceWorld()
    const id = putUnit(world, 'enemy', 'u', { x: 4, y: 4 })
    const unit = world.units.find((candidate) => candidate.id === id)!
    expect(unitThreatMilli(world, unit)).toBe(100000)
    unit.hp = 30
    expect(unitThreatMilli(world, unit)).toBe(30000)
  })

  it('threatAtTile 以格為單位查詢（界外夾到邊界格）', () => {
    const world = influenceWorld()
    putUnit(world, 'enemy', 'u', { x: 4, y: 4 })
    const map = computeInfluenceMap(world, 'player')
    expect(cellIndexOf(map, { x: -5, y: -5 })).toBe(0)
    expect(cellIndexOf(map, { x: 999, y: 999 })).toBe(15)
    const inside: TilePos = { x: 4, y: 4 }
    expect(enemyThreatAtTile(map, inside)).toBe(66667)
    expect(ownThreatAtTile(map, inside)).toBe(0)
  })

  it('enemyThreatAtPoint：在指定點求值（不受格中心稀釋）', () => {
    const world = influenceWorld()
    putUnit(world, 'enemy', 'u', { x: 20, y: 4 }) // 固定點 (4100, 900)
    expect(enemyThreatAtPoint(world, 'player', 4100, 900)).toBe(100000)
    // 距 1 格（200 固定點）→ 100000 / (1 + 1) = 50000。
    expect(enemyThreatAtPoint(world, 'player', 4300, 900)).toBe(50000)
    // 我方單位不計入敵方威脅。
    putUnit(world, 'player', 'u', { x: 20, y: 5 })
    expect(enemyThreatAtPoint(world, 'player', 4100, 900)).toBe(100000)
  })

  it('相同世界 → 相同地圖（確定性）', () => {
    const build = (): string => {
      const world = influenceWorld()
      putUnit(world, 'player', 'u', { x: 4, y: 4 })
      putUnit(world, 'enemy', 'u', { x: 20, y: 20 })
      return JSON.stringify(computeInfluenceMap(world, 'player'))
    }
    expect(build()).toBe(build())
  })
})
