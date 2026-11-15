import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import { getDatabaseUrl } from '../db/config.ts'
import { publishPack } from './publish.ts'
import { getActivePack } from './rollback.ts'

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body, null, 2)}\n`
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(text)
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  databaseUrl: string,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  try {
    if (request.method === 'POST' && url.pathname === '/api/publish/latest') {
      const version = url.searchParams.get('version') ?? 'v0'
      const result = await publishPack(databaseUrl, version)
      sendJson(response, 200, result)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/active-pack') {
      sendJson(response, 200, { active: await getActivePack(databaseUrl) })
      return
    }
    sendJson(response, 404, { error: `no route: ${request.method ?? '?'} ${url.pathname}` })
  } catch (cause) {
    sendJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) })
  }
}

/** 建立 publish API server（不 listen）；測試可指定 port 0 取隨機埠。 */
export function createApiServer(
  databaseUrl: string = getDatabaseUrl(),
): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, databaseUrl)
  })
}

const isDirectRun = process.argv[1] !== undefined && process.argv[1].endsWith('api.ts')

if (isDirectRun) {
  const port = Number(process.env['PORT'] ?? 3000)
  const server = createApiServer()
  server.listen(port, () => {
    console.log(`publish API：http://localhost:${port}`)
    console.log('  POST /api/publish/latest[?version=v0]  → publish + active')
    console.log('  GET  /api/active-pack                  → 目前 active pack')
  })
}
