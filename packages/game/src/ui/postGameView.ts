import { buildPolicyTimeline, surrenderSnapshotTicks } from '../ai/counterfactual.ts'
import type { PolicyValues } from '../ai/policy.ts'
import type { ReplayDecision, ReplayRecord, ReplaySample } from '../replay.ts'

/**
 * 戰後復盤三視圖的純邏輯（Prompt 10.5c）：結束狀態判定、文案、局勢快照
 * 切片、「為什麼會輸」關鍵時刻、反事實快照點。無 React／無渲染——
 * 供 PostGamePanel（components 檔不得導出常量）與測試共用。
 */

/** 三種結束狀態（Prompt 10.5c）：玩家投降／AI 投降（玩家贏）／正常結束。 */
export type EndType = 'player_surrender' | 'ai_surrender' | 'normal_end'

/** 結束狀態判定：投降方 = 玩家 → player_surrender；敵方 → ai_surrender；無投降 → normal_end。 */
export function endTypeOf(replay: ReplayRecord): EndType {
  const surrender = replay.surrender
  if (surrender === undefined) return 'normal_end'
  return surrender.player === 'player' ? 'player_surrender' : 'ai_surrender'
}

/** 標題／副標題／強調色（文案原則：不羞辱、不假裝鼓勵、中性分析性）。 */
export interface HeaderCopy {
  readonly title: string
  readonly subtitle: string
  readonly accent: string
}

export function headerCopyOf(endType: EndType, result: ReplayRecord['result']): HeaderCopy {
  if (endType === 'player_surrender') {
    return {
      title: '你投降了',
      subtitle: '這組 Policy 打不過。看看如果當時改了什麼，也許還有機會。',
      accent: '#ff7a7a',
    }
  }
  if (endType === 'ai_surrender') {
    return {
      title: '對手投降了',
      subtitle: '你的 Policy 設計壓制了對手。看看是什麼起了作用。',
      accent: '#7ce38b',
    }
  }
  if (result === 'player') {
    return {
      title: '勝利',
      subtitle: '正常結束——這組 Policy 撐到了最後。看看是什麼起了作用。',
      accent: '#7ce38b',
    }
  }
  if (result === 'enemy') {
    return {
      title: '失敗',
      subtitle: '這組 Policy 在這個對局中處於劣勢。試試調整 aggression 或軍經配比。',
      accent: '#ff7a7a',
    }
  }
  return {
    title: '平手',
    subtitle: '雙方撐到時限仍未分出勝負——資源效率是下一步的變數。',
    accent: '#ffd866',
  }
}

/** 序列切片：保留 tick ≤ before 的樣本（局勢快照小圖用）。 */
export function sliceBefore(series: readonly ReplaySample[], before: number): ReplaySample[] {
  return series.filter((sample) => sample.tick <= before)
}

/** 窗口切片：保留 tick ∈ [before − windowTicks, before]（投降前 30 秒 = 600 tick）。 */
export function sliceWindow(
  series: readonly ReplaySample[],
  before: number,
  windowTicks = 600,
): ReplaySample[] {
  return series.filter((sample) => sample.tick <= before && sample.tick >= before - windowTicks)
}

/** 「如果當時改成 X」的一個時刻（規則式陳述——重放驗證在反事實區塊）。 */
export interface LostMoment {
  readonly tick: number
  readonly action: ReplayDecision['action']
  readonly target: string
  /** 實際選擇（效用第一名）。 */
  readonly chosen: string
  /** 當時的第二候選（「如果改成 X」的素材）。 */
  readonly alternative: string
  /** 分差（第一名 − 第二名）：越小代表當時越是勢均力敵的抉擇。 */
  readonly gap: number
  readonly explanation: string
}

/**
 * 關鍵失誤時刻（Prompt 10.5c 區塊二）：投降前、我方、帶備選項的決策，
 * 依「分差小 → 越可能是勢均力敵的抉擇」排前（並以成本大者優先做次要排序）。
 */
export function lostMoments(
  decisions: readonly ReplayDecision[],
  beforeTick: number,
  max = 5,
): LostMoment[] {
  const candidates = decisions
    .filter(
      (decision) =>
        decision.actor === 'player' &&
        decision.tick <= beforeTick &&
        decision.alternatives !== undefined &&
        decision.alternatives.length > 1,
    )
    .map((decision) => {
      const chosen = decision.alternatives?.[0]
      const alternative = decision.alternatives?.[1]
      if (chosen === undefined || alternative === undefined) return null
      return {
        tick: decision.tick,
        action: decision.action,
        target: decision.target,
        chosen: chosen.defId,
        alternative: alternative.defId,
        gap: chosen.score - alternative.score,
        explanation: decision.explanation,
      }
    })
    .filter((moment): moment is LostMoment => moment !== null)
  return candidates
    .sort((a, b) => (a.gap !== b.gap ? a.gap - b.gap : b.tick - a.tick))
    .slice(0, max)
}

/** 反事實快照點（Prompt 10.5c）：投降局用投降 tick 三等分；正常局用全場三等分。 */
export function counterfactualPoints(replay: ReplayRecord): number[] {
  if (replay.surrender !== undefined) return surrenderSnapshotTicks(replay)
  const total = replay.durationTicks
  const out: number[] = []
  for (const fraction of [1 / 3, 2 / 3, 1]) {
    const tick = Math.round(total * fraction)
    if (tick <= 0) continue
    const last = out[out.length - 1]
    if (last !== undefined && tick - last < 40) {
      out[out.length - 1] = tick
      continue
    }
    out.push(tick)
  }
  if (out.length === 0) out.push(total)
  return out
}

/** 快照時刻的政策（時間線重建），供「從快照重玩」寫入初始政策。 */
export function policiesAt(replay: ReplayRecord, tick: number): PolicyValues | null {
  if (replay.initialPolicies === undefined) return null
  return buildPolicyTimeline(replay.initialPolicies, replay.policyEvents, replay.tempoEvents ?? []).at(tick)
}

/**
 * 「以此建議重玩」的初始政策：快照時刻政策＋單一維度覆寫。
 * 語義（Prompt 10.5c 降級決策）：從 tick 0、同規則開新局——**不是**從中途
 * 接管（中途注入需 session 快照支援，暫不做）。
 */
export function replayPoliciesOf(
  replay: ReplayRecord,
  tick: number,
  key: string,
  to: number,
): PolicyValues | null {
  const base = policiesAt(replay, tick)
  if (base === null) return null
  if (key === 'aggression' || key === 'econMilitary' || key === 'retreatThreshold') {
    return { ...base, [key]: to }
  }
  return base
}
