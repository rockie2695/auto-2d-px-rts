import type { ContentPack } from '@auto-2d-px-rts/shared'

import { clampSlider, DEFAULT_POLICIES, resolvePolicies } from './policy.ts'
import type { PolicyOverrides, PolicyValues } from './policy.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './strategy.ts'
import { computeTacticalPlan, TACTICAL_INTERVAL_TICKS } from './tactics.ts'
import { MICRO_INTERVAL_TICKS, runMicroCycle } from './micro.ts'
import { createWorld, stepWorld } from '../sim/world.ts'
import { matchEnded, resolveMatchResult } from '../sim/matchResult.ts'
import type { PlayerId } from '../sim/types.ts'
import type { TacticalPlan } from './tactics.ts'
import type {
  MatchResult,
  ReplayInitialPolicies,
  ReplayPolicyEvent,
  ReplayRecord,
  ReplayTempoEvent,
} from '../replay.ts'

/**
 * 反事實引擎（Prompt 10.5c）：**headless 確定性重放**——
 *
 * - `buildPolicyTimeline`：開局政策快照（replay.initialPolicies）＋政策事件
 *   ＋節奏事件 → 任意 tick 時刻的我方政策（純函數，與正式對局同語義：
 *   滑桿變更在下一個戰略／戰術週期生效）。
 * - `replayMatch`：同 seed 從 tick 0 重放整場（三層 AI 全開），可選自
 *   `overrideTick` 起換一組我方滑桿——「如果當時改成 X」的真實對局結果，
 *   不是規則推演。重放結果與原局一致（同 seed 同時間線無覆寫）是確定性驗收。
 * - 成本：一場重放 ≤ 原局時長（呼叫端以 `maxTicks = replay.durationTicks`
 *   封頂——結果在那裡已定案）；UI 端異步分批跑＋「計算中」狀態。
 */

const RESOURCE_BIAS_PREFIX = 'resourceBias.'

/** 扁平滑桿 map（replay.initialPolicies.sliders 同鍵）→ PolicyValues（夾緊）。 */
export function policiesFromSliders(
  sliders: Readonly<Record<string, number>>,
  tempoPreset: string,
): PolicyValues {
  const overrides: PolicyOverrides = { tempoPreset: tempoPreset as PolicyValues['tempoPreset'] }
  for (const [key, value] of Object.entries(sliders)) {
    if (key.startsWith(RESOURCE_BIAS_PREFIX)) {
      const sub = key.slice(RESOURCE_BIAS_PREFIX.length)
      if (sub !== 'blue' && sub !== 'red' && sub !== 'green') continue
      overrides.resourceBias = { ...overrides.resourceBias, [sub]: value }
      continue
    }
    // 已知數值滑桿才採用（未知鍵忽略——向前相容）。
    if (key in DEFAULT_POLICIES && typeof value === 'number') {
      ;(overrides as Record<string, number>)[key] = value
    }
  }
  return resolvePolicies(overrides)
}

/** 我方政策時間線：任意 tick 時刻的生效政策（初始值＋事件重放）。 */
export interface PolicyTimeline {
  /** 該 tick（含）之前最後一次變更後的政策；tick 0 = 開局值。 */
  at(tick: number): PolicyValues
}

/**
 * 組政策時間線：`initialPolicies` 為底、按 tick 升冪疊加 policyEvents
 * （滑桿逐鍵，`resourceBias.blue|red|green` 深合併）與 tempoEvents（整體覆蓋）。
 * 事件 tick 相同時按陣列序疊加（recorder 依發生序追加）。
 */
export function buildPolicyTimeline(
  initial: ReplayInitialPolicies,
  policyEvents: readonly ReplayPolicyEvent[] = [],
  tempoEvents: readonly ReplayTempoEvent[] = [],
): PolicyTimeline {
  const events = [...policyEvents].sort((a, b) => a.tick - b.tick)
  const tempos = [...tempoEvents].sort((a, b) => a.tick - b.tick)
  return {
    at(tick: number): PolicyValues {
      const sliders: Record<string, number> = { ...initial.sliders }
      let tempoPreset = initial.tempoPreset
      for (const event of events) {
        if (event.tick > tick) break
        sliders[event.key] = event.to
      }
      for (const event of tempos) {
        if (event.tick > tick) break
        tempoPreset = event.to
      }
      return policiesFromSliders(sliders, tempoPreset)
    },
  }
}

