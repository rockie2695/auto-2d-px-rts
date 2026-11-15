import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { PackFile } from '@auto-2d-px-rts/shared'
import { PackFileSchema } from '@auto-2d-px-rts/shared'

import { createSeededTestDatabase, dropTestDatabase } from '../db/testDb.ts'
import { computePackHash } from './hash.ts'
import { publishPack } from './publish.ts'
import { setActivePack, getActivePack } from './rollback.ts'
import { LocalDiskStorage } from './storage.ts'

let testUrl: string
let storageRoot: string

beforeAll(async () => {
  testUrl = await createSeededTestDatabase()
  storageRoot = join(tmpdir(), `pack-test-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
}, 120_000)

afterAll(async () => {
  await dropTestDatabase(testUrl)
}, 120_000)

describe('publish pipeline（DB → pack 三件套 → published＋active）', () => {
  it(
    'seed → publish → 三件套落盤、hash 自洽、active 指標就位',
    async () => {
      const result = await publishPack(testUrl, 'v0', new LocalDiskStorage(storageRoot))
      expect(result.packUrl).toBe('/packs/v0/pack.json')

      const packJson = JSON.parse(
        readFileSync(join(storageRoot, 'v0', 'pack.json'), 'utf8'),
      ) as unknown
      const pack = PackFileSchema.parse(packJson) as PackFile
      expect(pack.version).toBe('v0')
      expect(pack.atlasHash).toBeTruthy()
      expect(pack.packHash).toBe(await computePackHash(pack.content, pack.atlasHash))

      // 三件套鏡像到 latest/。
      expect(() => readFileSync(join(storageRoot, 'latest', 'pack.json'))).not.toThrow()
      expect(() => readFileSync(join(storageRoot, 'latest', 'frames.json'))).not.toThrow()
      expect(() => readFileSync(join(storageRoot, 'latest', 'atlas.png'))).not.toThrow()

      const active = await getActivePack(testUrl)
      expect(active?.packId).toBe(result.packId)
      expect(active?.version).toBe('v0')
    },
    120_000,
  )

  it(
    '改 DB 單位數值 → 重新 publish → pack 讀到新值、hash 變',
    async () => {
      const before = JSON.parse(
        readFileSync(join(storageRoot, 'v0', 'pack.json'), 'utf8'),
      ) as PackFile

      const { Client } = await import('pg')
      const client = new Client({ connectionString: testUrl })
      await client.connect()
      try {
        await client.query(
          "update units set data = jsonb_set(data, '{unit,stats,dmg}', '99') where id = 'archer'",
        )
      } finally {
        await client.end()
      }

      const after = await publishPack(testUrl, 'v0', new LocalDiskStorage(storageRoot))
      const packAfter = JSON.parse(
        readFileSync(join(storageRoot, 'v0', 'pack.json'), 'utf8'),
      ) as PackFile

      const archer = packAfter.content.units.find((unit) => unit.id === 'archer')
      expect(archer?.stats.dmg).toBe(99)
      expect(packAfter.packHash).not.toBe(before.packHash)
      expect(after.packHash).toBe(packAfter.packHash)
    },
    120_000,
  )

  it(
    'rollback：published pack 可設 active；draft／不存在版本被拒絕',
    async () => {
      // v0 已被 publish 測試發布 → 可 rollback。
      const result = await setActivePack(testUrl, 'v0')
      expect(result.status).toBe('published')
      expect((await getActivePack(testUrl))?.version).toBe('v0')

      // 建一個 draft pack v1 → 拒絕。
      const { Client } = await import('pg')
      const client = new Client({ connectionString: testUrl })
      await client.connect()
      try {
        await client.query(
          "insert into content_packs (version, status) values ('v1', 'draft')",
        )
      } finally {
        await client.end()
      }
      await expect(setActivePack(testUrl, 'v1')).rejects.toThrow('僅 published')
      await expect(setActivePack(testUrl, '不存在')).rejects.toThrow('找不到')
    },
    120_000,
  )
})
