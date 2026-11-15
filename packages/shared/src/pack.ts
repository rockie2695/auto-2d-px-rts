import { z } from 'zod'

import {
  BuildingDefSchema,
  FactionDefSchema,
  MapDefSchema,
  MatchDefSchema,
  PolicyDefSchema,
  ResourceDefSchema,
  SchemaVersionSchema,
  UnitDefSchema,
} from './schema.ts'

/** SHA-256 十六進位摘要（64 位小寫 hex）。 */
export const HashHexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'hash 必須是 64 位小寫 hex')

/**
 * pack.json 的內容本體：與遊戲 `ContentPack` 同形，另帶
 * `resources`（全部資源 def，現行 3 個；`resource` 是 sim 主消費的
 * blue_crystal）與完整 tiles／resourceNodes 的 map。
 */
export const PackContentSchema = z.object({
  resource: ResourceDefSchema,
  resources: z.array(ResourceDefSchema),
  units: z.array(UnitDefSchema),
  buildings: z.array(BuildingDefSchema),
  faction: FactionDefSchema,
  map: MapDefSchema,
  match: MatchDefSchema,
  policies: z.array(PolicyDefSchema),
})

export type PackContent = z.infer<typeof PackContentSchema>

/**
 * pack.json 檔案 schema（DB → Content Pack 匯出 pipeline 的發布格式）。
 * `packHash = sha256(canonicalJson(content) + atlasHash)`（無 atlas 時 atlasHash 為空字串）。
 */
export const PackFileSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  version: z.string().min(1),
  packHash: HashHexSchema,
  atlasHash: HashHexSchema.optional(),
  content: PackContentSchema,
})

export type PackFile = z.infer<typeof PackFileSchema>

/** frames.json：sprite atlas 的框架表（sprite id → atlas 內矩形）。 */
export const PackFramesSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  atlasHash: HashHexSchema,
  /** atlas 圖片尺寸（px）。 */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frames: z.array(
    z.object({
      id: z.string().min(1),
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
    }),
  ),
})

export type PackFrames = z.infer<typeof PackFramesSchema>
