import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { ContentPack } from '@auto-2d-px-rts/shared'

import { parseContentPack } from './contentPack.ts'
import type { RawEntry } from './contentPack.ts'

function readEntry(dataDir: string, relativePath: string): RawEntry {
  const fullPath = join(dataDir, relativePath)
  let text: string
  try {
    text = readFileSync(fullPath, 'utf8')
  } catch (cause) {
    throw new Error(`內容檔讀取失敗：${relativePath}`, { cause })
  }
  try {
    return { file: relativePath, data: JSON.parse(text) }
  } catch (cause) {
    throw new Error(`內容檔不是合法 JSON：${relativePath}`, { cause })
  }
}

function readDirEntries(dataDir: string, subDir: string): RawEntry[] {
  const dir = join(dataDir, subDir)
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => `${subDir}/${entry.name}`)
    .sort()
    .map((relativePath) => readEntry(dataDir, relativePath))
}

/**
 * 從目錄載入 MVP 內容檔（`packages/game/public/data/`）。
 *
 * 只給 Node 端用（`pnpm sim` 與測試）；瀏覽器端日後用 fetch 組出
 * `RawContentPack` 再交給同一個 `parseContentPack`。
 * 讀取或驗證失敗即丟錯，由呼叫者決定終止（不靜默降級）。
 */
export function loadContentPackFromDir(dataDir: string): ContentPack {
  return parseContentPack({
    resource: readEntry(dataDir, 'resources/blue_crystal.json'),
    faction: readEntry(dataDir, 'factions/test_faction.json'),
    map: readEntry(dataDir, 'maps/test_map.json'),
    match: readEntry(dataDir, 'match.json'),
    policies: readEntry(dataDir, 'policies.json'),
    units: readDirEntries(dataDir, 'units'),
    buildings: readDirEntries(dataDir, 'buildings'),
  })
}
