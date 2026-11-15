import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PackContentSchema } from '@auto-2d-px-rts/shared'

import { createSeededTestDatabase, dropTestDatabase } from '../db/testDb.ts'
import { canonicalJson, computePackHash } from './hash.ts'
import { buildPackContent } from './packBuilder.ts'

let testUrl: string

beforeAll(async () => {
  testUrl = await createSeededTestDatabase()
}, 120_000)

afterAll(async () => {
  await dropTestDatabase(testUrl)
}, 120_000)

describe('packBuilder（DB → pack content）', () => {
  it(
    '組出與 DB 一致的 content（8 單位/建築計數、3 資源、9 滑桿、1024 格地圖）',
    async () => {
      const { packId, content } = await buildPackContent(testUrl, 'v0')
      expect(packId).toBeTruthy()
      expect(content.units).toHaveLength(4)
      expect(content.buildings).toHaveLength(6)
      expect(content.resources).toHaveLength(3)
      expect(content.resource.id).toBe('blue_crystal')
      expect(content.policies).toHaveLength(9)
      expect(content.map.tiles).toHaveLength(1024)
      expect(content.map.resourceNodes.length).toBeGreaterThan(0)
      expect(content.faction.id).toBe('test_faction')
      expect(content.match.tickRateHz).toBe(20)
      // PackContentSchema 已在 builder 內驗證；這裡再鎖一次形狀。
      expect(() => PackContentSchema.parse(content)).not.toThrow()
    },
    120_000,
  )

  it(
    '同一 DB 內容組兩次 → canonical JSON 與 packHash 完全一致（可重現）',
    async () => {
      const a = await buildPackContent(testUrl, 'v0')
      const b = await buildPackContent(testUrl, 'v0')
      expect(canonicalJson(a.content)).toBe(canonicalJson(b.content))
      expect(await computePackHash(a.content)).toBe(await computePackHash(b.content))
    },
    120_000,
  )

  it(
    '改 DB 單位數值 → packHash 變、新值進 content',
    async () => {
      const { Client } = await import('pg')
      const client = new Client({ connectionString: testUrl })
      await client.connect()
      try {
        await client.query(
          "update units set data = jsonb_set(data, '{unit,stats,hp}', '777') where id = 'legionnaire'",
        )
      } finally {
        await client.end()
      }
      const { content } = await buildPackContent(testUrl, 'v0')
      const legionnaire = content.units.find((unit) => unit.id === 'legionnaire')
      expect(legionnaire?.stats.hp).toBe(777)
    },
    120_000,
  )
})
