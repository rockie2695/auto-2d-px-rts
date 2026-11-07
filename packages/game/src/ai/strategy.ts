import type { PolicyValues } from './policy.ts'
import { buildEconWeight, buildMilitaryWeight } from './policy.ts'
import { pickMostUrgentThreat } from './influence.ts'
import type { DecisionTopFactor, ExplainState } from './explain.ts'
import { explainBuild, explainTrain } from './explain.ts'
import type { ResourceId, Role } from '@auto-2d-px-rts/shared'
import { canAfford, placeBuilding, producedResourceOf, queueTrain } from '../sim/economy.ts'
import { findNearestPlacement, tryFindNearestFreeNode } from '../sim/world.ts'
import { getPlayer } from '../sim/types.ts'
import type { PlayerId, TilePos, World } from '../sim/types.ts'
import { hashFate } from '../sim/rng.ts'
import { survivalScoreOf } from '../balance/unitStats.ts'

/**
 * AI 戰略層（SPEC §8，Prompt 6 / 6.5）：每 40 tick（= 2 秒）決定「蓋什麼、生什麼」。
 *
 * 兩條獨立軌道，各取最高分且可負擔者執行一次：
 * - 建築軌：`U = weight × (1 − 飽和度)`；一礦都沒有時礦場強制 3.0
 *   （SPEC §8.1「除非一礦都沒有」，避免重經濟滑桿餓死）。
 * - 生產軌：`score = counterScore + tierScore + rangeScore − 稀缺性懲罰
 *   ＋ 生存項（Prompt 3.1：roster 內正規化有效HP/cost × 0.15 < FATE_BAND，
 *   只影響抽籤機率不消滅候選）`。
 * - **建築預備金（Prompt 10.24 A）**：建築軌未飽和時，生產軌不得把水晶花到
 *   「下一個建築目標的造價」以下——否則單位生產吞光結餘、建築永遠饿死
 *   （實測：水晶 9~49 震盪、塔只蓋得出開局一座）。全飽和 → 預備金 0。
 *
 * 每個實際執行的動作產出一條 `DecisionRecord`（Prompt 6.5）：
 * 候選分數、當時滑桿、主導因素與一行中文解釋（explain.ts 規則式模板）。
 *
 * 本層只做決策與下單（placeBuilding / queueTrain）；
 * 移動與接戰屬戰術層／微操層（之後的 Prompt）。全部決策確定性可重現。
 */

/** 戰略決策間隔（SPEC §8.1：每 40 tick = 2 秒）。 */
export const STRATEGIC_INTERVAL_TICKS = 40

/** 同種單位每多 1 個的稀缺性懲罰（防止鎖死單一種，同分時自然均攤）。 */
const SCARCITY_PENALTY = 0.05

/**
 * 敵軍壓境時的防守生產加權（Prompt 10.6，保護建築與水晶）：
 * 我方建築守備半徑內有敵軍（`pickMostUrgentThreat` 非 null）時，
 * 每個單位候選分數 +1.0——即使重經濟（econMilitary=1）或稀缺性懲罰偏高，
 * 也會持續產兵回防，而不是眼看礦場被拆。
 */
export const THREAT_DEFENSE_BONUS = 1.0

/**
 * 生存項權重（階段三 Prompt 3.1）：`survivalScoreOf`（roster 內正規化
 * 有效HP/cost 到 0..1）乘此權重併入生產分數。刻意取**小於 FATE_BAND（0.2）**——
 * 生存項單獨的滿差不得把弱甲單位整個擠出命運抽籤帶（Prompt 10.11 的多樣性
 * 必須保留；裝甲只影響抽籤機率權重，不消滅候選）。生產分數的主導結構仍是
 * counter + tier + range（balance 是刀-edge，由 fairness gate 實測守門）。
 */
export const SURVIVAL_SCORE_WEIGHT = 0.15

