import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase } from './testDb.ts'
import { exportPack } from './export.ts'
import { seedDatabase, SEED_SOURCE_DIR } from './seed.ts'

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

/** resourceNodes 在 DB 正規化後按 x,y 重排，屬已知差異 —— 比對前先排序。 */
function nodeKey(node: unknown): string {
  const n = node as { x?: unknown; y?: unknown }
  return `${String(n.x)},${String(n.y)}`
}

function normalize(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(normalize)
  if (data !== null && typeof data === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
      const normalized = normalize(value)
      out[key] =
        key === 'resourceNodes' && Array.isArray(normalized)
          ? [...normalized].sort((a, b) => nodeKey(a).localeCompare(nodeKey(b)))
          : normalized
    }
    return out
  }
  return data
}

let testUrl: string

beforeAll(async () => {
  testUrl = await createTestDatabase()
}, 120_000)

describe('seed → DB → export 深比對', () => {
  it(
    '匯出檔清單與 seed 來源完全一致',
    async () => {
      const summary = await seedDatabase(testUrl)
      expect(summary.units).toBe(4)
      expect(summary.buildings).toBe(6)
      expect(summary.resources).toBe(3)
      expect(summary.factions).toBe(1)
      expect(summary.maps).toBe(1)
      expect(summary.policies).toBe(2)

      const files = await exportPack(testUrl, 'v0')
      const exported = files.map((file) => file.file).sort()
      const source = listJsonFiles(SEED_SOURCE_DIR)
      expect(exported).toEqual(source)
    },
    120_000,
  )

  it(
    '每個重建檔與原始 JSON 語意一致（tiles 逐格、resourceNodes 正規化排序）',
    async () => {
      const files = await exportPack(testUrl, 'v0')
      for (const file of files) {
        const source = JSON.parse(readFileSync(join(SEED_SOURCE_DIR, file.file), 'utf8')) as unknown
        expect(normalize(file.data), `檔案不一致：${file.file}`).toEqual(normalize(source))
      }
    },
    120_000,
  )

  it(
    '重複 seed 冪等：draft 整包重建、不殘留舊列',
    async () => {
      await seedDatabase(testUrl)
      await seedDatabase(testUrl)
      const files = await exportPack(testUrl, 'v0')
      expect(files.map((file) => file.file).sort()).toEqual(
        listJsonFiles(SEED_SOURCE_DIR),
      )
    },
    120_000,
  )
})
