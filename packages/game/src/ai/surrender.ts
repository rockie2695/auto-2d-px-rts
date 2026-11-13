/**
 * AI 投降判定（階段三 Prompt 8.6）：
 *
 * 設計原則：投降不是「輸了就投」，是**確認無法翻盤才投**——
 * 1. **絕望指數**（0..1）：戰力／收入／領土／時間／科技五項劣勢的加權和；
 * 2. **持續性**：連續 `sustainSec` 秒超過有效閾值才投（一時劣勢不算）；
 * 3. **態度修正**：aggression 高 → 更不願投（threshold 上調）；
 * 4. 下限：對局不足 `minGameTimeSec` 不判定（開局波動不算）。
 *
 * 純邏輯層：判定函式只讀 World ＋ 就地更新**持續性追蹤**與**投降狀態**
 * （都是 sim 狀態，確定性受 seed 保證）；行為閘門（停火／停生產）在 sim 層。
 */

import { DEFAULT_AI_SURRENDER_CONFIG, TICK_RATE_HZ } from '@auto-2d-px-rts/shared'
import type { AiSurrenderConfig } from '@auto-2d-px-rts/shared'
import type { PolicyValues } from './policy.ts'

import { producedResourceOf } from '../sim/economy.ts'
import { applySurrender, surrenderIncomeOf, surrenderPowerOf } from '../sim/surrender.ts'
import type { PlayerId, World } from '../sim/types.ts'

// Prompt 10.6：`surrenderPowerOf` 下移到 sim 層（玩家/AI 投降同口徑）；此處 re-export
// 保持既有公開 API（surrender.test 從本模組匯入）。
export { surrenderPowerOf } from '../sim/surrender.ts'

/** 陣營投降配置（缺省 → 默認值）。 */
export function surrenderConfigOf(world: World): AiSurrenderConfig {
  return world.faction.aiSurrenderConfig ?? DEFAULT_AI_SURRENDER_CONFIG
}

/** 秒 → tick。 */
function secToTicks(sec: number): number {
  return Math.round(sec * TICK_RATE_HZ)
}

/** 有效當量戰力（Prompt 3.1）：已下移至 sim/surrender.ts（本模組 re-export）。 */

/** 最近窗口的三資源收入總和（Prompt 5 指定 API 的逐資源加總；Prompt 10.6 起走 sim 同函式）。 */
function incomeOf(world: World, playerId: PlayerId): number {
  return surrenderIncomeOf(world, playerId)
}

/** 綠翡翠生產建築數（聖所數＝科技等級；techGap 標尺 /3）。 */
function techLevelOf(world: World, playerId: PlayerId): number {
  return world.buildings.filter((building) => {
    if (building.player !== playerId || building.hp <= 0) return false
    const buildingDef = world.defs.buildings[building.defId]
    return buildingDef !== undefined && producedResourceOf(buildingDef) === 'green_emerald'
  }).length
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** 絕望指數的成分（記錄／測試斷言用）。 */
export interface DespairComponents {
  readonly powerGap: number
  readonly incomeGap: number
  readonly territoryLoss: number
  readonly timePressure: number
  readonly techGap: number
}

/** 絕望指數（Prompt 8.6 公式；權重吃陣營配置）。 */
export function despairOf(
  world: World,
  playerId: PlayerId,
  config: AiSurrenderConfig = surrenderConfigOf(world),
): { despair: number; components: DespairComponents } {
  const playerIdOther = playerId === 'player' ? 'enemy' : 'player'
  const myPower = surrenderPowerOf(world, playerId)
  const enemyPower = surrenderPowerOf(world, playerIdOther)
  const powerGap = clamp01((enemyPower - myPower) / (enemyPower + myPower + 1))

  const myIncome = incomeOf(world, playerId)
  const enemyIncome = incomeOf(world, playerIdOther)
  const incomeGap = clamp01((enemyIncome - myIncome) / (enemyIncome + myIncome + 0.01))

  const initial = world.initialBuildingCount[playerId] ?? 0
  const buildingCount = world.buildings.filter(
    (building) => building.player === playerId && building.hp > 0,
  ).length
  const territoryLoss = clamp01(initial > 0 ? 1 - buildingCount / initial : 0)

  const elapsed = world.tick / TICK_RATE_HZ
  const minGame = config.minGameTimeSec
  const timePressure = clamp01((elapsed - minGame) / (600 - minGame))

  const myTech = techLevelOf(world, playerId)
  const enemyTech = techLevelOf(world, playerIdOther)
  const techGap = clamp01((enemyTech - myTech) / 3)

  const w = config.weights
  const despair =
    w.power * powerGap +
    w.income * incomeGap +
    w.territory * territoryLoss +
    w.time * timePressure +
    w.tech * techGap
  return { despair, components: { powerGap, incomeGap, territoryLoss, timePressure, techGap } }
}

/**
 * 有效投降閾值（Prompt 8.6 修正項；夾 ≤ 1——各政策全域 10–90% 開 ↔
 * 修正 ≤ 0.22，不會被夾掉，夾值只是防禦性上限）。
 */
export function surrenderThresholdOf(config: AiSurrenderConfig, policies: PolicyValues): number {
  const raw =
    config.surrenderThreshold +
    0.1 * policies.aggression +
    0.05 * policies.reserve +
    0.08 * policies.techRush
  return Math.min(1, raw)
}

/** 投降判定結果（供 strategy 的 DecisionRecord 與 session 日誌）。 */
export interface SurrenderCheck {
  /** 本次檢查的絕望指數（每戰略循環 1 次）。 */
  readonly despair: number
  readonly components: DespairComponents
  readonly threshold: number
  /** 本次檢查是否觸發投降。 */
  surrendered: boolean
}

/**
 * 戰略循環內的投降檢查（每 `STRATEGIC_INTERVAL_TICKS` 調 1 次＝每 2 秒）：
 * - 對局不足 `minGameTimeSec` → 不判定（並清持續性計時）；
 * - 絕望 ≤ 閾 → 清持續性計時（連續性要求）；
 * - 絕望 > 閾 且持續 ≥ `sustainSec` → **投降**：寫 `world.surrender`、
 *   停該方一切行動（清生產隊列、斷單位移動與攻擊目標——行為閘門由 sim 層
 *   的每 tick 檢查兜底）。
 *
 * 單位順序確定性：單位/建築遍歷按現有陣列序（與 sim 其餘部分一致）。
 */
export function checkSurrender(
  world: World,
  playerId: PlayerId,
  policies: PolicyValues,
): SurrenderCheck {
  const config = surrenderConfigOf(world)
  const { despair, components } = despairOf(world, playerId, config)
  const threshold = surrenderThresholdOf(config, policies)
  const check: SurrenderCheck = { despair, components, threshold, surrendered: false }

  // 未過下限：不判定，並重置持續性計時（時間本身也是成分之一）。
  if (world.tick < secToTicks(config.minGameTimeSec)) {
    world.despairBreachSince[playerId] = null
    return check
  }
  if (despair <= threshold) {
    world.despairBreachSince[playerId] = null
    return check
  }

  const startedAt = world.despairBreachSince[playerId]
  if (startedAt === null || startedAt === undefined) {
    world.despairBreachSince[playerId] = world.tick // 首次超閾：開始計時
    return check
  }
  const sustainedTicks = world.tick - startedAt
  if (sustainedTicks < secToTicks(config.sustainSec)) {
    return check // 持續中但未滿 sustainSec
  }

  // ---- 投降定案（Prompt 10.6 起與玩家手動投降共用 sim 定案）----
  applySurrender(world, playerId, despair)
  check.surrendered = true
  return check
}
