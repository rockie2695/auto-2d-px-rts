import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `packages/server/src/db/` → repo 根目錄（往上四層）。 */
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)

/**
 * 極簡 `.env` 解析（只處理 `KEY=VALUE` 與成對引號，足夠讀 root `.env`）。
 *
 * `pnpm db:*` 腳本已用 `node --env-file=../../.env` 注入環境變數；
 * 這個 fallback 是給 vitest（不經 package script 啟動）用的。
 */
function parseEnvFile(path: string): Record<string, string> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    const key: string = match[1]!
    let value: string = match[2]!.trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** 讀 root `.env` 的 `DATABASE_URL`（Neon pooler 連線字串）。 */
export function getDatabaseUrl(): string {
  const fromEnv = process.env['DATABASE_URL']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const fromFile = parseEnvFile(join(REPO_ROOT, '.env'))['DATABASE_URL']
  if (fromFile !== undefined && fromFile !== '') return fromFile
  throw new Error('缺少 DATABASE_URL：請在 repo 根目錄 .env 設定')
}

/**
 * 由正式庫 URL 推導測試庫 URL：把最後一段資料庫名稱換成 `<name>_test`。
 * 例如 `.../neondb?sslmode=...` → `.../neondb_test?sslmode=...`。
 * 查詢參數（sslmode 等）原封不動保留。
 */
export function getTestDatabaseUrl(baseUrl: string = getDatabaseUrl()): string {
  const url = new URL(baseUrl)
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const dbName = segments[segments.length - 1]
  if (dbName === undefined || dbName === '') {
    throw new Error(`DATABASE_URL 缺少資料庫名稱：${baseUrl}`)
  }
  segments[segments.length - 1] = `${dbName}_test`
  url.pathname = `/${segments.join('/')}`
  return url.toString()
}