/** tier 由小到大的序數（unitSize 滑桿目標：0 → large、1 → small）。 */
const TIER_ORDER: Record<string, number> = { small: 0, medium: 1, large: 2 }

/** 一次戰略循環的產出（供 CLI 紀錄與測試斷言）。 */
export type StrategicAction =
  | { kind: 'build'; defId: string; tile: TilePos }
  | { kind: 'train'; defId: string }

/**
 * 單條決策記錄（Prompt 6.5）：只記錄實際執行的動作（每循環最多 2 條）。
 * `target` 對 build 為 `defId@(x,y)`、對 train 為 defId。
 */
export interface DecisionRecord {
  /** 決策當下的 world.tick。 */
  tick: number
  /** 所屬決策層；戰術層／微操層之後的 Prompt 擴充。 */
  layer: 'strategic'
  actor: PlayerId
  action: 'build' | 'train'
  target: string
  reason: {
    /** 當軌全部（可行）候選，依分數降冪。 */
    candidates: Array<{ defId: string; score: number }>
    /** 當時的 5 個 Policy 滑桿（快照複本）。 */
    weights: PolicyValues
    /** 主導因素（與 explanation 同一條規則鏈產出）。 */
    topFactor: DecisionTopFactor
    /** 一行中文解釋（explain.ts 規則式模板）。 */
    explanation: string
  }
}

/** 一次戰略循環的完整產出。 */
export interface StrategicCycleResult {
  actions: StrategicAction[]
  records: DecisionRecord[]
}

/* ------------------------------------------------------------------ */
/* 建築軌                                                              */
/* ------------------------------------------------------------------ */

/** 候選建築的可行性與效用。 */
interface BuildingCandidate {
  defId: string
  score: number
  /** 放置點（mine 用最近空閒節點，其餘用最近有效位）。 */
  tile: TilePos
  /** 水晶是否買得起。買不起的候選**保留在列表中**——供建築預備金
   *  （Prompt 10.24 A：生產軌不得把水晶花到下一個建築目標造價以下）。 */
  affordable: boolean
}

/** 帶防禦建築（塔）的放置錨點向敵方 keep 前移的格數（Prompt 10.24 B：前置防線）。
 *  （平衡實測：3 格 → 24-seed 全平——塔太靠中路，雙方攻勢反覆被塔火拉回；
 *   1 格 = keep 邊緣朝敵位移，同樣告別「塔與礦/兵營擠成一團」且攻勢不癱瘓。） */
export const TOWER_FORWARD_TILES = 1

/** 玩家的錨點：keep **中心格**（Prompt 10.9：點鏡射不變量——紅藍錨點互為精確鏡像，
 *  配合 mirrorOrder 平手裁決，兩側的建築位置決策逐項鏡像）。無 keep（合成世界）用出生點。 */
function anchorOf(world: World, playerId: PlayerId): TilePos {
  const keep = world.buildings.find(
    (building) => building.player === playerId && building.defId === 'keep',
  )
  if (keep !== undefined) {
    return {
      x: keep.x + Math.floor(keep.w / 2),
      y: keep.y + Math.floor(keep.h / 2),
    }
  }
  return getPlayer(world, playerId).spawn
}

/** 塔類建築的每方上限（Prompt 10.16）：2 座即飽和，AI 不再蓋。 */
export const TOWER_CAP = 2

/** 某玩家擁有的**指定資源類型**礦場數（Prompt 5：按礦場產出資源分型計數）。 */
function mineCountOfType(world: World, playerId: PlayerId, type: ResourceId): number {
  return world.buildings.filter((building) => {
    if (building.player !== playerId || building.hp <= 0 || building.nodeId === null) return false
    const def = world.defs.buildings[building.defId]
    return def !== undefined && producedResourceOf(def) === type
  }).length
}

/** 本地圖對應類型節點總數（飽和分母；放置本身由空閒節點與 mineCap 夾制）。 */
function nodesOfType(world: World, type: ResourceId): number {
  return world.map.resourceNodes.filter((node) => node.resourceType === type).length
}

