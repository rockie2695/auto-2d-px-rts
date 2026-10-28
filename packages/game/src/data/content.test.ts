import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  MAP_SIZE,
  TICK_RATE_HZ,
  BuildingFileSchema,
  FactionFileSchema,
  MapFileSchema,
  MatchFileSchema,
  PoliciesFileSchema,
  ResourceFileSchema,
  UnitFileSchema,
} from '@auto-2d-px-rts/shared'
import type {
  BuildingDef,
  FactionDef,
  MapDef,
  MatchDef,
  PolicyDef,
  ResourceDef,
  UnitDef,
} from '@auto-2d-px-rts/shared'

const DATA_DIR = fileURLToPath(new URL('../../public/data/', import.meta.url))

/** BFS 的四方向位移。 */
const CARDINAL_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/** Prompt 3 定義的完整內容檔清單；多一個少一個都算失敗。 */
const EXPECTED_FILES: readonly string[] = [
  'buildings/barracks.json',
  'buildings/crystal_mine.json',
  'buildings/keep.json',
  'factions/test_faction.json',
  'maps/test_map.json',
  'match.json',
  'policies.json',
  'resources/blue_crystal.json',
  'units/archer.json',
  'units/legionnaire.json',
]

function listJsonFiles(dir: string, prefix = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(join(dir, entry.name), relative))
    } else if (entry.name.endsWith('.json')) {
      files.push(relative)
    }
  }
  return files.sort()
}

/** 讀取並 JSON.parse；解析失敗會直接讓測試紅，不靜默略過。 */
function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(DATA_DIR, relativePath), 'utf8'))
}

function loadResource(): ResourceDef {
  return ResourceFileSchema.parse(readJson('resources/blue_crystal.json')).resource
}

function loadUnits(): UnitDef[] {
  return listJsonFiles(join(DATA_DIR, 'units')).map(
    (file) => UnitFileSchema.parse(readJson(`units/${file}`)).unit,
  )
}

function loadBuildings(): BuildingDef[] {
  return listJsonFiles(join(DATA_DIR, 'buildings')).map(
    (file) => BuildingFileSchema.parse(readJson(`buildings/${file}`)).building,
  )
}

function loadFaction(): FactionDef {
  return FactionFileSchema.parse(readJson('factions/test_faction.json')).faction
}

function loadMap(): MapDef {
  return MapFileSchema.parse(readJson('maps/test_map.json')).map
}

function loadMatch(): MatchDef {
  return MatchFileSchema.parse(readJson('match.json')).match
}

function loadPolicies(): PolicyDef[] {
  return PoliciesFileSchema.parse(readJson('policies.json')).policies
}

