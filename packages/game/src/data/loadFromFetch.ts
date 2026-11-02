import type { ContentPack } from '@auto-2d-px-rts/shared'

import { parseContentPack } from './contentPack.ts'
import type { RawEntry, RawContentPack } from './contentPack.ts'

/**
 * MVP 內容檔固定清單（瀏覽器無目錄列舉）。
 * 與 `packages/game/public/data/` 的 10 檔一一對應，目錄內容
 * 由 `content.test.ts` 保證恰為此清單 —— 兩邊若失聯即測試失敗。
 */
const MANIFEST = {
  resource: ['resources/blue_crystal.json'],
  faction: ['factions/test_faction.json'],
  map: ['maps/test_map.json'],
  match: ['match.json'],
  policies: ['policies.json'],
  units: ['units/archer.json', 'units/legionnaire.json'],
  buildings: ['buildings/barracks.json', 'buildings/keep.json', 'buildings/crystal_mine.json'],
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
 * 瀏覽器端內容載入器（Node 版為 `loadFromDir.ts`）：
 * fetch 全部內容檔 → 同一個 `parseContentPack` 做 Zod 驗證，
 * 任何一檔失敗即丟錯，不靜默降級（SPEC §13）。
 *
 * @param base 內容根目錄（Vite 把 `public/` 服務在站點根，如 `/data`）
 */
export async function loadContentPackFromFetch(base: string): Promise<ContentPack> {
  const [resource, faction, map, match, policies, units, buildings] = await Promise.all([
    fetchEntry(base, MANIFEST.resource[0]),
    fetchEntry(base, MANIFEST.faction[0]),
    fetchEntry(base, MANIFEST.map[0]),
    fetchEntry(base, MANIFEST.match[0]),
    fetchEntry(base, MANIFEST.policies[0]),
    Promise.all(MANIFEST.units.map((relativePath) => fetchEntry(base, relativePath))),
    Promise.all(MANIFEST.buildings.map((relativePath) => fetchEntry(base, relativePath))),
  ])
  const raw: RawContentPack = { resource, faction, map, match, policies, units, buildings }
  return parseContentPack(raw)
}
