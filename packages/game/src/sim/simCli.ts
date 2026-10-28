import { fileURLToPath } from 'node:url'

import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import { createWorld, describePlayer, orderMove, snapshotWorld, stepWorld } from './world.ts'
import type { World } from './types.ts'

/**
 * 模擬核心 CLI（`pnpm sim`）：載入真實內容檔，跑 1000 tick 的收斂對打。
 *
 * - 種子固定 42；雙方全體單位下令移往地圖中心 (16,16)，
 *   接觸後由自動接戰收尾 —— 用來確認經濟成長、移動與戰鬥都活著。
 * - 每 250 tick 印一次雙方狀態與 RNG 進度（快照含 rngState；
 *   兩次執行輸出逐字相同即確定性成立）。
 */

const SEED = 42
const TOTAL_TICKS = 1000
const PRINT_EVERY = 250
const CENTER_TILE = { x: 16, y: 16 }

function printStatus(world: World): void {
  console.log(`--- tick ${world.tick} ---`)
  for (const player of world.players) {
    console.log(`  ${describePlayer(world, player.id)}`)
  }
  const snapshot = snapshotWorld(world)
  const nodesLeft = world.resourceNodes.reduce((total, node) => total + node.amountRemaining, 0)
  console.log(
    `  units=${world.units.length} buildings=${world.buildings.length} ` +
      `nodesLeft=${nodesLeft} rng=${snapshot.rngState}`,
  )
}

function main(): void {
  // 以本檔位置推導資料目錄（dist 執行亦可用）。
  const dataDir = fileURLToPath(new URL('../../public/data/', import.meta.url))
  const content = loadContentPackFromDir(dataDir)
  const world = createWorld(content, SEED)

  // 全軍推向地圖中心：必然相遇並觸發自動接戰。
  for (const unit of world.units) orderMove(world, unit.id, CENTER_TILE)

  printStatus(world)
  while (world.tick < TOTAL_TICKS) {
    stepWorld(world)
    if (world.tick % PRINT_EVERY === 0) printStatus(world)
  }
}

main()