function saturationOf(world: World, playerId: PlayerId, defId: string): number {
  const player = getPlayer(world, playerId)
  const def = world.defs.buildings[defId]
  if (def === undefined) return 1
  if (def.requiresResourceNode === true) {
    // 礦場按**資源類型**分型飽和（Prompt 5）：分母 = 該類型節點總數——
    // 實際放置由「空閒節點」與 mineCap 夾制，飽和分只影響效用排序。
    const type = producedResourceOf(def)
    if (type === null) return 0
    return mineCountOfType(world, playerId, type) / Math.max(1, nodesOfType(world, type))
  }
  if (def.produces.length > 0) {
    return player.barracksCount / world.match.barracksCap
  }
  const count = world.buildings.filter(
    (building) => building.player === playerId && building.defId === defId,
  ).length
  // 塔類（帶 defense，Prompt 10.16）：上限 `TOWER_CAP` = 2 座——2 座即飽和，
  // AI 不再蓋（避免塔海蓋爆經濟）。
  if (def.defense !== undefined) return count / TOWER_CAP
  return count // 未分類建築：蓋 1 座即飽和
}

/**
 * 評估建築候選（含可行性）：
 * 無空閒節點、無放置空間的候選直接剔除；**買不起的候選保留**（`affordable` 標記，
 * Prompt 10.24 A——建築軌執行時自然跳過，生產軌為它攬預備金）。
 */
