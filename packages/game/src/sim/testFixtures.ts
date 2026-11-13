import { TICK_RATE_HZ } from '@auto-2d-px-rts/shared'
import type {
  BuildingDef,
  FactionDef,
  MapDef,
  MatchDef,
  ResourceId,
  Role,
  UnitDef,
} from '@auto-2d-px-rts/shared'

import { rebuildSpatialHash } from './spatialHash.ts'
import { createRng } from './rng.ts'
import { spawnUnit } from './economy.ts'
import { getPlayer, INCOME_WINDOW_TICKS, UNITS_PER_TILE } from './types.ts'
import type { PlayerId, TilePos, World } from './types.ts'

/**
 * 測試專用的世界建構器（不依賴內容檔）。
 *
 * 用合成定義精準控制 hp／傷害／射程等數值，
 * 讓「弱者先死」「10 tick 走 10 格」這類斷言可以整數化。
 */

/**
 * 測試輸入的資源量表（Prompt 5）：三鍵皆可省略（預設 0）——
 * 成本通常只寫藍水晶、礦場產出只寫自己的資源，不必逐個補鍵。
 */
export type ResourceAmountTest = {
  blue_crystal?: number
  red_ruby?: number
  green_emerald?: number
}

/** 補齊三鍵（缺省 0）。 */
export function normalizeResourceAmount(partial: ResourceAmountTest): {
  blue_crystal: number
  red_ruby: number
  green_emerald: number
} {
  return {
    blue_crystal: partial.blue_crystal ?? 0,
    red_ruby: partial.red_ruby ?? 0,
    green_emerald: partial.green_emerald ?? 0,
  }
}

/**
 * 測試單位輸入（Prompt 3.1）：`stats.armor` 可省略（預設 0）——
 * 絕大多數舊測試不關心裝甲，不必逐個補欄位。
 */
export type UnitDefTest = Omit<UnitDef, 'id' | 'stats' | 'cost'> & {
  id: string
  stats?: Omit<UnitDef['stats'], 'armor'> & { armor?: number }
  cost?: ResourceAmountTest
}

/** 測試單位輸入 → 完整 UnitDef（armor／cost 缺省補 0）。 */
export function normalizeUnitDef(partial: UnitDefTest): UnitDef {
  return {
    ...partial,
    cost: normalizeResourceAmount(partial.cost ?? { blue_crystal: 50 }),
    stats: { hp: 100, dmg: 10, range: 0.8, attackSpeed: 1.0, moveSpeed: 1.0, ...partial.stats, armor: partial.stats?.armor ?? 0 },
  }
}

/** 合成單位定義；未指定的欄位用平衡預設值。 */
export function makeUnitDef(overrides: Partial<UnitDefTest> & { id: string }): UnitDef {
  return normalizeUnitDef({
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
  })
}

/** 合成建築定義（cost/incomePerSec 的紅綠鍵可省略，預設 0）。 */
export type BuildingDefTest = Omit<BuildingDef, 'id' | 'cost' | 'incomePerSec'> & {
  id: string
  cost?: ResourceAmountTest
  incomePerSec?: ResourceAmountTest
}

/** 測試建築輸入 → 完整 BuildingDef。 */
export function normalizeBuildingDef(partial: BuildingDefTest): BuildingDef {
  return {
    ...partial,
    cost: normalizeResourceAmount(partial.cost ?? { blue_crystal: 0 }),
    incomePerSec:
      partial.incomePerSec === undefined
        ? undefined
        : normalizeResourceAmount(partial.incomePerSec),
  }
}

/** 合成建築定義。 */
export function makeBuildingDef(overrides: Partial<BuildingDefTest> & { id: string }): BuildingDef {
  return normalizeBuildingDef({
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
  })
}

export interface TestWorldOptions {
  /** 地圖邊長（預設 12）。 */
  size?: number
  /** 岩石格。 */
  rocks?: readonly TilePos[]
  /** 資源點格（預設全部 blue_crystal；Prompt 5 類型節點用 `typedResourceNodes`）。 */
  resourceNodes?: readonly TilePos[]
  /** 每個資源點的蘊藏量（預設 500，與 test_map.json 一致）。 */
  nodeAmount?: number
  /**
   * 帶類型的資源節點（Prompt 5）：與 `resourceNodes` 擇一（同給時合併），
   * `resourceType` 缺省 blue_crystal。
   */
  typedResourceNodes?: ReadonlyArray<TilePos & { resourceType?: ResourceId }>
  /** 單位定義（armor 可省略，預設 0）。 */
  units?: readonly UnitDefTest[]
  /** 建築定義（cost／incomePerSec 的紅綠鍵可省略）。 */
  buildings?: readonly (BuildingDef | BuildingDefTest)[]
  /** 玩家起始藍水晶（預設 1000）。 */
  startCrystal?: number
  /** 礦場上限（預設 3；Prompt 5 三資源世界傳 5）。 */
  mineCap?: number
  /** counterMatrix 覆寫（預設全 1.0；克制測試用）。 */
  counterMatrix?: FactionDef['counterMatrix']
  seed?: number
}

