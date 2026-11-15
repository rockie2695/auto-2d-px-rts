import {
  BuildingFileSchema,
  FactionFileSchema,
  MapFileSchema,
  MatchFileSchema,
  PoliciesFileSchema,
  ResourceFileSchema,
  UnitFileSchema,
} from '@auto-2d-px-rts/shared'

/**
 * 依相對路徑挑出對應的 FileSchema。schema 用結構型別承接，
 * server 不直接依賴 zod（zod 是 `@auto-2d-px-rts/shared` 的依賴）。
 */
export type FileSchemaLike = { parse(data: unknown): unknown }

export function pickFileSchema(file: string): FileSchemaLike {
  if (file === 'match.json') return MatchFileSchema
  if (file === 'policies.json') return PoliciesFileSchema
  const folder = file.split('/')[0]
  switch (folder) {
    case 'resources':
      return ResourceFileSchema
    case 'factions':
      return FactionFileSchema
    case 'units':
      return UnitFileSchema
    case 'buildings':
      return BuildingFileSchema
    case 'maps':
      return MapFileSchema
    default:
      throw new Error(`無法分類的內容檔：${file}`)
  }
}

/** 以對應 FileSchema 驗證；失敗時把檔名帶進錯誤訊息。 */
export function validateContentFile(file: string, data: unknown): void {
  try {
    pickFileSchema(file).parse(data)
  } catch (cause) {
    throw new Error(`內容檔驗證失敗：${file}`, { cause })
  }
}
