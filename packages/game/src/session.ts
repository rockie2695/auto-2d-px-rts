import type { Application, Ticker } from 'pixi.js'

import { MICRO_INTERVAL_TICKS, runMicroCycle } from './ai/micro.ts'
import type { MicroDecision } from './ai/micro.ts'
import { DEFAULT_POLICIES, resolvePolicies } from './ai/policy.ts'
import type { PolicyValues } from './ai/policy.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './ai/strategy.ts'
import type { DecisionRecord } from './ai/strategy.ts'
import { pickMostUrgentThreat } from './ai/influence.ts'
import { computeTacticalPlan, TACTICAL_INTERVAL_TICKS } from './ai/tactics.ts'
import type { Squad, TacticalPlan } from './ai/tactics.ts'
import { loadContentPackFromFetch } from './data/loadFromFetch.ts'
import { ReplayRecorder, REPLAY_SAMPLE_INTERVAL_TICKS } from './replay.ts'
import type { MatchResult, ReplayRecord } from './replay.ts'
import type { GameScene } from './render/scene.ts'
import type { PlayerId, World } from './sim/types.ts'
import { buildingEffectiveMaxHp, tileOf } from './sim/types.ts'
import { GameLoop } from './sim/gameLoop.ts'
import { createWorld, snapshotWorld } from './sim/world.ts'
import type { WorldSnapshot } from './sim/world.ts'

/** 對局預設種子（CLI 對照用；瀏覽器對局每場隨機取種，見 `matchSeed`）。 */
export const SEED = 42

/** 本場對局的種子：每場隨機（同一場內確定性不變，種子記錄進 replay 可重播）。 */
function matchSeed(): number {
  return Math.floor(Math.random() * 2 ** 31)
}

/** 決策日誌單條（Prompt 9.5：左下面板顯示；戰略紀錄＋戰術小隊變動＋政策變更）。 */
export interface DecisionLogEntry {
  /** 單調遞增序號（面板 key 用；同 tick 同文字的兩條也不會撞）。 */
  readonly sequence: number
  readonly tick: number
  readonly layer: 'strategic' | 'tactical' | 'policy'
  readonly actor: PlayerId
  /** 一行中文：動作＋原因（戰略例 `build mine（…）`）。 */
  readonly text: string
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
}

