import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSeededTestDatabase, dropTestDatabase } from '../db/testDb.ts'
import { createApiServer } from './api.ts'

let testUrl: string
let close: () => Promise<void>
let baseUrl: string

beforeAll(async () => {
  testUrl = await createSeededTestDatabase()
  const server = createApiServer(testUrl)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('API server 未取得埠號')
  }
  baseUrl = `http://127.0.0.1:${address.port}`
  close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error == null ? resolve() : reject(error)))
    })
}, 180_000)

afterAll(async () => {
  await close()
  await dropTestDatabase(testUrl)
}, 180_000)

describe('publish API（node:http）', () => {
  it(
    'POST /api/publish/latest → publish 並設 active；GET /api/active-pack 回版本',
    async () => {
      const published = await fetch(`${baseUrl}/api/publish/latest?version=v0`, { method: 'POST' })
      expect(published.status).toBe(200)
      const body = (await published.json()) as { version: string; packUrl: string; packHash: string }
      expect(body.version).toBe('v0')
      expect(body.packUrl).toContain('pack.json')
      expect(body.packHash).toMatch(/^[0-9a-f]{64}$/)

      const active = await fetch(`${baseUrl}/api/active-pack`)
      expect(active.status).toBe(200)
      const activeBody = (await active.json()) as { active: { version: string } | null }
      expect(activeBody.active?.version).toBe('v0')
    },
    180_000,
  )

  it(
    '未知路由 → 404 JSON',
    async () => {
      const response = await fetch(`${baseUrl}/api/nope`)
      expect(response.status).toBe(404)
      const body = (await response.json()) as { error: string }
      expect(body.error).toContain('no route')
    },
    60_000,
  )
})
