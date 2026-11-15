import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSeededTestDatabase, dropTestDatabase } from '../db/testDb.ts'
import { buildAtlas, readPackSprites } from './atlas.ts'

let testUrl: string

beforeAll(async () => {
  testUrl = await createSeededTestDatabase()
}, 120_000)

afterAll(async () => {
  await dropTestDatabase(testUrl)
}, 120_000)

describe('sprite atlas（sharp 合成）', () => {
  it(
    'seed 產生 10 個佔位 sprite（4 單位＋6 建築），讀回帶 color/size',
    async () => {
      const sprites = await readPackSprites(testUrl, await packIdOf(testUrl))
      expect(sprites).toHaveLength(10)
      for (const sprite of sprites) {
        expect(sprite.color).toMatch(/^#[0-9a-fA-F]{6}$/)
        expect(sprite.size).toBeGreaterThan(0)
      }
    },
    120_000,
  )

  it(
    'atlas 合成：frames 在邊界內、PNG 尺寸正確、hash 穩定',
    async () => {
      const sprites = await readPackSprites(testUrl, await packIdOf(testUrl))
      const { png, frames } = await buildAtlas(sprites)
      expect(frames.frames).toHaveLength(sprites.length)
      expect(frames.width).toBe(512)
      expect(png.length).toBeGreaterThan(0)

      const { default: sharp } = await import('sharp')
      const meta = await sharp(png).metadata()
      expect(meta.width).toBe(frames.width)
      expect(meta.height).toBe(frames.height)
      for (const frame of frames.frames) {
        expect(frame.x).toBeGreaterThanOrEqual(0)
        expect(frame.y).toBeGreaterThanOrEqual(0)
        expect(frame.x + frame.w).toBeLessThanOrEqual(frames.width)
        expect(frame.y + frame.h).toBeLessThanOrEqual(frames.height)
      }

      const again = await buildAtlas(sprites)
      expect(again.frames.atlasHash).toBe(frames.atlasHash)
      expect(again.frames.frames).toEqual(frames.frames)
    },
    120_000,
  )

  it(
    '換色 → atlasHash 變（hash 涵蓋 atlas 內容）',
    async () => {
      const sprites = await readPackSprites(testUrl, await packIdOf(testUrl))
      const recolored = sprites.map((sprite, index) =>
        index === 0 ? { ...sprite, color: '#123456' } : sprite,
      )
      const base = await buildAtlas(sprites)
      const other = await buildAtlas(recolored)
      expect(other.frames.atlasHash).not.toBe(base.frames.atlasHash)
    },
    120_000,
  )
})

/** 取測試庫 draft pack 的 id。 */
async function packIdOf(databaseUrl: string): Promise<string> {
  const { Client } = await import('pg')
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const result = await client.query(
      'select id from content_packs where version = $1',
      ['v0'],
    )
    if (result.rows.length !== 1) throw new Error('測試庫缺少 pack v0')
    return result.rows[0]!['id'] as string
  } finally {
    await client.end()
  }
}
