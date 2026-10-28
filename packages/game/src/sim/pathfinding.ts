import type { TilePos } from './types.ts'

/**
 * 格線 A\*（SPEC §9.4）：4 方向、曼哈頓啟發、成本 1。
 *
 * 確定性：鄰居展開順序固定，open list 用「最小 f → 較早插入」穩定選取，
 * 相同起訖格在任何平台都會產生相同路徑。
 */

export interface PathQuery {
  /** 地圖邊長（32）。 */
  size: number
  /** 格是否可走；界外一律由本函式視為不可走。 */
  walkable: (tile: TilePos) => boolean
}

/** 鄰居展開的固定順序（北、東、南、西）。 */
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

/**
 * 求 start → goal 的格路徑。
 *
 * @returns 依序的**下一格**清單（不含 start，含 goal）；
 *          start === goal 回傳空陣列；無路徑回傳 null。
 */
export function findPath(query: PathQuery, start: TilePos, goal: TilePos): TilePos[] | null {
  const { size, walkable } = query
  const inBounds = (tile: TilePos): boolean =>
    tile.x >= 0 && tile.y >= 0 && tile.x < size && tile.y < size

  if (!inBounds(start) || !inBounds(goal)) return null
  if (!walkable(goal)) return null
  if (start.x === goal.x && start.y === goal.y) return []

  const cellCount = size * size
  const indexOf = (tile: TilePos): number => tile.y * size + tile.x
  const tileAt = (index: number): TilePos => ({ x: index % size, y: Math.floor(index / size) })
  const heuristic = (index: number): number => {
    const tile = tileAt(index)
    return Math.abs(tile.x - goal.x) + Math.abs(tile.y - goal.y)
  }

  const startIndex = indexOf(start)
  const goalIndex = indexOf(goal)

  const gScore = new Array<number>(cellCount).fill(Number.POSITIVE_INFINITY)
  const cameFrom = new Array<number>(cellCount).fill(-1)
  const closed = new Array<boolean>(cellCount).fill(false)

  gScore[startIndex] = 0
  const open: number[] = [startIndex]

  while (open.length > 0) {
    // 穩定選取：最小 fScore；平手取陣列中較早插入者。
    let bestPosition = 0
    let bestScore = Number.POSITIVE_INFINITY
    for (let position = 0; position < open.length; position++) {
      const index = open[position] ?? -1
      const score = (gScore[index] ?? Number.POSITIVE_INFINITY) + heuristic(index)
      if (score < bestScore) {
        bestScore = score
        bestPosition = position
      }
    }

    const currentIndex = open[bestPosition] ?? -1
    open.splice(bestPosition, 1)
    if (closed[currentIndex]) continue

    if (currentIndex === goalIndex) {
      const path: TilePos[] = []
      let cursor = currentIndex
      while (cursor !== startIndex) {
        path.push(tileAt(cursor))
        cursor = cameFrom[cursor] ?? -1
        if (cursor === -1) return null // 不應發生；防呆避免無限迴圈
      }
      path.reverse()
      return path
    }

    closed[currentIndex] = true
    const current = tileAt(currentIndex)
    const currentG = gScore[currentIndex] ?? Number.POSITIVE_INFINITY

    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      const neighbor: TilePos = { x: current.x + dx, y: current.y + dy }
      if (!inBounds(neighbor) || !walkable(neighbor)) continue
      const neighborIndex = indexOf(neighbor)
      if (closed[neighborIndex]) continue

      const tentativeG = currentG + 1
      if (tentativeG < (gScore[neighborIndex] ?? Number.POSITIVE_INFINITY)) {
        cameFrom[neighborIndex] = currentIndex
        gScore[neighborIndex] = tentativeG
        open.push(neighborIndex)
      }
    }
  }

  return null
}
