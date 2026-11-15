import { resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runner } from 'node-pg-migrate'

import { getDatabaseUrl } from './config.ts'

/** `packages/server/src/db/` → `packages/server/migrations/`。 */
const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
)

const direction = process.argv[2] === 'down' ? 'down' : 'up'

await runner({
  databaseUrl: getDatabaseUrl(),
  migrationsTable: 'pgmigrations',
  dir: MIGRATIONS_DIR,
  direction,
  count: direction === 'up' ? Infinity : 1,
})
