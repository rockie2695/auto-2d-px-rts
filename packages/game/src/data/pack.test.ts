import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { computePackHash } from '@auto-2d-px-rts/shared'

import { loadContentPackFromDir } from './loadFromDir.ts'
import { PackHashMismatchError, loadPack, loadPackWithFallback } from './pack.ts'

/** 真內容（data-db）組出 pack.json 的 content 形狀。 */
const DATA_DIR = fileURLToPath(new URL('../../public/data-db/', import.meta.url))

function packContentShape(): Record<string, unknown> {
  const content = loadContentPackFromDir(DATA_DIR)
  return {
    resource: content.resource,
    resources: [content.resource],
    units: content.units,
    buildings: content.buildings,
    faction: content.faction,
    map: content.map,
    match: content.match,
    policies: content.policies,
  }
}

/** stub fetch：成功回傳 body／指定 HTTP 失敗。 */
function stubFetch(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status, json: async () => body })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadPack（pack.json 載入＋hash 驗證）', () => {
  it(
    'hash 正確 → 載入成功，version／packHash／content 帶出',
    async () => {
      const content = packContentShape()
      const packHash = await computePackHash(content)
      stubFetch({ schemaVersion: 1, version: 'v0', packHash, content })

      const loaded = await loadPack('/packs/latest')
      expect(loaded.version).toBe('v0')
      expect(loaded.packHash).toBe(packHash)
      expect(loaded.source).toBe('pack')
      expect(loaded.pack.units).toHaveLength(4)
      expect(loaded.pack.buildings).toHaveLength(6)
      expect(loaded.pack.map.tiles).toHaveLength(1024)
    },
    30_000,
  )

  it(
    'hash 不符 → 丟 PackHashMismatchError（拒絕載入）',
    async () => {
      stubFetch({
        schemaVersion: 1,
        version: 'v0',
        packHash: '0'.repeat(64),
        content: packContentShape(),
      })
      await expect(loadPack('/packs/latest')).rejects.toBeInstanceOf(PackHashMismatchError)
    },
    30_000,
  )

  it(
    'pack 不存在（HTTP 404）→ 丟載入錯誤',
    async () => {
      stubFetch({}, false, 404)
      await expect(loadPack('/packs/latest')).rejects.toThrow('pack 載入失敗')
    },
    30_000,
  )

  it(
    'schema 不合法 → Zod 丟錯（不靜默降級）',
    async () => {
      stubFetch({ schemaVersion: 1, version: 'v0' })
      await expect(loadPack('/packs/latest')).rejects.toThrow()
    },
    30_000,
  )
})

describe('loadPackWithFallback（pack 優先、回退 data-db）', () => {
  it(
    'pack 不可用 → 回退 data-db（version／packHash 留空）',
    async () => {
      // /packs/latest 一律 404（未 publish）；data-db 路徑改讀實體檔（模擬 Vite 靜態服務）。
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('/packs/latest')) return { ok: false, status: 404, json: async () => ({}) }
          const rel = url.slice(url.indexOf('data-db') + 'data-db'.length + 1)
          const text = readFileSync(join(DATA_DIR, rel), 'utf8')
          return { ok: true, status: 200, json: async () => JSON.parse(text) as unknown }
        }),
      )
      const loaded = await loadPackWithFallback(DATA_DIR)
      expect(loaded.source).toBe('data-db-fallback')
      expect(loaded.version).toBe('')
      expect(loaded.packHash).toBe('')
      expect(loaded.pack.units.length).toBeGreaterThan(0)
    },
    30_000,
  )

  it(
    'pack hash 不符 → 不回退，直接上拋（竄改防護）',
    async () => {
      stubFetch({
        schemaVersion: 1,
        version: 'v0',
        packHash: 'f'.repeat(64),
        content: packContentShape(),
      })
      await expect(loadPackWithFallback(DATA_DIR)).rejects.toBeInstanceOf(PackHashMismatchError)
    },
    30_000,
  )
})
