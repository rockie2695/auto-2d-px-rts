import type { Application, Ticker } from 'pixi.js'
import type { ResourceId } from '@auto-2d-px-rts/shared'

import { MICRO_INTERVAL_TICKS, microRecords, runMicroCycle } from './ai/micro.ts'
import type { MicroDecision, MicroRecordState } from './ai/micro.ts'
import { DEFAULT_POLICIES, resolvePolicies } from './ai/policy.ts'
import { POLICY_IDS } from '@auto-2d-px-rts/shared'
import type { PolicyValues } from './ai/policy.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './ai/strategy.ts'
import type { DecisionRecord } from './ai/strategy.ts'
import { pickMostUrgentThreat, computeInfluenceMap } from './ai/influence.ts'
import type { InfluenceMap } from './ai/influence.ts'
import { visibleTileMask } from './ai/sight.ts'
import { computeEngageLines } from './sim/combat.ts'
import { armorTierOf } from './render/armor.ts'
import {
  computeTacticalPlan,
  SUDDEN_DEATH_HARD_TICK,
  SUDDEN_DEATH_START_TICK,
  TACTICAL_INTERVAL_TICKS,
} from './ai/tactics.ts'
import type { Squad, TacticalPlan, TacticalRecord } from './ai/tactics.ts'
import { loadContentPackFromFetch } from './data/loadFromFetch.ts'
import { ReplayRecorder, REPLAY_SAMPLE_INTERVAL_TICKS } from './replay.ts'
import type { MatchResult, ReplayRecord } from './replay.ts'
import type { GameScene, MapMarker } from './render/scene.ts'
import type { PlayerId, ResourceStock, World } from './sim/types.ts'
import { buildingEffectiveMaxHp, tileOf } from './sim/types.ts'
import { GameLoop } from './sim/gameLoop.ts'
import { createWorld, snapshotWorld } from './sim/world.ts'
import type { WorldSnapshot } from './sim/world.ts'
import { effectiveHp } from './sim/combat.ts'
import { getIncome } from './sim/economy.ts'

/** 對局預設種子（CLI 對照用；瀏覽器對局每場隨機取種，見 `matchSeed`）。 */
export const SEED = 42

/**
 * 戰前頁選定的初始政策（Prompt 10.5 完整版）：模組級 pending——
 * `setInitialPolicies` 由戰前頁寫入，下一次 `startGameSession` 消費後清空。
 * 未設定 → `DEFAULT_POLICIES`（與既有行為一致）。
 */
let pendingInitialPolicies: Partial<PolicyValues> | null = null

export function setInitialPolicies(values: Partial<PolicyValues>): void {
  pendingInitialPolicies = values
}

function consumeInitialPolicies(): PolicyValues {
  const pending = pendingInitialPolicies
  pendingInitialPolicies = null
  return pending === null ? DEFAULT_POLICIES : resolvePolicies(pending)
}

/**
 * 最近一次結束對局的 replay（Prompt 10.5 完整版路由傳遞）：`/post-game` 頁
 * mount 時讀取；null = 沒有可復盤的對局（導回 /pre-game）。模組級——
 * 不進 render state，頁面重新掛載（react-router 切換）也不丟。
 */
let lastReplay: ReplayRecord | null = null

export function getLastReplay(): ReplayRecord | null {
  return lastReplay
}

/** 本場對局的種子：每場隨機（同一場內確定性不變，種子記錄進 replay 可重播）。 */
function matchSeed(): number {
  return Math.floor(Math.random() * 2 ** 31)
}

/**
 * 決策日誌單條（Prompt 9.5：左下面板顯示；戰略紀錄＋戰術小隊變動＋政策變更；
 * Prompt 8.5 起含微操層戰鬥狀態切換記錄）。
 */
export interface DecisionLogEntry {
  /** 單調遞增序號（面板 key 用；同 tick 同文字的兩條也不會撞）。 */
  readonly sequence: number
  readonly tick: number
  readonly layer: 'strategic' | 'tactical' | 'policy' | 'micro'
  readonly actor: PlayerId
  /** 一行中文：動作＋原因（戰略例 `build mine（…）`）。 */
  readonly text: string
  /**
   * 候選與主導因素（Prompt 9.5 完整版）：**只掛在戰略層條目**——點擊展開
   * 候選分數柱狀圖用。其他層（戰術／政策／微操）無此欄（undefined）。
   */
  readonly candidates?: readonly { readonly defId: string; readonly score: number }[]
  readonly topFactor?: string
  /**
   * 決策目標單位的裝甲分檔（Prompt 9.5 完整版：重裝甲紫／超重裝甲金標籤）。
   * 戰略 train 條目＝目標單位檔；build／其他層＝'none'（undefined 視同 none）。
   */
  readonly armorTier?: 'none' | 'light' | 'medium' | 'heavy' | 'ultra'
}

/** 小隊狀態單條（Prompt 9.5：右下面板，一行一隊）。 */
export interface SquadInfo {
  readonly player: PlayerId
  readonly index: number
  readonly mission: string
  /** 任務目標格（defend = 集結點）。 */
  readonly targetX: number
  readonly targetY: number
  readonly memberCount: number
  /** 隊伍戰力（戰術層 Σ value × hp/maxHp）。 */
  readonly power: number
  /** 隊伍重心到目標格的距離（格，里程整數）。 */
  readonly distTiles: number
  /** 接觸迎戰中（Prompt 10.15；右下面板黃燈＝交戰，Prompt 9.5 完整版）。 */
  readonly engaging: boolean
}

/** 一個 tier 的 HP 堆疊數據（Prompt 9.5 完整版：右上戰力對比）。 */
export interface TierHp {
  /** 現值 HP 總和（原始）。 */
  readonly rawHp: number
  /** 有效 HP 總和 = Σ hp/(1−armor)（Prompt 3.1 當量）。 */
  readonly effHp: number
}

