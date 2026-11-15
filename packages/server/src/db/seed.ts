import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'

import { getDatabaseUrl } from './config.ts'
import { validateContentFile } from './fileSchemas.ts'
import { encodeTilesRle } from './rle.ts'

/** repo 根目錄（`packages/server/src/db/` 往上四層）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * seed 來源：`packages/server/seed-data` 的 17 檔 JSON
 * （自 `packages/game/public/data` 整批搬入）。
 */
export const SEED_SOURCE_DIR = resolve(REPO_ROOT, 'packages/server/seed-data')

/** 初始 draft 包版本；seed 可重複執行（重跑即重建 draft）。 */
export const PACK_VERSION = 'v0'

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

export interface SeedSummary {
  readonly packVersion: string
  readonly sha256: string
  readonly resources: number
  readonly factions: number
  readonly units: number
  readonly buildings: number
  readonly policies: number
  readonly maps: number
  readonly sprites: number
}

/**
 * 把 `sourceDir` 的 JSON 內容檔 seed 進 `databaseUrl` 指向的資料庫。
 *
 * - 逐檔以 shared 的 FileSchema 驗證（不合格即丟錯，不靜默降級）。
 * - sha256 以「排序後的原始檔內容」計算，與 seed／export 流程無關、可重現。
 * - 已 published 的同版本 pack 拒絕覆寫；draft 則整包重建（冪等）。
 * - 全程單一交易，失敗即 ROLLBACK。
 */
export async function seedDatabase(
  databaseUrl: string,
  sourceDir: string = SEED_SOURCE_DIR,
): Promise<SeedSummary> {
  const files = listJsonFiles(sourceDir).map((file) =>
    loadJsonFile(sourceDir, file),
  )
  for (const file of files) {
    validateContentFile(file.file, file.data)
  }

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

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('BEGIN')

    // 已 published 的版本不可覆寫；draft 可整包重 seed。
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

    const paletteResult = await client.query(
      'insert into palettes (pack_id, palette_id, colors) values ($1, $2, $3) returning id',
      [packId, 'default', JSON.stringify(DEFAULT_PALETTE_COLORS)],
    )
    const paletteId: string = paletteResult.rows[0]!['id'] as string

    // 佔位 sprites：從 unit/building def 的 sprite.color/size 產生，
    // 供 publish pipeline 合成 atlas（MVP render 仍程序繪製，不消費 atlas）。
    for (const file of [...units, ...buildings]) {
      const wrapper = file.data as Record<string, unknown>
      const key = file.file.startsWith('units/') ? 'unit' : 'building'
      const def = wrapper[key] as
        | { id: string; sprite?: { color: string; size: number } }
        | undefined
      if (def === undefined || def.sprite === undefined) {
        throw new Error(`內容檔缺少 ${key}.sprite：${file.file}`)
      }
      await client.query(
        'insert into sprites (pack_id, sprite_id, owner_type, owner_id, palette_id, data) values ($1, $2, $3, $4, $5, $6)',
        [
          packId,
          def.id,
          key,
          def.id,
          paletteId,
          JSON.stringify({
            source: 'placeholder',
            color: def.sprite.color,
            size: def.sprite.size,
          }),
        ],
      )
    }

    await client.query('COMMIT')

    return {
      packVersion: PACK_VERSION,
      sha256: sha256Hex,
      resources: resources.length,
      factions: factions.length,
      units: units.length,
      buildings: buildings.length,
      policies: contentRows.length - resources.length - factions.length - units.length - buildings.length,
      maps: maps.length,
      sprites: units.length + buildings.length,
    }
  } catch (cause) {
    await client.query('ROLLBACK')
    throw cause
  } finally {
    await client.end()
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  const summary = await seedDatabase(getDatabaseUrl())
  console.log(
    `seed 完成：pack ${summary.packVersion}（draft, sha256=${summary.sha256.slice(0, 12)}…）` +
      ` resources=${summary.resources} factions=${summary.factions}` +
      ` units=${summary.units} buildings=${summary.buildings}` +
      ` policies=${summary.policies} maps=${summary.maps} sprites=${summary.sprites}`,
  )
}
