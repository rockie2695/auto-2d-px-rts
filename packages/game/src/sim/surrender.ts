/**
 * sim 層投降定案（Prompt 8.6 AI 投降／Prompt 10.6 玩家手動投降共用）：
 *
 * - 行為閘門（停火／停產）在 sim 層每 tick 檢查（combat/economy 讀
 *   `world.surrender`）；本模組負責**定案那一刻**的狀態寫入與即時停行動。
 * - `surrenderPowerOf`／`surrenderIncomeOf` 是純 sim 計算（原本在 ai 層，
 *   Prompt 10.6 下移——sim 不依賴 ai，兩條投降路徑用同一口徑現算復盤數據）。
 * - 確定性：遍歷按 world 陣列序（與 sim 其餘部分一致），無 RNG。
 */

import { RESOURCE_IDS } from '@auto-2d-px-rts/shared'

import { effectiveHp } from './combat.ts'
import { getIncome } from './economy.ts'
import { matchEnded } from './matchResult.ts'
import type { PlayerId, SurrenderEvent, World } from './types.ts'

/** 陣營有效當量戰力（Prompt 3.1）：Σ 現值 hp 換算 hp/(1−armor) × dmg × attackSpeed。 */
export function surrenderPowerOf(world: World, playerId: PlayerId): number {
  return world.units.reduce((total, unit) => {
    if (unit.player !== playerId || unit.hp <= 0) return total
    const def = world.defs.units[unit.defId]
    if (def === undefined) return total
    return total + (unit.hp / effectiveHp(def)) * def.stats.dmg * def.stats.attackSpeed
  }, 0)
}

/** 最近窗口的三資源收入總和（Prompt 5 指定 API 的逐資源加總）。 */
export function surrenderIncomeOf(world: World, playerId: PlayerId): number {
  return RESOURCE_IDS.reduce((total, id) => total + getIncome(world, playerId, id), 0)
}

/**
 * 投降定案（共用）：寫 `world.surrender` 並**停該方一切行動**——
 * 清生產隊列、斷單位移動與攻擊目標（之後由 sim 每 tick 行為閘門兜底：
 * 不開火、不生產、AI 不決策）。
 *
 * - `powerRatio`／`incomeRatio` 照 AI 口徑現算（分母地板防除零），
 *   復盤橫幅直接可讀；`despairAtSurrender` 由呼叫端給（AI＝絕望指數、
 *   玩家手動＝0 不適用）。
 * - 已有投降（先投方不覆蓋）不在這裡擋——呼叫端負責。
 */
export function applySurrender(
  world: World,
  playerId: PlayerId,
  despairAtSurrender: number,
): SurrenderEvent {
  const other = playerId === 'player' ? 'enemy' : 'player'
  const myPower = surrenderPowerOf(world, playerId)
  const enemyPower = surrenderPowerOf(world, other)
  const myIncome = Math.max(0.01, surrenderIncomeOf(world, playerId))
  const enemyIncome = Math.max(0.01, surrenderIncomeOf(world, other))
  world.surrender = {
    player: playerId,
    tick: world.tick,
    despairAtSurrender,
    powerRatio: myPower / Math.max(1, enemyPower),
    incomeRatio: myIncome / enemyIncome,
  }
  // 停止一切行動：清生產隊列、斷單位移動與攻擊目標。
  for (const building of world.buildings) {
    if (building.player === playerId) building.queue = []
  }
  for (const unit of world.units) {
    if (unit.player !== playerId) continue
    unit.path = null
    unit.dest = null
    unit.targetId = null
  }
  return world.surrender
}

/**
 * 玩家手動投降（Prompt 10.6）：
 * - 已投降（先投方定案）或對局已結束條件成立 → false（幂等）。
 * - 否則立即定案：投降方停止一切行動；敵方 AI 照常運作 3 秒
 *   （`SURRENDER_GRACE_TICKS` 寬限）後 `matchEnded` → 投降方判負
 *   （`resolveMatchResult` 既有語義）。
 */
export function surrenderPlayer(world: World, playerId: PlayerId): boolean {
  if (world.surrender !== null) return false
  if (matchEnded(world)) return false
  applySurrender(world, playerId, 0)
  return true
}
