import type { Application, Ticker } from 'pixi.js'

import { MICRO_INTERVAL_TICKS, runMicroCycle } from './ai/micro.ts'
import { DEFAULT_POLICIES } from './ai/policy.ts'
import type { PolicyValues } from './ai/policy.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './ai/strategy.ts'
import { computeTacticalPlan, TACTICAL_INTERVAL_TICKS } from './ai/tactics.ts'
import type { TacticalPlan } from './ai/tactics.ts'
import { loadContentPackFromFetch } from './data/loadFromFetch.ts'
import type { GameScene } from './render/scene.ts'
import type { PlayerId, World } from './sim/types.ts'
import { buildingEffectiveMaxHp, tileOf } from './sim/types.ts'
import { GameLoop } from './sim/gameLoop.ts'
import { createWorld, snapshotWorld } from './sim/world.ts'
import type { WorldSnapshot } from './sim/world.ts'

/** 對局種子（與 `pnpm sim` 相同，方便對照）。 */
export const SEED = 42

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

export interface GameSession {
  readonly scene: GameScene
  /** 最新一份世界快照（插值的「當前」幀）。 */
  getSnapshot(): WorldSnapshot | null
  getUnitInfo(unitId: number): UnitInfo | null
  getBuildingInfo(buildingId: number): BuildingInfo | null
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
 * - 雙方滑桿固定預設值（滑桿 UI 屬後續 prompt 的 ui 層）。
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

  let prev: WorldSnapshot = snapshotWorld(world)
  let curr: WorldSnapshot = prev

  const onTick = (w: World): void => {
    if (w.tick % STRATEGIC_INTERVAL_TICKS === 0) {
      for (const player of w.players) runStrategicCycle(w, player.id, policies[player.id])
    }
    if (w.tick % TACTICAL_INTERVAL_TICKS === 0) {
      for (const player of w.players) {
        plans[player.id] = computeTacticalPlan(w, player.id, policies[player.id])
      }
    }
    if (w.tick % MICRO_INTERVAL_TICKS === 0) {
      for (const player of w.players) runMicroCycle(w, player.id, plans[player.id])
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
      return {
        id: unit.id,
        defId: unit.defId,
        player: unit.player,
        hp: unit.hp,
        maxHp: def.stats.hp,
        tileX: tile.x,
        tileY: tile.y,
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
    stop: (): void => {
      app.ticker.remove(onFrame)
      activeSession = null
    },
  }
  activeSession = session
  return session
}
