import type { Application, Ticker } from 'pixi.js'

import { MICRO_INTERVAL_TICKS, runMicroCycle } from './ai/micro.ts'
import type { MicroDecision } from './ai/micro.ts'
import { DEFAULT_POLICIES, resolvePolicies } from './ai/policy.ts'
import type { PolicyValues } from './ai/policy.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './ai/strategy.ts'
import type { DecisionRecord } from './ai/strategy.ts'
import { computeTacticalPlan, TACTICAL_INTERVAL_TICKS } from './ai/tactics.ts'
import type { Squad, TacticalPlan } from './ai/tactics.ts'
import { loadContentPackFromFetch } from './data/loadFromFetch.ts'
import type { GameScene } from './render/scene.ts'
import type { PlayerId, World } from './sim/types.ts'
import { buildingEffectiveMaxHp, tileOf } from './sim/types.ts'
import { GameLoop } from './sim/gameLoop.ts'
import { createWorld, snapshotWorld } from './sim/world.ts'
import type { WorldSnapshot } from './sim/world.ts'

/** 對局種子（與 `pnpm sim` 相同，方便對照）。 */
export const SEED = 42

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
  const world = createWorld(content, SEED)
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
  const missionChangeReason = (from: Squad['mission'], to: Squad['mission']): string => {
    if (to === 'retreat') return '戰力處於劣勢'
    if (to === 'harass') return '軍事建築不足，騷擾敵方經濟'
    if (to === 'attack') return from === 'retreat' ? '重新取得戰力優勢' : '兵力充足，鎖定目標建築'
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
            text: `小隊 #${squad.index} ${before.mission}→${squad.mission}（${missionChangeReason(before.mission, squad.mission)}）`,
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
    prev = curr
    curr = snapshotWorld(w)
  }

  const onFrame = (ticker: Ticker): void => {
    loop.advance(ticker.deltaMS, onTick)
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
    stop: (): void => {
      app.ticker.remove(onFrame)
      activeSession = null
    },
  }
  activeSession = session
  return session
}
