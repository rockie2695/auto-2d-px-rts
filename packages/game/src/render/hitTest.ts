import { fixedToPx } from './interpolate.ts'
import { TILE_SIZE, UNIT_RENDER_SIZE } from './constants.ts'
import type { WorldSnapshot } from '../sim/world.ts'
import type { Viewport } from './viewport.ts'

/**
 * 點擊拾取（純函式，Prompt 9）：螢幕座標 → 世界座標 → 命中的單位/建築 id。
 * 拾取用**當前快照**（不用插值位置），讓判定貼合最新 sim 狀態。
 */

/** 點擊拾取結果：先單位、再建築（單位點擊優先權高）。 */
export type SelectionTarget =
  | { readonly kind: 'unit'; readonly id: number }
  | { readonly kind: 'building'; readonly id: number }

/** 螢幕座標 → 世界座標（px；`computeViewport` 的逆運算）。 */
export function screenToWorld(
  screenX: number,
  screenY: number,
  viewport: Viewport,
): { x: number; y: number } {
  return {
    x: (screenX - viewport.offsetX) / viewport.scale,
    y: (screenY - viewport.offsetY) / viewport.scale,
  }
}

/** 命中框半邊長（px）：與渲染色塊一致（UNIT_RENDER_SIZE 的中心 ± 一半）。 */
const HALF = UNIT_RENDER_SIZE / 2

/**
 * 找點擊命中的單位 id；沒有命中回傳 null。
 * 重疊一律取 id 最小者（確定性）。
 */
export function pickUnit(snapshot: WorldSnapshot, worldX: number, worldY: number): number | null {
  let hit: number | null = null
  for (const unit of snapshot.units) {
    const px = Math.round(fixedToPx(unit.x))
    const py = Math.round(fixedToPx(unit.y))
    if (worldX < px - HALF || worldX > px + HALF) continue
    if (worldY < py - HALF || worldY > py + HALF) continue
    if (hit === null || unit.id < hit) hit = unit.id
  }
  return hit
}

/** 從定義 id 取建築佔地（格）；定義不存在回傳 null。 */
export type BuildingSizeOf = (defId: string) => { readonly w: number; readonly h: number } | null

/** 快照無佔地欄位 → 命中箱由呼叫端供給 defs 尺寸（scene.buildingSizeOf）。 */
export function pickBuilding(
  snapshot: WorldSnapshot,
  worldX: number,
  worldY: number,
  sizeOf: BuildingSizeOf,
): number | null {
  let hit: number | null = null
  for (const building of snapshot.buildings) {
    const size = sizeOf(building.defId)
    if (size === null) continue
    const x0 = building.x * TILE_SIZE
    const y0 = building.y * TILE_SIZE
    if (worldX < x0 || worldX >= x0 + size.w * TILE_SIZE) continue
    if (worldY < y0 || worldY >= y0 + size.h * TILE_SIZE) continue
    if (hit === null || building.id < hit) hit = building.id
  }
  return hit
}

/** 點擊拾取（Prompt 9.1）：單位優先、其次建築、空白回 null。 */
export function pickTarget(
  snapshot: WorldSnapshot,
  worldX: number,
  worldY: number,
  sizeOf: BuildingSizeOf,
): SelectionTarget | null {
  const unitId = pickUnit(snapshot, worldX, worldY)
  if (unitId !== null) return { kind: 'unit', id: unitId }
  const buildingId = pickBuilding(snapshot, worldX, worldY, sizeOf)
  if (buildingId !== null) return { kind: 'building', id: buildingId }
  return null
}
