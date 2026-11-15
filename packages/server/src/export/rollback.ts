import { Client } from 'pg'

import { getDatabaseUrl } from '../db/config.ts'

export interface RollbackResult {
  readonly packId: string
  readonly version: string
  readonly status: string
}

/**
 * rollback：把某個 **published** pack 標記為 active
 * （active_pack singleton 指標切換；draft 不可設為 active）。
 * 讀取端（遊戲 loader／dev-pack 腳本）以 active pack 為「latest」的來源。
 */
export async function setActivePack(
  databaseUrl: string,
  packVersion: string,
): Promise<RollbackResult> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    const pack = await client.query(
      'select id, status from content_packs where version = $1',
      [packVersion],
    )
    if (pack.rows.length !== 1) {
      throw new Error(`rollback 失敗：找不到 content pack ${packVersion}`)
    }
    const packId: string = pack.rows[0]!['id'] as string
    const status: string = pack.rows[0]!['status'] as string
    if (status !== 'published') {
      throw new Error(
        `rollback 失敗：pack ${packVersion} 狀態為 ${status}（僅 published 可設為 active）`,
      )
    }
    await client.query(
      'insert into active_pack (id, pack_id, updated_at) values (1, $1, now()) ' +
        'on conflict (id) do update set pack_id = excluded.pack_id, updated_at = now()',
      [packId],
    )
    await client.query('COMMIT')
    return { packId, version: packVersion, status }
  } catch (cause) {
    await client.query('ROLLBACK')
    throw cause
  } finally {
    await client.end()
  }
}

/**
 * 開發用：把已 published 的 pack 退回 draft（並清掉指向它的 active 指標）。
 * 讓 `pnpm pack:dev`（seed → publish）可在同一版本上反覆迭代；
 * 正式流程不應使用（published 唯讀是資料完整性守衛）。
 */
export async function resetPackToDraft(
  databaseUrl: string,
  packVersion: string,
): Promise<{ reset: boolean }> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    const pack = await client.query('select id from content_packs where version = $1', [
      packVersion,
    ])
    if (pack.rows.length !== 1) {
      await client.query('ROLLBACK')
      return { reset: false }
    }
    const packId: string = pack.rows[0]!['id'] as string
    await client.query('delete from active_pack where pack_id = $1', [packId])
    await client.query("update content_packs set status = 'draft' where id = $1", [packId])
    await client.query('COMMIT')
    return { reset: true }
  } catch (cause) {
    await client.query('ROLLBACK')
    throw cause
  } finally {
    await client.end()
  }
}

/** 讀取目前 active pack（無指標時為 null）。 */
export async function getActivePack(
  databaseUrl: string,
): Promise<{ packId: string; version: string } | null> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const result = await client.query(
      'select p.id, p.version from active_pack a join content_packs p on p.id = a.pack_id where a.id = 1',
    )
    if (result.rows.length === 0) return null
    return {
      packId: result.rows[0]!['id'] as string,
      version: result.rows[0]!['version'] as string,
    }
  } finally {
    await client.end()
  }
}

const isDirectRun =
  process.argv[1] !== undefined && process.argv[1].endsWith('rollback.ts')

if (isDirectRun) {
  const version = process.argv[2]
  if (version === undefined || version === '') {
    console.error('用法：node rollback.ts <version>')
    process.exit(1)
  }
  const result = await setActivePack(getDatabaseUrl(), version)
  console.log(`rollback 完成：active pack = ${result.version}（${result.status}）`)
}
