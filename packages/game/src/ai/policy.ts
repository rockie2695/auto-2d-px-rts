import type { TempoPreset } from '@auto-2d-px-rts/shared'

/**
 * Policy 滑桿值（規則 10，階段三 Prompt 6 擴展：9 數值滑桿＋三資源偏重＋節奏預設）。
 * 0.0–1.0 連續值；敵方用固定預設值（SPEC §7）。
 * **玩家讀的是「用戶設定值」**——AI 決策一律經 `effectivePolicies`（tempo 覆蓋後）。
 */
export interface ResourceBias {
  /** 藍水晶礦場效用權重（相對值；max 歸一）。 */
  blue: number
  /** 紅寶石礦場效用權重。 */
  red: number
  /** 綠翡翠礦場效用權重。 */
  green: number
}

export interface PolicyValues {
  /** 0 = 全力軍事，1 = 全力經濟（SPEC §8.1）。 */
  econMilitary: number
  /** 0 = 大型，1 = 小型（§8.2）。 */
  unitSize: number
  /** 0 = 近戰，1 = 遠程（§8.3）。 */
  unitRange: number
  /** 0 = 分散，1 = 集群（§8.5）。 */
  clusterSpread: number
  /** 0 = 固守，1 = 強攻（§8.4）。 */
  aggression: number
  /** 0 = 龜縮，1 = 擴張（Prompt 6）：提前解鎖紅／綠礦。 */
  expansion: number
  /** 0 = 數量海，1 = 科技（Prompt 6）：綠礦優先＋單位技術加成。 */
  techRush: number
  /** 0 = 全軍出擊，1 = 重兵留守（Prompt 6）：留守戰力比例。 */
  reserve: number
  /** 0 = 死戰，1 = 一有劣勢就撤（Prompt 6）：撤退閾值乘數。 */
  retreatThreshold: number
  /** 三資源礦場偏重（Prompt 6 #7；相對權重，max 歸一）。 */
  resourceBias: ResourceBias
  /** 節奏預設（Prompt 6 #3；時間窗覆蓋，見 tempo.ts）。 */
  tempoPreset: TempoPreset
}

/** content policies.json 的 default（9 滑杆全 0.5）；敵方與未設定時使用。 */
export const DEFAULT_POLICIES: PolicyValues = {
  econMilitary: 0.5,
  unitSize: 0.5,
  unitRange: 0.5,
  clusterSpread: 0.5,
  aggression: 0.5,
  expansion: 0.5,
  techRush: 0.5,
  reserve: 0.5,
  retreatThreshold: 0.5,
  resourceBias: { blue: 0.5, red: 0.5, green: 0.5 },
  tempoPreset: 'standard',
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

/** Prompt 6 權重映射：expandBias = expansion（原值使用）。 */
export function buildExpandBias(policies: PolicyValues): number {
  return clampSlider(policies.expansion)
}

/** Prompt 6 權重映射：techBias = techRush（原值使用）。 */
export function buildTechBias(policies: PolicyValues): number {
  return clampSlider(policies.techRush)
}

/** Prompt 6 權重映射：reservePct = reserve（戰力留守比例）。 */
export function buildReservePct(policies: PolicyValues): number {
  return clampSlider(policies.reserve)
}

/** 用戶輸入的覆寫（resourceBias 可只給部分子鍵）。 */
export type PolicyOverrides = Partial<Omit<PolicyValues, 'resourceBias'>> & {
  resourceBias?: Partial<ResourceBias>
}

/** 從 CLI 參數等覆寫來源組出 PolicyValues（缺漏項用預設值；bias 深合併）。 */
export function resolvePolicies(overrides: PolicyOverrides): PolicyValues {
  const bias = overrides.resourceBias ?? {}
  return {
    econMilitary: clampSlider(overrides.econMilitary ?? DEFAULT_POLICIES.econMilitary),
    unitSize: clampSlider(overrides.unitSize ?? DEFAULT_POLICIES.unitSize),
    unitRange: clampSlider(overrides.unitRange ?? DEFAULT_POLICIES.unitRange),
    clusterSpread: clampSlider(overrides.clusterSpread ?? DEFAULT_POLICIES.clusterSpread),
    aggression: clampSlider(overrides.aggression ?? DEFAULT_POLICIES.aggression),
    expansion: clampSlider(overrides.expansion ?? DEFAULT_POLICIES.expansion),
    techRush: clampSlider(overrides.techRush ?? DEFAULT_POLICIES.techRush),
    reserve: clampSlider(overrides.reserve ?? DEFAULT_POLICIES.reserve),
    retreatThreshold: clampSlider(overrides.retreatThreshold ?? DEFAULT_POLICIES.retreatThreshold),
    resourceBias: {
      blue: clampSlider(bias.blue ?? DEFAULT_POLICIES.resourceBias.blue),
      red: clampSlider(bias.red ?? DEFAULT_POLICIES.resourceBias.red),
      green: clampSlider(bias.green ?? DEFAULT_POLICIES.resourceBias.green),
    },
    tempoPreset: overrides.tempoPreset ?? DEFAULT_POLICIES.tempoPreset,
  }
}
