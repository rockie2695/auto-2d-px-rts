import { Client } from 'pg'

import type { PackContent } from '@auto-2d-px-rts/shared'
import { PackContentSchema } from '@auto-2d-px-rts/shared'

import { exportPack } from '../db/export.ts'

/** 從包裝檔 JSON 抽內層 def（`data.unit` / `data.map` …）。 */
function unwrap(file: { file: string; data: unknown }, key: string): unknown {
  const wrapper = file.data as Record<string, unknown>
  const def = wrapper[key]
  if (def === undefined || def === null) {
    throw new Error(`內容檔缺少 ${key}：${file.file}`)
  }
  return def
}

function requireFile(
  files: readonly { file: string; data: unknown }[],
  name: string,
): { file: string; data: unknown } {
  const found = files.find((file) => file.file === name)
  if (found === undefined) {
    throw new Error(`pack 缺少必要內容檔：${name}`)
  }
  return found
}

/**
 * 從 DB 重組出 pack 的 content 本體（形狀同遊戲 `ContentPack`，
 * 另帶 `resources` 全集合與完整 tiles／resourceNodes 的 map）。
 *
 * 順序：資源／單位／建築按 id 排序（export 的 order by id）；
 * `resource` 固定取 sim 主消費的 blue_crystal。
 * 組完以 shared 的 `PackContentSchema` 驗證，失敗即丟錯。
 */
export async function buildPackContent(
  databaseUrl: string,
  packVersion: string,
): Promise<{ packId: string; version: string; content: PackContent }> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  let packId: string
  try {
    const pack = await client.query(
      'select id from content_packs where version = $1',
      [packVersion],
    )
    if (pack.rows.length !== 1) {
      throw new Error(`找不到 content pack：${packVersion}`)
    }
    packId = pack.rows[0]!['id'] as string
  } finally {
    await client.end()
  }

  const files = await exportPack(databaseUrl, packVersion)

  const resourceDefs = files
    .filter((file) => file.file.startsWith('resources/'))
    .map((file) => unwrap(file, 'resource'))
  const mainResource = resourceDefs.find(
    (def) => (def as { id: string }).id === 'blue_crystal',
  )
  if (mainResource === undefined) {
    throw new Error('pack 缺少主資源 blue_crystal')
  }

  const content: PackContent = {
    resource: mainResource as PackContent['resource'],
    resources: resourceDefs as PackContent['resources'],
    units: files
      .filter((file) => file.file.startsWith('units/'))
      .map((file) => unwrap(file, 'unit') as PackContent['units'][number]),
    buildings: files
      .filter((file) => file.file.startsWith('buildings/'))
      .map((file) => unwrap(file, 'building') as PackContent['buildings'][number]),
    faction: unwrap(
      requireFile(files, 'factions/test_faction.json'),
      'faction',
    ) as PackContent['faction'],
    map: unwrap(requireFile(files, 'maps/test_map.json'), 'map') as PackContent['map'],
    match: unwrap(requireFile(files, 'match.json'), 'match') as PackContent['match'],
    policies: unwrap(
      requireFile(files, 'policies.json'),
      'policies',
    ) as PackContent['policies'],
  }

  try {
    PackContentSchema.parse(content)
  } catch (cause) {
    throw new Error(`pack 內容驗證失敗（pack ${packVersion}）`, { cause })
  }

  return { packId: packId!, version: packVersion, content }
}