function evaluateBuildings(world: World, playerId: PlayerId, policies: PolicyValues): BuildingCandidate[] {
  const player = getPlayer(world, playerId)
  const anchor = anchorOf(world, playerId)
  const econ = buildEconWeight(policies)
  const military = buildMilitaryWeight(policies)
  // 幾何掃描序鏡像（Prompt 10.9）：敵方側平手裁決反轉，紅藍建築位置互為鏡像。
  const mirrorOrder = playerId === 'enemy'

  const candidates: BuildingCandidate[] = []
  for (const defId of world.faction.buildings) {
    const def = world.defs.buildings[defId]
    if (def === undefined) continue

    // 帶防禦的建築（塔，Prompt 10.24 B）：放置錨點朝敵方 keep 方向**符號位移**
    // `TOWER_FORWARD_TILES` 格（前置防線，貼著 keep 蓋守不到礦與兵營）。
    // 用 **sign 位移**而非比例截斷——sign 在鏡射下嚴格翻轉、無捨入，
    // 比例截斷的 `.5` 進位正是 10.23 rallyPoint 鏡像缺陷的來源。
    let buildAnchor = anchor
    if (def.defense !== undefined) {
      const enemyKeep = world.buildings.find(
        (candidate) =>
          candidate.player !== playerId && candidate.hp > 0 && candidate.defId === 'keep',
      )
      if (enemyKeep !== undefined) {
        const foeX = enemyKeep.x + Math.floor(enemyKeep.w / 2)
        const foeY = enemyKeep.y + Math.floor(enemyKeep.h / 2)
        const clampTile = (value: number): number =>
          Math.min(world.map.size - 1, Math.max(0, value))
        buildAnchor = {
          x: clampTile(anchor.x + Math.sign(foeX - anchor.x) * TOWER_FORWARD_TILES),
          y: clampTile(anchor.y + Math.sign(foeY - anchor.y) * TOWER_FORWARD_TILES),
        }
      }
    }

    // 可行性：放置點必須找得到（Prompt 5：礦場找**對應資源類型**的空閒節點）。
    const [w, h] = def.size
    const mineType = def.requiresResourceNode === true ? producedResourceOf(def) : null
    let tile: TilePos | null
    if (def.requiresResourceNode === true) {
      tile = tryFindNearestFreeNode(world, buildAnchor, mirrorOrder, mineType)?.tile ?? null
    } else {
      tile = findNearestPlacement(world, buildAnchor, w, h, mirrorOrder)
    }
    if (tile === null) continue

    // 效用（Prompt 6 權重映射 × 飽和度）。
    const weight = def.requiresResourceNode === true ? econ : military
    let score = weight * (1 - saturationOf(world, playerId, defId))

    if (def.requiresResourceNode === true && mineType !== null) {
      // SPEC §8.1 擴展（Prompt 5）：**每種資源**的第一座礦強制高優先——
      // 但紅／綠礦受「藍礦先行」gate（見下），實際上強制項只在藍礦生效。
      if (mineType === 'blue_crystal' && player.mineCount === 0) {
        score = Math.max(score, 3.0)
      }
      // 資源分配啟發式（Prompt 5 #6，AI 內建；resourceBias 滑杆留待後續 prompt）：
      // - 藍礦永遠優先（基礎資源）——紅／綠礦在「藍礦再無空閒節點可蓋」前不評分；
      // - 紅礦（軍事）：藍礦節點耗盡後立即入列；roster 有吃紅寶石的單位加固定分；
      // - 綠礦（科技）：零消費者（MVP 無科技系統）→ 紅礦蓋出後才解鎖且分數打 5 折。
      if (mineType !== 'blue_crystal') {
        const blueExhausted =
          tryFindNearestFreeNode(world, buildAnchor, mirrorOrder, 'blue_crystal') === null
        if (mineType === 'red_ruby') {
          const rosterNeedsRuby = world.faction.roster.some((unitId) => {
            const unitDef = world.defs.units[unitId]
            return unitDef !== undefined && (unitDef.cost.red_ruby ?? 0) > 0
          })
          score = blueExhausted
            ? weight * (1 - saturationOf(world, playerId, defId)) + (rosterNeedsRuby ? 0.4 : 0)
            : 0
        } else {
          const rubyCount = mineCountOfType(world, playerId, 'red_ruby')
          score =
            blueExhausted && rubyCount >= 1
              ? weight * (1 - saturationOf(world, playerId, defId)) * 0.5
              : 0
        }
      }
    }

    // 買得起與否改為**標記**（Prompt 10.24 A）：買不起的候選不從列表剔除——
    // 它仍是建築軌的目標（建築軌執行時 placeBuilding 自然拒絕、落到次高），
    // 且生產軌要為它**攢預備金**，否則單位生產每循環吞光結餘、建築永遠饿死。
    // （Prompt 5：可負擔性 = 三資源逐一檢查。）
    const affordable = canAfford(player.resources, def.cost)

    candidates.push({ defId, score, tile, affordable })
  }

  // 依分數降冪；平手保留 palette 順序（穩定、確定性）。
  return candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
}

/* ------------------------------------------------------------------ */
/* 生產軌                                                              */
/* ------------------------------------------------------------------ */

interface UnitCandidate {
  defId: string
  score: number
}

/** 敵方活著單位的角色計數（melee / ranged）。 */
function enemyRoleCounts(world: World, playerId: PlayerId): Record<Role, number> {
  const totals: Record<Role, number> = { melee: 0, ranged: 0 }
  for (const unit of world.units) {
    if (unit.hp <= 0 || unit.player === playerId) continue
    totals[unit.role] += 1
  }
  return totals
}

/** 敵方角色佔比（melee / ranged）；無敵方單位回傳 null。 */
function enemyRoleShare(world: World, playerId: PlayerId): Record<Role, number> | null {
  const totals = enemyRoleCounts(world, playerId)
  const total = totals.melee + totals.ranged
  if (total === 0) return null
  return { melee: totals.melee / total, ranged: totals.ranged / total }
}

/** 克制分：Σ_敵方角色 佔比 × counterMatrix[我方角色][敵方角色]。 */
function counterScoreOf(world: World, myRole: Role, share: Record<Role, number> | null): number {
  if (share === null) return 1.0 // 無敵方單位 → 中性
  const matrix = world.faction.counterMatrix[myRole]
  return share.melee * matrix.melee + share.ranged * matrix.ranged
}

