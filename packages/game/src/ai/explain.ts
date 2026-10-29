import type { Role } from '@auto-2d-px-rts/shared'
import type { PolicyValues } from './policy.ts'
import { buildEconWeight, buildMilitaryWeight } from './policy.ts'

/**
 * 決策解釋模板（Prompt 6.5）：純規則式，不用 LLM。
 *
 * `explainBuild` / `explainTrain` 內部走同一條規則鏈，
 * 同時產出一行中文解釋與主導因素 `topFactor` —— 兩者保證一致
 * （不會出現 topFactor 講克制、解釋卻在講射程的矛盾）。
 */

/** 決策主導因素（與 explanation 同源；建築軌 4 種、生產軌 5 種）。 */
export type DecisionTopFactor =
  | 'forcedMine'
  | 'econWeight'
  | 'militaryWeight'
  | 'saturation'
  | 'counter'
  | 'range'
  | 'tier'
  | 'scarcity'
  | 'feasibility'

/** 解釋產出：一行中文 + 主導因素。 */
export interface Explanation {
  text: string
  topFactor: DecisionTopFactor
}

/** 解釋所需的當時世界狀態（由 strategy.ts 從 world 摘出）。 */
export interface ExplainState {
  mineCount: number
  mineCap: number
  barracksCount: number
  barracksCap: number
  /** 活著的敵方單位角色計數（克制子句用）。 */
  enemyMeleeCount: number
  enemyRangedCount: number
  /** 被生產單位的角色（explainTrain 用）。 */
  unitRole?: Role
  /**
   * 當軌可行候選數（explainTrain 用）：
   * 恰為 1 時表示其他單位已被篩掉（不可負擔／無產能），
   * 解釋應歸因於可行性而非分數接近。
   */
  candidateCount?: number
}

/** 建築候選的解釋輸入：defId + 類別（節點建築 vs 軍事建築）。 */
export interface BuildTarget {
  defId: string
  kind: 'node' | 'military'
}

/** 把滑桿夾到 [0, 1]（模板閾值比較用）。 */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * 建築解釋規則鏈（首條命中即產出）：
 * 1. 節點建築且一礦都沒有 → 強制確保基本收入
 * 2. 節點建築且經濟權重高 → econMilitary 偏經濟
 * 3. 軍事建築且軍事權重高 → econMilitary 偏軍事
 * 4. 其餘（含雙權重相等）→ 飽和度：礦場尚未飽和 / 軍事建築不足
 */
export function explainBuild(
  target: BuildTarget,
  policies: PolicyValues,
  state: ExplainState,
): Explanation {
  const econ = buildEconWeight(policies)
  const military = buildMilitaryWeight(policies)

  if (target.kind === 'node') {
    if (state.mineCount === 0) {
      return {
        text: `蓋 ${target.defId}。理由：完全沒有礦場，強制確保基本收入`,
        topFactor: 'forcedMine',
      }
    }
    if (econ > military) {
      return {
        text: `蓋 ${target.defId}。理由：econMilitary 偏經濟，優先補礦場`,
        topFactor: 'econWeight',
      }
    }
    return { text: `蓋 ${target.defId}。理由：礦場尚未飽和`, topFactor: 'saturation' }
  }

  if (military > econ) {
    return {
      text: `蓋 ${target.defId}。理由：econMilitary 偏軍事，補充戰力`,
      topFactor: 'militaryWeight',
    }
  }
  return { text: `蓋 ${target.defId}。理由：軍事建築不足`, topFactor: 'saturation' }
}

/**
 * 生產解釋規則鏈：子句依序 [range, counter, tier]，
 * 可疊加但最多 2 條（以「且」連接）；第一條命中者即 topFactor。
 * 全部未命中 → 依可行候選數給稀缺性輪替句或可行性句。
 */
export function explainTrain(
  defId: string,
  policies: PolicyValues,
  state: ExplainState,
): Explanation {
  const unitRange = clamp01(policies.unitRange)
  const unitSize = clamp01(policies.unitSize)
  const clauses: string[] = []
  let topFactor: DecisionTopFactor | null = null

  const addClause = (clause: string, factor: DecisionTopFactor): void => {
    if (clauses.length >= 2) return
    clauses.push(clause)
    topFactor ??= factor
  }

  // 射程偏好：滑桿傾向與單位本性一致時才歸因於射程。
  if (state.unitRole === 'ranged' && unitRange >= 0.6) {
    addClause('unitRange 偏遠程', 'range')
  } else if (state.unitRole === 'melee' && unitRange <= 0.4) {
    addClause('unitRange 偏近戰', 'range')
  }

  // 敵方組成：多數方與我方角色形成克制敘事。
  if (state.enemyMeleeCount > state.enemyRangedCount && state.unitRole === 'ranged') {
    addClause('敵方近戰多', 'counter')
  } else if (state.enemyRangedCount > state.enemyMeleeCount && state.unitRole === 'melee') {
    addClause('敵方遠程多', 'counter')
  }

  // tier 偏好：unitSize 明確傾斜時歸因。
  if (unitSize >= 0.6) {
    addClause('unitSize 偏小型', 'tier')
  } else if (unitSize <= 0.4) {
    addClause('unitSize 偏大型', 'tier')
  }

  if (clauses.length === 0) {
    // 只有 1 個可行候選 → 其他單位已被篩掉，歸因可行性而非分數接近。
    if (state.candidateCount === 1) {
      return {
        text: `生 ${defId}。理由：僅此單位可負擔且有產能，其他候選不可行`,
        topFactor: 'feasibility',
      }
    }
    return {
      text: `生 ${defId}。理由：候選分數接近，依稀缺性輪替生產`,
      topFactor: 'scarcity',
    }
  }
  return { text: `生 ${defId}。理由：${clauses.join('且')}`, topFactor: topFactor ?? 'scarcity' }
}
