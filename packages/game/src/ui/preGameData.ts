import { createWorld } from '../sim/world.ts'
import type { ContentPack } from '@auto-2d-px-rts/shared'

/**
 * 戰前頁靜態資料源（Prompt 10.5 完整版）：從 content pack ＋ headless world
 * 取預覽所需的確定性資料——純函式，無 React（fast-refresh 友好）。
 */

/** 開局 keep 位置（出生點標記）：headless world 純資料生成（我方 keep 在前）。 */
export function keepSpawnTiles(content: ContentPack, seed: number): Array<{ x: number; y: number }> {
  const world = createWorld(content, seed)
  const keeps = world.buildings.filter((building) => building.defId === 'keep')
  const playerKeep = keeps.find((building) => building.player === 'player')
  const enemyKeep = keeps.find((building) => building.player === 'enemy')
  return [playerKeep, enemyKeep]
    .filter((keep) => keep !== undefined)
    .map((keep) => ({ x: keep.x, y: keep.y }))
}