/** tier 分：與 unitSize 目標 tier 的接近度（1 → small、0 → large）。 */
function tierScoreOf(world: World, defId: string, policies: PolicyValues): number {
  const def = world.defs.units[defId]
  if (def === undefined) return 0
  const myIndex = TIER_ORDER[def.tier] ?? 1
  const target = Math.round((1 - Math.min(1, Math.max(0, policies.unitSize))) * 2)
  return 1 - Math.abs(myIndex - target) / 2
}

/** range 分：單位射程在 roster 內正規化後與 unitRange 的接近度（等價 §8.3 配額）。 */
function rangeScoreOf(world: World, defId: string, policies: PolicyValues): number {
  const def = world.defs.units[defId]
  if (def === undefined) return 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const rosterId of world.faction.roster) {
    const rosterDef = world.defs.units[rosterId]
    if (rosterDef === undefined) continue
    min = Math.min(min, rosterDef.stats.range)
    max = Math.max(max, rosterDef.stats.range)
  }
  const normalized = max === min ? 0.5 : (def.stats.range - min) / (max - min)
  const slider = Math.min(1, Math.max(0, policies.unitRange))
  return 1 - Math.abs(normalized - slider)
}

/** 玩家已擁有（活著 + 排程中）的某單位數量。 */
function ownedCountOf(world: World, playerId: PlayerId, defId: string): number {
  const alive = world.units.filter(
    (unit) => unit.player === playerId && unit.defId === defId && unit.hp > 0,
  ).length
  let queued = 0
  for (const building of world.buildings) {
    if (building.player !== playerId) continue
    queued += building.queue.filter((job) => job.defId === defId).length
  }
  return alive + queued
}

/**
 * 命運值（Prompt 10.11；10.14 種子活化）：由**比賽種子**與 tick 純函數導出的 [0,1) 值
 * （hashFate avalanche；不再借用 `world.rng.state`——該狀態保留給未來規則）。
 * - 同 tick 兩側同值 → 鏡像對稱（紅藍抽籤一致）。
 * - 跨 tick／跨種子變化 → 對局多樣性（軍種組成因種子而異）。
 */
function fateOf(world: World, tick: number): number {
  return hashFate(world.seed, tick)
}

/** 評估生產候選：克制 + tier + range − 稀缺性 ＋ 生存項 ＋ 壓境防守加權；不可負擔或無產能者剔除。 */
function evaluateUnits(world: World, playerId: PlayerId, policies: PolicyValues): UnitCandidate[] {
  const player = getPlayer(world, playerId)
  const share = enemyRoleShare(world, playerId)
  // 主動防禦（Prompt 10.6）：我方建築受威脅 → 防守生產加權（保護建築與水晶）。
  const threatened = pickMostUrgentThreat(world, playerId) !== null
  // 生存項（Prompt 3.1）的 roster 快照（rosterDefs 正規化基準）。
  const rosterDefs = world.faction.roster
    .map((rosterId) => world.defs.units[rosterId])
    .filter((def) => def !== undefined)

  const candidates: UnitCandidate[] = []
  for (const defId of world.faction.roster) {
    const def = world.defs.units[defId]
    if (def === undefined) continue
    // 可行性：有兵營能生產 + 負擔得起。
    const hasProducer = world.buildings.some(
      (building) =>
        building.player === playerId &&
        world.defs.buildings[building.defId]?.produces.includes(defId) === true,
    )
    if (!hasProducer) continue
    if (!canAfford(player.resources, def.cost)) continue

    const score =
      counterScoreOf(world, def.role, share) +
      tierScoreOf(world, defId, policies) +
      rangeScoreOf(world, defId, policies) -
      ownedCountOf(world, playerId, defId) * SCARCITY_PENALTY +
      (threatened ? THREAT_DEFENSE_BONUS : 0) +
      // 生存項（Prompt 3.1）：有效HP/cost 高者（如 shield_guard）加分。
      survivalScoreOf(def, rosterDefs) * SURVIVAL_SCORE_WEIGHT
    candidates.push({ defId, score })
  }

  return candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
}