/** 三個 tier（small/medium/large）→ HP 堆疊；無該 tier 單位時為 0。 */
export type TierHpTable = Readonly<Record<'small' | 'medium' | 'large', TierHp>>

/** 戰況快查（Prompt 9.5：四角面板一次取齊，500ms 級輪詢夠用）。 */
export interface BattleStats {
  readonly tick: number
  /** 對局長度上限（tick，時鐘倒數用）。 */
  readonly maxTicks: number
  readonly playerCrystal: number
  readonly enemyCrystal: number
  /** 三資源庫存（Prompt 5：藍水晶＋紅寶石＋綠翡翠）。 */
  readonly playerResources: ResourceStock
  readonly enemyResources: ResourceStock
  /** 三資源收入率（每秒；Prompt 5 getIncome 60 tick 窗 ÷ 3s）。 */
  readonly playerIncomes: Record<ResourceId, number>
  readonly enemyIncomes: Record<ResourceId, number>
  /** 雙方存活單位數（圖表「單位數量」模式取樣用）。 */
  readonly playerUnits: number
  readonly enemyUnits: number
  /** Σ hp/(1−armor) × dmg × attackSpeed（Prompt 3.1 有效當量）；雙方存活單位合計。 */
  readonly playerPower: number
  readonly enemyPower: number
  /** 雙方 per-tier HP 堆疊（Prompt 9.5 完整版：右上原始／有效 HP 兩根堆疊條）。 */
  readonly playerTiers: TierHpTable
  readonly enemyTiers: TierHpTable
  readonly log: readonly DecisionLogEntry[]
  readonly squads: readonly SquadInfo[]
}

/** 目前生效的對局（由 `startGameSession` 註冊、stop 或換局時清除）。 */
let activeSession: GameSession | null = null

/** ui 面板輪詢讀取目前的對局；無對局（尚未載入／已停止）回傳 null。 */
export function getActiveSession(): GameSession | null {
  return activeSession
}

/** 單位資訊（ui 面板顯示用，Prompt 9 驗收：點單位看到資訊）。 */
export interface UnitInfo {
  readonly id: number
  readonly defId: string
  readonly player: PlayerId
  readonly hp: number
  readonly maxHp: number
  readonly tileX: number
  readonly tileY: number
  /** 最新的微操決策原因（中文）；無決策為 null。 */
  readonly decision: string | null
  /** 所屬小隊任務；未編隊為 null。 */
  readonly squadMission: string | null
  /** 攻擊射程（格，Prompt 10.13 單位資訊）。 */
  readonly rangeTiles: number
  /** 移動速度（格/秒，Prompt 10.13 單位資訊）。 */
  readonly moveSpeedTilesPerSec: number
  /** 裝甲（減傷百分比 0~0.8，Prompt 3.1；顯示「裝甲」不用「護甲」）。 */
  readonly armor: number
  /** 有效 HP = maxHp / (1 − armor)（Prompt 3.1）。 */
  readonly effHp: number
  /** DPS = dmg × attackSpeed（Prompt 3.1）。 */
  readonly dps: number
}

/** 建築資訊（ui 面板顯示用，Prompt 9.1 驗收：點建築看到資訊）。 */
export interface BuildingInfo {
  readonly id: number
  readonly defId: string
  readonly player: PlayerId
  readonly hp: number
  /** 當前實際上限：未完工按完成比例折算（SPEC §5）。 */
  readonly effMaxHp: number
  /** 建造進度（0–100，100 = 已完工）。 */
  readonly progressPct: number
  /** 佔地（格）。 */
  readonly w: number
  readonly h: number
  /** 佔地左上角（格）。 */
  readonly tileX: number
  readonly tileY: number
}

/** 出廠集合格標記資訊（ui 面板顯示用，Prompt 10.17：點標記看名稱與說明）。 */
export interface MarkerInfo {
  readonly kind: 'gather'
  readonly player: PlayerId
  readonly tileX: number
  readonly tileY: number
  /** 名稱（例：「我方兵營出廠集合格」）。 */
  readonly title: string
  /** 一行說明（用途與選點規則）。 */
  readonly description: string
}

/** 政策冷卻：30 秒 × 20Hz = 600 tick（Prompt 10：對局中每 30 秒才能改一次滑桿）。 */
export const POLICY_COOLDOWN_TICKS = 600

/* ------------------------------------------------------------------ */
/* 對局結束與勝負判定（Prompt 10.5，純函數供測試）                      */
/* ------------------------------------------------------------------ */
/* Prompt 8.6：抽出至 `sim/matchResult.ts`（無渲染依賴，session 與 CLI 共用 */
/* 同一語義來源）。此處 re-export 維持既有 import 路徑不變。               */

export { matchEnded, matchSideValue, resolveMatchResult } from './sim/matchResult.ts'

import { matchEnded, resolveMatchResult } from './sim/matchResult.ts'
import { surrenderPlayer } from './sim/surrender.ts'

/**
 * 突變期敘事文字（Prompt 10.23）：只在突變期起點／硬期限的**那一 tick** 回傳
 * 條目文字（每陣營記一條 tactical 日誌），其餘 tick 回傳 null——純敘事、
 * 不影響任何決策與模擬結果。
 */
export function suddenDeathLogText(tick: number): string | null {
  if (tick === SUDDEN_DEATH_START_TICK) return '突變期啟動：出兵門檻逐檔遞減'
  return tick === SUDDEN_DEATH_HARD_TICK ? '突變期硬期限：全軍出擊' : null
}

