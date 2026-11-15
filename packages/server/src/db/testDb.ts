import { Client } from 'pg'
import { runner } from 'node-pg-migrate'

import { MIGRATIONS_DIR, getDatabaseUrl, getTestDatabaseUrl } from './config.ts'
import { seedDatabase } from './seed.ts'

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** 資料庫名稱（URL 最後一段）。 */
export function testDbName(databaseUrl: string): string {
  const name = new URL(databaseUrl).pathname.split('/').filter(Boolean).pop()
  if (name === undefined || name === '') {
    throw new Error(`資料庫 URL 缺少名稱：${databaseUrl}`)
  }
  return name
}

/** 以 admin 連線對某個資料庫名稱執行 DROP（WITH (FORCE) 清殘留連線）。 */
async function dropDatabaseIfExists(
  adminUrl: string,
  dbName: string,
): Promise<void> {
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    await admin.query(`drop database if exists ${quoteIdent(dbName)} with (force)`)
  } finally {
    await admin.end()
  }
}

/**
 * 重建固定名測試庫 `<正式庫>_test`：DROP（FORCE）→ CREATE → migrations。
 * 只動測試庫，不碰正式庫資料。回傳測試庫連線字串。
 */
export async function createTestDatabase(): Promise<string> {
  const baseUrl = getDatabaseUrl()
  const testUrl = getTestDatabaseUrl(baseUrl)
  await dropDatabaseIfExists(baseUrl, testDbName(testUrl))
  const admin = new Client({ connectionString: baseUrl })
  await admin.connect()
  try {
    await admin.query(`create database ${quoteIdent(testDbName(testUrl))}`)
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

/**
 * 建立並 seed 一個「本測試檔專屬」的測試庫：
 * 名稱唯一（`neondb_test_<pid>_<亂數>`），平行 worker／測試檔互不打架
 * （每個檔的 beforeAll 各自建庫、afterAll 各自 DROP）。
 */
export async function createSeededTestDatabase(): Promise<string> {
  const baseUrl = getDatabaseUrl()
  const dbName =
    `neondb_test_${process.pid.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const testUrl = getTestDatabaseUrl(baseUrl, dbName)

  const admin = new Client({ connectionString: baseUrl })
  await admin.connect()
  try {
    await admin.query(`create database ${quoteIdent(dbName)}`)
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
  await seedDatabase(testUrl)
  return testUrl
}

/** DROP 某測試庫（測試檔 afterAll 清理用；連線會被 FORCE 清掉）。 */
export async function dropTestDatabase(testUrl: string): Promise<void> {
  await dropDatabaseIfExists(getDatabaseUrl(), testDbName(testUrl))
}