/* ------------------------------------------------------------------ */
/* 決策執行                                                            */
/* ------------------------------------------------------------------ */

/** 選佇列最短、可生產該單位的兵營（平手取 id 小）。 */
function chooseProducer(world: World, playerId: PlayerId, defId: string): number | null {
  let bestId: number | null = null
  let bestLength = Number.POSITIVE_INFINITY
  for (const building of world.buildings) {
    if (building.player !== playerId) continue
    if (world.defs.buildings[building.defId]?.produces.includes(defId) !== true) continue
    if (building.queue.length < bestLength) {
      bestLength = building.queue.length
      bestId = building.id
    }
  }
  return bestId
}

/**
 * 執行一次戰略循環（呼叫端負責節流：每 STRATEGIC_INTERVAL_TICKS 一次）。
 * 建築軌與生產軌各嘗試執行一個最高分動作；
 * 回傳實際執行的動作（0–2 個）與對應的決策記錄（動作成功才記錄）。
 */
export function runStrategicCycle(
  world: World,
  playerId: PlayerId,
  policies: PolicyValues,
): StrategicCycleResult {
  const actions: StrategicAction[] = []
  const records: DecisionRecord[] = []
  const player = getPlayer(world, playerId)

  // 決策所依據的狀態快照（placeBuilding 會改動計數，先取 pre 值）。
  const enemyCounts = enemyRoleCounts(world, playerId)
  const explainState: ExplainState = {
    mineCount: player.mineCount,
    mineCap: world.match.mineCap,
    barracksCount: player.barracksCount,
    barracksCap: world.match.barracksCap,
    enemyMeleeCount: enemyCounts.melee,
    enemyRangedCount: enemyCounts.ranged,
  }

  // 建築軌：最高分優先（買不起的候選由 placeBuilding 自然拒絕、落到次高），
  // placeBuilding 拒絕（競態：節點被佔等）則嘗試次高。記住執行位置——
  // 供下方**建築預備金**取「下一個建築目標」。
  const buildingCandidates = evaluateBuildings(world, playerId, policies)
  let builtIndex = -1
  for (let index = 0; index < buildingCandidates.length; index++) {
    const candidate = buildingCandidates[index]
    if (candidate === undefined || candidate.affordable !== true) {
      continue // 買不起：這循環不蓋，生產軌為它攬錢
    }
    const building = placeBuilding(world, playerId, candidate.defId, candidate.tile)
    if (building !== null) {
      actions.push({ kind: 'build', defId: candidate.defId, tile: candidate.tile })
      const def = world.defs.buildings[candidate.defId]
      const explanation = explainBuild(
        {
          defId: candidate.defId,
          kind: def?.requiresResourceNode === true ? 'node' : 'military',
        },
        policies,
        explainState,
      )
      records.push({
        tick: world.tick,
        layer: 'strategic',
        actor: playerId,
        action: 'build',
        target: `${candidate.defId}@(${candidate.tile.x},${candidate.tile.y})`,
        reason: {
          candidates: buildingCandidates.map((c) => ({ defId: c.defId, score: c.score })),
          weights: { ...policies },
          topFactor: explanation.topFactor,
          explanation: explanation.text,
        },
      })
      builtIndex = index
      break
    }
  }

  // 建築預備金（Prompt 10.24 A）：建築軌未飽和時，生產軌不得把水晶花到
  // 「下一個建築目標的造價」以下——否則單位生產每循環吞光結餘（實測水晶
  // 永遠在 9~49 震盪），150~200 的塔／兵營永遠攒不齊，開局那座塔只是吃
  // 600 起始水晶的運氣。下一個目標 = 建成功 → 次高候選；未建成 → 最高分候選
  // （可能就是買不起的那座——預備金機制的存在意義）。全飽和（列表空 /
  // 已建最後一座）→ 預備金 0，全額造兵。
  const nextBuilding =
    builtIndex >= 0 ? buildingCandidates[builtIndex + 1] : buildingCandidates[0]
  // 冲刺阈值版预备金（Prompt 10.24 A 修订）：下一建筑目标**快买得起**（当前
  // 水晶 ≥ 造價 × RESERVE_SPRINT_THRESHOLD）才鎖下全額——否則不鎖、照常產兵。
  // 全額常鎖版實測（消融 A）：開局 600 花完後 t2000–t6000 雙方 **0 單位**，
  // 24-seed tally 崩成 1 藍/1 紅/22 平；衝刺版讓「產兵幾循環 → 攒滿 → 蓋建築」
  // 自然交替，軍力節奏與建築達標兩全。
  const SPRINT_THRESHOLD = 0.5
  const reserve = (() => {
    if (nextBuilding === undefined) return 0
    // 預備金只鎖藍水晶（建築成本全藍，Prompt 5 維持）。
    const cost = world.defs.buildings[nextBuilding.defId]?.cost.blue_crystal ?? 0
    if (cost === 0) return 0
    return player.resources.blue_crystal >= cost * SPRINT_THRESHOLD ? cost : 0
  })()

  // 生產軌：最高分優先，queueTrain 拒絕則嘗試次高。
  // **預備金保護**（Prompt 10.24 A）：扣掉預備金後仍買得起才排隊。
  // 命運抽籤（Prompt 10.11）：分數在 best − FATE_BAND 內的候選以 fate 抽選先後——
  // 同 tick 兩側同值（鏡像對稱）、跨種子變化（軍種組成因對局而異）。
  // （稀缺性差 0.15 級的近似同分也納入，否則同帶候選永遠固定先後。）
  const FATE_BAND = 0.2
  const unitCandidates = evaluateUnits(world, playerId, policies)
  const bestScore = unitCandidates[0]?.score ?? 0
  const tied = unitCandidates.filter((candidate) => candidate.score >= bestScore - FATE_BAND)
  let ordered = unitCandidates
  if (tied.length > 1) {
    const cut = Math.floor(fateOf(world, world.tick) * tied.length) % tied.length
    const pickedIds = new Set(tied.map((candidate) => candidate.defId))
    const rest = unitCandidates.filter((candidate) => !pickedIds.has(candidate.defId))
    ordered = [...tied.slice(cut), ...tied.slice(0, cut), ...rest]
  }
  for (const candidate of ordered) {
    const unitDef = world.defs.units[candidate.defId]
    // 預備金保護（Prompt 10.24 A）：扣掉預備金後買不起 → 不排隊（攢錢蓋建築）。
    // （Prompt 5：三資源逐一檢查——預備金只從藍水晶扣；紅寶石／綠翡翠足額即可。）
    if (
      unitDef !== undefined &&
      (player.resources.blue_crystal - reserve < unitDef.cost.blue_crystal ||
        player.resources.red_ruby < (unitDef.cost.red_ruby ?? 0) ||
        player.resources.green_emerald < (unitDef.cost.green_emerald ?? 0))
    ) {
      continue
    }
    const producerId = chooseProducer(world, playerId, candidate.defId)
    if (producerId === null) continue
    if (queueTrain(world, producerId, candidate.defId)) {
      actions.push({ kind: 'train', defId: candidate.defId })
      const explanation = explainTrain(candidate.defId, policies, {
        ...explainState,
        unitRole: world.defs.units[candidate.defId]?.role,
        candidateCount: unitCandidates.length,
      })
      records.push({
        tick: world.tick,
        layer: 'strategic',
        actor: playerId,
        action: 'train',
        target: candidate.defId,
        reason: {
          candidates: unitCandidates.map((c) => ({ defId: c.defId, score: c.score })),
          weights: { ...policies },
          topFactor: explanation.topFactor,
          explanation: explanation.text,
        },
      })
      break
    }
  }

  return { actions, records }
}
