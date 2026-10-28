import { TICK_RATE_HZ } from '@auto-2d-px-rts/shared'
import type {
  BuildingDef,
  FactionDef,
  MapDef,
  MatchDef,
  Role,
  UnitDef,
} from '@auto-2d-px-rts/shared'

import { rebuildSpatialHash } from './spatialHash.ts'
import { createRng } from './rng.ts'
import { spawnUnit } from './economy.ts'
import { getPlayer, UNITS_PER_TILE } from './types.ts'
import type { PlayerId, TilePos, World } from './types.ts'

/**
 * 測試專用的世界建構器（不依賴內容檔）。
 *
 * 用合成定義精準控制 hp／傷害／射程等數值，
 * 讓「弱者先死」「10 tick 走 10 格」這類斷言可以整數化。
 */

/** 合成單位定義；未指定的欄位用平衡預設值。 */
export function makeUnitDef(overrides: Partial<UnitDef> & { id: string }): UnitDef {
  return {
    faction: 'test_faction',
    tier: 'small',
    role: 'melee' as Role,
    cost: { blue_crystal: 50 },
    stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1.0, moveSpeed: 1.0 },
    requires: [],
    sprite: { color: '#ffffff', size: 8 },
    ai: { value: 100, preferredRange: 0.8, retreatHpPct: 0.2 },
    trainTimeSec: 1,
    ...overrides,
  }
}

/** 合成建築定義。 */
export function makeBuildingDef(overrides: Partial<BuildingDef> & { id: string }): BuildingDef {
  return {
    faction: 'test_faction',
    cost: { blue_crystal: 0 },
    size: [1, 1],
    produces: [],
    requires: [],
    sprite: { color: '#888888', size: 8 },
    ai: { value: 100 },
    hp: 500,
    buildTimeSec: 0,
    ...overrides,
  }
}

export interface TestWorldOptions {
  /** 地圖邊長（預設 12）。 */
  size?: number
  /** 岩石格。 */
  rocks?: readonly TilePos[]
  /** 資源點格。 */
  resourceNodes?: readonly TilePos[]
  /** 每個資源點的蘊藏量（預設 500，與 test_map.json 一致）。 */
  nodeAmount?: number
  units?: readonly UnitDef[]
  buildings?: readonly BuildingDef[]
  /** 玩家起始藍水晶（預設 1000）。 */
  startCrystal?: number
  seed?: number
}

const TEST_FACTION_ID = 'test_faction'

function makeMap(
  size: number,
  rocks: readonly TilePos[],
  nodes: readonly TilePos[],
  nodeAmount: number,
): MapDef {
  const tiles = new Array<number>(size * size).fill(0)
  for (const rock of rocks) tiles[rock.y * size + rock.x] = 1
  return {
    id: 'test_map',
    size,
    tiles,
    resourceNodes: nodes.map((node) => ({ ...node, amount: nodeAmount })),
    // 開局配置不跑，出生點只給型別檢查用。
    spawnPoints: [
      { x: 0, y: 0 },
      { x: size - 1, y: size - 1 },
    ],
  }
}

function makeMatch(): MatchDef {
  return { tickRateHz: TICK_RATE_HZ, maxTicks: 12000, unitCap: 40, mineCap: 3, barracksCap: 3 }
}

function makeFaction(
  units: readonly UnitDef[],
  buildings: readonly BuildingDef[],
  startCrystal: number,
): FactionDef {
  return {
    id: TEST_FACTION_ID,
    name: 'Test',
    startUnits: {},
    startBuildings: [],
    roster: units.map((unit) => unit.id),
    // palette 含全部合成建築（keep 測試自行用 makeBuildingDef 排除）。
    buildings: buildings.map((building) => building.id),
    startResources: { blue_crystal: startCrystal },
    counterMatrix: {
      melee: { melee: 1.0, ranged: 1.0 },
      ranged: { melee: 1.0, ranged: 1.0 },
    },
  }
}

/** 建立一個可直接推進的合成世界（不含開局配置，由測試自行擺放）。 */
export function createTestWorld(options: TestWorldOptions = {}): World {
  const size = options.size ?? 12
  const units = options.units ?? [makeUnitDef({ id: 'u' })]
  const buildings = options.buildings ?? [makeBuildingDef({ id: 'b' })]
  const map = makeMap(size, options.rocks ?? [], options.resourceNodes ?? [], options.nodeAmount ?? 500)

  const world: World = {
    tick: 0,
    map,
    match: makeMatch(),
    faction: makeFaction(units, buildings, options.startCrystal ?? 1000),
    defs: {
      units: Object.fromEntries(units.map((unit) => [unit.id, unit])),
      buildings: Object.fromEntries(buildings.map((building) => [building.id, building])),
    },
    units: [],
    buildings: [],
    resourceNodes: map.resourceNodes.map((node) => ({
      x: node.x,
      y: node.y,
      amountRemaining: node.amount,
      buildingId: null,
    })),
    players: ['player', 'enemy'].map((id) => ({
      id: id as PlayerId,
      factionId: TEST_FACTION_ID,
      blueCrystal: options.startCrystal ?? 1000,
      spawn: id === 'player' ? { x: 0, y: 0 } : { x: size - 1, y: size - 1 },
      unitCount: 0,
      mineCount: 0,
      barracksCount: 0,
    })),
    rng: createRng(options.seed ?? 1),
    hash: { units: new Map(), buildings: new Map() },
    nextUnitId: 1,
    nextBuildingId: 1,
  }
  rebuildSpatialHash(world)
  return world
}

/** 在指定格放一個單位（格中心座標）。 */
export function putUnit(
  world: World,
  playerId: PlayerId,
  defId: string,
  tile: TilePos,
): number {
  const unit = spawnUnit(world, playerId, defId, tile)
  if (unit === null) throw new Error(`putUnit 失敗：${defId}`)
  rebuildSpatialHash(world)
  return unit.id
}

/** 格座標 → 固定點中心（供斷言）。 */
export function centerOf(tile: TilePos): { x: number; y: number } {
  return {
    x: tile.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    y: tile.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
  }
}

/** 玩家起始藍水晶的便捷讀取。 */
export function crystalOf(world: World, playerId: PlayerId): number {
  return getPlayer(world, playerId).blueCrystal
}