/** 戰況快查（Prompt 9.5：四角面板一次取齊，500ms 級輪詢夠用）。 */
export interface BattleStats {
  readonly tick: number
  readonly playerCrystal: number
  readonly enemyCrystal: number
  /** 雙方存活單位數（圖表「單位數量」模式取樣用）。 */
  readonly playerUnits: number
  readonly enemyUnits: number
  /** Σ hp × dmg × attackSpeed（SPEC §12.1）；雙方存活單位合計。 */
  readonly playerPower: number
  readonly enemyPower: number
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

/** 政策冷卻：30 秒 × 20Hz = 600 tick（Prompt 10：對局中每 30 秒才能改一次滑桿）。 */
export const POLICY_COOLDOWN_TICKS = 600

/* ------------------------------------------------------------------ */
/* 對局結束與勝負判定（Prompt 10.5，純函數供測試）                      */
/* ------------------------------------------------------------------ */

/** 主堡 defId（不可建造、只能由開局配置放置；SPEC §12）。 */
const KEEP_DEF_ID = 'keep'

function keepAlive(world: World, playerId: PlayerId): boolean {
  return world.buildings.some(
    (building) =>
      building.player === playerId && building.defId === KEEP_DEF_ID && building.hp > 0,
  )
}

/** 一方是否全滅：無任何存活建築且無存活單位（Prompt 10.5 修：全滅也結束）。 */
function hasNoForces(world: World, playerId: PlayerId): boolean {
  if (world.buildings.some((building) => building.player === playerId && building.hp > 0)) {
    return false
  }
  return !world.units.some((unit) => unit.player === playerId && unit.hp > 0)
}

/** 對局是否已結束：一方主堡被毀、一方全滅（無建築且無單位），或達 `match.maxTicks` 上限。 */
export function matchEnded(world: World): boolean {
  if (world.tick >= world.match.maxTicks) return true
  return (
    !keepAlive(world, 'player') ||
    !keepAlive(world, 'enemy') ||
    hasNoForces(world, 'player') ||
    hasNoForces(world, 'enemy')
  )
}

/**
 * 勝負判定：一方主堡被毀 → 對方勝；同 tick 雙殺 → 全滅者敗（都還有部隊 → 平手）；
 * 超時（雙主堡俱在）→ 水晶多者勝、同數平手（MVP：不比戰力）。
 * 全滅（無建築且無單位）同樣判負——無建築必含主堡已毀，此為 SPEC §11.1 的另一面。
 * 手動提前結束（雙主堡俱在且未超時）→ 平手。
 */
export function resolveMatchResult(world: World): MatchResult {
  const playerAlive = keepAlive(world, 'player')
  const enemyAlive = keepAlive(world, 'enemy')
  if (playerAlive !== enemyAlive) return playerAlive ? 'player' : 'enemy'
  if (!playerAlive && !enemyAlive) {
    // 雙主堡俱毀：全滅者敗；雙方都沒有部隊 → 平手。
    const playerWiped = hasNoForces(world, 'player')
    const enemyWiped = hasNoForces(world, 'enemy')
    if (playerWiped !== enemyWiped) return playerWiped ? 'enemy' : 'player'
    return 'draw'
  }
  if (playerAlive && enemyAlive && world.tick >= world.match.maxTicks) {
    const crystal = (id: PlayerId): number =>
      world.players.find((player) => player.id === id)?.blueCrystal ?? 0
    const playerCrystal = crystal('player')
    const enemyCrystal = crystal('enemy')
    if (playerCrystal > enemyCrystal) return 'player'
    if (enemyCrystal > playerCrystal) return 'enemy'
  }
  return 'draw'
}

/** 政策滑桿快照（Prompt 10：下方面板輪詢讀取）。 */
export interface PolicySnapshot {
  /** 目前生效的 5 個滑桿值。 */
  readonly values: PolicyValues
  /** 距離下次可變更還需等待的 tick 數；0 = 可立即變更。 */
  readonly cooldownRemainingTicks: number
  /** 目前 AI 決策摘要：該玩家最後一條戰略日誌文字；尚無為 null。 */
  readonly summary: string | null
}

export interface GameSession {
  readonly scene: GameScene
  /** 最新一份世界快照（插值的「當前」幀）。 */
  getSnapshot(): WorldSnapshot | null
  getUnitInfo(unitId: number): UnitInfo | null
  getBuildingInfo(buildingId: number): BuildingInfo | null
  /** 四角面板（Prompt 9.5）一次取齊的戰況。 */
  getBattleStats(): BattleStats
  /** 政策滑桿（Prompt 10）：讀取某玩家的滑桿值與冷卻狀態。 */
  getPolicies(playerId: PlayerId): PolicySnapshot
  /**
   * 政策滑桿（Prompt 10）：套用某玩家的滑桿變更。
   * 冷卻中（上次變更後 600 tick 內）回傳 false；無實際變更不消耗冷卻。
   * 生效時機：即時換掉政策物件，下一個戰略／戰術週期讀到新值。
   */
  applyPolicies(playerId: PlayerId, values: Partial<PolicyValues>): boolean
  /** 復盤（Prompt 10.5）：對局是否已結束；結束時帶完整 replay 紀錄。 */
  getOutcome(): { ended: boolean; replay: ReplayRecord | null }
  /** 復盤（Prompt 10.5）：手動提前結束（以當下狀態判勝負、停迴圈、產出 replay）。
   *  已結束時回傳 false。 */
  endMatch(): boolean
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
    player: DEFAULT_POLICIES,
    enemy: DEFAULT_POLICIES,
  }
  const plans: Record<PlayerId, TacticalPlan | null> = { player: null, enemy: null }
  // tick 0 先算一次戰術計畫（同 aiCli），讓微操層從第 1 tick 起就有小隊目標。
  for (const player of world.players) {
    plans[player.id] = computeTacticalPlan(world, player.id, policies[player.id])
  }
  // 每玩家最新的微操決策（Prompt 9.4：點單位顯示 AI 當下在想什麼）。
  const latestMicro: Record<PlayerId, MicroDecision[]> = { player: [], enemy: [] }
  // 決策日誌（Prompt 9.5：戰略紀錄＋戰術小隊變動；面板取最後 5 條）。
  const decisionLog: DecisionLogEntry[] = []
  const LOG_LIMIT = 32
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
  const crystalOf = (playerId: PlayerId): number =>
    world.players.find((player) => player.id === playerId)?.blueCrystal ?? 0
  const aliveUnitCount = (playerId: PlayerId): number =>
    world.units.filter((unit) => unit.player === playerId && unit.hp > 0).length
  recorder.sample(
    0,
    crystalOf('player'),
    crystalOf('enemy'),
    aliveUnitCount('player'),
    aliveUnitCount('enemy'),
  )

  // 對局結果（Prompt 10.5）：結束時填入；之前為 null。
  let outcome: { result: MatchResult; replay: ReplayRecord } | null = null
  /** 結束對局：判勝負、產出 replay、停 ticker（冪等）。 */
  const finalize = (): void => {
    if (outcome !== null) return
    const result = resolveMatchResult(world)
    outcome = {
      result,
      replay: recorder.finish(
        seed,
        result,
        { player: crystalOf('player'), enemy: crystalOf('enemy') },
        world.tick,
      ),
    }
    app.ticker.remove(onFrame) // 對局結束：不再推進（復盤頁不依賴即時 sim）
  }

