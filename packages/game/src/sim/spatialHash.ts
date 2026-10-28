import { UNITS_PER_TILE } from './types.ts'
import type { SpatialHash, World } from './types.ts'

/**
 * 空間雜湊：每格（1 格 = 1 bucket）一份名單，鄰近查詢只掃相關格子。
 *
 * 每 tick 在移動後整批重建（MVP 單位 ≤ 80，重建比增量維護更簡單且同樣確定）。
 * 查詢結果一律**依 id 升冪排序**回傳，讓「最近目標」的平手裁決有穩定順序。
 */

export interface NearQuery {
  unitIds: number[]
  buildingIds: number[]
}

export function createSpatialHash(): SpatialHash {
  return { units: new Map(), buildings: new Map() }
}

function cellIndexOf(size: number, fixedX: number, fixedY: number): number {
  const cellX = Math.min(size - 1, Math.max(0, Math.floor(fixedX / UNITS_PER_TILE)))
  const cellY = Math.min(size - 1, Math.max(0, Math.floor(fixedY / UNITS_PER_TILE)))
  return cellY * size + cellX
}

/** 以目前的單位／建築位置重建雜湊（每個 tick 摼一次）。 */
export function rebuildSpatialHash(world: World): void {
  const size = world.map.size
  world.hash.units.clear()
  world.hash.buildings.clear()

  for (const unit of world.units) {
    const key = cellIndexOf(size, unit.x, unit.y)
    const bucket = world.hash.units.get(key)
    if (bucket === undefined) world.hash.units.set(key, [unit.id])
    else bucket.push(unit.id)
  }

  for (const building of world.buildings) {
    // 佔地的每一格都放一份；查詢端用 seen 去重。
    for (let cellY = building.y; cellY < building.y + building.h; cellY++) {
      for (let cellX = building.x; cellX < building.x + building.w; cellX++) {
        const key = cellY * size + cellX
        const bucket = world.hash.buildings.get(key)
        if (bucket === undefined) world.hash.buildings.set(key, [building.id])
        else bucket.push(building.id)
      }
    }
  }
}

/**
 * 查詢固定點座標 (fixedX, fixedY) 半徑 radius 內的候選。
 *
 * 格範圍外再擴 1 格 padding：確保「到建築外框距離 ≤ radius」的建築
 * 一定會被掃到（建築以整塊佔地入 bucket，單位只在自己的格）。
 * 回傳的是**候選**，精確距離由呼叫端判定。
 */
export function queryNear(world: World, fixedX: number, fixedY: number, radius: number): NearQuery {
  const size = world.map.size
  const toCell = (fixed: number): number => Math.floor(fixed / UNITS_PER_TILE)
  const cellMinX = Math.max(0, toCell(fixedX - radius) - 1)
  const cellMaxX = Math.min(size - 1, toCell(fixedX + radius) + 1)
  const cellMinY = Math.max(0, toCell(fixedY - radius) - 1)
  const cellMaxY = Math.min(size - 1, toCell(fixedY + radius) + 1)

  const unitIds: number[] = []
  const seenBuildings = new Set<number>()

  for (let cellY = cellMinY; cellY <= cellMaxY; cellY++) {
    for (let cellX = cellMinX; cellX <= cellMaxX; cellX++) {
      const key = cellY * size + cellX
      const units = world.hash.units.get(key)
      if (units !== undefined) unitIds.push(...units)
      const buildings = world.hash.buildings.get(key)
      if (buildings !== undefined) {
        for (const buildingId of buildings) seenBuildings.add(buildingId)
      }
    }
  }

  unitIds.sort((a, b) => a - b)
  const buildingIds = [...seenBuildings].sort((a, b) => a - b)
  return { unitIds, buildingIds }
}
