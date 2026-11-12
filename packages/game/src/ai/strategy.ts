import type { PolicyValues } from './policy.ts'
import { buildEconWeight, buildExpandBias, buildMilitaryWeight, buildTechBias } from './policy.ts'
import { effectivePolicies } from './tempo.ts'
import { pickMostUrgentThreat } from './influence.ts'
import { isVisibleTo } from './sight.ts'
import type { DecisionTopFactor, ExplainState } from './explain.ts'
import { explainBuild, explainTrain } from './explain.ts'
import type { ResourceId, Role, UnitDef } from '@auto-2d-px-rts/shared'
import { canAfford, placeBuilding, producedResourceOf, queueTrain } from '../sim/economy.ts'
import { findNearestPlacement, tryFindNearestFreeNode } from '../sim/world.ts'
import { getPlayer } from '../sim/types.ts'
import type { PlayerId, TilePos, World } from '../sim/types.ts'
import { hashFate } from '../sim/rng.ts'
import { survivalScoreOf } from '../balance/unitStats.ts'
import { checkSurrender } from './surrender.ts'
import type { SurrenderCheck } from './surrender.ts'

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

/**
 * 稀缺乘法衰減（Prompt 6 #5）：同種單位每多 1 個，效用 ×(1 − 0.12)——
 * 防止鎖死單一種；地板 0.1（見 evaluateUnits）。
 */
const SCARCITY_DECAY = 0.12

/**
 * 敵軍壓境時的防守生產加權（Prompt 10.6，保護建築與水晶）：
 * 我方建築守備半徑內有敵軍（`pickMostUrgentThreat` 非 null）時，
 * 每個單位候選效用 **×(1 + 1.0) = ×2**（Prompt 6 乘法結構）——
 * 即使重經濟或稀缺懲罰偏高，也會持續產兵回防，而不是眼看礦場被拆。
 */
