/**
 * 攻擊特效的**純偵測** helpers（Prompt 10.24）：從相鄰兩 tick 的世界快照 diff 出
 * 「本 tick 誰開火了」與「塔的受害者」。不 import pixi——可在 node 單測；
 * sim 層零改動（塔的受害者由渲染層現算，避免在 sim 設 `building.targetId`
 * 引入 id 平手鏡像分叉）。
 */
import { UNITS_PER_TILE } from '../sim/types.ts'
import type { WorldDefs } from '../sim/types.ts'
import type { WorldSnapshot } from '../sim/world.ts'

/** 單位快照（結構子集，`WorldSnapshot['units'][number]` 可指派）。 */
export type FxUnit = WorldSnapshot['units'][number]

/** 建築快照（結構子集）。 */
export type FxBuilding = WorldSnapshot['buildings'][number]

/**
 * 開火判據（Prompt 10.24 修）：`attackAcc` 每 tick `＋attackSpeed / 20` **單調遞增**、
 * 開火當 tick `−1` → 「after ＜ before」⟺ 本 tick 開火。
 *
 * 舊判據 `before ≥ 1 && after ＜ before` 只在**冷卻封頂（閒置）後的首發**成立——
 * 持續交戰時快照序列是 0.05 → 0.10 → … → 0.95 → 0（開火）→ 0.05…，before 恆 ＜ 1，
 * 逐發特效全部丟失（長距離對射看不到彈道的根因，只有第一發有動畫）。
 */
export function firedThisTick(beforeAcc: number, afterAcc: number): boolean {
  return afterAcc < beforeAcc
}

/**
 * 塔的受害者（快照版，復刻 sim `acquireBuildingTarget` 語義，Prompt 10.24）：
 * 帶 `defense` 且存活的建築 → 防禦射程內**最近**敵方單位（距離＝單位 px 到佔地
 * **外框**，與 `combat.ts` 同一算法；w/h 由內容定義補齐——快照不帶佔地尺寸），
 * 平手取**先出現者**（快照單位依 id 升冪 ⟺ id 較小者）；無則 null。
 */
export function towerVictimOf(
  defs: WorldDefs,
  building: Pick<FxBuilding, 'defId' | 'player' | 'x' | 'y' | 'hp'>,
  units: readonly FxUnit[],
): FxUnit | null {
  const def = defs.buildings[building.defId]
  const defense = def?.defense
  if (def === undefined || defense === undefined || building.hp <= 0) return null
  const rangeFixed = Math.round(defense.range * UNITS_PER_TILE)
  const [w, h] = def.size
  const x0 = building.x * UNITS_PER_TILE
  const y0 = building.y * UNITS_PER_TILE
  const x1 = (building.x + w) * UNITS_PER_TILE
  const y1 = (building.y + h) * UNITS_PER_TILE
  let best: FxUnit | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of units) {
    if (candidate.player === building.player || candidate.hp <= 0) continue
    const closestX = Math.min(Math.max(candidate.x, x0), x1)
    const closestY = Math.min(Math.max(candidate.y, y0), y1)
    const dx = candidate.x - closestX
    const dy = candidate.y - closestY
    const distance = dx * dx + dy * dy
    if (distance <= rangeFixed * rangeFixed) {
      // 平手取 id 較小者（與 sim `acquireBuildingTarget` 同義、與掃描序無關——
      // render 逐 tick 快照單位依 id 升冪，兩者一致）。
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
      } else if (distance === bestDistance && best !== null && candidate.id < best.id) {
        best = candidate
      }
    }
  }
  return best
}
