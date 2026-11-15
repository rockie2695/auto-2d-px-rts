import { Client } from 'pg'
import { runner } from 'node-pg-migrate'

import { MIGRATIONS_DIR, getDatabaseUrl, getTestDatabaseUrl } from './config.ts'

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** 測試庫名稱（URL 最後一段）。 */
export function testDbName(testUrl: string): string {
  const name = new URL(testUrl).pathname.split('/').filter(Boolean).pop()
  if (name === undefined || name === '') {
    throw new Error(`測試庫 URL 缺少資料庫名稱：${testUrl}`)
  }
  return name
}

/**
 * 重建測試庫：DROP（WITH (FORCE) 清掉殘留連線）→ CREATE → 跑 migrations。
 * 只動 `<正式庫>_test`，不碰正式庫資料。回傳測試庫連線字串。
 */
export async function createTestDatabase(): Promise<string> {
  const baseUrl = getDatabaseUrl()
  const testUrl = getTestDatabaseUrl(baseUrl)
  const testName = testDbName(testUrl)

  const admin = new Client({ connectionString: baseUrl })
  await admin.connect()
  try {
    await admin.query(
      `drop database if exists ${quoteIdent(testName)} with (force)`,
    )
    await admin.query(`create database ${quoteIdent(testName)}`)
  } finally {
    await admin.end()
  }

  await runner({
    databaseUrl: testUrl,
    migrationsTable: 'pgmigrations',
    dir: MIGRATIONS_DIR,
    direction: 'up',
    count: Infinity,
  })
  return testUrl
}
