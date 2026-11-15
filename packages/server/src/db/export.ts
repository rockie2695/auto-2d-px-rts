import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'

import { getDatabaseUrl } from './config.ts'
import { validateContentFile } from './fileSchemas.ts'
import { decodeTilesRle } from './rle.ts'

/** repo 根目錄（`packages/server/src/db/` 往上四層）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** 匯出目錄：Vite public 直服，遊戲 loader 優先讀這裡。 */
export const EXPORT_DIR = resolve(REPO_ROOT, 'packages/game/public/data-db')

export interface ExportedFile {
  readonly file: string
  readonly data: unknown
}

/** 內容表 → 檔案目錄的對應（policies 表另收 match.json，見 seed.ts）。 */
const CONTENT_TABLES: ReadonlyArray<{
  readonly table: string
  readonly folder: string
}> = [
  { table: 'resources', folder: 'resources' },
  { table: 'factions', folder: 'factions' },
  { table: 'units', folder: 'units' },
  { table: 'buildings', folder: 'buildings' },
]

/**
 * 從 DB 重組出整包內容檔（不做 I/O，寫檔由 CLI／測試負責）。
 *
 * - data jsonb 存的就是整份檔 JSON，直接回存即可；
 * - maps.data 補回 tiles（map_tiles RLE 解碼）與 resourceNodes
 *   （map_resources，按 x,y 排序 —— 與原始檔順序可能不同，屬已知正規化差異）；
 * - 每個重建檔都以 shared 的 FileSchema 驗證，失敗即丟錯。
 */
export async function exportPack(
  databaseUrl: string,
  packVersion: string,
): Promise<ExportedFile[]> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const pack = await client.query(
      'select id from content_packs where version = $1',
      [packVersion],
    )
    if (pack.rows.length !== 1) {
      throw new Error(`找不到 content pack：${packVersion}`)
    }
    const packId: string = pack.rows[0]!['id'] as string

    const files: ExportedFile[] = []
    for (const { table, folder } of CONTENT_TABLES) {
      const rows = await client.query(
        `select id, data from ${table} where pack_id = $1 order by id`,
        [packId],
      )
      for (const row of rows.rows) {
        files.push({
          file: `${folder}/${row['id'] as string}.json`,
          data: row['data'],
        })
      }
    }

    // pack 層級 config（policies.json / match.json）。
    const configRows = await client.query(
      "select id, data from policies where pack_id = $1 and id in ('policies', 'match') order by id",
      [packId],
    )
    for (const row of configRows.rows) {
      files.push({ file: `${row['id'] as string}.json`, data: row['data'] })
    }

    // 地圖：data + tiles(RLE 解碼) + resourceNodes(map_resources)。
    const mapRows = await client.query(
      'select id, map_id, data from maps where pack_id = $1 order by map_id',
      [packId],
    )
    for (const mapRow of mapRows.rows) {
      const data = mapRow['data'] as {
        schemaVersion: number
        map: { id: string; size: number; spawnPoints: unknown[] }
      }
      const mapId: string = mapRow['id'] as string
      const tilesResult = await client.query(
        "select rle_data from map_tiles where map_id = $1 and layer = 'terrain'",
        [mapId],
      )
      if (tilesResult.rows.length !== 1) {
        throw new Error(`地圖 ${data.map.id} 缺少 terrain 層 tiles`)
      }
      const rleData: Uint8Array = tilesResult.rows[0]!['rle_data'] as Uint8Array
      const tiles = decodeTilesRle(rleData)

      const resourceRows = await client.query(
        'select x, y, resource_id, amount from map_resources where map_id = $1 order by x, y',
        [mapId],
      )
      const resourceNodes = resourceRows.rows.map((row) => ({
        x: row['x'] as number,
        y: row['y'] as number,
        amount: row['amount'] as number,
        resourceType: row['resource_id'] as string,
      }))

      files.push({
        file: `maps/${mapRow['map_id'] as string}.json`,
        data: { schemaVersion: data.schemaVersion, map: { ...data.map, tiles, resourceNodes } },
      })
    }

    for (const file of files) {
      validateContentFile(file.file, file.data)
    }
    return files
  } finally {
    await client.end()
  }
}

function toJsonText(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

/** 把重組結果寫到 `outDir`（與 seed 來源相同的目錄結構）。 */
export async function exportPackToDir(
  databaseUrl: string,
  packVersion: string,
  outDir: string,
): Promise<string[]> {
  const files = await exportPack(databaseUrl, packVersion)
  for (const file of files) {
    const target = resolve(outDir, file.file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, toJsonText(file.data))
  }
  return files.map((file) => file.file)
}

const isDirectRun =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  const written = await exportPackToDir(getDatabaseUrl(), 'v0', EXPORT_DIR)
  console.log(`export 完成：${written.length} 檔 → ${EXPORT_DIR}`)
}
