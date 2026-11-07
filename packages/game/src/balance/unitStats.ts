import type { UnitDef } from '@auto-2d-px-rts/shared'

import { effectiveHp } from '../sim/combat.ts'

/**
 * 平衡指標（階段三 Prompt 3.1；原規劃在 `packages/server/src/balance/`——
 * 本 workspace 無 server 包，落地為 game 內建的純函式模組）。
 *
 * 每個單位的靜態平衡表：
 * - 裝甲 `armor`（減傷百分比 0~0.8）
 * - 有效 HP = `hp / (1 − armor)`（裝甲把傷害攤薄後的等價總量）
 * - 有效 HP / cost（生存性價比；用有效 HP 而非原始 HP——
 *   裝甲單位的原始 HP 看起來弱、實際能撐久得多）
 * - DPS = `dmg × attackSpeed`（攻擊性價比之分母不變）
 * - DPS / cost（攻擊性價比）
 *
 * 純函式、不 import pixi / react——只吃 Shared UnitDef。
 */

export interface UnitBalanceStats {
  defId: string
  /** 統一資源成本（MVP 僅 blue_crystal）。 */
  cost: number
  /** 裝甲：減傷百分比（0~0.8）。 */
  armor: number
  /** 有效 HP = hp / (1 − armor)。 */
  effectiveHpValue: number
  /** 生存性價比 = 有效 HP / cost（值越大越耐打換算划算）。 */
  effectiveHpPerCost: number
  /** DPS = dmg × attackSpeed。 */
  dps: number
  /** 攻擊性價比 = DPS / cost。 */
  dpsPerCost: number
}

export function unitBalanceStats(def: UnitDef): UnitBalanceStats {
  const totalCost = def.cost.blue_crystal
  const hp = effectiveHp(def)
  const dps = def.stats.dmg * def.stats.attackSpeed
  return {
    defId: def.id,
    cost: totalCost,
    armor: def.stats.armor,
    effectiveHpValue: hp,
    effectiveHpPerCost: totalCost === 0 ? 0 : hp / totalCost,
    dps,
    dpsPerCost: totalCost === 0 ? 0 : dps / totalCost,
  }
}

/**
 * 生存性評分（Prompt 3.1 #3，AI 生產評分用）：roster 內把
 * `有效 HP / cost` 正規化到 0..1（min-max、全平時回 0.5）。
 * 呼叫端自行乘權重（本專案生產分數的量級為 0~1 上下）。
 */
export function survivalScoreOf(def: UnitDef, roster: readonly UnitDef[]): number {
  const efficiency = (unit: UnitDef): number => {
    const cost = unit.cost.blue_crystal
    return cost === 0 ? effectiveHp(unit) : effectiveHp(unit) / cost
  }
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const unit of roster) {
    const value = efficiency(unit)
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  if (max === min) return 0.5 // 全平（如單一單位）→ 中性
  const value = efficiency(def)
  return (value - min) / (max - min)
}
