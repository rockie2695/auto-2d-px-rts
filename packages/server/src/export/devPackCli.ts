import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getDatabaseUrl } from '../db/config.ts'
import { seedDatabase } from '../db/seed.ts'
import { publishPack } from './publish.ts'
import { resetPackToDraft } from './rollback.ts'

/**
 * `pnpm pack:dev`（Windows 等價於 `scripts/dev-pack.sh`）：
 * seed（seed-data JSON → DB）→ publish（DB → public/packs/{version}／latest）
 * 一步到位，不需要常駐 API server。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const version = process.argv[2] ?? 'v0'

// 開發迭代：已 published 的同版本先退回 draft（seed 才允許改寫；正式流程不使用）。
const { reset } = await resetPackToDraft(getDatabaseUrl(), version)
if (reset) console.log(`已將 pack ${version} 退回 draft（開發迭代）`)

const summary = await seedDatabase(getDatabaseUrl())
console.log(
  `seed 完成：pack ${summary.packVersion}（draft）resources=${summary.resources}` +
    ` units=${summary.units} buildings=${summary.buildings} sprites=${summary.sprites}`,
)
const result = await publishPack(getDatabaseUrl(), version)
console.log(
  `pack:dev 完成：pack ${result.version} packHash=${result.packHash.slice(0, 12)}…` +
    ` atlasHash=${result.atlasHash.slice(0, 12)}…`,
)
console.log(`遊戲端讀取：${REPO_ROOT}\\packages\\game\\public\\packs\\latest\\pack.json`)
