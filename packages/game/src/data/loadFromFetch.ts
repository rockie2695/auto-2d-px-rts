import type { ContentPack } from '@auto-2d-px-rts/shared'

import { parseContentPack } from './contentPack.ts'
import type { RawEntry, RawContentPack } from './contentPack.ts'

/**
 * MVP 內容檔固定清單（瀏覽器無目錄列舉）。
 * 與內容目錄的 17 檔一一對應，目錄內容由 `content.test.ts` 保證恰為此清單
 * —— 兩邊若失聯即測試失敗。DB 匯出的 `data-db/` 內容相同（見 docs/DB_MAPPING.md）。
 */
const MANIFEST = {
  resource: ['resources/blue_crystal.json'],
  faction: ['factions/test_faction.json'],
  map: ['maps/test_map.json'],
  match: ['match.json'],
  policies: ['policies.json'],
  units: [
    'units/archer.json',
    'units/ballista.json',
    'units/legionnaire.json',
    'units/shield_guard.json',
  ],
  buildings: [
    'buildings/barracks.json',
    'buildings/crystal_mine.json',
    'buildings/emerald_sanctuary.json',
    'buildings/keep.json',
    'buildings/ruby_mine.json',
    'buildings/tower.json',
  ],
} as const

async function fetchEntry(base: string, relativePath: string): Promise<RawEntry> {
  const url = `${base}/${relativePath}`
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new Error(`內容檔請求失敗：${relativePath}`, { cause })
  }
  if (!response.ok) {
    throw new Error(`內容檔讀取失敗（HTTP ${response.status}）：${relativePath}`)
  }
  let data: unknown
  try {
    data = await response.json()
  } catch (cause) {
    throw new Error(`內容檔不是合法 JSON：${relativePath}`, { cause })
  }
  return { file: relativePath, data }
}

/**
 * 探測 DB 匯出目錄是否存在（以任一固定檔是否可取為準）。
 * dev server／靜態 host 未跑過 `pnpm db:export` 時為 false。
 */
async function probeBase(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/${MANIFEST.match[0]}`)
    return response.ok
  } catch {
    return false
  }
}

/**
 * 瀏覽器端內容載入器（Node 版為 `loadFromDir.ts`）：
 *
 * 1. 優先讀 DB 匯出目錄 `<base>-db`（Phase 資料源遷移：Neon Postgres
 *    `pnpm db:export` 產生，檔案結構與 `data/` 相同，見 docs/DB_MAPPING.md）；
 * 2. 探測不到（404 或網路失敗）時回退原 `<base>` JSON 目錄。
 *
 * fetch 全部內容檔 → 同一個 `parseContentPack` 做 Zod 驗證，
 * 任何一檔失敗即丟錯，不靜默降級（SPEC §13）。
 *
 * @param base 內容根目錄（Vite 把 `public/` 服務在站點根，如 `/data`）
 */
export async function loadContentPackFromFetch(base: string): Promise<ContentPack> {
  const dbBase = `${base}-db`
  const resolvedBase = (await probeBase(dbBase)) ? dbBase : base
  const [resource, faction, map, match, policies, units, buildings] = await Promise.all([
    fetchEntry(resolvedBase, MANIFEST.resource[0]),
    fetchEntry(resolvedBase, MANIFEST.faction[0]),
    fetchEntry(resolvedBase, MANIFEST.map[0]),
    fetchEntry(resolvedBase, MANIFEST.match[0]),
    fetchEntry(resolvedBase, MANIFEST.policies[0]),
    Promise.all(MANIFEST.units.map((relativePath) => fetchEntry(resolvedBase, relativePath))),
    Promise.all(MANIFEST.buildings.map((relativePath) => fetchEntry(resolvedBase, relativePath))),
  ])
  const raw: RawContentPack = { resource, faction, map, match, policies, units, buildings }
  return parseContentPack(raw)
}
