import { TICK_INTERVAL_MS } from '@auto-2d-px-rts/shared'

import { stepWorld } from './world.ts'
import type { World } from './types.ts'

/**
 * 固定步長遊戲迴圈（20Hz，SPEC §2）。
 *
 * 遊戲端用 `advance(ms)` 把牆鐘時間轉成整數個 tick（累加器法）；
 * 測試與 CLI 直接用 `step()`／`run(n)` 精確推進 n 個 tick。
 * 每個 tick 都是完整的 `stepWorld`，與時間來源無關 —— 保證確定性。
 */
export class GameLoop {
  private accumulatorMs = 0

  readonly world: World

  constructor(world: World) {
    this.world = world
  }

  /** 精確推進 1 個 tick。 */
  step(): void {
    stepWorld(this.world)
  }

  /** 精確推進 n 個 tick。 */
  run(ticks: number): void {
    for (let index = 0; index < ticks; index++) this.step()
  }

  /**
   * 以毫秒推進：累加時間，每滿 `TICK_INTERVAL_MS` 走一個 tick，
   * 餘數留到下次。回傳本次實際推進的 tick 數。
   *
   * `onTick`（可選）在**每個 tick 完成後**立即回呼本 world —— 瀏覽器組合根
   * 借此把 AI 三層（每 40/10/2 tick）掛在精確的 tick 邊界上；一次推進多個
   * tick 時（分頁切換補齊）每個 tick 都會各自回呼，節奏不受掉幀影響。
   */
  advance(deltaMs: number, onTick?: (world: World) => void): number {
    if (deltaMs < 0) return 0
    this.accumulatorMs += deltaMs
    let ticks = 0
    while (this.accumulatorMs >= TICK_INTERVAL_MS) {
      this.accumulatorMs -= TICK_INTERVAL_MS
      this.step()
      ticks += 1
      if (onTick !== undefined) onTick(this.world)
    }
    return ticks
  }

  /** 距離下一個 tick 還差多少毫秒（供渲染端補間）。 */
  get progressToNextTick(): number {
    return this.accumulatorMs / TICK_INTERVAL_MS
  }
}
