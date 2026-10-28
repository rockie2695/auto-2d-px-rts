import {
  BuildingFileSchema,
  FactionFileSchema,
  MapFileSchema,
  MatchFileSchema,
  PoliciesFileSchema,
  ResourceFileSchema,
  UnitFileSchema,
} from '@auto-2d-px-rts/shared'
import type { ContentPack } from '@auto-2d-px-rts/shared'

/** 帶檔名的原始 JSON：驗證失敗時錯誤訊息才能指出是哪個檔。 */
export interface RawEntry {
  readonly file: string
  readonly data: unknown
}

/** 全部內容檔的原始資料（`loadFromDir` 或瀏覽器 fetch 產生）。 */
export interface RawContentPack {
  resource: RawEntry
  faction: RawEntry
  map: RawEntry
  match: RawEntry
  policies: RawEntry
  units: readonly RawEntry[]
  buildings: readonly RawEntry[]
}

function parseEntry<T>(entry: RawEntry, run: () => T): T {
  try {
    return run()
  } catch (cause) {
    throw new Error(`內容檔驗證失敗：${entry.file}`, { cause })
  }
}

/**
 * 把原始 JSON 組成 `ContentPack`（純函式，不碰檔案系統）。
 *
 * 逐檔以 `packages/shared/src/schema.ts` 的 Zod schema 驗證，
 * 任何一檔不合格即丟錯 —— 不靜默降級（SPEC §13）。
 */
export function parseContentPack(raw: RawContentPack): ContentPack {
  return {
    resource: parseEntry(raw.resource, () => ResourceFileSchema.parse(raw.resource.data).resource),
    faction: parseEntry(raw.faction, () => FactionFileSchema.parse(raw.faction.data).faction),
    units: raw.units.map((entry) =>
      parseEntry(entry, () => UnitFileSchema.parse(entry.data).unit),
    ),
    buildings: raw.buildings.map((entry) =>
      parseEntry(entry, () => BuildingFileSchema.parse(entry.data).building),
    ),
    map: parseEntry(raw.map, () => MapFileSchema.parse(raw.map.data).map),
    match: parseEntry(raw.match, () => MatchFileSchema.parse(raw.match.data).match),
    policies: parseEntry(raw.policies, () => PoliciesFileSchema.parse(raw.policies.data).policies),
  }
}
