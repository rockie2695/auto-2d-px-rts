import { describe, expect, it } from 'vitest'

import { findPath } from './pathfinding.ts'
import { createSpatialHash, queryNear, rebuildSpatialHash } from './spatialHash.ts'
import { centerOf, createTestWorld, makeUnitDef, putUnit } from './testFixtures.ts'
import { isRockAt } from './types.ts'
import type { TilePos } from './types.ts'

function walkableOver(rocks: readonly TilePos[], size: number) {
  const rockSet = new Set(rocks.map((rock) => `${rock.x},${rock.y}`))
  return (tile: TilePos): boolean =>
    tile.x >= 0 && tile.y >= 0 && tile.x < size && tile.y < size && !rockSet.has(`${tile.x},${tile.y}`)
}

describe('A* 尋路（SPEC §9.4）', () => {
  const size = 10

  it('空地：回傳最短路徑（含 goal、不含 start）', () => {
    const path = findPath(
      { size, walkable: walkableOver([], size) },
      { x: 1, y: 1 },
      { x: 4, y: 1 },
    )
    expect(path).toEqual([
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
    ])
  })

  it('起訖相同：回傳空陣列', () => {
    expect(findPath({ size, walkable: walkableOver([], size) }, { x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([])
  })

  it('goal 是岩石或界外：回傳 null', () => {
    const rocks = [{ x: 5, y: 5 }]
    expect(findPath({ size, walkable: walkableOver(rocks, size) }, { x: 0, y: 0 }, { x: 5, y: 5 })).toBeNull()
    expect(findPath({ size, walkable: walkableOver([], size) }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeNull()
  })

  it('岩石封死 goal：回傳 null', () => {
    // (5,5) 四周全封。
    const rocks = [
      { x: 5, y: 4 },
      { x: 6, y: 5 },
      { x: 5, y: 6 },
      { x: 4, y: 5 },
    ]
    expect(findPath({ size, walkable: walkableOver(rocks, size) }, { x: 0, y: 0 }, { x: 5, y: 5 })).toBeNull()
  })

  it('牆壁中留一個缺口：繞行且路徑全落在可走格', () => {
    // x=5 整行是牆，只有 (5,8) 是缺口。
    const rocks: TilePos[] = []
    for (let y = 0; y < size; y++) if (y !== 8) rocks.push({ x: 5, y })
    const path = findPath(
      { size, walkable: walkableOver(rocks, size) },
      { x: 0, y: 0 },
      { x: 9, y: 0 },
    )
    expect(path).not.toBeNull()
    if (path === null) return
    expect(path).toHaveLength(25) // 4 右 + 8 下 + 1 右(缺口) + 4 右 + 8 上
    expect(path.at(-1)).toEqual({ x: 9, y: 0 })
    for (const tile of path) {
      expect(walkableOver(rocks, size)(tile)).toBe(true)
    }
  })

  it('相同輸入必得相同路徑（確定性）', () => {
    const rocks = [
      { x: 3, y: 1 },
      { x: 3, y: 2 },
      { x: 3, y: 3 },
    ]
    const query = { size, walkable: walkableOver(rocks, size) }
    const a = findPath(query, { x: 0, y: 0 }, { x: 9, y: 9 })
    const b = findPath(query, { x: 0, y: 0 }, { x: 9, y: 9 })
    expect(a).toEqual(b)
  })
})

describe('空間雜湊', () => {
  it('createSpatialHash 產生空的兩個 Map', () => {
    const hash = createSpatialHash()
    expect(hash.units.size).toBe(0)
    expect(hash.buildings.size).toBe(0)
  })

  it('queryNear 只回報半徑內的單位，且依 id 升冪', () => {
    const world = createTestWorld({
      size: 16,
      units: [makeUnitDef({ id: 'u' })],
    })
    const near = putUnit(world, 'player', 'u', { x: 4, y: 4 })
    const alsoNear = putUnit(world, 'player', 'u', { x: 5, y: 4 })
    putUnit(world, 'player', 'u', { x: 14, y: 14 })
    rebuildSpatialHash(world)

    const result = queryNear(world, centerOf({ x: 4, y: 4 }).x, centerOf({ x: 4, y: 4 }).y, 400)
    expect(result.unitIds).toEqual([near, alsoNear].sort((a, b) => a - b))
    expect(result.buildingIds).toEqual([])
  })
})

describe('isRockAt（地圖邊界）', () => {
  it('界外視為岩石', () => {
    const world = createTestWorld({ size: 8 })
    expect(isRockAt(world, { x: -1, y: 0 })).toBe(true)
    expect(isRockAt(world, { x: 0, y: 8 })).toBe(true)
    expect(isRockAt(world, { x: 0, y: 0 })).toBe(false)
  })
})