/** 一場 headless 重放的結局（與正式對局同一判定語義：resolveMatchResult）。 */
export interface ReplayOutcome {
  readonly result: MatchResult
  /** 重放實際跑到結束的 tick（≤ maxTicks）。 */
  readonly durationTicks: number
  /** 若以投降定案：投降方；否則 null。 */
  readonly surrenderedBy: PlayerId | null
  /** 重放終點雙方藍水晶存量（UI 顯示「重放 60 秒末水晶」與差異斷言用）。 */
  readonly finalCrystal: { player: number; enemy: number }
  /** 重放終點雙方存活單位數。 */
  readonly aliveUnits: { player: number; enemy: number }
}

export interface ReplayMatchOptions {
  /** 對局種子（＝replay.seed——重放可復現的前提）。 */
  readonly seed: number
  /** 我方政策時間線（＝原局玩家行為）。 */
  readonly timeline: PolicyTimeline
  /** 敵方政策（預設 DEFAULT_POLICIES——與正式對局一致）。 */
  readonly enemyPolicies?: PolicyValues
  /** 反事實覆寫：自 `overrideTick`（含）起我方改用這組值（其餘欄位沿用時間線）。 */
  readonly overrides?: Partial<PolicyValues>
  /** 覆寫生效 tick（預設 = 不覆寫給一個超局時長的值）。 */
  readonly overrideTick?: number
  /** 成本上限：跑到此 tick 為止（呼叫端傳 replay.durationTicks 封頂）。 */
  readonly maxTicks?: number
}

/**
 * 從 tick 0 重放整場對局（可選中途覆寫）：三層 AI 全開、敵我照常，
 * 與 session／CLI 組合根同一語義（戰略 40／戰術 10／微操 2 tick、
 * 投降方停決策、tick 0 先算一次戰術計畫）。
 */
export function replayMatch(content: ContentPack, options: ReplayMatchOptions): ReplayOutcome {
  const overrideTick = options.overrideTick ?? Number.POSITIVE_INFINITY
  const maxTicks = options.maxTicks ?? Number.POSITIVE_INFINITY
  const world = createWorld(content, options.seed)
  const policies: Record<PlayerId, PolicyValues> = {
    player: options.timeline.at(0),
    enemy: options.enemyPolicies ?? DEFAULT_POLICIES,
  }
  const plans: Record<PlayerId, TacticalPlan | null> = {
    player: null,
    enemy: null,
  }
  // tick 0 先算一次戰術計畫（同 session／CLI——微操層從第 1 tick 起有小隊目標）。
  for (const player of world.players) {
    plans[player.id] = computeTacticalPlan(world, player.id, policies[player.id])
  }
  let microCycleIndex = 0
  while (world.tick < maxTicks && !matchEnded(world)) {
    stepWorld(world)
    if (world.tick % STRATEGIC_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        // 投降方停 AI 決策（sim 停產／停火兜底——同 session）。
        if (world.surrender?.player === player.id) continue
        if (player.id === 'player' && world.tick >= overrideTick && options.overrides !== undefined) {
          policies.player = resolvePolicies({ ...policies.player, ...options.overrides })
        }
        runStrategicCycle(world, player.id, policies[player.id])
      }
    }
    if (world.tick % TACTICAL_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        if (world.surrender?.player === player.id) continue
        plans[player.id] = computeTacticalPlan(world, player.id, policies[player.id], plans[player.id])
      }
    }
    if (world.tick % MICRO_INTERVAL_TICKS === 0) {
      microCycleIndex += 1
      for (const player of world.players) {
        if (world.surrender?.player === player.id) continue
        runMicroCycle(world, player.id, plans[player.id])
      }
    }
  }
  const crystalOf = (playerId: PlayerId): number =>
    world.players.find((player) => player.id === playerId)?.resources.blue_crystal ?? 0
  const aliveOf = (playerId: PlayerId): number =>
    world.units.filter((unit) => unit.player === playerId && unit.hp > 0).length
  return {
    result: resolveMatchResult(world),
    durationTicks: world.tick,
    surrenderedBy: world.surrender?.player ?? null,
    finalCrystal: { player: crystalOf('player'), enemy: crystalOf('enemy') },
    aliveUnits: { player: aliveOf('player'), enemy: aliveOf('enemy') },
  }
}

