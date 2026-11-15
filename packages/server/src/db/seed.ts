import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'

import {
  BuildingFileSchema,
  FactionFileSchema,
  MapFileSchema,
  MatchFileSchema,
  PoliciesFileSchema,
  ResourceFileSchema,
  UnitFileSchema,
} from '@auto-2d-px-rts/shared'
import { getDatabaseUrl } from './config.ts'
import { encodeTilesRle } from './rle.ts'

/** repo 根目錄（`packages/server/src/db/` 往上四層）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * seed 來源：現階段仍是 `packages/game/public/data` 的 17 檔 JSON。
 * Phase E 會整批搬到 `packages/server/seed-data`。
 */
const SEED_SOURCE_DIR = resolve(REPO_ROOT, 'packages/game/public/data')

/** 初始 draft 包版本；seed 可重複執行（重跑即重建 draft）。 */
const PACK_VERSION = 'v0'

/** MVP 佔位 palette：借 game 既有的裝甲階層色（render/armor.ts）。 */
const DEFAULT_PALETTE_COLORS = {
  armorTier: {
    light: '#4aff9e',
    medium: '#4a9eff',
    heavy: '#b44aff',
    ultra: '#ffd24a',
  },
}

interface JsonFile {
  readonly file: string
  readonly data: unknown
  readonly raw: string
}

function listJsonFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.json')) {
        out.push(relative(dir, full).replaceAll('\\', '/'))
      }
    }
  }
  walk(dir)
  return out.sort()
}

function loadJsonFile(dir: string, file: string): JsonFile {
  const raw = readFileSync(join(dir, file), 'utf8')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`JSON 解析失敗：${file}`, { cause })
  }
  return { file, data, raw }
}

/** 依目錄結構挑出對應的 FileSchema 逐檔驗證（不合格即丟錯，不靜默降級）。 */
function validateFile(file: JsonFile): void {
  // 結構型別即可，避免 server 直接依賴 zod（zod 是 shared 的依賴）。
  const schema: { parse(data: unknown): unknown } = (() => {
    if (file.file === 'match.json') return MatchFileSchema
    if (file.file === 'policies.json') return PoliciesFileSchema
    const folder = file.file.split('/')[0]
    switch (folder) {
      case 'resources':
        return ResourceFileSchema
      case 'factions':
        return FactionFileSchema
      case 'units':
        return UnitFileSchema
      case 'buildings':
        return BuildingFileSchema
      case 'maps':
        return MapFileSchema
      default:
        throw new Error(`無法分類的內容檔：${file.file}`)
    }
  })()
  try {
    schema.parse(file.data)
  } catch (cause) {
    throw new Error(`內容檔驗證失敗：${file.file}`, { cause })
  }
}

/** 內容表共用的列（id 取自包裝物件內的 def id）。 */
interface ContentRow {
  readonly table: string
  readonly id: string
  readonly data: unknown
}

/** 從包裝檔抽內層 def（如 `data.unit`）作為一列。 */
function toContentRows(
  table: string,
  key: string,
  files: readonly JsonFile[],
): ContentRow[] {
  return files.map((file) => {
    const wrapper = file.data as Record<string, unknown>
    const def = wrapper[key] as { id?: unknown } | undefined
    const id = def?.id
    if (typeof id !== 'string' || id === '') {
      throw new Error(`內容檔缺少 ${key}.id：${file.file}`)
    }
    return { table, id, data: file.data }
  })
}

async function insertContentRows(
  client: Client,
  packId: string,
  rows: readonly ContentRow[],
): Promise<void> {
  for (const row of rows) {
    await client.query(
      `insert into ${row.table} (pack_id, id, data) values ($1, $2, $3)`,
      [packId, row.id, JSON.stringify(row.data)],
    )
  }
}

