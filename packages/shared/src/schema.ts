import { z } from 'zod'

/**
 * MVP 內容資料的 Zod schema（規則 7）。
 *
 * `packages/game/public/data/` 的每一份 JSON 都會以這裡的 schema 驗證；
 * 欄位結構按最終 schema 設計，日後把 JSON 遷移到 DB 時不需改動。
 *
 * 注意：MVP **沒有 armor 欄位** —— 裝甲屬延後的 Prompt 3.1。
 */

/** 每份內容檔共有的版本標記（SPEC §13）。 */
export const SchemaVersionSchema = z.literal(1)

const IdSchema = z.string().min(1, 'id 不可為空')

/** 十六進位顏色（`#rrggbb`），用於資源、單位與建築的 sprite。 */
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, '顏色必須是 #rrggbb 格式')

/** 以資源 id 為鍵的數量表（整數，用於成本與存量）。 */
export const ResourceAmountSchema = z.object({
  blue_crystal: z.number().int().nonnegative(),
})

/** 以資源 id 為鍵的速率表（可為小數，用於每秒產出）。 */
export const ResourceRateSchema = z.object({
  blue_crystal: z.number().nonnegative(),
})

/** 地圖上的單一格座標，範圍是 [0, map.size)。 */
export const TileCoordSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
})

export type TileCoord = z.infer<typeof TileCoordSchema>

/* ------------------------------------------------------------------ */
/* 資源                                                                */
/* ------------------------------------------------------------------ */

export const ResourceDefSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  color: HexColorSchema,
})

export type ResourceDef = z.infer<typeof ResourceDefSchema>

/* ------------------------------------------------------------------ */
/* 單位                                                                */
/* ------------------------------------------------------------------ */

export const RoleSchema = z.enum(['melee', 'ranged'])
export type Role = z.infer<typeof RoleSchema>

/** MVP 只使用 small；medium / large 依規則 7 預留給之後的 tier。 */
export const TierSchema = z.enum(['small', 'medium', 'large'])
export type Tier = z.infer<typeof TierSchema>

export const UnitDefSchema = z.object({
  id: IdSchema,
  faction: IdSchema,
  tier: TierSchema,
  role: RoleSchema,
  cost: ResourceAmountSchema,
  stats: z.object({
    hp: z.number().int().positive(),
    dmg: z.number().int().positive(),
    range: z.number().nonnegative(),
    /** 每秒攻擊次數（SPEC §4）。 */
    attackSpeed: z.number().positive(),
    /** 每秒移動格數（SPEC §4）。 */
    moveSpeed: z.number().positive(),
  }),
  /** 產出此單位所需的建築 id。 */
  requires: z.array(IdSchema),
  sprite: z.object({
    color: HexColorSchema,
    size: z.number().int().positive(),
  }),
  ai: z.object({
    /** AI 對此單位的評價權重（生產排序用）。 */
    value: z.number().nonnegative(),
    /** 微操層偏好的交戰距離（風箏用）。 */
    preferredRange: z.number().nonnegative(),
    /** hp 低於此比例即撤退（SPEC §8.4：資料定義、玩家不可調）。 */
    retreatHpPct: z.number().min(0).max(1),
  }),
  /** 生產時間（秒），SPEC §6。 */
  trainTimeSec: z.number().positive(),
})

export type UnitDef = z.infer<typeof UnitDefSchema>

/* ------------------------------------------------------------------ */
/* 建築                                                                */
/* ------------------------------------------------------------------ */

export const BuildingDefSchema = z.object({
  id: IdSchema,
  faction: IdSchema,
  cost: ResourceAmountSchema,
  /** 佔地（格）：[寬, 高]。 */
  size: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  /** 此建築可生產的單位 id。 */
  produces: z.array(IdSchema),
  /** 興建此建築的前置建築 id。 */
  requires: z.array(IdSchema),
  sprite: z.object({
    color: HexColorSchema,
    size: z.number().int().positive(),
  }),
  ai: z.object({
    /** AI 對此建築的防護／爭奪評價。 */
    value: z.number().nonnegative(),
  }),
  hp: z.number().int().positive(),
  /** 建造時間（秒）；0 表示只能由開局配置放置（例如 keep）。 */
  buildTimeSec: z.number().nonnegative(),
  /** 每秒產出（僅經濟設施有；SPEC §5 的 crystal_mine）。 */
  incomePerSec: ResourceRateSchema.optional(),
  /** 是否必須蓋在空資源點上。 */
  requiresResourceNode: z.boolean().optional(),
})

export type BuildingDef = z.infer<typeof BuildingDefSchema>

/* ------------------------------------------------------------------ */
/* 陣營                                                                */
/* ------------------------------------------------------------------ */

const RoleTallySchema = z.object({
  melee: z.number().nonnegative(),
  ranged: z.number().nonnegative(),
})

/**
 * melee / ranged 2x2 相剋矩陣。
 *
 * MVP 中四格皆為 1.0（恆等）—— 欄位依規則 7 預留，
 * 戰鬥公式尚未讀取它（SPEC §10），傷害相剋屬延後範圍。
 */
export const CounterMatrixSchema = z.object({
  melee: RoleTallySchema,
  ranged: RoleTallySchema,
})

