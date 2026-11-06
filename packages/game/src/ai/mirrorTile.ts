import { tileOf, UNITS_PER_TILE } from '../sim/types.ts'
import type { TilePos } from '../sim/types.ts'

/**
 * 單一固定點 px 的**鏡像安全取格**（Prompt 10.22，Prompt 10.23 擴及全 AI 層）：
 * 紅方一律先在**正規化（藍方）座標**取格再鏡回實座標——px 恰停在**格邊界**
 * （200 的倍數）時，直接對紅方實座標 floor 會翻到錯邊的格（藍 tile 10 ↔
 * 紅直接取格得 22 而非鏡像的 21；偶數尺寸建築的中心 px 必落在格邊界上），
 * 使紅藍的 AI 決策（目的地、接近格、威脅中心）差一格、fullMirrorProbe 分叉。
 * 回傳的格＝鏡射一致的格：藍方等於 `tileOf(x, y)`；紅方等於鏡像
 * `31 − tileOf(mapPx − x, mapPx − y)`（canonical 路徑：先鏡 px 再 floor 再鏡回）。
 */
export function mirrorSafeTileOf(
  mapSize: number,
  mirrorOrder: boolean,
  x: number,
  y: number,
): TilePos {
  if (!mirrorOrder) return tileOf(x, y)
  const mapPx = mapSize * UNITS_PER_TILE
  const canonical = tileOf(mapPx - x, mapPx - y)
  return { x: mapSize - 1 - canonical.x, y: mapSize - 1 - canonical.y }
}