async function main(): Promise<void> {
  const files = listJsonFiles(SEED_SOURCE_DIR).map((file) =>
    loadJsonFile(SEED_SOURCE_DIR, file),
  )
  for (const file of files) {
    validateFile(file)
  }
  console.log(`已讀取並驗證 ${files.length} 個內容檔`)

  // sha256 以「排序後的原始檔內容」計算，與 seed／export 流程無關、可重現。
  const sha256 = createHash('sha256')
  for (const file of files) {
    sha256.update(`${file.file}\n`)
    sha256.update(file.raw)
    sha256.update('\n')
  }
  const sha256Hex = sha256.digest('hex')

  const byFolder = (prefix: string): JsonFile[] =>
    files.filter((file) => file.file.startsWith(`${prefix}/`))
  const resources = byFolder('resources')
  const factions = byFolder('factions')
  const units = byFolder('units')
  const buildings = byFolder('buildings')
  const maps = byFolder('maps')
  const match = files.filter((file) => file.file === 'match.json')
  const policies = files.filter((file) => file.file === 'policies.json')
  if (match.length !== 1 || policies.length !== 1) {
    throw new Error('seed 來源必須恰有一份 match.json 與一份 policies.json')
  }

  const contentRows: ContentRow[] = [
    ...toContentRows('resources', 'resource', resources),
    ...toContentRows('factions', 'faction', factions),
    ...toContentRows('units', 'unit', units),
    ...toContentRows('buildings', 'building', buildings),
    // policies 表收納 pack 層級 config：policies.json（id='policies'）與
    // match.json（id='match'），data 存整份檔 JSON 供 export 直接重組。
    { table: 'policies', id: 'policies', data: policies[0]!.data },
    { table: 'policies', id: 'match', data: match[0]!.data },
  ]

  const client = new Client({ connectionString: getDatabaseUrl() })
  await client.connect()
  try {
    await client.query('BEGIN')

    // 已 published 的 v0 不可覆寫；draft 可整包重 seed。
    const existing = await client.query(
      'select status from content_packs where version = $1',
      [PACK_VERSION],
    )
    const existingStatus: unknown = existing.rows[0]?.['status']
    if (existingStatus === 'published') {
      throw new Error(`content pack ${PACK_VERSION} 已 published，seed 拒絕覆寫`)
    }
    await client.query('delete from content_packs where version = $1', [
      PACK_VERSION,
    ])

    const packResult = await client.query(
      "insert into content_packs (version, status, sha256) values ($1, 'draft', $2) returning id",
      [PACK_VERSION, sha256Hex],
    )
    const packId: string = packResult.rows[0]!['id'] as string

    await insertContentRows(client, packId, contentRows)

    for (const mapFile of maps) {
      const wrapper = mapFile.data as {
        schemaVersion: number
        map: {
          id: string
          tiles: number[]
          resourceNodes: Array<{
            x: number
            y: number
            amount: number
            resourceType: string
          }>
        }
      }
      // maps.data 存「去除 tiles / resourceNodes」的整份檔 JSON。
      const { tiles, resourceNodes, ...mapRest } = wrapper.map
      const mapData = { schemaVersion: wrapper.schemaVersion, map: mapRest }

      const mapResult = await client.query(
        'insert into maps (pack_id, map_id, data) values ($1, $2, $3) returning id',
        [packId, wrapper.map.id, JSON.stringify(mapData)],
      )
      const mapId: string = mapResult.rows[0]!['id'] as string

      await client.query(
        'insert into map_tiles (map_id, layer, rle_data) values ($1, $2, $3)',
        [mapId, 'terrain', encodeTilesRle(tiles)],
      )
      for (const node of resourceNodes) {
        await client.query(
          'insert into map_resources (map_id, x, y, resource_id, amount) values ($1, $2, $3, $4, $5)',
          [mapId, node.x, node.y, node.resourceType, node.amount],
        )
      }
    }

    await client.query(
      'insert into palettes (pack_id, palette_id, colors) values ($1, $2, $3)',
      [packId, 'default', JSON.stringify(DEFAULT_PALETTE_COLORS)],
    )

    await client.query('COMMIT')
    console.log(
      `seed 完成：pack ${PACK_VERSION}（draft, sha256=${sha256Hex.slice(0, 12)}…）` +
        ` resources=${resources.length} factions=${factions.length}` +
        ` units=${units.length} buildings=${buildings.length}` +
        ` policies=2 maps=${maps.length} palettes=1`,
    )
  } catch (cause) {
    await client.query('ROLLBACK')
    throw cause
  } finally {
    await client.end()
  }
}

await main()