export type CounterMatrix = z.infer<typeof CounterMatrixSchema>

export const FactionDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    /** 開局單位：單位 id → 數量（SPEC §7）。 */
    startUnits: z.record(IdSchema, z.number().int().positive()),
    /** 開局建築的單位 id 清單（每項 1 座）。 */
    startBuildings: z.array(IdSchema),
    /** 可訓練的單位 id 清單。 */
    roster: z.array(IdSchema).nonempty(),
    /** 可建造的建築 id 清單（不含不可建造的 keep）。 */
    buildings: z.array(IdSchema),
    startResources: ResourceAmountSchema,
    counterMatrix: CounterMatrixSchema,
  })
  .superRefine((faction, ctx) => {
    // 開局單位必須在可訓練名單內，否則開局後無法補充。
    for (const [unitId, count] of Object.entries(faction.startUnits)) {
      if (!faction.roster.includes(unitId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['startUnits', unitId],
          message: `startUnits 的「${unitId}」不在 roster 中（數量 ${count}）`,
        })
      }
    }
  })

export type FactionDef = z.infer<typeof FactionDefSchema>

/* ------------------------------------------------------------------ */
/* 地圖                                                                */
/* ------------------------------------------------------------------ */

export const MapDefSchema = z
  .object({
    id: IdSchema,
    size: z.number().int().positive(),
    /**
     * 可通行性，長度必須為 size × size，行優先（index = y × size + x）。
     * 0 = 可走、1 = 不可走（岩石）。
     */
    tiles: z.array(z.number().int().min(0).max(1)),
    resourceNodes: z.array(TileCoordSchema),
    spawnPoints: z.array(TileCoordSchema),
  })
  .superRefine((map, ctx) => {
    const expectedLength = map.size * map.size
    if (map.tiles.length !== expectedLength) {
      ctx.addIssue({
        code: 'custom',
        path: ['tiles'],
        message: `tiles 長度 ${map.tiles.length} 必須等於 size² = ${expectedLength}`,
      })
    }

    const checkBounds = (
      coords: readonly TileCoord[],
      path: readonly (string | number)[],
    ): void => {
      coords.forEach((coord, index) => {
        if (coord.x < 0 || coord.x >= map.size || coord.y < 0 || coord.y >= map.size) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, index],
            message: `座標 (${coord.x}, ${coord.y}) 超出 [0, ${map.size}) 範圍`,
          })
        }
      })
    }

    checkBounds(map.resourceNodes, ['resourceNodes'])
    checkBounds(map.spawnPoints, ['spawnPoints'])

    if (map.spawnPoints.length !== 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['spawnPoints'],
        message: `1v1 對戰需要恰好 2 個出生點，實際 ${map.spawnPoints.length} 個`,
      })
    }
  })

export type MapDef = z.infer<typeof MapDefSchema>

/* ------------------------------------------------------------------ */
/* 對局設定                                                            */
/* ------------------------------------------------------------------ */

export const MatchDefSchema = z.object({
  /** 必須等於 shared 的 TICK_RATE_HZ（測試會交叉驗證）。 */
  tickRateHz: z.number().int().positive(),
  /** 10 分鐘 = 600s × 20Hz（SPEC §11）。 */
  maxTicks: z.number().int().positive(),
  unitCap: z.number().int().positive(),
  mineCap: z.number().int().positive(),
  barracksCap: z.number().int().positive(),
})

export type MatchDef = z.infer<typeof MatchDefSchema>

/* ------------------------------------------------------------------ */
/* Policy 滑桿                                                         */
/* ------------------------------------------------------------------ */

/** MVP 的 5 個滑桿 id（SPEC §8）。 */
export const POLICY_IDS = [
  'econMilitary',
  'unitSize',
  'unitRange',
  'aggression',
  'clusterSpread',
] as const

export const PolicyIdSchema = z.enum(POLICY_IDS)
export type PolicyId = z.infer<typeof PolicyIdSchema>

export const PolicyDefSchema = z
  .object({
    id: PolicyIdSchema,
    min: z.number(),
    max: z.number(),
    default: z.number(),
    step: z.number().positive(),
  })
  .superRefine((policy, ctx) => {
    if (policy.min >= policy.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['min'],
        message: `min (${policy.min}) 必須小於 max (${policy.max})`,
      })
    }
    if (policy.default < policy.min || policy.default > policy.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: `default (${policy.default}) 必須落在 [${policy.min}, ${policy.max}]`,
      })
    }
  })

export type PolicyDef = z.infer<typeof PolicyDefSchema>

/* ------------------------------------------------------------------ */
/* 檔案包裝（每份 JSON 的最外層）                                      */
/* ------------------------------------------------------------------ */

export const ResourceFileSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  resource: ResourceDefSchema,
})

export const UnitFileSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  unit: UnitDefSchema,
})

export const BuildingFileSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  building: BuildingDefSchema,
})

export const FactionFileSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  faction: FactionDefSchema,
})

export const MapFileSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  map: MapDefSchema,
})

export const MatchFileSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  match: MatchDefSchema,
})

export const PoliciesFileSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  policies: z.array(PolicyDefSchema),
})