  let prev: WorldSnapshot = snapshotWorld(world)
  let curr: WorldSnapshot = prev

  /** 戰略紀錄 → 日誌一行（動作＋一行中文原因）。 */
  const logDecisionRecords = (records: readonly DecisionRecord[]): void => {
    for (const record of records) {
      pushLog({
        tick: record.tick,
        layer: 'strategic',
        actor: record.actor,
        text: `${record.action} ${record.target}（${record.reason.explanation}）`,
      })
    }
  }

  /** 戰術任務變動的原因句（規則式、確定性）。 */
  const missionChangeReason = (playerId: PlayerId, from: Squad['mission'], to: Squad['mission']): string => {
    if (to === 'retreat') return '戰力處於劣勢'
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
      const next = computeTacticalPlan(world, player.id, policies[player.id])
      plans[player.id] = next
      if (previous === null) continue
      for (const squad of next.squads) {
        const before = previous.squads.find((candidate) => candidate.index === squad.index)
        if (before === undefined) continue
        if (before.mission !== squad.mission) {
          pushLog({
            tick,
            layer: 'tactical',
            actor: player.id,
            text: `小隊 #${squad.index} ${before.mission}→${squad.mission}（${missionChangeReason(player.id, before.mission, squad.mission)}）`,
          })
        } else if (before.target.x !== squad.target.x || before.target.y !== squad.target.y) {
          pushLog({
            tick,
            layer: 'tactical',
            actor: player.id,
            text: `小隊 #${squad.index} 目標改為 (${squad.target.x},${squad.target.y})`,
          })
        }
      }
    }
  }

  const onTick = (w: World): void => {
    if (w.tick % STRATEGIC_INTERVAL_TICKS === 0) {
      for (const player of w.players) {
        logDecisionRecords(runStrategicCycle(w, player.id, policies[player.id]).records)
      }
    }
    if (w.tick % TACTICAL_INTERVAL_TICKS === 0) {
      refreshPlans(w.tick)
    }
    if (w.tick % MICRO_INTERVAL_TICKS === 0) {
      for (const player of w.players) {
        latestMicro[player.id] = runMicroCycle(w, player.id, plans[player.id])
      }
    }
    if (w.tick % REPLAY_SAMPLE_INTERVAL_TICKS === 0) {
      recorder.sample(
        w.tick,
        crystalOf('player'),
        crystalOf('enemy'),
        aliveUnitCount('player'),
        aliveUnitCount('enemy'),
      )
    }
    prev = curr
    curr = snapshotWorld(w)
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
    getBattleStats: (): BattleStats => {
      const crystal = (id: PlayerId): number => world.players.find((p) => p.id === id)?.blueCrystal ?? 0
      const power = (id: PlayerId): number =>
        world.units.reduce((total, unit) => {
          if (unit.player !== id || unit.hp <= 0) return total
          const def = world.defs.units[unit.defId]
          if (def === undefined) return total
          return total + unit.hp * def.stats.dmg * def.stats.attackSpeed
        }, 0)
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
          })
        }
      }
      return {
        tick: world.tick,
        playerCrystal: crystal('player'),
        enemyCrystal: crystal('enemy'),
        playerUnits: world.units.filter((unit) => unit.player === 'player' && unit.hp > 0).length,
        enemyUnits: world.units.filter((unit) => unit.player === 'enemy' && unit.hp > 0).length,
        playerPower: power('player'),
        enemyPower: power('enemy'),
        log: [...decisionLog],
        squads,
      }
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
      }
    },
    applyPolicies: (playerId: PlayerId, values: Partial<PolicyValues>): boolean => {
      if (world.tick - lastPolicyChange[playerId] < POLICY_COOLDOWN_TICKS) return false
      const current = policies[playerId]
      const next = resolvePolicies({ ...current, ...values })
      const changed = (Object.keys(next) as Array<keyof PolicyValues>).filter(
        (key) => next[key] !== current[key],
      )
      if (changed.length === 0) return true // 無實際變更：不消耗冷卻、不記日誌
      policies[playerId] = next
      lastPolicyChange[playerId] = world.tick
      for (const key of changed) {
        recorder.recordPolicy({ tick: world.tick, key, from: current[key], to: next[key] })
      }
      pushLog({
        tick: world.tick,
        layer: 'policy',
        actor: playerId,
        text: `政策變更：${changed
          .map((key) => `${key} ${current[key].toFixed(2)}→${next[key].toFixed(2)}`)
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
