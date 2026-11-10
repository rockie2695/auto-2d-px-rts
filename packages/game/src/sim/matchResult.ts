import { TICK_RATE_HZ } from '@auto-2d-px-rts/shared'

import type { ResourceAmount } from '@auto-2d-px-rts/shared'
import type { MatchResult } from '../replay.ts'
import { buildingEffectiveMaxHp } from './types.ts'
import type { PlayerId, ResourceStock, World } from './types.ts'

/**
 * 對局結束與勝負判定（純函數，無渲染依賴）：
 * session.ts 與 CLI（aiCli）共用——**語義單一來源**，避免兩處抄寫漂移。
 * （從 session.ts 抽出：session 透過 gameLoop 間接依賴 pixi，node CLI 不能引。）
 */

/** 主堡 defId（不可建造、只能由開局配置放置；SPEC §12）。 */
const KEEP_DEF_ID = 'keep'

/** AI 投降後的寬限（Prompt 8.6）：遊戲繼續 3 秒後定案。 */
export const SURRENDER_GRACE_TICKS = 3 * TICK_RATE_HZ

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

/** 對局是否已結束：一方主堡被毀、一方全滅（無建築且無單位）、AI 投降且 3 秒寬限已過，或達 `match.maxTicks` 上限。 */
export function matchEnded(world: World): boolean {
  if (world.tick >= world.match.maxTicks) return true
  // AI 投降（Prompt 8.6）：寬限 3 秒（遊戲繼續）後定案。
  if (world.surrender !== null && world.tick >= world.surrender.tick + SURRENDER_GRACE_TICKS) {
    return true
  }
  return (
    !keepAlive(world, 'player') ||
    !keepAlive(world, 'enemy') ||
    hasNoForces(world, 'player') ||
    hasNoForces(world, 'enemy')
  )
}

/**
 * 勝負判定：一方主堡被毀 → 對方勝；同 tick 雙殺 → 全滅者敗（都還有部隊 → 平手）；
 * **超時（10:00 雙主堡俱在）→ 總價值多者勝、嚴格相等才平手**
 * （Prompt 10.23 破局：鏡像僵持的兜底裁定——取代 Prompt 10.10 的「一律平手」）。
 * 全滅（無建築且無單位）同樣判負——無建築必含主堡已毀，此為 SPEC §11.1 的另一面。
 * 手動提前結束（雙主堡俱在且未超時）→ 平手（Prompt 10.10 既有語義不變）。
 * AI 投降（Prompt 8.6）：投降方判負。雙方同 tick 投降 → 平手（各不願再戰）。
 */
export function resolveMatchResult(world: World): MatchResult {
  // AI 投降（Prompt 8.6）：投降方判負。
  if (world.surrender !== null) {
    return world.surrender.player === 'player' ? 'enemy' : 'player'
  }
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
  // 雙主堡俱在且已超時 → 超時值裁定（Prompt 10.23）；未超時（手動提前結束）→ 平手。
  if (world.tick >= world.match.maxTicks) {
    const playerValue = matchSideValue(world, 'player')
    const enemyValue = matchSideValue(world, 'enemy')
    if (playerValue !== enemyValue) return playerValue > enemyValue ? 'player' : 'enemy'
  }
  return 'draw'
}

/** 三資源總和（Prompt 5：超時值裁定的庫存項）。 */
function totalResourcesOf(stock: ResourceStock): number {
  return stock.blue_crystal + stock.red_ruby + stock.green_emerald
}

/** 單位／建築總成本（三資源等權求和）。 */
function totalCostOf(cost: ResourceAmount): number {
  return cost.blue_crystal + (cost.red_ruby ?? 0) + (cost.green_emerald ?? 0)
}

/**
 * 陣營**總價值**（Prompt 10.23 超時值裁定）：三資源庫存 + 單位殘值 + 建築殘值
 * （Prompt 5：庫存項 = 藍水晶＋紅寶石＋綠翡翠總和——紅綠即時無消費者也是資產；
 * 殘值成本 = 三資源總成本）。
 * 殘值 = `cost ×（現 hp ÷ 有效最大 hp）` 四捨五入——興建中建築的有效最大 hp
 * 已按完成比例折算（SPEC §5）→ 殘值自動含完成度。全整數運算、跨平台一致。
 */
export function matchSideValue(world: World, playerId: PlayerId): number {
  const player = world.players.find((candidate) => candidate.id === playerId)
  let value = player === undefined ? 0 : totalResourcesOf(player.resources)
  for (const unit of world.units) {
    if (unit.player !== playerId || unit.hp <= 0) continue
    const def = world.defs.units[unit.defId]
    if (def === undefined) continue
    value += Math.round((totalCostOf(def.cost) * unit.hp) / Math.max(1, def.stats.hp))
  }
  for (const building of world.buildings) {
    if (building.player !== playerId || building.hp <= 0) continue
    const def = world.defs.buildings[building.defId]
    if (def === undefined) continue
    value += Math.round(
      (totalCostOf(def.cost) * building.hp) / buildingEffectiveMaxHp(def, building),
    )
  }
  return value
}