/** 政策滑桿快照（Prompt 10：下方面板輪詢讀取）。 */
export interface PolicySnapshot {
  /** 目前生效的 5 個滑桿值。 */
  readonly values: PolicyValues
  /** 距離下次可變更還需等待的 tick 數；0 = 可立即變更。 */
  readonly cooldownRemainingTicks: number
  /** 目前 AI 決策摘要：該玩家最後一條戰略日誌文字；尚無為 null。 */
  readonly summary: string | null
  /** 當前世界 tick（Prompt 10 完整版）：節奏覆蓋預覽高亮「當前所處時間窗」用。 */
  readonly tick: number
  /** 本方是否已投降（Prompt 10.6）：投降後政策鎖定、投降按鈕隱藏。 */
  readonly surrendered: boolean
}

export interface GameSession {
  readonly scene: GameScene
  /** 最新一份世界快照（插值的「當前」幀）。 */
  getSnapshot(): WorldSnapshot | null
  getUnitInfo(unitId: number): UnitInfo | null
  getBuildingInfo(buildingId: number): BuildingInfo | null
  /** 目前的地圖標記（Prompt 10.17）：供 ui 層拾取（單位／建築優先權在 ui 端處理）。 */
  getMarkers(): readonly MapMarker[]
  /** 標記資訊（Prompt 10.17）：名稱與說明；查無回 null。 */
  getMarkerInfo(ref: { kind: 'gather'; player: PlayerId; buildingId: number }): MarkerInfo | null
  /** 四角面板（Prompt 9.5）一次取齊的戰況。 */
  getBattleStats(): BattleStats
  /**
   * 影響力粗格（Prompt 9.5 完整版：熱力圖疊加層數據源）。
   * 以 tick 為鍵緩存——同一 tick 內重複呼叫回同一物件（UI 500ms 輪詢不重算）。
   */
  getInfluence(): InfluenceMap
  /** 疊加層開關（Prompt 9.5 完整版）：只切場景容器 visible，不影響 sim。 */
  setOverlays(opts: { heatmap: boolean; fog: boolean; paths: boolean }): void
  /** 熱力圖資料推入場景（UI 500ms 呼叫一次；開關關閉時場景自行忽略）。 */
  refreshInfluence(): void
  /** 政策滑桿（Prompt 10）：讀取某玩家的滑桿值與冷卻狀態。 */
  getPolicies(playerId: PlayerId): PolicySnapshot
  /**
   * 政策滑桿（Prompt 10）：套用某玩家的滑桿變更。
   * 冷卻中（上次變更後 600 tick 內）回傳 false；無實際變更不消耗冷卻。
   * 生效時機：即時換掉政策物件，下一個戰略／戰術週期讀到新值。
   */
  applyPolicies(
    playerId: PlayerId,
    values: Partial<Omit<PolicyValues, 'resourceBias'>> & {
      resourceBias?: Partial<PolicyValues['resourceBias']>
    },
  ): boolean
  /** 復盤（Prompt 10.5）：對局是否已結束；結束時帶完整 replay 紀錄。 */
  getOutcome(): { ended: boolean; replay: ReplayRecord | null }
  /** 復盤（Prompt 10.5）：手動提前結束（以當下狀態判勝負、停迴圈、產出 replay）。
   *  已結束時回傳 false。 */
  endMatch(): boolean
  /**
   * 投降（Prompt 10.6）：該方立即定案投降——停止一切行動，敵方 AI 照常運作
   * 3 秒（寬限）後對局結束、投降方判負；replay 記 `player_surrender` 事件
   * （含牆鐘 timestamp）。已投降／已結束回 false（幂等）。
   */
  surrender(playerId: PlayerId): boolean
  /** 停止 ticker 迴圈（卸載 PixiCanvas 前呼叫）。 */
  stop(): void
}

/**
 * 瀏覽器組合根（Prompt 9）：data + sim + ai + render 在此匯合，
 * 職責與 `aiCli.ts`（CLI 版組合根）相同，時間來源換成 Pixi ticker。
 *
 * - `app.ticker`（60fps）每幀 `GameLoop.advance(deltaMS, onTick)` 推進 20Hz 邏輯；
 *   AI 三層在 `onTick` 掛在精確的 tick 邊界（strategy 40 / tactics 10 / micro 2）。
 * - 每個 tick 完成、AI 下單後取一份 `snapshotWorld`；場景以
 *   `progressToNextTick` 為 alpha 在前後兩份快照之間插值（SPEC §2：20Hz 邏輯、60fps 渲染）。
 * - 政策滑桿（Prompt 10）：玩家側可由 ui 經 `applyPolicies` 變更（600 tick 冷卻），
 *   下一個戰略／戰術週期讀到新值；敵方固定預設值。
 */
