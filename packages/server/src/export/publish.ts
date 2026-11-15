import { PackContentSchema, PackFileSchema } from '@auto-2d-px-rts/shared'
import { Client } from 'pg'

import { buildPackContent } from './packBuilder.ts'
import { computePackHash } from './hash.ts'
import { buildAtlas, readPackSprites } from './atlas.ts'
import { DEFAULT_PACKS_DIR, LocalDiskStorage } from './storage.ts'
import type { Storage } from './storage.ts'
import { getDatabaseUrl } from '../db/config.ts'

export interface PublishResult {
  readonly packId: string
  readonly version: string
  readonly packHash: string
  readonly atlasHash: string
  /** pack.json 的 URL（LocalDiskStorage 為 `/packs/v{version}/pack.json`）。 */
  readonly packUrl: string
}

/**
 * publish job：DB → Content Pack 三件套 → storage → 更新 DB 狀態。
 *
 * 1. 從 DB 讀取該 pack 的所有表（buildPackContent）＋ sprites；
 * 2. 組成 content（PackContentSchema 驗證）；
 * 3. sprite 合成 atlas（sharp）；
 * 4. `packHash = sha256(canonicalJson(content) + atlasHash)`；
 * 5. 上傳（storage.putPack：v{version}/ 與 latest/ 鏡像）；
 * 6. 更新 content_packs：status='published'、sha256=packHash（version 不變）；
 *    並把 active_pack 指標切到本 pack；
 * 7. 回傳 pack URL。
 *
 * content_packs.sha256 語意：seed 時是「來源檔 hash」，publish 後改寫為
 * packHash（見 docs/DB_MAPPING.md）。
 */
export async function publishPack(
  databaseUrl: string,
  packVersion: string,
  storage: Storage = new LocalDiskStorage(DEFAULT_PACKS_DIR),
): Promise<PublishResult> {
  // 1+2. DB → content（builder 內含 PackContentSchema 驗證）。
  // publish 內容一律以 zod parse 後的 canonical 形態為準（預設值補齊），
  // hash 與檔案內容完全同源 —— 載入端 parse 後重算必得同一 hash。
  const { packId, content: rawContent } = await buildPackContent(databaseUrl, packVersion)
  const content = PackContentSchema.parse(rawContent)

  // 3. atlas。
  const sprites = await readPackSprites(databaseUrl, packId)
  const { png, frames } = await buildAtlas(sprites)
  const atlasHash = frames.atlasHash

  // 4. hash ＋ 發布前最後驗證。
  const packHash = computePackHash(content, atlasHash)
  const packFile = { schemaVersion: 1, version: packVersion, packHash, atlasHash, content }
  PackFileSchema.parse(packFile)

  // 5. 上傳。
  const packUrl = await storage.putPack(packVersion, {
    packJson: `${JSON.stringify(packFile, null, 2)}\n`,
    framesJson: `${JSON.stringify(frames, null, 2)}\n`,
    atlasPng: png,
  })

  // 6. 更新 DB：published ＋ active 指標。
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      "update content_packs set status = 'published', sha256 = $2 where id = $1",
      [packId, packHash],
    )
    await client.query(
      'insert into active_pack (id, pack_id, updated_at) values (1, $1, now()) ' +
        'on conflict (id) do update set pack_id = excluded.pack_id, updated_at = now()',
      [packId],
    )
    await client.query('COMMIT')
  } catch (cause) {
    await client.query('ROLLBACK')
    throw cause
  } finally {
    await client.end()
  }

  // 7.
  return { packId, version: packVersion, packHash, atlasHash, packUrl }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('publish.ts')

if (isDirectRun) {
  const version = process.argv[2] ?? 'v0'
  const result = await publishPack(getDatabaseUrl(), version)
  console.log(
    `publish 完成：pack ${result.version}（packHash=${result.packHash.slice(0, 12)}…，` +
      `atlasHash=${result.atlasHash.slice(0, 12)}…）→ ${result.packUrl}`,
  )
}
