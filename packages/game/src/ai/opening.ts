import { STRATEGIC_INTERVAL_TICKS, runStrategicCycle } from './strategy.ts'
import type { PolicyValues } from './policy.ts'
import { DEFAULT_POLICIES } from './policy.ts'
import { createWorld, stepWorld } from '../sim/world.ts'
import type { PlayerId } from '../sim/types.ts'
import type { ContentPack } from '@auto-2d-px-rts/shared'

/**
 * 開局預測（Prompt 10.5 完整版：戰前頁「快照模擬跑 60 秒」）：
 * headless 跑一段短對局（默認 1200 tick = 60 秒），收集我方戰略層
 * 實際執行的動作——**真 AI 真模擬**，不是規則推演；與對局本體共用同一套
 * sim＋戰略層（確定性：同 seed 同滑桿 → 同預測）。
 *
 * - 預測與正式對局的差異只在 seed（預測固定 42——地圖/開局佈局來自
 *   content pack 靜態資料不變；命運抽籤只影響同分候選的次序抖動）。
 * - 每個戰略循環（40 tick）對**我方**跑一次 `runStrategicCycle`；
 *   敵方不跑（預測頁只關心玩家 AI 的開局計劃）。
 * - 純計算、無 I/O；1200 tick × 全量 sim 在桌面瀏覽器約 <0.5s（CLI 24-seed
 *   tally 跑 24×12000 tick 為量級上界參照）。
 */

/** 一條開局預測動作（生產或建造）。 */
export interface OpeningAction {
  readonly tick: number
  readonly action: 'build' | 'train'
  /** train = 單位 defId；build = 建築 defId。 */
  readonly target: string
  /** 一行中文解釋（explain.ts 模板，與對局內決策日誌同源）。 */
  readonly explanation: string
}

/** 開局預測結果。 */
export interface OpeningPlan {
  readonly ticks: number
  /** 我方 AI 實際執行的動作時間線（按 tick 升冪）。 */
  readonly actions: readonly OpeningAction[]
  /** 60 秒末我方藍水晶存量（預測經濟曲線的單點摘要）。 */
  readonly finalCrystal: number
  /** 60 秒末我方各單位生產（完成進隊列＋出生）統計：defId → 數量。 */
  readonly trainCounts: Readonly<Record<string, number>>
}

/** 跑 60 秒（默認）headless 開局模擬，回傳我方 AI 的生產/建造計劃。 */
export function simulateOpening(
  content: ContentPack,
  options: {
    ticks?: number
    seed?: number
    policies?: PolicyValues
    playerId?: PlayerId
  } = {},
): OpeningPlan {
  const ticks = options.ticks ?? 1200
  const seed = options.seed ?? 42
  const policies = options.policies ?? DEFAULT_POLICIES
  const playerId = options.playerId ?? 'player'

  const world = createWorld(content, seed)
  const actions: OpeningAction[] = []
  const trainCounts: Record<string, number> = {}

  while (world.tick < ticks) {
    stepWorld(world)
    if (world.tick % STRATEGIC_INTERVAL_TICKS === 0) {
      const result = runStrategicCycle(world, playerId, policies)
      for (const action of result.actions) {
        actions.push({
          tick: world.tick,
          action: action.kind,
          target: action.defId,
          explanation: recordExplanation(result, action),
        })
        if (action.kind === 'train') {
          trainCounts[action.defId] = (trainCounts[action.defId] ?? 0) + 1
        }
      }
    }
  }
  actions.sort((a, b) => a.tick - b.tick)

  const player = world.players.find((candidate) => candidate.id === playerId)
  return {
    ticks,
    actions,
    finalCrystal: player?.resources.blue_crystal ?? 0,
    trainCounts,
  }
}

/** 從戰略循環的決策記錄找出該動作的一行解釋（找不到給動作本身）。 */
function recordExplanation(
  result: { records: ReadonlyArray<{ action: string; target: string; reason: { explanation: string } }> },
  action: { kind: 'build' | 'train'; defId: string },
): string {
  const found = result.records.find(
    (record) => record.action === action.kind && record.target.startsWith(action.defId),
  )
  return found?.reason.explanation ?? action.defId
}