export const THREAT_DEFENSE_BONUS = 1.0

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
  /** 投降判定（Prompt 8.6）：每循環 1 次的絕望指數快照與是否觸發。 */
  surrenderCheck: SurrenderCheck
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

    // 效用（Prompt 6 #4）：礦場 = econ × resourceBias[資源] × (1−飽和)；
    // 軍事建築 = military × (1−飽和)；科技建築（綠礦）另加 techBias 項。
    const weight = def.requiresResourceNode === true ? econ : military
    let score = weight * (1 - saturationOf(world, playerId, defId))

    if (def.requiresResourceNode === true && mineType !== null) {
      const maxBias = Math.max(
        policies.resourceBias.blue,
        policies.resourceBias.red,
        policies.resourceBias.green,
        0.001,
      )
      const bias =
        mineType === 'blue_crystal'
          ? policies.resourceBias.blue
          : mineType === 'red_ruby'
            ? policies.resourceBias.red
            : policies.resourceBias.green
      const biasMult = bias / maxBias
      // 基礎分（含 bias；Prompt 6 #4 resourceBias[產出資源]）。
      score = weight * biasMult * (1 - saturationOf(world, playerId, defId))

      // SPEC §8.1 擴展（Prompt 5）：**每種資源**的第一座礦強制高優先——
      // 在 bias 之後套用（強制項不受 resourceBias 壓制）。
      if (mineType === 'blue_crystal' && player.mineCount === 0) {
        score = Math.max(score, 3.0)
      }
      // 資源 gate（Prompt 6 #6 expansion / techRush）：
      // - 紅礦 gate：藍礦數 ≥ ceil(藍礦每方上限 × (1 − max(0, expansion−0.5)×1.4))
      //   ——**上半段生效**曲線：0.5 → 藍滿才解鎖（3 座，零偏移）、0.75 → 2 座、
      //   1 → 1 座即解鎖。（全線版在 0.5 預設就把紅礦提前到 2 藍礦，實測平局
      //   8→16——150 藍的早期投資拖慢全盤節奏。）
      // - 綠礦 gate：紅礦已蓋 **或** techRush ≥ 0.75（科技衝刺可跳過紅礦）。
      if (mineType !== 'blue_crystal') {
        const blueSideCap = Math.max(1, world.match.mineCap - 2)
        const blueCount = mineCountOfType(world, playerId, 'blue_crystal')
        // 【消融②】expansion 效用暫關（gate 恆要求藍礦全滿）。
        const blueUnlocked =
          blueCount >=
          Math.ceil(blueSideCap * (1 - Math.max(0, buildExpandBias(policies) - 0.5) * 1.4))
        const rubyCount = mineCountOfType(world, playerId, 'red_ruby')
        // 綠礦仍鎖 = 紅礦未蓋且 techRush 未達衝刺檔（0.75 可跳過紅礦直上科技）。
        const greenLocked =
          mineType === 'green_emerald' && rubyCount < 1 && buildTechBias(policies) < 0.75
        if (!blueUnlocked || greenLocked) {
          score = 0
        } else if (mineType === 'red_ruby') {
          const rosterNeedsRuby = world.faction.roster.some((unitId) => {
            const unitDef = world.defs.units[unitId]
            return unitDef !== undefined && (unitDef.cost.red_ruby ?? 0) > 0
          })
          score += rosterNeedsRuby ? 0.4 : 0
        } else {
          // 綠礦（科技建築）：techBias 項（Prompt 6 #4 isTechBuilding）。
          score = score * 0.5 + buildTechBias(policies) * 0.5
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

/**
 * 敵方活著單位的角色計數（melee / ranged）。
 * **視野過濾（Prompt 9.5b）**：只計視野內的敵單位——看不見的爆兵不進克制判斷
 * （隱形堆兵 → AI 短暫誤判克制是特性，敵人現身後即修正）；無記憶。
 */
function enemyRoleCounts(world: World, playerId: PlayerId): Record<Role, number> {
  const totals: Record<Role, number> = { melee: 0, ranged: 0 }
  for (const unit of world.units) {
    if (unit.hp <= 0 || unit.player === playerId) continue
    if (!isVisibleTo(world, playerId, unit.x, unit.y)) continue
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

/** tier 貼合度（0..1）：與 unitSize 目標 tier 的序數距離（1 → 完全貼合）。 */
function tierScoreOf(world: World, defId: string, policies: PolicyValues): number {
  const def = world.defs.units[defId]
  if (def === undefined) return 0
  const myIndex = TIER_ORDER[def.tier] ?? 1
  const target = Math.round((1 - Math.min(1, Math.max(0, policies.unitSize))) * 2)
  return 1 - Math.abs(myIndex - target) / 2
}

/**
 * tier 乘法項（Prompt 6 #5）：`1 + 3×(tierFit − 0.5)`——完全貼合 ×2.5、
 * 中性 ×1、完全錯配 clamp 到 0.05（不為 0，可行性已由 hasProducer 過濾）。
 */
function tierTermOf(world: World, defId: string, policies: PolicyValues): number {
  return Math.min(2.5, Math.max(0.05, 1 + 3 * (tierScoreOf(world, defId, policies) - 0.5)))
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

/** range 乘法項（Prompt 6 #5）：`1 + 2×(rangeFit − 0.5)`——完全貼合 ×2、錯配 clamp 0.05。 */
function rangeTermOf(world: World, defId: string, policies: PolicyValues): number {
  return Math.min(2, Math.max(0.05, 1 + 2 * (rangeScoreOf(world, defId, policies) - 0.5)))
}

/**
 * 生存乘法項（Prompt 3.1 → Prompt 6 乘法化）：`0.9 + 0.2 × survivalScore`——
 * roster 內最差 ×0.9、最好 ×1.1、roster 中位（0.5）恰 ×1.0（中性零偏移）。
 * 刻意收窄到 ±10%：乘法分差過大會把弱甲單位擠出命運抽籤相對帶
 * （Prompt 10.11 多樣性必須保留——多樣性測試守門）。
 */
function survivalTermOf(def: UnitDef, roster: readonly UnitDef[]): number {
  return 0.9 + 0.2 * survivalScoreOf(def, roster)
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

/** 評估生產候選（Prompt 6 #5 乘法結構）：克制 × tier × range × tech × 稀缺 × 生存 × 壓境；無產能或買不起者剔除。 */
function evaluateUnits(world: World, playerId: PlayerId, policies: PolicyValues): UnitCandidate[] {
  const player = getPlayer(world, playerId)
  const share = enemyRoleShare(world, playerId)
  // 主動防禦（Prompt 10.6）：我方建築受威脅 → 防守生產加權（乘法項）。
  const threatened = pickMostUrgentThreat(world, playerId) !== null
  // 生存項（Prompt 3.1）的 roster 快照（rosterDefs 正規化基準）。
  const rosterDefs = world.faction.roster
    .map((rosterId) => world.defs.units[rosterId])
    .filter((def) => def !== undefined)
  // 技術項（Prompt 6）：techLevel = min(1, 翡翠聖所數)——因果鏈：
  // techRush → 蓋綠礦 → techLevel 上升 → 單位效用 ×(1 + techRush × level × 0.4)。
  const techLevel = Math.min(
    1,
    world.buildings.filter((building) => {
      if (building.player !== playerId || building.hp <= 0) return false
      const buildingDef = world.defs.buildings[building.defId]
      return buildingDef !== undefined && producedResourceOf(buildingDef) === 'green_emerald'
    }).length,
  )

  const candidates: UnitCandidate[] = []
  for (const defId of world.faction.roster) {
    const def = world.defs.units[defId]
    if (def === undefined) continue
    // 可行性：有兵營能生產 + 負擔得起（Prompt 5：三資源逐一檢查）。
    const hasProducer = world.buildings.some(
      (building) =>
        building.player === playerId &&
        world.defs.buildings[building.defId]?.produces.includes(defId) === true,
    )
    if (!hasProducer) continue
    if (!canAfford(player.resources, def.cost)) continue

    // 乘法結構（Prompt 6 #5）：各項為相對倍率，1.0 = 中性。
    const score =
      counterScoreOf(world, def.role, share) *
      tierTermOf(world, defId, policies) *
      rangeTermOf(world, defId, policies) *
      (1 + policies.techRush * techLevel * 0.4) *
      Math.max(0.1, 1 - ownedCountOf(world, playerId, defId) * SCARCITY_DECAY) *
      survivalTermOf(def, rosterDefs) *
      (threatened ? 1 + THREAT_DEFENSE_BONUS : 1)
    candidates.push({ defId, score })
  }

  return candidates.sort((a, b) => b.score - a.score)
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
 * `policies` 是**用戶設定值**——內部先經 `effectivePolicies`（節奏預設覆蓋）。
 */
export function runStrategicCycle(
  world: World,
  playerId: PlayerId,
  userPolicies: PolicyValues,
): StrategicCycleResult {
  // Prompt 6 #3：節奏預設覆蓋（standard = 恆等）。以下全用生效值。
  const policies = effectivePolicies(userPolicies, world.tick)

  // AI 投降判定（Prompt 8.6）：每戰略循環 1 次（40 tick = 2 秒）。已投降者
  // 不再行動（session／sim 閘門兜底）；本循環觸發投降 → 跳過 build/train。
  const surrenderCheck = checkSurrender(world, playerId, policies)
  if (world.surrender !== null || surrenderCheck.surrendered) {
    return { actions: [], records: [], surrenderCheck }
  }

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
  // 命運抽籤（Prompt 10.11；Prompt 6 改**相對帶**）：分數 ≥ best × FATE_RATIO 的
  // 候選以 fate 抽選先後——同 tick 兩側同值（鏡像對稱）、跨種子變化
  // （軍種組成因對局而異）。乘法分差下絕對帶（best − 0.2）語義失真，
  // 相對帶 0.85 = 「與最高分差 15% 以內都算同帶」。
  const FATE_RATIO = 0.8
  const unitCandidates = evaluateUnits(world, playerId, policies)
  const bestScore = unitCandidates[0]?.score ?? 0
  const tied = unitCandidates.filter((candidate) => candidate.score >= bestScore * FATE_RATIO)
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

  return { actions, records, surrenderCheck }
}
