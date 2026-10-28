import type { PolicyId } from '@auto-2d-px-rts/shared'

/**
 * Policy 滑桿值（規則 10：玩家只調這 5 個滑桿，不得直接指揮單位）。
 * 0.0 – 1.0 連續值；敵方用固定預設值（SPEC §7）。
 */
export interface PolicyValues {
  econMilitary: number
  unitSize: number
  unitRange: number
  aggression: number
  clusterSpread: number
}

/** 全部 Policy id（含尚未作用於戰略層的 aggression / clusterSpread）。 */
export const POLICY_IDS_LIST: readonly PolicyId[] = [
  'econMilitary',
  'unitSize',
  'unitRange',
  'aggression',
  'clusterSpread',
]

/** content policies.json 的 default（全 0.5）；敵方與未設定時使用。 */
export const DEFAULT_POLICIES: PolicyValues = {
  econMilitary: 0.5,
  unitSize: 0.5,
  unitRange: 0.5,
  aggression: 0.5,
  clusterSpread: 0.5,
}

/** 把滑桿值夾到 [0, 1]（CLI 覆寫或外部輸入可能超界）。 */
export function clampSlider(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Prompt 6 權重映射：buildEcon = econMilitary × 2.0（0 → 0、0.5 → 1、1 → 2）。 */
export function buildEconWeight(policies: PolicyValues): number {
  return clampSlider(policies.econMilitary) * 2.0
}

/** Prompt 6 權重映射：buildMilitary = (1 − econMilitary) × 2.0。 */
export function buildMilitaryWeight(policies: PolicyValues): number {
  return (1 - clampSlider(policies.econMilitary)) * 2.0
}

/** 從 CLI 參數等覆寫來源組出 PolicyValues（缺漏項用預設值）。 */
export function resolvePolicies(overrides: Partial<Record<PolicyId, number>>): PolicyValues {
  return {
    econMilitary: clampSlider(overrides.econMilitary ?? DEFAULT_POLICIES.econMilitary),
    unitSize: clampSlider(overrides.unitSize ?? DEFAULT_POLICIES.unitSize),
    unitRange: clampSlider(overrides.unitRange ?? DEFAULT_POLICIES.unitRange),
    aggression: clampSlider(overrides.aggression ?? DEFAULT_POLICIES.aggression),
    clusterSpread: clampSlider(overrides.clusterSpread ?? DEFAULT_POLICIES.clusterSpread),
  }
}
