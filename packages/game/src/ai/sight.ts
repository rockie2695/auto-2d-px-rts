import { distanceSquaredToBuilding } from '../sim/combat.ts'
import { UNITS_PER_TILE } from '../sim/types.ts'
import type { PlayerId, World } from '../sim/types.ts'

/**
 * 視野（Prompt 9.5b：真·資訊不完全）：AI 判知的**單一真相來源**。
 *
 * - 單位視野 = 6 格（與主動防禦守備半徑 `DEFENSE_RADIUS_TILES` 同值——
 *   「守得住的距離 = 看得到的距離」；influence.test 有交叉核對）。
 * - 帶 `defense` 的建築（塔）= 防禦射程 + 2；其餘建築 = 6 格
 *   （主動防禦的偵測半徑也是 6——敵人進守備半徑必在視野內，攔截不失明）。
 * - **無記憶**：本模組全部無狀態——敵人離開視野即從 AI 判知消失
 *   （影響力地圖／生產克制／接觸迎戰都當場重算，不留影）。
 *
 * 幾何全部整數距離平方（固定點 px），跨平台確定；鏡像對稱：
 * 鏡射世界裡 `player` 的視野集與 `enemy` 的視野集互為鏡像
 * （對稱局面 → 雙方判知對稱 → fullMirrorProbe 守門依然成立）。
 */

/** 單位視野半徑（tile）。必須等於 DEFENSE_RADIUS_TILES（測試守門）。 */
export const UNIT_SIGHT_TILES = 6

/** 無防禦建築的視野半徑（tile）。 */
export const BUILDING_SIGHT_TILES = 6

/** 塔視野 = 防禦射程 + 此常數（tile）。 */
export const TOWER_SIGHT_BONUS_TILES = 2

/** 帶防禦的建築視野（tile）：防禦射程 + 2；其餘 = 基準值。 */
export function buildingSightTiles(world: World, buildingDefId: string): number {
  const range = world.defs.buildings[buildingDefId]?.defense?.range
  return range === undefined
    ? BUILDING_SIGHT_TILES
    : Math.round(range) + TOWER_SIGHT_BONUS_TILES
}

/**
 * 固定點座標 `(x, y)` 是否在 `playerId` 的視野內。
 * 視野 = 存活我方單位（6 格圓）∪ 存活我方建築（塔射程+2／其餘 6 格）的並集；
 * 建築距離以**佔地外框邊緣**計（與戰鬥射程同一量測，`distanceSquaredToBuilding`）。
 */
export function isVisibleTo(world: World, playerId: PlayerId, x: number, y: number): boolean {
  const unitRadius = UNIT_SIGHT_TILES * UNITS_PER_TILE
  const unitLimit = unitRadius * unitRadius
  for (const unit of world.units) {
    if (unit.player !== playerId || unit.hp <= 0) continue
    const dx = unit.x - x
    const dy = unit.y - y
    if (dx * dx + dy * dy <= unitLimit) return true
  }
  for (const building of world.buildings) {
    if (building.player !== playerId || building.hp <= 0) continue
    const radius = buildingSightTiles(world, building.defId) * UNITS_PER_TILE
    if (distanceSquaredToBuilding({ x, y }, building) <= radius * radius) return true
  }
  return false
}

/**
 * 整張地圖的視野遮罩（UI 迷霧層 + 測試用）：每格一布林，
 * 格中心（固定點中點）可見 = true。index = ty × size + tx。
 */
export function visibleTileMask(world: World, playerId: PlayerId): boolean[] {
  const size = world.map.size
  const mask = new Array<boolean>(size * size).fill(false)
  const half = UNITS_PER_TILE / 2
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      mask[ty * size + tx] = isVisibleTo(
        world,
        playerId,
        tx * UNITS_PER_TILE + half,
        ty * UNITS_PER_TILE + half,
      )
    }
  }
  return mask
}