export async function startGameSession(app: Application, scene: GameScene): Promise<GameSession> {
  const content = await loadContentPackFromFetch('/data')
  const seed = matchSeed()
  const world = createWorld(content, seed)
  scene.initialize(world)

  const loop = new GameLoop(world)
  const policies: Record<PlayerId, PolicyValues> = {
    // 戰前頁初始政策（Prompt 10.5 完整版）：戰前頁有設定 → 帶入；否則預設值。
    player: consumeInitialPolicies(),
    enemy: DEFAULT_POLICIES,
  }
  const plans: Record<PlayerId, TacticalPlan | null> = { player: null, enemy: null }
  // tick 0 先算一次戰術計畫（同 aiCli），讓微操層從第 1 tick 起就有小隊目標。
  for (const player of world.players) {
    plans[player.id] = computeTacticalPlan(world, player.id, policies[player.id])
  }
  // 出廠集合格標記（Prompt 10.19）：每間生產建築一個（陣營級「集結點」轉為
  // AI 內部概念，不再顯示——援引「玩家只看新兵會去哪」）。
  // 保留一份供拾取（Prompt 10.17：點標記看名稱／說明）。
  let markers: MapMarker[] = []
  const pushMarkers = (): void => {
    const next: MapMarker[] = []
    for (const player of world.players) {
      const plan = plans[player.id]
      if (plan === null) continue
      for (const spawn of plan.spawns) {
        next.push({ kind: 'gather', player: player.id, buildingId: spawn.buildingId, tile: spawn.tile })
      }
    }
    markers = next
    scene.setMarkers(next)
  }
  pushMarkers()
  // 每玩家最新的微操決策（Prompt 9.4：點單位顯示 AI 當下在想什麼）。
  const latestMicro: Record<PlayerId, MicroDecision[]> = { player: [], enemy: [] }
  // 微操層決策記錄狀態（Prompt 8.5）：每單位上次動作＋上次記錄循環（microRecords 就地更新）。
  const microRecordState: Record<PlayerId, MicroRecordState> = {
    player: new Map(),
    enemy: new Map(),
  }
  let microCycleIndex = 0
  // 決策日誌（Prompt 9.5：戰略紀錄＋戰術小隊變動；面板取最後 10 條）。
  const decisionLog: DecisionLogEntry[] = []
  // Prompt 9.5 完整版：保留上限 32 → 100（展開候選柱狀圖需要回看更多史）。
  const LOG_LIMIT = 100
  let logSequence = 0
  const pushLog = (entry: Omit<DecisionLogEntry, 'sequence'>): void => {
    logSequence += 1
    decisionLog.push({ ...entry, sequence: logSequence })
    while (decisionLog.length > LOG_LIMIT) {
      decisionLog.shift()
    }
  }

  // 政策滑桿（Prompt 10）：每次變更的 tick（冷卻 600 tick）；初始 -600 = 開局即可改。
  const lastPolicyChange: Record<PlayerId, number> = {
    player: -POLICY_COOLDOWN_TICKS,
    enemy: -POLICY_COOLDOWN_TICKS,
  }

  // 復盤紀錄（Prompt 10.5）：tick 0 起每 20 tick 取雙陣營樣本；政策變更即時記錄。
  const recorder = new ReplayRecorder()

  // 影響力粗格（Prompt 9.5 完整版）：以 tick 為鍵的緩存——同一 tick 內重複
  // 呼叫回同一物件；UI 500ms 熱力圖輪詢不重算，sim 決策亦不受影響（純觀測）。
  let influenceCache: { tick: number; map: InfluenceMap } | null = null
  const influenceOf = (): InfluenceMap => {
    if (influenceCache === null || influenceCache.tick !== world.tick) {
      influenceCache = { tick: world.tick, map: computeInfluenceMap(world, 'player') }
    }
    return influenceCache.map
  }

  const resourcesOf = (playerId: PlayerId): ResourceStock =>
    world.players.find((player) => player.id === playerId)?.resources ?? {
      blue_crystal: 0,
      red_ruby: 0,
      green_emerald: 0,
    }
  const crystalOf = (playerId: PlayerId): number => resourcesOf(playerId).blue_crystal
  const aliveUnitCount = (playerId: PlayerId): number =>
    world.units.filter((unit) => unit.player === playerId && unit.hp > 0).length
  /** tier 級存活數（Prompt 10.5 完整版：堆疊圖資料源）。 */
  const tierCountOf = (
    playerId: PlayerId,
  ): { small: number; medium: number; large: number } => {
    const counts = { small: 0, medium: 0, large: 0 }
    for (const unit of world.units) {
      if (unit.player !== playerId || unit.hp <= 0) continue
      const tier = world.defs.units[unit.defId]?.tier ?? 'small'
      counts[tier] += 1
    }
    return counts
  }
  const powerOf = (playerId: PlayerId): number =>
    world.units.reduce((total, unit) => {
      if (unit.player !== playerId || unit.hp <= 0) return total
      const def = world.defs.units[unit.defId]
      if (def === undefined) return total
      // 戰力（Prompt 3.1）：現值 HP 換算**有效當量** hp/(1−armor)——保留
      // 「隨損血下降」的語義，同時反映裝甲的攤薄（滿血當量更大）。
      return total + (unit.hp / (1 - def.stats.armor)) * def.stats.dmg * def.stats.attackSpeed
    }, 0)
  recorder.sample(
    0,
    crystalOf('player'),
    crystalOf('enemy'),
    aliveUnitCount('player'),
    aliveUnitCount('enemy'),
    powerOf('player'),
    powerOf('enemy'),
    resourcesOf('player').red_ruby,
    resourcesOf('enemy').red_ruby,
    resourcesOf('player').green_emerald,
    resourcesOf('enemy').green_emerald,
  )
  // tier 級開局樣本（Prompt 10.5 完整版）：與 tick 0 主樣本成對。
  recorder.sampleTiers(0, tierCountOf('player'), tierCountOf('enemy'))

  // 對局結果（Prompt 10.5）：結束時填入；之前為 null。
  let outcome: { result: MatchResult; replay: ReplayRecord } | null = null
  /** 結束對局：判勝負、產出 replay、停 ticker（冪等）。 */
  const finalize = (): void => {
    if (outcome !== null) return
    const result = resolveMatchResult(world)
    const playerResources = resourcesOf('player')
    const enemyResources = resourcesOf('enemy')
    const replay = recorder.finish(
      seed,
      result,
      { player: playerResources.blue_crystal, enemy: enemyResources.blue_crystal },
      world.tick,
      { player: playerResources.red_ruby, enemy: enemyResources.red_ruby },
      { player: playerResources.green_emerald, enemy: enemyResources.green_emerald },
    )
    // 決策後果（Prompt 10.5 完整版）：此決策之後出生的同 target 現存量（元數據 spawnTick）。
    const withOutcomes =
      replay.decisions === undefined
        ? replay
        : {
            ...replay,
            decisions: replay.decisions.map((decision) => ({
              ...decision,
              outcomeAlive:
                decision.action === 'train'
                  ? world.units.filter(
                      (unit) =>
                        unit.player === decision.actor &&
                        unit.defId === decision.target &&
                        unit.spawnTick >= decision.tick,
                    ).length
                  : world.buildings.filter(
                      (building) =>
                        building.player === decision.actor &&
                        building.defId === decision.target &&
                        building.spawnTick >= decision.tick,
                    ).length,
            })),
          }
    // 裝甲效益（Prompt 10.5 完整版）：sim 純累加器 → replay（累計減傷 = raw − actual）。
    const withArmor: ReplayRecord = {
      ...withOutcomes,
      armorStats: {
        takenRaw: {
          player: world.metrics.damageTakenRaw.player,
          enemy: world.metrics.damageTakenRaw.enemy,
        },
        takenActual: {
          player: world.metrics.damageTakenActual.player,
          enemy: world.metrics.damageTakenActual.enemy,
        },
      },
    }
    outcome = { result, replay: withArmor }
    lastReplay = withArmor // 路由傳遞（Prompt 10.5 完整版）：/post-game 讀取。
    app.ticker.remove(onFrame) // 對局結束：不再推進（復盤頁不依賴即時 sim）
  }

  let prev: WorldSnapshot = snapshotWorld(world)
  let curr: WorldSnapshot = prev

  /** 戰略紀錄 → 日誌一行（動作＋一行中文原因）＋候選快照（Prompt 9.5 完整版）＋replay 決策歸因（Prompt 10.5 完整版）。 */
  const logDecisionRecords = (records: readonly DecisionRecord[]): void => {
    for (const record of records) {
      // 裝甲分檔：train 條目 target 即 defId；build 條目 target 為 `defId@(x,y)`
      // （建築無裝甲 → 查單位檔查不到即 'none'）。
      const targetDefId = record.action === 'build' ? (record.target.split('@')[0] ?? '') : record.target
      const unitDef = world.defs.units[targetDefId]
      pushLog({
        tick: record.tick,
        layer: 'strategic',
        actor: record.actor,
        text: `${record.action} ${record.target}（${record.reason.explanation}）`,
        candidates: record.reason.candidates,
        topFactor: record.reason.topFactor,
        armorTier: unitDef === undefined ? 'none' : armorTierOf(unitDef.stats.armor),
      })
      // 決策歸因（Prompt 10.5 完整版）：效用分＝候選第一名；成本＝藍水晶（影響力排序主鍵）。
      const buildDef = record.action === 'build' ? world.defs.buildings[targetDefId] : undefined
      const cost =
        unitDef !== undefined
          ? (unitDef.cost.blue_crystal ?? 0)
          : buildDef !== undefined
            ? (buildDef.cost.blue_crystal ?? 0)
            : 0
      recorder.recordDecisions([
        {
          tick: record.tick,
          actor: record.actor,
          action: record.action,
          target: targetDefId,
          score: record.reason.candidates[0]?.score ?? 0,
          cost,
          explanation: record.reason.explanation,
        },
      ])
    }
  }

  /** 戰術任務變動的原因句（規則式、確定性）。 */
  const missionChangeReason = (playerId: PlayerId, from: Squad['mission'], to: Squad['mission']): string => {
    if (to === 'retreat') return '戰力處於劣勢'
    if (to === 'stage') {
      // 攻擊波次門檻（Prompt 10.21）沒過 → 回集結點會師，等支援成軍再出擊。
      return '戰力未達出擊門檻，集結待戰'
    }
    if (to === 'harass') {
      // attack → harass 可能是交戰評估降級（打不贏轉騷擾等支援，Prompt 10.8）。
      if (from === 'attack') return '戰力不足以正面交戰，轉為騷擾等待支援'
      return '軍事建築不足，騷擾敵方經濟'
    }
    if (to === 'attack') return from === 'retreat' ? '重新取得戰力優勢' : '兵力充足，鎖定目標建築'
    if (to === 'defend') {
      // 主動防禦（Prompt 10.6）：攻轉守且建築受威脅 → 是「回防攔截」而非「無目標轉守」。
      if (from !== 'retreat' && pickMostUrgentThreat(world, playerId) !== null) {
        return '敵軍壓境，回防攔截（保護建築與水晶）'
      }
      return from === 'retreat' ? '解除了兵力劣勢' : '無合適進攻目標，轉為守備'
    }
    return from === 'retreat' ? '解除了兵力劣勢' : '無合適進攻目標，轉為守備'
  }

  /** 戰術層：重算前後比較，任務／目標變動才進日誌（每 10 tick 一次）。 */
  const refreshPlans = (tick: number): void => {
    for (const player of world.players) {
      const previous = plans[player.id]
      // 傳入前一計畫：編組 warm start＋遲滯（Prompt 10.13，避免乒乓換隊）。
      const next = computeTacticalPlan(world, player.id, policies[player.id], previous)
      plans[player.id] = next
      // 接觸驅動的重新評估／夾擊呼叫（Prompt 10.15）→ 決策日誌逐條一列。
      for (const event of next.events ?? []) {
        pushLog({
          tick,
          layer: 'tactical',
          actor: player.id,
          text: event.text,
        })
      }
      if (previous === null) continue
      // 戰術層決策記錄（Prompt 7.5）：任務／目標**變化時**才進日誌（每 10 tick
      // 一循環 × 1200 循環若全量會刷屏），文字取自記錄的 topFactor＋解釋。
      const recordOf = (
        action: 'mission' | 'target',
        predicate: (record: TacticalRecord) => boolean,
      ): TacticalRecord | undefined =>
        (next.records ?? []).find(
          (record) => record.action === action && predicate(record),
        )
      for (const squad of next.squads) {
        const before = previous.squads.find((candidate) => candidate.index === squad.index)
        if (before === undefined) continue
        if (before.mission !== squad.mission) {
          const record = recordOf(
            'mission',
            (candidate) => candidate.target === `#${squad.index}:${squad.mission}`,
          )
          pushLog({
            tick,
            layer: 'tactical',
            actor: player.id,
            text:
              `小隊 #${squad.index} ${before.mission}→${squad.mission}` +
              `（${record?.reason.topFactor ?? missionChangeReason(player.id, before.mission, squad.mission)}）` +
              (record !== undefined ? `：${record.reason.explanation}` : ''),
          })
        } else if (before.target.x !== squad.target.x || before.target.y !== squad.target.y) {
          const aimedBuilding = squad.targetBuildingId === null
            ? undefined
            : world.buildings.find((building) => building.id === squad.targetBuildingId)
          const record =
            aimedBuilding === undefined
              ? undefined
              : recordOf(
                  'target',
                  (candidate) =>
                    candidate.target === `${aimedBuilding.defId}@(${aimedBuilding.x},${aimedBuilding.y})`,
                )
          pushLog({
            tick,
            layer: 'tactical',
            actor: player.id,
            text: record !== undefined
              ? `小隊 #${squad.index} 目標改為 ${record.target}（${record.reason.explanation}）`
              : `小隊 #${squad.index} 目標改為 (${squad.target.x},${squad.target.y})`,
          })
        }
      }
    }
    pushMarkers() // 集結點／生產點可能變了（Prompt 10.13）
  }

  /**
   * 突變期敘事（Prompt 10.23，純日誌不影響決策）：只在跨門檻的**那一 tick**
   * 各記一條／陣營（tick 遞增 1 → 精確相等即恰好觸發一次）。
   */
  const onTick = (w: World): void => {
    const suddenText = suddenDeathLogText(w.tick)
    if (suddenText !== null) {
      for (const player of w.players) {
        pushLog({ tick: w.tick, layer: 'tactical', actor: player.id, text: suddenText })
      }
    }
    if (w.tick % STRATEGIC_INTERVAL_TICKS === 0) {
      for (const player of w.players) {
        // AI 投降（Prompt 8.6）：投降方不再參與 AI 決策（sim 停產／停火兜底）。
        if (w.surrender?.player === player.id) continue
        const strategic = runStrategicCycle(w, player.id, policies[player.id])
        logDecisionRecords(strategic.records)
        if (strategic.surrenderCheck.surrendered) {
          const event = w.surrender
          const detail =
            `AI 投降：絕望 ${strategic.surrenderCheck.despair.toFixed(2)} > ` +
            `閾 ${strategic.surrenderCheck.threshold.toFixed(2)}（持續超閾 15 秒）` +
            (event === null
              ? ''
              : `；戰力比 ${event.powerRatio.toFixed(2)}、收入比 ${event.incomeRatio.toFixed(2)}`)
          pushLog({
            tick: w.tick,
            layer: 'strategic',
            actor: player.id,
            text: detail,
          })
          if (event !== null) {
            recorder.recordSurrender({
              tick: event.tick,
              player: event.player,
              type: 'ai_surrender',
              despairAtSurrender: event.despairAtSurrender,
              powerRatio: event.powerRatio,
              incomeRatio: event.incomeRatio,
            })
          }
        }
      }
    }
    if (w.tick % TACTICAL_INTERVAL_TICKS === 0) {
      refreshPlans(w.tick)
    }
    if (w.tick % MICRO_INTERVAL_TICKS === 0) {
      for (const player of w.players) {
        latestMicro[player.id] = runMicroCycle(w, player.id, plans[player.id])
      }
      // 微操層決策記錄（Prompt 8.5）：`microRecords` 只在戰鬥狀態切換時產生
      // （formation↔rally 常規切換不記；同單位 20 循環防抖），因此全量進日誌。
      microCycleIndex += 1
      for (const player of w.players) {
        const records = microRecords(
          player.id,
          w.tick,
          latestMicro[player.id],
          microRecordState[player.id],
          microCycleIndex,
        )
        for (const record of records) {
          pushLog({
            tick: w.tick,
            layer: 'micro',
            actor: player.id,
            text: `${record.reason.explanation}（[${record.reason.topFactor}] ${record.target}）`,
          })
        }
      }
    }
    if (w.tick % REPLAY_SAMPLE_INTERVAL_TICKS === 0) {
      recorder.sample(
        w.tick,
        crystalOf('player'),
        crystalOf('enemy'),
        aliveUnitCount('player'),
        aliveUnitCount('enemy'),
        powerOf('player'),
        powerOf('enemy'),
      )
      // tier 級存活數（Prompt 10.5 完整版）：與主樣本同 tick 成對（堆疊圖資料源）。
      recorder.sampleTiers(w.tick, tierCountOf('player'), tierCountOf('enemy'))
    }
    // 死亡事件抽取（Prompt 10.5 完整版）：sim 事件環 → replay；抽取即清空。
    if (w.recentDeaths.length > 0) {
      recorder.recordDeaths(w.recentDeaths)
      w.recentDeaths = []
    }
    prev = curr
    curr = snapshotWorld(w)
    // 視野迷霧（Prompt 9.5b）：每 tick 重算 player 視野並推入場景——
    // 無記憶（純函式），敵人離開視野即同步從 AI 判知與迷霧消失；
    // 開關關閉時場景只存 mask 不重繪（零繪製成本）。
    scene.updateFogMask(visibleTileMask(w, 'player'))
    // 接戰線資料（Prompt 9.5c）：每 tick 用與 stepCombat 同一解析現算
    // 「現在開火會打到誰」推入場景——接戰線與實際傷害同源、延遲 250ms → ≤50ms。
    scene.setEngageLines(computeEngageLines(w))
  }

  const onFrame = (ticker: Ticker): void => {
    if (outcome !== null) return // 已結束：保險，不再推進（正常路徑 ticker 已移除）
    loop.advance(ticker.deltaMS, onTick)
    if (matchEnded(world)) finalize()
    scene.update(curr, prev, loop.progressToNextTick, app.screen.width, app.screen.height)
  }
  app.ticker.add(onFrame)

  const session: GameSession = {
    scene,
    getSnapshot: (): WorldSnapshot | null => curr,
    getUnitInfo: (unitId: number): UnitInfo | null => {
      const unit = world.units.find((candidate) => candidate.id === unitId)
      if (unit === undefined) return null
      const def = world.defs.units[unit.defId]
      if (def === undefined) return null
      const tile = tileOf(unit.x, unit.y)
      const decision =
        latestMicro[unit.player].find((candidate) => candidate.unitId === unitId)?.reason ?? null
      const squadMission =
        plans[unit.player]?.squads.find((squad) => squad.memberIds.includes(unit.id))?.mission ??
        null
      return {
        id: unit.id,
        defId: unit.defId,
        player: unit.player,
        hp: unit.hp,
        maxHp: def.stats.hp,
        tileX: tile.x,
        tileY: tile.y,
        decision,
        squadMission,
        rangeTiles: def.stats.range,
        moveSpeedTilesPerSec: def.stats.moveSpeed,
        armor: def.stats.armor,
        effHp: effectiveHp(def),
        dps: def.stats.dmg * def.stats.attackSpeed,
      }
    },
    getBuildingInfo: (buildingId: number): BuildingInfo | null => {
      const building = world.buildings.find((candidate) => candidate.id === buildingId)
      if (building === undefined) return null
      const def = world.defs.buildings[building.defId]
      if (def === undefined) return null
      const effMaxHp = buildingEffectiveMaxHp(def, building)
      const progressPct =
        building.totalTicks === 0
          ? 100
          : Math.min(100, Math.floor((building.builtTicks * 100) / building.totalTicks))
      const [w, h] = def.size
      return {
        id: building.id,
        defId: building.defId,
        player: building.player,
        hp: building.hp,
        effMaxHp,
        progressPct,
        w,
        h,
        tileX: building.x,
        tileY: building.y,
      }
    },
    getMarkers: (): readonly MapMarker[] => markers,
    getMarkerInfo: (
      ref: { kind: 'gather'; player: PlayerId; buildingId: number },
    ): MarkerInfo | null => {
      const marker = markers.find(
        (candidate) =>
          candidate.kind === ref.kind &&
          candidate.player === ref.player &&
          candidate.buildingId === ref.buildingId,
      )
      if (marker === undefined) return null
      const side = marker.player === 'player' ? '我方' : '敵方'
      const building = world.buildings.find((candidate) => candidate.id === marker.buildingId)
      const buildingName = building?.defId ?? '建築'
      return {
        kind: 'gather',
        player: marker.player,
        tileX: marker.tile.x,
        tileY: marker.tile.y,
        title: `${side}${buildingName}出廠集合格`,
        description:
          '新兵出廠後先到此格集結（由這間建築往主目標方向前移約 4 格），' +
          'AI 再把同區新兵編成同一隊出擊。（AI 待命集結點為內部概念，會依局面自動調整，不在此顯示。）',
      }
    },
    getBattleStats: (): BattleStats => {
      const resourcesOf = (id: PlayerId): ResourceStock =>
        world.players.find((player) => player.id === id)?.resources ?? {
          blue_crystal: 0,
          red_ruby: 0,
          green_emerald: 0,
        }
      const playerResources = resourcesOf('player')
      const enemyResources = resourcesOf('enemy')
      const incomesOf = (id: PlayerId): Record<ResourceId, number> => ({
        // getIncome = 60 tick 總入帳 → 每秒 = ÷3（INCOME_WINDOW_TICKS / TICK_RATE_HZ）。
        blue_crystal: getIncome(world, id, 'blue_crystal') / 3,
        red_ruby: getIncome(world, id, 'red_ruby') / 3,
        green_emerald: getIncome(world, id, 'green_emerald') / 3,
      })
      const power = powerOf
      /** per-tier HP 堆疊（Prompt 9.5 完整版）：rawHp = 現值 HP、effHp = hp/(1−armor)。 */
      const tiersOf = (id: PlayerId): TierHpTable => {
        const table: Record<'small' | 'medium' | 'large', { rawHp: number; effHp: number }> = {
          small: { rawHp: 0, effHp: 0 },
          medium: { rawHp: 0, effHp: 0 },
          large: { rawHp: 0, effHp: 0 },
        }
        for (const unit of world.units) {
          if (unit.player !== id || unit.hp <= 0) continue
          const def = world.defs.units[unit.defId]
          if (def === undefined) continue
          const bucket = table[def.tier]
          bucket.rawHp += unit.hp
          bucket.effHp += unit.hp / (1 - def.stats.armor)
        }
        return table
      }
      const squads: SquadInfo[] = []
      for (const player of world.players) {
        const plan = plans[player.id]
        if (plan === null) continue
        for (const squad of plan.squads) {
          const [sumX, sumY] = squad.memberIds.reduce<[number, number]>(
            (acc, id) => {
              const unit = world.units.find((candidate) => candidate.id === id)
              if (unit === undefined) return acc
              return [acc[0] + unit.x, acc[1] + unit.y]
            },
            [0, 0],
          )
          const memberCount = Math.max(1, squad.memberIds.length)
          const cx = Math.floor(sumX / memberCount / 200)
          const cy = Math.floor(sumY / memberCount / 200)
          const dist = Math.floor(
            Math.sqrt(
              (squad.target.x - cx) * (squad.target.x - cx) +
                (squad.target.y - cy) * (squad.target.y - cy),
            ),
          )
          squads.push({
            player: player.id,
            index: squad.index,
            mission: squad.mission,
            targetX: squad.target.x,
            targetY: squad.target.y,
            memberCount: squad.memberIds.length,
            power: squad.power,
            distTiles: dist,
            engaging: squad.engaging === true,
          })
        }
      }
      return {
        tick: world.tick,
        maxTicks: world.match.maxTicks,
        playerCrystal: playerResources.blue_crystal,
        enemyCrystal: enemyResources.blue_crystal,
        playerResources,
        enemyResources,
        playerIncomes: incomesOf('player'),
        enemyIncomes: incomesOf('enemy'),
        playerUnits: world.units.filter((unit) => unit.player === 'player' && unit.hp > 0).length,
        enemyUnits: world.units.filter((unit) => unit.player === 'enemy' && unit.hp > 0).length,
        playerPower: power('player'),
        enemyPower: power('enemy'),
        playerTiers: tiersOf('player'),
        enemyTiers: tiersOf('enemy'),
        log: [...decisionLog],
        squads,
      }
    },
    getInfluence: influenceOf,
    setOverlays: (opts): void => {
      scene.setOverlays(opts)
    },
    refreshInfluence: (): void => {
      scene.updateInfluence(influenceOf())
    },
    getPolicies: (playerId: PlayerId): PolicySnapshot => {
      let summary: string | null = null
      for (let index = decisionLog.length - 1; index >= 0; index--) {
        const entry = decisionLog[index]
        if (entry === undefined) continue
        if (entry.actor === playerId && entry.layer === 'strategic') {
          summary = entry.text
          break
        }
      }
      return {
        values: policies[playerId],
        cooldownRemainingTicks: Math.max(
          0,
          lastPolicyChange[playerId] + POLICY_COOLDOWN_TICKS - world.tick,
        ),
        summary,
        tick: world.tick,
        surrendered: world.surrender?.player === playerId,
      }
    },
    applyPolicies: (
      playerId: PlayerId,
      values: Partial<Omit<PolicyValues, 'resourceBias'>> & {
        resourceBias?: Partial<PolicyValues['resourceBias']>
      },
    ): boolean => {
      // 投降後不能再調 Policy（Prompt 10.6）：投降方政策鎖定（含 tempo）。
      if (world.surrender?.player === playerId) return false
      // 節奏預設（Prompt 6）不受冷卻約束——它是戰略模板不是即時干預；
      // 只改 tempo 時不走冷卻、不開冷卻。
      const touchesSliders = (Object.keys(values) as Array<keyof PolicyValues>).some(
        (key) => key !== 'tempoPreset' && values[key] !== undefined,
      )
      const cooling =
        world.tick - lastPolicyChange[playerId] < POLICY_COOLDOWN_TICKS
      if (touchesSliders && cooling) return false
      const current = policies[playerId]
      const next = resolvePolicies({
        ...current,
        ...values,
        resourceBias: { ...current.resourceBias, ...values.resourceBias },
      })
      // 變更偵測（Prompt 6 深合併）：數值滑桿逐鍵、bias 逐子鍵；tempo 單獨記日誌。
      const changes: Array<{ key: string; from: number; to: number }> = []
      for (const key of POLICY_IDS) {
        if (next[key] !== current[key]) {
          changes.push({ key, from: current[key], to: next[key] })
        }
      }
      for (const sub of ['blue', 'red', 'green'] as const) {
        if (next.resourceBias[sub] !== current.resourceBias[sub]) {
          changes.push({
            key: `resourceBias.${sub}`,
            from: current.resourceBias[sub],
            to: next.resourceBias[sub],
          })
        }
      }
      if (next.tempoPreset !== current.tempoPreset) {
        pushLog({
          tick: world.tick,
          layer: 'policy',
          actor: playerId,
          text: `節奏預設 → ${next.tempoPreset}（時段覆蓋生效，見戰略決策）`,
        })
        // 節奏切換時間軸（Prompt 10.5 完整版）：獨立於 policyEvents（後者僅記數值鍵）。
        recorder.recordTempo({ tick: world.tick, from: current.tempoPreset, to: next.tempoPreset })
      }
      if (changes.length === 0 && next.tempoPreset === current.tempoPreset) {
        return true // 無實際變更：不消耗冷卻、不記日誌
      }
      policies[playerId] = next
      if (touchesSliders) lastPolicyChange[playerId] = world.tick // 只有滑桿才開冷卻
      for (const change of changes) {
        recorder.recordPolicy({
          tick: world.tick,
          key: change.key,
          from: change.from,
          to: change.to,
        })
      }
      pushLog({
        tick: world.tick,
        layer: 'policy',
        actor: playerId,
        text: `政策變更：${changes
          .map((change) => `${change.key} ${change.from.toFixed(2)}→${change.to.toFixed(2)}`)
          .join('、')}（此後決策受影響）`,
      })
      return true
    },
    getOutcome: (): { ended: boolean; replay: ReplayRecord | null } => ({
      ended: outcome !== null,
      replay: outcome === null ? null : outcome.replay,
    }),
    endMatch: (): boolean => {
      if (outcome !== null) return false
      finalize()
      return true
    },
    surrender: (playerId: PlayerId): boolean => {
      // 投降（Prompt 10.6）：sim 定案（幂等：已投降／已結束條件成立 → false）。
      if (!surrenderPlayer(world, playerId)) return false
      const event = world.surrender
      pushLog({
        tick: world.tick,
        layer: 'strategic',
        actor: playerId,
        text: '玩家投降：手動觸發（敵方 AI 繼續行動 3 秒後結束對局）',
      })
      if (event !== null) {
        recorder.recordSurrender({
          tick: event.tick,
          player: event.player,
          type: 'player_surrender',
          despairAtSurrender: event.despairAtSurrender,
          powerRatio: event.powerRatio,
          incomeRatio: event.incomeRatio,
          timestamp: Date.now(),
        })
      }
      return true
    },
    stop: (): void => {
      app.ticker.remove(onFrame)
      // 僅在「自己仍是註冊中的 session」時清除：React StrictMode 雙掛載下，
      // 第一次掛載的 dispose 可能晚於第二次的 startGameSession 完成——
      // 若無條件清 null，會把正在跑的新 session 從 App 輪詢中拔掉
      // （對局自然結束後 App 就再也讀不到 outcome、永遠不切復盤頁）。
      if (activeSession === session) {
        activeSession = null
      }
    },
  }
  activeSession = session
  return session
}
