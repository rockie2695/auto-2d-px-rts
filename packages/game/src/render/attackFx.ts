/**
 * 攻擊特效的**純偵測** helpers（Prompt 10.24）：從相鄰兩 tick 的世界快照 diff 出
 * 「本 tick 誰開火了」。不 import pixi——可在 node 單測；sim 層零改動。
 * （9.5c：開火/接戰線的受害者端點改由 sim 同源 `computeEngageLines` 提供，
 * 快照版 `towerVictimOf` 近似已移除。）
 */
import type { WorldSnapshot } from '../sim/world.ts'

/** 單位快照（結構子集，`WorldSnapshot['units'][number]` 可指派）。 */
export type FxUnit = WorldSnapshot['units'][number]

/**
 * 開火判據（Prompt 10.24 修）：`attackAcc` 每 tick `＋attackSpeed / 20` **單調遞增**、
 * 開火當 tick `−1` → 「after ＜ before」⟺ 本 tick 開火。
 *
 * 舊判據 `before ≥ 1 && after ＜ before` 只在**冷卻封頂（閒置）後的首發**成立——
 * 持續交戰時快照序列是 0.05 → 0.10 → … → 0.95 → 0（開火）→ 0.05…，before 恆 ＜ 1，
 * 逐發特效全部丟失（長距離對射看不到彈道的根因，只有第一發有動畫）。
 */
export function firedThisTick(beforeAcc: number, afterAcc: number): boolean {
  return afterAcc < beforeAcc
}