const TEST_FACTION_ID = 'test_faction'

function makeMap(
  size: number,
  rocks: readonly TilePos[],
  nodes: ReadonlyArray<TilePos & { resourceType?: ResourceId }>,
  nodeAmount: number,
): MapDef {
  const tiles = new Array<number>(size * size).fill(0)
  for (const rock of rocks) tiles[rock.y * size + rock.x] = 1
  return {
    id: 'test_map',
    size,
    tiles,
    resourceNodes: nodes.map((node) => ({
      ...node,
      amount: nodeAmount,
      resourceType: node.resourceType ?? 'blue_crystal',
    })),
    // 開局配置不跑，出生點只給型別檢查用。
    spawnPoints: [
      { x: 0, y: 0 },
      { x: size - 1, y: size - 1 },
    ],
  }
}

function makeMatch(mineCap: number): MatchDef {
  return { tickRateHz: TICK_RATE_HZ, maxTicks: 12000, unitCap: 40, mineCap, barracksCap: 3 }
}

function makeFaction(
  units: readonly UnitDef[],
  buildings: readonly BuildingDef[],
  startCrystal: number,
  counterMatrix: FactionDef['counterMatrix'],
): FactionDef {
  return {
    id: TEST_FACTION_ID,
    name: 'Test',
    startUnits: {},
    startBuildings: [],
    roster: units.map((unit) => unit.id),
    // palette 含全部合成建築（keep 測試自行用 makeBuildingDef 排除）。
    buildings: buildings.map((building) => building.id),
    startResources: {
      blue_crystal: startCrystal,
      red_ruby: 0,
      green_emerald: 0,
    },
    counterMatrix,
  }
}

/** 建立一個可直接推進的合成世界（不含開局配置，由測試自行擺放）。 */
export function createTestWorld(options: TestWorldOptions = {}): World {
  const size = options.size ?? 12
  const units = (options.units ?? [makeUnitDef({ id: 'u' })]).map(normalizeUnitDef)
  const buildings = (options.buildings ?? [makeBuildingDef({ id: 'b' })]).map((def) =>
    normalizeBuildingDef(def as BuildingDefTest),
  )
  const plainNodes = (options.resourceNodes ?? []).map((node) => ({ ...node }))
  const typedNodes = (options.typedResourceNodes ?? []).map((node) => ({ ...node }))
  const map = makeMap(
    size,
    options.rocks ?? [],
    [...plainNodes, ...typedNodes],
    options.nodeAmount ?? 500,
  )

  const world: World = {
    tick: 0,
    seed: options.seed ?? 1,
    map,
    match: makeMatch(options.mineCap ?? 3),
    faction: makeFaction(
      units,
      buildings,
      options.startCrystal ?? 1000,
      options.counterMatrix ?? {
        melee: { melee: 1.0, ranged: 1.0 },
        ranged: { melee: 1.0, ranged: 1.0 },
      },
    ),
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
      resourceType: node.resourceType,
      buildingId: null,
    })),
    players: ['player', 'enemy'].map((id) => ({
      id: id as PlayerId,
      factionId: TEST_FACTION_ID,
      resources: {
        blue_crystal: options.startCrystal ?? 1000,
        red_ruby: 0,
        green_emerald: 0,
      },
      incomeRing: {
        blue_crystal: new Array<number>(INCOME_WINDOW_TICKS).fill(0),
        red_ruby: new Array<number>(INCOME_WINDOW_TICKS).fill(0),
        green_emerald: new Array<number>(INCOME_WINDOW_TICKS).fill(0),
      },
      spawn: id === 'player' ? { x: 0, y: 0 } : { x: size - 1, y: size - 1 },
      unitCount: 0,
      mineCount: 0,
      barracksCount: 0,
    })),
    rng: createRng(options.seed ?? 1),
    hash: { units: new Map(), buildings: new Map() },
    nextUnitId: 1,
    nextBuildingId: 1,
    surrender: null,
    initialBuildingCount: { player: 0, enemy: 0 },
    despairBreachSince: { player: null, enemy: null },
    metrics: {
      damageTakenRaw: { player: 0, enemy: 0 },
      damageTakenActual: { player: 0, enemy: 0 },
    },
    recentDeaths: [],
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

/** 玩家起始藍水晶的便捷讀取（Prompt 5：讀三資源表中的 blue_crystal）。 */
export function crystalOf(world: World, playerId: PlayerId): number {
  return getPlayer(world, playerId).resources.blue_crystal
}