/* ------------------------------------------------------------------ */
/* 建議生成（規則式、確定性）                                           */
/* ------------------------------------------------------------------ */

/** 建議的三個維度：方向＝「輸家往另一個體制試一步」（±0.25，夾緊）。 */
const SUGGESTION_DIMENSIONS: ReadonlyArray<{
  key: 'aggression' | 'econMilitary' | 'retreatThreshold'
  label: string
  /** 基準方向（+1 = 增、−1 = 減）；撞邊界（值不變）時翻轉。 */
  step: 1 | -1
}> = [
  { key: 'aggression', label: 'aggression（強攻度）', step: 1 }, // 更積極出擊
  { key: 'econMilitary', label: 'econMilitary（軍事↔經濟）', step: -1 }, // 更偏軍事
  { key: 'retreatThreshold', label: 'retreatThreshold（撤退閾值）', step: -1 }, // 更死戰不退
]

/** 一條反事實建議（單一維度 ±0.25 的重放結局）。 */
export interface CounterfactualSuggestion {
  readonly key: string
  /** 中文標籤（含滑桿 id——與政策面板文案同風格）。 */
  readonly label: string
  readonly from: number
  readonly to: number
  /** 自 snapshotTick 起套用此覆寫的重放結局。 */
  readonly outcome: ReplayOutcome
}

/** 投降局的三個關鍵快照點：投降 tick 的 1/3、2/3、整點（去重——極短局保留整點）。 */
export function surrenderSnapshotTicks(replay: ReplayRecord): number[] {
  const surrender = replay.surrender
  if (surrender === undefined) return []
  const total = surrender.tick
  const out: number[] = []
  for (const fraction of [1 / 3, 2 / 3, 1]) {
    const tick = Math.round(total * fraction)
    if (tick <= 0) continue
    const last = out[out.length - 1]
    if (last !== undefined && tick - last < 40) {
      out[out.length - 1] = tick // 太近 → 以後點取代（投降整點最關鍵）
      continue
    }
    out.push(tick)
  }
  if (out.length === 0) out.push(total)
  return out
}

/**
 * 一個快照點的反事實建議（Prompt 10.5c 區塊三）：三維度各一條，
 * 每條跑一場完整重放（同步、純計算——UI 端自行分批包異步）。
 */
export function suggestCounterfactuals(
  content: ContentPack,
  replay: ReplayRecord,
  timeline: PolicyTimeline,
  snapshotTick: number,
): CounterfactualSuggestion[] {
  const base = timeline.at(snapshotTick)
  const suggestions: CounterfactualSuggestion[] = []
  for (const dimension of SUGGESTION_DIMENSIONS) {
    const from = base[dimension.key]
    let to = clampSlider(from + dimension.step * 0.25)
    if (to === from) to = clampSlider(from - dimension.step * 0.25) // 撞邊界翻轉
    if (to === from) continue // 兩向都無變化（理論上不會：值域 [0,1]）
    const outcome = replayMatch(content, {
      seed: replay.seed,
      timeline,
      overrides: { [dimension.key]: to },
      overrideTick: snapshotTick,
      maxTicks: replay.durationTicks,
    })
    suggestions.push({ key: dimension.key, label: dimension.label, from, to, outcome })
  }
  return suggestions
}
