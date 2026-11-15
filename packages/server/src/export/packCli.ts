import { getDatabaseUrl } from '../db/config.ts'
import { publishPack } from './publish.ts'

/**
 * `pnpm --filter @auto-2d-px-rts/server build:pack`（root 亦有 `pnpm build:pack` 別名）：
 * 對 DB 的 draft pack 跑完整 publish pipeline（build → atlas → hash →
 * 寫 public/packs/v{version}/ + latest/ → 標記 published＋active）。
 * 用法：build:pack [version]（預設 v0）。
 */
const version = process.argv[2] ?? 'v0'
const result = await publishPack(getDatabaseUrl(), version)
console.log(
  `build:pack 完成：pack ${result.version}` +
    ` packHash=${result.packHash.slice(0, 12)}…` +
    ` atlasHash=${result.atlasHash.slice(0, 12)}…` +
    ` → ${result.packUrl}`,
)