describe('MVP 內容 JSON（Prompt 3）', () => {
  it('所有 JSON 檔案都存在，且沒有計畫外的檔案', () => {
    expect(listJsonFiles(DATA_DIR)).toEqual([...EXPECTED_FILES].sort())
  })

  it('資源：1 個（blue_crystal）', () => {
    expect(loadResource()).toEqual({
      id: 'blue_crystal',
      name: '藍水晶',
      color: '#4fc3f7',
    })
  })

  it('單位：2 個（legionnaire / archer），且都通過 Zod 驗證', () => {
    const units = loadUnits()
    expect(units.map((unit) => unit.id).sort()).toEqual(['archer', 'legionnaire'])
    expect(units).toHaveLength(2)
  })

  it('建築：3 個（keep / barracks / crystal_mine），且都通過 Zod 驗證', () => {
    const buildings = loadBuildings()
    expect(buildings.map((building) => building.id).sort()).toEqual([
      'barracks',
      'crystal_mine',
      'keep',
    ])
    expect(buildings).toHaveLength(3)
  })

  it('地圖：1 張（32x32 test_map），且通過 superRefine', () => {
    const map = loadMap()
    expect(map.id).toBe('test_map')
    expect(map.size).toBe(MAP_SIZE)
    expect(map.tiles).toHaveLength(MAP_SIZE * MAP_SIZE)
    // superRefine 已驗證座標界內與恰好 2 個出生點；這裡再確認內容數量
    expect(map.spawnPoints).toHaveLength(2)
    expect(map.resourceNodes).toHaveLength(6)
    // Prompt 5：每個節點的蘊藏量鎖定 500（SPEC §5，對稱同值）。
    for (const node of map.resourceNodes) {
      expect(node.amount).toBe(500)
    }
  })

  it('Policy 滑桿：5 個，數值與 SPEC §8 一致', () => {
    const policies = loadPolicies()
    expect(policies).toHaveLength(5)
    expect(policies).toEqual([
      { id: 'econMilitary', min: 0, max: 1, default: 0.5, step: 0.01 },
      { id: 'unitSize', min: 0, max: 1, default: 0.5, step: 0.01 },
      { id: 'unitRange', min: 0, max: 1, default: 0.5, step: 0.01 },
      { id: 'aggression', min: 0, max: 1, default: 0.5, step: 0.01 },
      { id: 'clusterSpread', min: 0, max: 1, default: 0.5, step: 0.01 },
    ])
  })

  it('陣營：1 個（test_faction），開局為 SPEC §7 對稱標準局', () => {
    const faction = loadFaction()
    expect(faction.id).toBe('test_faction')
    expect(faction.startResources).toEqual({ blue_crystal: 600 })
    expect(faction.startUnits).toEqual({ legionnaire: 3 })
    expect(faction.startBuildings.sort()).toEqual(['barracks', 'crystal_mine', 'keep'])
    expect(faction.roster).toEqual(['legionnaire', 'archer'])
    expect(faction.buildings).toEqual(['barracks', 'crystal_mine'])
  })

  it('對局設定：tick 頻率與時限等於 shared 常數', () => {
    const match = loadMatch()
    expect(match.tickRateHz).toBe(TICK_RATE_HZ)
    expect(match.maxTicks).toBe(12000)
    expect(match.unitCap).toBe(40)
    expect(match.mineCap).toBe(3)
    expect(match.barracksCap).toBe(3)
  })
})

describe('JSON 之間的交叉引用', () => {
  it('所有 id 引用都能在內容檔中找到，faction 字段指向 test_faction', () => {
    const units = loadUnits()
    const buildings = loadBuildings()
    const faction = loadFaction()
    const unitIds = new Set(units.map((unit) => unit.id))
    const buildingIds = new Set(buildings.map((building) => building.id))

    const broken: string[] = []
    const check = (ids: readonly string[], valid: ReadonlySet<string>, label: string): void => {
      for (const id of ids) {
        if (!valid.has(id)) broken.push(`${label} → ${id}`)
      }
    }

    check(faction.roster, unitIds, 'faction.roster')
    check(Object.keys(faction.startUnits), unitIds, 'faction.startUnits')
    check(faction.buildings, buildingIds, 'faction.buildings')
    check(faction.startBuildings, buildingIds, 'faction.startBuildings')
    for (const unit of units) {
      check(unit.requires, buildingIds, `unit(${unit.id}).requires`)
      if (unit.faction !== faction.id) broken.push(`unit(${unit.id}).faction = ${unit.faction}`)
    }
    for (const building of buildings) {
      check(building.produces, unitIds, `building(${building.id}).produces`)
      check(building.requires, buildingIds, `building(${building.id}).requires`)
      if (building.faction !== faction.id) {
        broken.push(`building(${building.id}).faction = ${building.faction}`)
      }
    }

    expect(broken).toEqual([])
  })

  it('counterMatrix 四格皆為 1.0（MVP 未套用相剋，SPEC §10 預留欄位）', () => {
    const matrix = loadFaction().counterMatrix
    expect(Object.values(matrix).flatMap((tally) => Object.values(tally))).toEqual([
      1, 1, 1, 1,
    ])
  })
})

