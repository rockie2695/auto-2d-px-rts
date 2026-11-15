import { PackFileSchema } from '@auto-2d-px-rts/shared'
import type { ContentPack } from '@auto-2d-px-rts/shared'
import { computePackHash } from '@auto-2d-px-rts/shared'

import { loadContentPackFromFetch } from './loadFromFetch.ts'

/** 遊戲讀取的 pack 位置（LocalDiskStorage 寫進 Vite public 的 latest 鏡像）。 */
export const PACK_LATEST_BASE = '/packs/latest'

/**
 * pack hash 驗證失敗（內容被改／版本錯置／傳輸損壞）。
 * 與「載入不到」區分：hash 不符**不可**靜默回退舊資料源。
 */
export class PackHashMismatchError extends Error {}

/** `loadPack` 的載入結果：遊戲用 pack，replay 記錄 version／packHash。 */
export interface LoadedPack {
  readonly pack: ContentPack
  readonly version: string
  readonly packHash: string
  readonly atlasHash?: string
  /** 內容來源：pack.json（DB pipeline）或 data-db 回退。 */
  readonly source: 'pack' | 'data-db-fallback'
}

function toContentPack(packFile: ReturnType<typeof PackFileSchema.parse>): ContentPack {
  const content = packFile.content
  return {
    resource: content.resource,
    units: content.units,
    buildings: content.buildings,
    faction: content.faction,
    map: content.map,
    match: content.match,
    policies: content.policies,
  }
}

/**
 * 載入 Content Pack（`pack.json`），並**重算 hash 驗證**。
 *
 * - `source` 是 pack 根路徑／URL（如 `/packs/latest` 或遠端
 *   `https://cdn.example/packs/v0`）；本函式 fetch `${source}/pack.json`。
 * - PackFileSchema（Zod）驗證失敗即丟錯，不靜默降級。
 * - hash 不符（內容被改、版本錯置、傳輸損壞）即丟錯拒載。
 */
export async function loadPack(source: string): Promise<LoadedPack> {
  const url = `${source}/pack.json`
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new Error(`pack 請求失敗：${url}`, { cause })
  }
  if (!response.ok) {
    throw new Error(`pack 載入失敗（HTTP ${response.status}）：${url}`)
  }
  let data: unknown
  try {
    data = await response.json()
  } catch (cause) {
    throw new Error(`pack 不是合法 JSON：${url}`, { cause })
  }

  const packFile = PackFileSchema.parse(data)
  const recomputed = await computePackHash(packFile.content, packFile.atlasHash ?? '')
  if (recomputed !== packFile.packHash) {
    throw new PackHashMismatchError(
      `pack hash 驗證失敗：宣稱 ${packFile.packHash.slice(0, 12)}…，重算 ${recomputed.slice(0, 12)}…` +
        `（${url} 的內容與 hash 不一致，拒絕載入）`,
    )
  }

  return {
    pack: toContentPack(packFile),
    version: packFile.version,
    packHash: packFile.packHash,
    atlasHash: packFile.atlasHash,
    source: 'pack',
  }
}

/**
 * 遊戲內容載入的統一入徑：
 * 1. 優先讀 DB publish pipeline 的 `/packs/latest/pack.json`（含 hash 驗證）；
 * 2. 失敗（未 publish、dev server 沒 packs/ 等）回退 `<base>` 的 17 檔
 *    `loadContentPackFromFetch`（`/data-db`）。
 *
 * @param base 回退內容根目錄（現為 `/data-db`）
 */
export async function loadPackWithFallback(base: string): Promise<LoadedPack> {
  try {
    return await loadPack(PACK_LATEST_BASE)
  } catch (cause) {
    // hash 不符不可回退（竄改防護），原樣上拋；
    // 其餘（未 publish、pack 不存在）才回退 data-db。
    if (cause instanceof PackHashMismatchError) throw cause
    // 回退路徑沒有 pack hash 語意（version/packHash 留空，replay 不記）。
    const pack = await loadContentPackFromFetch(base)
    return { pack, version: '', packHash: '', source: 'data-db-fallback' }
  }
}