describe('地圖資料（tiles = 可通行性：0 可走 / 1 岩石）', () => {
  it('tiles 為 180° 旋轉對稱', () => {
    const map = loadMap()
    const last = map.size - 1
    for (let y = 0; y < map.size; y++) {
      for (let x = 0; x < map.size; x++) {
        const here = map.tiles[y * map.size + x]
        const rotated = map.tiles[(last - y) * map.size + (last - x)]
        expect(
          here,
          `(${x},${y}) 的 tiles 值與其 180° 像 (${last - x},${last - y}) 不同`,
        ).toBe(rotated)
      }
    }
  })

  it('資源點與出生點都在界內且可通行，出生點互為 180° 像', () => {
    const map = loadMap()
    const walkable = (x: number, y: number): boolean => map.tiles[y * map.size + x] === 0
    const last = map.size - 1

    for (const node of map.resourceNodes) {
      expect(walkable(node.x, node.y), `資源點 (${node.x},${node.y}) 不可通行`).toBe(true)
    }
    for (const spawn of map.spawnPoints) {
      expect(walkable(spawn.x, spawn.y), `出生點 (${spawn.x},${spawn.y}) 不可通行`).toBe(true)
    }

    const spawnKeys = new Set(map.spawnPoints.map((spawn) => `${spawn.x},${spawn.y}`))
    for (const spawn of map.spawnPoints) {
      expect(spawnKeys.has(`${last - spawn.x},${last - spawn.y}`)).toBe(true)
    }
  })

  it('兩個出生點之間存在可通行路徑（BFS）', () => {
    const map = loadMap()
    const first = map.spawnPoints[0]
    const second = map.spawnPoints[1]
    if (first === undefined || second === undefined) {
      throw new Error('schema 已保證恰好 2 個出生點')
    }

    const walkable = (x: number, y: number): boolean =>
      x >= 0 && x < map.size && y >= 0 && y < map.size && map.tiles[y * map.size + x] === 0

    const queue: Array<[number, number]> = [[first.x, first.y]]
    const seen = new Set([`${first.x},${first.y}`])
    let reached = false

    while (queue.length > 0) {
      const current = queue.pop()
      if (current === undefined) break
      const [x, y] = current
      if (x === second.x && y === second.y) {
        reached = true
        break
      }
      for (const [dx, dy] of CARDINAL_DIRECTIONS) {
        const nx = x + dx
        const ny = y + dy
        const key = `${nx},${ny}`
        if (walkable(nx, ny) && !seen.has(key)) {
          seen.add(key)
          queue.push([nx, ny])
        }
      }
    }

    expect(reached, '兩個出生點之間被岩石隔斷').toBe(true)
  })
})

describe('內容數值與 SPEC 一致（防止資料悄悄漂移）', () => {
  it('單位數值 = SPEC §4', () => {
    expect(loadUnits().find((unit) => unit.id === 'legionnaire')?.stats).toEqual({
      hp: 100,
      dmg: 12,
      range: 0.8,
      attackSpeed: 1.2,
      moveSpeed: 2.1,
    })
    expect(loadUnits().find((unit) => unit.id === 'archer')?.stats).toEqual({
      hp: 60,
      dmg: 8,
      range: 3.0,
      attackSpeed: 1.0,
      moveSpeed: 2.5,
    })
    expect(loadUnits().find((unit) => unit.id === 'legionnaire')?.trainTimeSec).toBe(5)
    expect(loadUnits().find((unit) => unit.id === 'archer')?.trainTimeSec).toBe(7)
    expect(loadUnits().find((unit) => unit.id === 'legionnaire')?.cost).toEqual({
      blue_crystal: 50,
    })
    expect(loadUnits().find((unit) => unit.id === 'archer')?.cost).toEqual({
      blue_crystal: 75,
    })
  })

  it('建築數值 = SPEC §5 / §6', () => {
    const buildings = loadBuildings()
    expect(buildings.find((building) => building.id === 'keep')?.hp).toBe(1000)
    expect(buildings.find((building) => building.id === 'barracks')?.hp).toBe(600)
    expect(buildings.find((building) => building.id === 'barracks')?.cost).toEqual({
      blue_crystal: 200,
    })
    expect(buildings.find((building) => building.id === 'barracks')?.buildTimeSec).toBe(15)
    expect(buildings.find((building) => building.id === 'crystal_mine')?.hp).toBe(300)
    expect(buildings.find((building) => building.id === 'crystal_mine')?.cost).toEqual({
      blue_crystal: 150,
    })
    expect(buildings.find((building) => building.id === 'crystal_mine')?.buildTimeSec).toBe(12)
    expect(buildings.find((building) => building.id === 'crystal_mine')?.incomePerSec).toEqual({
      blue_crystal: 1.0,
    })
    expect(buildings.find((building) => building.id === 'crystal_mine')?.requiresResourceNode).toBe(
      true,
    )
  })

  it('撤退閾值固定為 0.2（資料定義，玩家不可調 — SPEC §8.4）', () => {
    for (const unit of loadUnits()) {
      expect(unit.ai.retreatHpPct, `${unit.id} 的 retreatHpPct`).toBe(0.2)
    }
  })
})
