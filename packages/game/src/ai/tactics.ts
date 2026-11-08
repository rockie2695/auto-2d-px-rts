import { getPlayer, isBlockedAt, isConstructed, tileOf, UNITS_PER_TILE } from '../sim/types.ts'
import type { Building, PlayerId, TilePos, Unit, World } from '../sim/types.ts'
import { distanceSquaredToBuilding } from '../sim/combat.ts'
import { hashFate } from '../sim/rng.ts'
import { mirrorSafeTileOf } from './mirrorTile.ts'
import { computeInfluenceMap, DEFENSE_RADIUS_TILES, enemyThreatAtPoint, enemyThreatAtTile, pickMostUrgentThreat, unitThreatMilli } from './influence.ts'
import type { BuildingThreat, InfluenceMap } from './influence.ts'
import { clampSlider } from './policy.ts'
import type { PolicyValues } from './policy.ts'
import { effectivePolicies } from './tempo.ts'

/**
 * AI 戰術層（SPEC §9.2，Prompt 7）：每 500ms（= 10 tick）重編小隊、指派任務、
 * 選定進攻目標、判斷撤退。
 *
 * **本層只產出計畫（純函式），不下單**：實際的移動與聚火由微操層
 * （`micro.ts`，Prompt 8）每 100ms 依行為樹決定 —— 單一「命令來源」
 * 才能讓風箏／集火／撤退互相協調而不打架。戰鬥仍由 sim 自動接戰結算。
 *
 * 小隊編組：
 * - `squadCount = round(lerp(4, 1, clusterSpread))`（0 → 4 隊分散、1 → 1 隊集中）
 * - `squadSize  = round(lerp(4, 18, clusterSpread))`
 * - 隊數不超過兵力（不產生空隊）；兵力超過 `squadCount × squadSize` 時自動擴隊。
 * - **就近聚類（Prompt 10.7）**：成員按地理位置聚類分隊（k-means-lite，固定 3 輪、
 *   容量受限最終分配）——同區域的兵編成同一隊，小隊是地理群而非名冊，行軍自然成團；
 *   空群丟棄、重新編號。
 *
 * 任務（`aggression` 決定攻守比例）：
 * - `attackCount = round(squadCount × aggression)`；`attackCount ≥ 2` 且隊數 ≥ 3 時
 *   其中 1 隊為 `harass`（打敵方經濟），其餘 `attack`，剩下的 `defend`。
 * - 進攻目標評分 = `建築value × 1/(敵方格威脅+1) × 1/(1+距離)`（價值高 × 防守弱 × 距離近）。
 * - **攻擊波次門檻（Prompt 10.21，多點蓄兵）**：進攻／騷擾隊要過出擊門檻才前進——
 *   `cohort 戰力×1e6 ≥ 守備戰力 milli × waveRatioMilli(policies)`
 *   （`waveRatioMilli = round(lerp(550, 1100, clusterSpread))`，散兵快打 ↔ 集結總攻）
 *   **且**合併交戰評估判殺得掉守軍（決定性優勢）。cohort＝重心最近蓄兵錨格
 *   （各生產建築的出廠集合格，無生產建築→集結點）相同的進攻隊：同點蓄兵共享
 *   門檻，不添油；成軍後**同一循環多路一起出擊**，各隊各自鎖定目標（不同 cohort
 *   可同時打不同位置）。守衛 0 → 門檻自動為 0 → 全軍出擊（Prompt 10.18 不回退）。
 *   已投入戰場（重心離目標 ≤ 8 格或上一循環在迎戰）不中途翻 stage，避免開打一半掉頭。
 * - **突變期（Prompt 10.23）**：`tick ≥ 7200` 出兵門檻逐檔 ×0.75 遞減、`tick ≥ 10800`
 *   stage 停用全軍出擊——對稱局的確定破局壓力（見 `SUDDEN_DEATH_*` 常數處的註）。
 * - **集結再攻（Prompt 10.7）**：成員鬆散（最遠成員離重心 > `REGROUP_DISTANCE_TILES`
 *   = 5 格）的攻擊隊先往「重心→目標」方向的集結點聚攏，到齊後才直接鎖定目標建築。
 * - **主動防禦（Prompt 10.6）**：敵軍進入我方建築守備半徑（`DEFENSE_RADIUS_TILES`
 *   = 6 格）→ 受威脅建築（平手優先水晶礦場）旁的來襲敵軍重心成為**攔截目標**：
 *   守備隊前出接敵，保護建築與水晶收入；全軍出擊（無守備隊）時把離威脅最近的
 *   一支攻擊隊拉回守備。同時戰略層生產軌加 **壓境防守加權**（`THREAT_DEFENSE_BONUS`
 *   = 1.0，保護建築與水晶 → 持續產兵回防）。
 *
 * 主動防禦（Prompt 10.6）：
 * - 敵軍進入我方建築守備半徑（`DEFENSE_RADIUS_TILES`）→ 受威脅建築（平手優先
 *   水晶礦場）旁的來襲敵軍重心成為**攔截目標**：守備隊前出接敵，保護建築與
 *   水晶收入；全軍出擊時把離威脅最近的一支攻擊隊拉回守備。
 *
 * 撤退（MVP 簡化版）：
 * - 隊級：`squadPower < 敵方在重心的即時威脅 × 0.7` → 本循環全隊 `retreat` 回集結點
 *   （用即時點位威脅而非格中心值，才反映「貼身敵軍」的壓力）。
 * - 個體：`hp < retreatHpPct × maxHp`（JSON 讀）→ 脫離戰鬥；傷兵不閒置，
 *   round-robin 補進守備隊尾端（attack／harass 隊不收）。
 *
 * 編組為無狀態（每循環按 unit id 排序重算），確保相同世界 → 相同計畫。
 */

/** 戰術循環間隔（SPEC §9.2：500ms = 10 tick）。 */
export const TACTICAL_INTERVAL_TICKS = 10

/** 撤退門檻：小隊戰力 < 敵附近戰力 × 0.7（SPEC §8 小隊撤退）。 */
export const RETREAT_POWER_RATIO = 0.7

/** 集結再攻門檻（tile）：最遠成員離隊重心超過此距離 → 先集結、到齊再進攻。 */
export const REGROUP_DISTANCE_TILES = 5

/** 集結門檻的平方（固定點）：5 × 200 = 1000 → 1,000,000。 */
const REGROUP_LIMIT_SQUARED =
  REGROUP_DISTANCE_TILES * REGROUP_DISTANCE_TILES * UNITS_PER_TILE * UNITS_PER_TILE

/** 集火半徑（tile）：斬殺集火只在小隊重心此距離內的敵人裡挑（維持協同）。 */
export const FOCUS_RADIUS_TILES = 8

/**
 * 戰力評估比例（Prompt 10.8）：我方戰力（milli）≥ 敵方戰力 × 此值才承諾
 * 進攻／攔截；打不贏 → 降級騷擾或守在原處等待支援。
 */
export const ENGAGE_POWER_RATIO = 0.9

/**
 * 攻擊波次門檻（Prompt 10.21）：進攻／騷擾隊要**波次成形**才壓上
 * `squad.power × 1e6 ≥ 守備戰力 milli × waveRatioMilli(policies)`。
 * `clusterSpread` 決定波次風格：0（散兵快打）→ 550 milli（我方戰力達守備 55%
 * 即可出擊）、1（集結總攻）→ 1100 milli（近乎全勝才壓上），中間線性內插。
 */
export const WAVE_RATIO_MIN_MILLI = 550
export const WAVE_RATIO_MAX_MILLI = 1100

/** 出擊波次比例（milli，Prompt 10.21）：由 `clusterSpread` 內插 550..1100。 */
export function waveRatioMilli(policies: PolicyValues): number {
  return Math.round(
    WAVE_RATIO_MIN_MILLI + (WAVE_RATIO_MAX_MILLI - WAVE_RATIO_MIN_MILLI) * policies.clusterSpread,
  )
}

/** 已投入戰場半徑（tile，Prompt 10.21）：重心離目標建築 ≤ 8 格或正在迎戰 → 不中途翻 stage。 */
export const COMMITTED_RADIUS_TILES = 8

const COMMITTED_RADIUS_SQUARED = COMMITTED_RADIUS_TILES * COMMITTED_RADIUS_TILES

/**
 * 突變期（Prompt 10.23）：對稱局的**確定破局機制**——鏡像決策逐格一致（Prompt
 * 10.22）後，完美對鏡會僵持到超時；實測（24 種子）perfectly-mirrored 交戰
 * 逐對同 tick 互滅，平局是鏡像自戰的數學必然。兩件套破局：
 * - **門檻遞進**：`tick ≥ 7200`（剩 4 分鐘）起每 1200 tick `waveRatioMilli ×
 *   乘數`（1000→750→563→422）遞減——把壓著的兵力投出去；
 * - **硬期限**：`tick ≥ 10800` stage 停用、全軍出擊（committed／10.8 降級鏈不變）。
 * - **破局相位差**：若兩陣同 tick 同規則，交戰仍是鏡像互滅 → 不破局。因此
 *   各陣營以 `hashFate(種子，錨點，陣營)` **獨立抽 0..1200 tick 的啟動相位**，
 *   門檻遞減與硬期限按 `tick − 相位` 評估（`suddenDeathPhaseTicks`）——紅藍
 *   同分布（無偏側）但通常錯開 → 非對稱首接觸 → 集火 id 平手裁決級聯破局。
 *   同種子可復現；7200 前鏡像探針仍 0 mismatch（相位尚未生效）。
 * 交戰一接觸，既有集火／id 平手裁決把局面撕開、勝者滾雪球；超時兜底為
 * 總價值裁定（`matchSideValue`，session.ts）。
 */

/** 突變期起點（tick；12000 上限剩 4 分鐘）。 */
export const SUDDEN_DEATH_START_TICK = 7200

/** 門檻乘數遞減步距（tick）。 */
export const SUDDEN_DEATH_STEP_TICKS = 1200

/** 突變期硬期限（tick）：stage 停用、全軍出擊。 */
export const SUDDEN_DEATH_HARD_TICK = 10800

/** 每步的門檻乘數（milli；×0.75）。 */
export const SUDDEN_DEATH_DECAY_MILLI = 750

/** 突變期階段：`none` 未開始、`ramp` 門檻遞減中、`allin` 硬期限全軍出擊。 */
export type SuddenDeathStage = 'none' | 'ramp' | 'allin'

/**
 * 破局相位窗（tick，Prompt 10.23）：突變期**各陣營獨立**抽 0..窗−1 的啟動相位差。
 * 兩邊抽同一分布（hashFate 對種子×錨點×陣營 avalanche，無偏側），但完美鏡像
 * 的紅藍通常相位不同 → 出兵門檻遞減／硬期限全軍出擊在實際 tick 上錯開 →
 * 非對稱首接觸 → 集火 id 平手裁決級聯破局。昇冪鏡像自戰恆平局的破局噪聲。
 */
export const SUDDEN_DEATH_PHASE_WINDOW_TICKS = 1200

/**
 * 陣營的突變期啟動相位差（0..窗−1 tick）：`hashFate(種子，錨點，陣營)` 決定。
 * 同種子同陣營必同值（確定性可復現）；錨點分 `ramp` 與 `allin` 兩处——
 * 呼叫端以 `SUDDEN_DEATH_START_TICK`／`SUDDEN_DEATH_HARD_TICK` 作錨點分別抽籤。
 */
export function suddenDeathPhaseTicks(
  seed: number,
  anchorTick: number,
  playerId: PlayerId,
): number {
  return Math.floor(
    hashFate(seed, anchorTick, playerId === 'enemy' ? 1 : 0) * SUDDEN_DEATH_PHASE_WINDOW_TICKS,
  )
}

/** 目前 tick 的突變期階段（`phaseTicks` 為該陣營抽到的啟動相位差，預設 0）。 */
export function suddenDeathStage(tick: number, phaseTicks = 0): SuddenDeathStage {
  if (tick < SUDDEN_DEATH_START_TICK + phaseTicks) return 'none'
  return tick >= SUDDEN_DEATH_HARD_TICK + phaseTicks ? 'allin' : 'ramp'
}

/** 出兵門檻乘數（milli；未開始 = 1000，銳減至 422 封頂——硬期限由 stage 停用接手）。 */
export function suddenDeathMultiplierMilli(tick: number, phaseTicks = 0): number {
  if (tick < SUDDEN_DEATH_START_TICK + phaseTicks) return 1000
  const steps = Math.min(
    Math.floor((tick - SUDDEN_DEATH_START_TICK - phaseTicks) / SUDDEN_DEATH_STEP_TICKS) + 1,
    3,
  )
  let milli = 1000
  for (let index = 0; index < steps; index += 1) {
    milli = Math.round((milli * SUDDEN_DEATH_DECAY_MILLI) / 1000)
  }
  return milli
}

/** 接觸注意半徑（tile，Prompt 10.15 W1）：敵人進到小隊重心此半徑內算「接觸」。
 *  接觸本身不等于接戰——射程內照樣由模擬層自動接戰，AI 層只在接觸時做**重新評估**。 */
export const CONTACT_NOTICE_RADIUS_TILES = 6

/** 接觸重評估冷卻（tick，Prompt 10.15 W1）：同小隊冷卻期內不重複評估（防抖動）。 */
export const CONTACT_REPLAN_COOLDOWN_TICKS = 60

/** 夾擊接應半徑（tile，Prompt 10.15 W2）：受襲小隊只向「此範圍內且殺得掉」的友隊求援。 */
export const PINCER_REPLY_RADIUS_TILES = 12

/** 夾擊繞後半徑（tile，Prompt 10.15 W2）：接應小隊自敵群重心此半徑的**不同方位**接近。 */
export const PINCER_STANDOFF_TILES = 3

/** 最多幾支小隊響應夾擊（Prompt 10.15 W2）。 */
export const PINCER_MAX_RESPONDERS = 2

export type SquadMission = 'defend' | 'attack' | 'harass' | 'stage' | 'retreat'

export interface Squad {
  index: number
  mission: SquadMission
  memberIds: number[]
  /** 任務目標格（attack/harass = 目標建築旁可走格；defend = 集結點或攔截點；stage/retreat = 集結點）。 */
  target: TilePos
  /** attack/harass 的目標建築 id；其餘（含 stage）為 null。 */
  targetBuildingId: number | null
  /** 隊伍有效戰力（Σ value × hp/maxHp，整數）。 */
  power: number
  /** 成員重心格。 */
  centroid: TilePos
  /** 接觸重評估（Prompt 10.15）：true = 決定迎戰敵群（target = 敵群接近格；集火不指建築）。
   *  false/未設 = 維持原命令——單位不自行離隊追擊，射程內仍由模擬層自動接戰。 */
  engaging?: boolean
}

/** 接觸事件（Prompt 10.15）：一次接觸驅動的重新評估／夾擊呼叫，供決策日誌逐條顯示。 */
export interface ContactEvent {
  squadIndex: number
  /** `engage` = 迎戰；`keep` = 維持原命令；`pincer` = 呼叫友隊夾擊；
   *  `retreat` = 受襲殺不掉且無友隊響應 → 撤回集結點（Prompt 10.24 D）。 */
  outcome: 'engage' | 'keep' | 'pincer' | 'retreat'
  /** 人類可讀的完整句（規則生成、中文、確定性）。 */
  text: string
}

/** 接觸狀態（Prompt 10.15）：跨循環持續的小隊接觸記錄（以 squad index 為鍵）。 */
export interface ContactState {
  /** squadIndex → 上次接觸重評估 tick（冷卻期內不再重複評估）。 */
  replanTick: Record<number, number>
  /** squadIndex → 隊上已知的敵人 id（這循環才出現者為「新接觸」）。 */
  known: Record<number, number[]>
}

/**
 * 生產建築的出廠集合格（Prompt 10.19）：新兵出廠後先到**其出處建築**的集合格。
 */
export interface SpawnPoint {
  /** 生產建築 id。 */
  buildingId: number
  /** 出廠集合格（該建築往主目標方向前移 `SPAWN_FORWARD_TILES` 格）。 */
  tile: TilePos
}

export interface TacticalPlan {
  tick: number
  player: PlayerId
  /**
   * 集結點（**AI 內部**，不再顯示給玩家——Prompt 10.19）：無威脅＝W4 前移點、
   * 有威脅＝往受威脅建築方向壓近；守備隊站位／撤退目的地用，AI 依局面自動調整。
   * 蓄兵（stage，Prompt 10.21）不在此會師——回各生產建築的蓄兵錨格（多點）；
   * 無生產建築時才以本點充當單一蓄兵錨格。
   */
  rally: TilePos
  /**
   * 出廠集合格（Prompt 10.19）：**每間**自家生產建築一筆（buildingId 升冪）。
   * 新兵出廠後前往最近一間生產建築的出廠集合格，AI 再就近聚類編組。
   */
  spawns: SpawnPoint[]
  squads: Squad[]
  /** hp < retreatHpPct 而脫離戰鬥的單位 id（守備隊補位者仍列於此，供資訊面板顯示）。 */
  disengaged: number[]
  influence: InfluenceMap
  /** 接觸狀態（Prompt 10.15）：供下一循環區分「新接觸」與冷卻判斷。 */
  contact?: ContactState
  /** 本循環產生的接觸事件（迎戰／維持原命令／夾擊呼叫），session 轉進決策日誌。 */
  events?: readonly ContactEvent[]
  /**
   * 個體撤退閾值乘數（Prompt 6 #8）：有效 retreatHpPct = JSON 值 × 本因子
   * （retreatThreshold 0.5 → 1.0 = 零偏移；0 → 0.4 更敢戰、1 → 1.6 更早撤）。
   * micro 層從 plan 讀取——runMicroCycle 簽名不變。
   */
  retreatHpFactor: number
  /** 小隊撤退戰力比（Prompt 6 #8）：RETREAT_POWER_RATIO × lerp(0.5, 1.43, threshold)。 */
  squadRetreatRatio: number
}

/** 線性插值。 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** clusterSpread → 小隊數量與每隊上限。 */
export function squadSizing(policies: PolicyValues): { count: number; size: number } {
  const spread = clampSlider(policies.clusterSpread)
  return {
    count: Math.round(lerp(4, 1, spread)),
    size: Math.round(lerp(4, 18, spread)),
  }
}

/**
 * 依兵力把「目標隊數」修正為實際隊數：
 * 隊數不超過兵力（不產生空隊），兵力超過 `隊數 × 每隊上限` 時自動擴隊。
 */
export function countSquads(unitCount: number, sizing: { count: number; size: number }): number {
  if (unitCount <= 0) return 0
  let count = Math.min(sizing.count, unitCount)
  while (count * sizing.size < unitCount) count += 1
  return count
}

/**
 * 依 aggression（＋攻勢加成）決定各隊任務（index 由小到大：harass → attack → defend）。
 *
 * `aggressionBonus`（Prompt 10.18）：由**全局戰力優勢**導出的額外加權——
 * 我方明顯強於敵方時提高出擊比例（不再照本宣科用固定 aggression 讓半數兵力守家）；
 * 敵方**已無單位**時加成 1.0 → 全軍出擊收尾（否則優勢方看戲、戰局拖成平手）。
 */
export function assignMissions(
  squadCount: number,
  policies: PolicyValues,
  aggressionBonus = 0,
): SquadMission[] {
  const aggression = clampSlider(policies.aggression + aggressionBonus)
  // 戰力留守（Prompt 6 reserve）：攻擊份額 × 2×(1−reserve)——
  // reserve 0.5 = 中性（恰為 aggression 編制）、0 = 全軍出擊、1 = 全軍留守。
  // 敵方無單位的全軍出擊加成（Prompt 10.18，bonus ≥ 1）不受 reserve 削減。
  const allOut = aggressionBonus >= 1
  const reserveFactor = allOut ? 1 : 2 * (1 - clampSlider(policies.reserve))
  const attackCount = Math.min(squadCount, Math.round(squadCount * aggression * reserveFactor))
  const harassCount = squadCount >= 3 && attackCount >= 2 ? 1 : 0
  const missions: SquadMission[] = []
  for (let index = 0; index < squadCount; index++) {
    if (index < harassCount) missions.push('harass')
    else if (index < attackCount) missions.push('attack')
    else missions.push('defend')
  }
  return missions
}

/* ------------------------------------------------------------------ */
/* 就近聚類編組（Prompt 10.7）                                          */
/* ------------------------------------------------------------------ */

/** 聚類迭代輪數（固定值 → 確定性；不判斷收斂）。 */
const REGROUP_ITERATIONS = 3

/** 編組遲滯裕度（格）：換隊需比原隊近超過此值（避免邊界單位每循環乒乓）。 */
const SQUAD_HYSTERESIS_TILES = 2

/**
 * 就近聚類（k-means-lite）：讓同區域的兵編成同一隊。
 * 1. 種子：優先用前次群心（warm start，Prompt 10.13），不足則按 id 升冪等距取。
 * 2. 固定 `REGROUP_ITERATIONS` 輪「就近分配 → 重算重心」（平手取 index 小）。
 * 3. 最終分配：按 id 升冪、就近且未滿 `capacity` 的群；**遲滯**——原隊距離在
 *    「最近距離 + 裕度」內就留在原隊（不乒乓）。
 * 回傳每群的 unit id 清單（群內 id 升冪）；空群保留（呼叫端過濾）。
 */
export function groupByProximity(
  ready: readonly Unit[],
  squadCount: number,
  capacity: number,
  seedCenters: readonly TilePos[] = [],
  previousIndex: ReadonlyMap<number, number> = new Map(),
): number[][] {
  const clusters: number[][] = Array.from({ length: Math.max(0, squadCount) }, () => [])
  if (squadCount <= 0 || ready.length === 0) return clusters

  const centers: Array<{ x: number; y: number }> = []
  for (let index = 0; index < squadCount; index++) {
    const seed = seedCenters[index]
    if (seed !== undefined) {
      // warm start：前次群心（固定點中心）。
      centers.push({ x: seed.x * UNITS_PER_TILE + UNITS_PER_TILE / 2, y: seed.y * UNITS_PER_TILE + UNITS_PER_TILE / 2 })
      continue
    }
    const unit = ready[Math.floor((index * ready.length) / squadCount)]
    if (unit === undefined) continue
    centers.push({ x: unit.x, y: unit.y })
  }

  for (let round = 0; round < REGROUP_ITERATIONS; round++) {
    const sums = centers.map(() => ({ x: 0, y: 0, count: 0 }))
    for (const unit of ready) {
      let bestIndex = 0
      let bestDistance = Number.POSITIVE_INFINITY
      for (let index = 0; index < centers.length; index++) {
        const center = centers[index]
        if (center === undefined) continue
        const dx = unit.x - center.x
        const dy = unit.y - center.y
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = index
        }
      }
      const bucket = sums[bestIndex]
      if (bucket === undefined) continue
      bucket.x += unit.x
      bucket.y += unit.y
      bucket.count += 1
    }
    for (let index = 0; index < centers.length; index++) {
      const bucket = sums[index]
      const center = centers[index]
      if (bucket === undefined || center === undefined || bucket.count === 0) continue
      center.x = bucket.x / bucket.count
      center.y = bucket.y / bucket.count
    }
  }

  const hysteresisMargin = SQUAD_HYSTERESIS_TILES * UNITS_PER_TILE
  // 遲滯距離以「前次群心」為準（迭代後的中心會漂移，不適合當原隊參考）。
  const previousCenters = seedCenters.map((seed) => ({
    x: seed.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    y: seed.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
  }))
  for (const unit of ready) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY
    let found = false
    for (let index = 0; index < centers.length; index++) {
      const cluster = clusters[index]
      if (cluster === undefined || cluster.length >= capacity) continue
      const center = centers[index]
      if (center === undefined) continue
      const dx = unit.x - center.x
      const dy = unit.y - center.y
      const distance = dx * dx + dy * dy
      if (!found || distance < bestDistance) {
        found = true
        bestDistance = distance
        bestIndex = index
      }
    }
    // 遲滯（Prompt 10.13）：原隊仍在且距離在「最近距離 + 裕度」內 → 留原隊（不乒乓）。
    const previous = previousIndex.get(unit.id)
    if (previous !== undefined && previous < centers.length && previous !== bestIndex && found) {
      const cluster = clusters[previous]
      const center = previousCenters[previous] ?? centers[previous]
      if (cluster !== undefined && center !== undefined && cluster.length < capacity) {
        const dx = unit.x - center.x
        const dy = unit.y - center.y
        const limit = (Math.sqrt(bestDistance) + hysteresisMargin) ** 2
        if (dx * dx + dy * dy <= limit) {
          cluster.push(unit.id)
          continue
        }
      }
    }
    const cluster = clusters[found ? bestIndex : 0]
    if (cluster === undefined) continue
    cluster.push(unit.id)
  }
  return clusters
}

/** 單位有效戰力（`value × hp / maxHp`，整數）。 */
function unitPower(world: World, unit: Unit): number {
  const def = world.defs.units[unit.defId]
  if (def === undefined || def.stats.hp <= 0) return 0
  return Math.round((def.ai.value * Math.max(0, unit.hp)) / def.stats.hp)
}

/** 由指定格往外找最近的可走格（環狀搜尋）。微操層亦共用。
 *  `mirrorOrder`（Prompt 10.9）：敵方側用**鏡像掃描序**（候選取負偏移）——
 *  讓紅藍雙方對鏡射位置挑出互為鏡像的格，消除「兩邊都往左上找」的幾何偏誤。 */
export function nearestWalkable(
  world: World,
  tile: TilePos,
  mirrorOrder = false,
): TilePos | null {
  const { size } = world.map
  const inBounds = (candidate: TilePos): boolean =>
    candidate.x >= 0 && candidate.y >= 0 && candidate.x < size && candidate.y < size
  const candidateOf = (offset: TilePos): TilePos =>
    mirrorOrder
      ? { x: tile.x - offset.x, y: tile.y - offset.y }
      : { x: tile.x + offset.x, y: tile.y + offset.y }

  if (inBounds(tile) && !isBlockedAt(world, tile)) return { x: tile.x, y: tile.y }
  for (let radius = 1; radius < size * 2; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const candidate = candidateOf({ x: dx, y: dy })
        if (!inBounds(candidate)) continue
        if (!isBlockedAt(world, candidate)) return candidate
      }
    }
  }
  return null
}

/** 集結點預設前移比例分母（Prompt 10.17 W4）：往 own↔enemy keep 中點 1/3 處。 */
export const RALLY_FORWARD_DIV = 3

/**
 * 集結點（Prompt 10.13；10.17 W4 前移）：AI 依局勢選點——
 * - **無威脅**（W4）→ 由自家 keep 往**雙方 keep 中點**（地圖中心方向）前移 `1/DIV`
 *   的可走格——待命部隊前推到中線附近，不再死守家門（更早接觸、更快反應）。
 *   以**正規化（藍方）座標**計算再鏡射回來 → 紅藍集結點精確互為鏡像（公平性）。
 * - **有威脅**（`threat`）→ 覆寫：往受威脅建築方向前移到中點附近的可走格
 *   （防守儲備更靠近前線）；沒有 keep 時退回出生點。
 */
export function rallyPoint(
  world: World,
  playerId: PlayerId,
  threat: BuildingThreat | null = null,
): TilePos {
  const spawn = getPlayer(world, playerId).spawn
  const mirrorOrder = playerId === 'enemy'
  const keep = world.buildings.find(
    (building) => building.player === playerId && building.hp > 0 && building.defId === 'keep',
  )
  const base =
    keep === undefined
      ? spawn
      : { x: keep.x + Math.floor(keep.w / 2), y: keep.y + Math.floor(keep.h / 2) }
  const home = nearestWalkable(world, base, mirrorOrder) ?? { x: spawn.x, y: spawn.y }

  // W4：預設點 = 由自家 keep 往**雙方 keep 中點**前移 1/DIV（正規化座標計算
  // → 紅藍精確互為鏡像）；無敵 keep 時退回 keep 旁的 home。
  const enemyKeep = world.buildings.find(
    (building) => building.player !== playerId && building.hp > 0 && building.defId === 'keep',
  )
  let staging = home
  if (enemyKeep !== undefined) {
    const last = world.map.size - 1
    const canonical = (tile: TilePos): TilePos =>
      playerId === 'enemy' ? { x: last - tile.x, y: last - tile.y } : { x: tile.x, y: tile.y }
    const own = canonical(base)
    const foe = canonical(buildingCenterTile(enemyKeep))
    const stage: TilePos = {
      x: own.x + Math.trunc((foe.x - own.x) / RALLY_FORWARD_DIV),
      y: own.y + Math.trunc((foe.y - own.y) / RALLY_FORWARD_DIV),
    }
    staging = nearestWalkable(world, canonical(stage), mirrorOrder) ?? home
  }

  // 有威脅 → 覆寫：由預設點再往受威脅建築方向前移到中點（防守儲備更靠近前線）。
  // 中點一律在 **canonical（藍方）座標**內計算再鏡回（Prompt 10.23 鏡像修復）：
  // `staging`（紅方已是實座標）與 `threat.buildingCenterTile`（鏡像安全取格的
  // 實座標）若直接在實座標取中點，座標和為奇數時 `Math.round` 半數進位會破壞
  // 鏡像等式（藍 round(s)=k ↔ 紅應 31−k 卻得 31−k+1）→ 紅藍集結點差一格、
  // fullMirrorProbe 在 tick 1352 分叉。canonical 化後兩邊的捨入輸入完全相同。
  if (threat === null) return staging
  const last = world.map.size - 1
  // 鏡射是對合（self-inverse）：canonical 化與鏡回是同一個映射。
  const mirrorTile = (tile: TilePos): TilePos =>
    mirrorOrder ? { x: last - tile.x, y: last - tile.y } : tile
  const stagingC = mirrorTile(staging)
  const threatC = mirrorTile(threat.buildingCenterTile)
  const forwardC: TilePos = {
    x: Math.round((stagingC.x + threatC.x) / 2),
    y: Math.round((stagingC.y + threatC.y) / 2),
  }
  return nearestWalkable(world, mirrorTile(forwardC), mirrorOrder) ?? staging
}

/**
 * 攻城接近格（Prompt 10.18）：選一個**與建築佔地正交相鄰**的可走格——
 * 格心距外框 0.5 格，近戰射程 0.8 格必在射程內。
 *
 * 舊版用 `nearestWalkable(建築中心格)`：中心格被建築佔住 → 回傳最近可走格，
 * 常是**對角**那一格（距外框 ≈ 0.99 格 > 近戰 0.8 格）→ 部隊站定後 sim 打不到、
 * 微操也不會再靠近 → **攻城卡死**（無敵方單位時也啃不掉主堡，戰局拖成平手）。
 *
 * 取離 `from` 最近者；平手以**正規化座標**（敵方鏡像）比序 → 紅藍互為鏡像。
 * 無可走鄰格回 null（呼叫端退回中心附近搜尋）。
 */
export function siegeApproachTile(
  world: World,
  playerId: PlayerId,
  building: Building,
  from: TilePos,
): TilePos | null {
  const mirrorOrder = playerId === 'enemy'
  const last = world.map.size - 1
  const canon = (tile: TilePos): TilePos =>
    mirrorOrder ? { x: last - tile.x, y: last - tile.y } : tile
  const fromC = canon(from)
  let best: TilePos | null = null
  let bestScore: readonly [number, number, number] | null = null
  for (let x = building.x - 1; x <= building.x + building.w; x++) {
    for (let y = building.y - 1; y <= building.y + building.h; y++) {
      const onRing =
        x === building.x - 1 ||
        x === building.x + building.w ||
        y === building.y - 1 ||
        y === building.y + building.h
      if (!onRing) continue
      if (x < 0 || y < 0 || x > last || y > last) continue
      const tile: TilePos = { x, y }
      if (isBlockedAt(world, tile)) continue
      const c = canon(tile)
      const score: readonly [number, number, number] = [
        Math.abs(c.x - fromC.x) + Math.abs(c.y - fromC.y),
        c.x,
        c.y,
      ]
      if (
        bestScore === null ||
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] &&
          (score[1] < bestScore[1] || (score[1] === bestScore[1] && score[2] < bestScore[2])))
      ) {
        bestScore = score
        best = tile
      }
    }
  }
  return best
}

/** 出廠集合格前移格數（建築中心往主目標方向，Prompt 10.19）。 */
const SPAWN_FORWARD_TILES = 4

/** 建築中心格（3×3 等**奇數**尺寸精確；偶數尺寸會截斷，鏡射敏感處請用 `buildingCenter` 單位座標）。 */
function buildingCenterTile(building: Building): TilePos {
  return tileOf(buildingCenter(building).x, buildingCenter(building).y)
}

/** 出廠集合格（Prompt 10.19）方向前移的固定點距離（單位）。 */
const SPAWN_FORWARD_PX = SPAWN_FORWARD_TILES * UNITS_PER_TILE

/**
 * 出廠集合格（Prompt 10.19，取代 Prompt 10.13 的單一全隊生產點）：
 * **每間**自家可生產單位的建築（`produces` 非空、已建成、存活）各有一個集合格——
 * 由該建築中心往**主目標**方向前移 `SPAWN_FORWARD_TILES` 格；
 * 主目標＝進攻／騷擾隊的目標建築（計畫取第一隊），無則敵方 keep、再無則留守原地。
 * 新兵出廠移往**最近一間**生產建築的集合格；AI 的就近聚類編組自然把
 * 同區新兵編成同一隊——玩家看到的點即「這間建築出的兵會先到哪」。
 *
 * 鏡射對稱（對偶數尺寸建築尤須如此）：**一律先鏡到固定點單位座標**再算——
 * 紅方把建築中心與主目標都映到 `mapPx − px`（整數精確、無截斷失真），在
 * 正規化（藍方）座標算前移向量後鏡射回來，最後才 `Math.floor` 轉格交給
 * `nearestWalkable`（掃描序鏡像）→ 紅藍互為鏡像。若先轉格再鏡射，2×2 建築的
 * 「中心格」差 1 格（藍 (6,28) ↔ 鏡射後應為 (25,3)，截斷成 (26,4) 不對稱——
 * session 標記測發現）。
 */
export function spawnPoints(
  world: World,
  playerId: PlayerId,
  rally: TilePos,
  squads: readonly Squad[],
): SpawnPoint[] {
  // 主目標（正規化單位座標）：進攻／騷擾隊的目標建築 → 敵方 keep。
  let objectivePx: { x: number; y: number } | null = null
  const attacker = squads.find(
    (squad) =>
      (squad.mission === 'attack' || squad.mission === 'harass') && squad.targetBuildingId !== null,
  )
  if (attacker !== undefined) {
    const target = world.buildings.find(
      (building) => building.id === attacker.targetBuildingId && building.hp > 0,
    )
    objectivePx = target === undefined ? null : buildingCenter(target)
  }
  if (objectivePx === null) {
    const enemyKeep = world.buildings.find(
      (building) => building.player !== playerId && building.defId === 'keep' && building.hp > 0,
    )
    objectivePx = enemyKeep === undefined ? null : buildingCenter(enemyKeep)
  }
  return spawnTilesFor(world, playerId, rally, objectivePx)
}

/**
 * 蓄兵點（Prompt 10.21 B 版）：每間自家生產建築一個蓄兵錨格——
 * 與出廠集合格同格，但**主目標固定為敵方主堡**（不依賴當下攻擊隊的目標，
 * 與 squad 狀態解耦 → 每循環確定、鏡像對稱）。無生產建築 → 全部退回集結點
 * （cohort key 自然合併成單一「全軍蓄兵點」）。
 *
 * stage 隊在此成結（cohort＝同錨格的 stage 隊共享門檻），成軍後同循環
 * 多路一起出擊、各自鎖定目標。
 */
function stageSpawnPoints(world: World, playerId: PlayerId, rally: TilePos): SpawnPoint[] {
  const enemyKeep = world.buildings.find(
    (building) => building.player !== playerId && building.defId === 'keep' && building.hp > 0,
  )
  const objectivePx = enemyKeep === undefined ? null : buildingCenter(enemyKeep)
  return spawnTilesFor(world, playerId, rally, objectivePx)
}

/** 出廠集合格逐建築計算（`objectivePx` 由呼叫端決定，鏡像規則見 `spawnPoints`）。 */
function spawnTilesFor(
  world: World,
  playerId: PlayerId,
  rally: TilePos,
  objectivePx: { x: number; y: number } | null,
): SpawnPoint[] {
  const mirrorOrder = playerId === 'enemy'
  const mapPx = world.map.size * UNITS_PER_TILE

  const mirrorPx = (point: { x: number; y: number }): { x: number; y: number } =>
    mirrorOrder ? { x: mapPx - point.x, y: mapPx - point.y } : point
  const objectiveC = objectivePx === null ? null : mirrorPx(objectivePx)

  const spawns: SpawnPoint[] = []
  for (const building of world.buildings) {
    if (building.player !== playerId || building.hp <= 0) continue
    if (!isConstructed(building)) continue
    const def = world.defs.buildings[building.defId]
    if (def === undefined || def.produces.length === 0) continue
    const centerPx = mirrorPx(buildingCenter(building))
    let tile = rally
    if (objectiveC !== null) {
      const dx = objectiveC.x - centerPx.x
      const dy = objectiveC.y - centerPx.y
      const steps = Math.max(Math.abs(dx), Math.abs(dy))
      if (steps > 0) {
        const candidatePx = {
          x: centerPx.x + Math.trunc((dx * SPAWN_FORWARD_PX) / steps),
          y: centerPx.y + Math.trunc((dy * SPAWN_FORWARD_PX) / steps),
        }
        // 候選格先在**正規化座標**定格，再鏡射回實座標——紅方不獨立地對
        // 鏡射 px 取 floor：偶數尺寸建築的中心候選會落在**格邊界**上
        // （中心 px 為 100 的倍數），floor 在鏡射方向會翻到錯邊的格
        // （藍 24 ↔ 紅取到 8 而非 7）。由正規化格鏡射而来 → 紅藍逐格對稱。
        const tileC = tileOf(candidatePx.x, candidatePx.y)
        const candidateTrue = mirrorOrder
          ? { x: world.map.size - 1 - tileC.x, y: world.map.size - 1 - tileC.y }
          : tileC
        tile = nearestWalkable(world, candidateTrue, mirrorOrder) ?? rally
      }
    }
    spawns.push({ buildingId: building.id, tile })
  }
  spawns.sort((a, b) => a.buildingId - b.buildingId)
  return spawns
}

/**
 * 最近一個出廠集合格／蓄兵點（曼哈頓距離最近；平手取 buildingId 小者，
 * Prompt 10.19 / 10.21）。曼哈頓距離在點鏡射下不變 → 紅藍選點對稱。
 */
export function nearestSpawnPoint(
  spawns: readonly SpawnPoint[],
  ownTile: TilePos,
): { tile: TilePos; buildingId: number } | null {
  let best:
    | { tile: TilePos; buildingId: number; score: readonly [number, number] }
    | null = null
  for (const spawn of spawns) {
    const score: readonly [number, number] = [
      Math.abs(spawn.tile.x - ownTile.x) + Math.abs(spawn.tile.y - ownTile.y),
      spawn.buildingId,
    ]
    if (
      best === null ||
      score[0] < best.score[0] ||
      (score[0] === best.score[0] && score[1] < best.score[1])
    ) {
      best = { tile: spawn.tile, buildingId: spawn.buildingId, score }
    }
  }
  return best === null ? null : { tile: best.tile, buildingId: best.buildingId }
}

/** 建築中心（固定點）。 */
function buildingCenter(building: Building): { x: number; y: number } {
  return {
    x: building.x * UNITS_PER_TILE + (building.w * UNITS_PER_TILE) / 2,
    y: building.y * UNITS_PER_TILE + (building.h * UNITS_PER_TILE) / 2,
  }
}

/** 進攻目標評分：價值高 × 敵防守弱 × 距離近。 */
function scoreTarget(value: number, threatMilli: number, distanceTiles: number): number {
  const defense = 1 / (1 + threatMilli / 1000)
  const proximity = 1 / (1 + distanceTiles)
  return value * defense * proximity
}

/** 從候選建築挑最高分者（平手取陣列中較前者，即 id 較小者）。
 *  威脅格由建築中心 px 落格——走鏡像安全路徑（Prompt 10.23）：偶數尺寸建築
 *  （barracks/tower 2×2）的中心 px 恰停**格邊界**，紅方直接 floor 翻錯邊會讓
 *  影響力查表取錯格 → 目標分數分叉 → 選中不同建築。 */
function pickTarget(
  world: World,
  playerId: PlayerId,
  influence: InfluenceMap,
  from: { x: number; y: number },
  candidates: readonly Building[],
): Building | null {
  let best: Building | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const building of candidates) {
    const value = world.defs.buildings[building.defId]?.ai.value ?? 0
    const center = buildingCenter(building)
    const dx = center.x - from.x
    const dy = center.y - from.y
    const distanceTiles = Math.sqrt(dx * dx + dy * dy) / UNITS_PER_TILE
    const tile = mirrorSafeTileOf(world.map.size, playerId === 'enemy', center.x, center.y)
    const score = scoreTarget(value, enemyThreatAtTile(influence, tile), distanceTiles)
    if (score > bestScore) {
      bestScore = score
      best = building
    }
  }
  return best
}

/** 敵方目標建築清單（economicOnly 時只取需資源點的礦場）。 */
function enemyTargets(world: World, playerId: PlayerId, economicOnly: boolean): Building[] {
  return world.buildings.filter((building) => {
    if (building.player === playerId || building.hp <= 0) return false
    if (!economicOnly) return true
    return world.defs.buildings[building.defId]?.requiresResourceNode === true
  })
}

/** 隊伍鬆散度：最遠成員與隊重心的距離平方（固定點）。 */
function squadSpreadSquared(unitById: Map<number, Unit>, squad: Squad): number {
  const cx = squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2
  const cy = squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2
  let max = 0
  for (const id of squad.memberIds) {
    const unit = unitById.get(id)
    if (unit === undefined) continue
    const dx = unit.x - cx
    const dy = unit.y - cy
    const distance = dx * dx + dy * dy
    if (distance > max) max = distance
  }
  return max
}

/** 集結點：從隊重心朝目標格方向前進 `REGROUP_DISTANCE_TILES` 的最近可走格（整數比例，確定性）。 */
function stagingPoint(
  world: World,
  playerId: PlayerId,
  centroid: TilePos,
  targetTile: TilePos,
): TilePos | null {
  const dx = targetTile.x - centroid.x
  const dy = targetTile.y - centroid.y
  const steps = Math.max(Math.abs(dx), Math.abs(dy))
  if (steps === 0) return nearestWalkable(world, centroid, playerId === 'enemy')
  const stepX = Math.round((dx * REGROUP_DISTANCE_TILES) / steps)
  const stepY = Math.round((dy * REGROUP_DISTANCE_TILES) / steps)
  return nearestWalkable(
    world,
    { x: centroid.x + stepX, y: centroid.y + stepY },
    playerId === 'enemy',
  )
}

/** 目標附近的敵方守軍（守備半徑內）與其戰力（milli）。 */
function defendersNear(
  world: World,
  playerId: PlayerId,
  centerFixed: { x: number; y: number },
): { enemies: Unit[]; powerMilli: number } {
  const radiusFixed = DEFENSE_RADIUS_TILES * UNITS_PER_TILE
  const limit = radiusFixed * radiusFixed
  const enemies: Unit[] = []
  let powerMilli = 0
  for (const unit of world.units) {
    if (unit.player === playerId || unit.hp <= 0) continue
    const dx = unit.x - centerFixed.x
    const dy = unit.y - centerFixed.y
    if (dx * dx + dy * dy > limit) continue
    enemies.push(unit)
    powerMilli += unitThreatMilli(world, unit)
  }
  return { enemies, powerMilli }
}

/**
 * 交戰評估（Prompt 10.8）：這群我們殺得掉嗎？
 * 1. 戰力：我方總戰力（milli）≥ 敵方戰力 × `ENGAGE_POWER_RATIO`。
 * 2. 角色：敵方**全遠程**而我方無遠程 → 會被風箏到死，判為殺不掉
 *    （打不贏就騷擾／守建築等待支援）。
 */
function canKillGroup(
  world: World,
  unitById: Map<number, Unit>,
  memberIds: readonly number[],
  totalPowerMilli: number,
  enemyPowerMilli: number,
  enemies: readonly Unit[],
): boolean {
  if (totalPowerMilli < enemyPowerMilli * ENGAGE_POWER_RATIO) return false
  const allRanged = enemies.length > 0 && enemies.every((enemy) => enemy.role === 'ranged')
  if (!allRanged) return true
  return memberIds.some((id) => {
    const unit = unitById.get(id)
    return unit !== undefined && world.defs.units[unit.defId]?.role === 'ranged'
  })
}

/**
 * 純計算：編組、任務、目標、撤退判斷（不修改世界）。
 * `previous`（Prompt 10.13）：前一循環的計畫——供編組 warm start 與遲滯，
 * 避免邊界單位每循環乒乓換隊（反覆切組＝原地發呆）。
 */
/**
 * 「px 均值取格」的鏡像安全版（Prompt 10.22）：小隊重心、接觸迎戰格等由單位
 * px 平均值落格。紅方一律先在**正規化（藍方）座標**對均值取格、再鏡回實座標——
 * 均值恰落在格邊界時，直接對紅方實座標 floor 會翻到錯邊的格（藍重心
 * tile (17,16) ↔ 紅實座標取到 (14,15) 而非鏡像的 (14,15)… 一步之差），
 * 之後的分隊／迎戰目標就像 fullMirrorProbe tick 310 實測那樣逐步分叉。
 * canonical 路徑：紅 px 均值 → `mapPx − mean` → floor → `size−1` 鏡回 → 與藍方同格。
 */
function tileOfMeanPx(
  mapSize: number,
  mirrorOrder: boolean,
  avgX: number,
  avgY: number,
): TilePos {
  return mirrorSafeTileOf(mapSize, mirrorOrder, avgX, avgY)
}

export function computeTacticalPlan(
  world: World,
  playerId: PlayerId,
  policies: PolicyValues,
  previous: TacticalPlan | null = null,
): TacticalPlan {
  // Prompt 6 #3：節奏預設覆蓋——以下全用生效值（standard = 恆等）。
  const eff = effectivePolicies(policies, world.tick)
  const influence = computeInfluenceMap(world, playerId)
  // 先偵測威脅（集結點依局勢選點；Prompt 10.13）。
  const threat = pickMostUrgentThreat(world, playerId)
  const rally = rallyPoint(world, playerId, threat)

  // 撤退閾值（Prompt 6 #8，parity 乘法映射）：
  // - 個體：有效 retreatHpPct = JSON 值 × lerp(0.4, 1.6, threshold)（0.5 → ×1.0 零偏移，
  //   保留每單位 JSON 的分級差異）；micro 層從 plan 讀 factor。
  // - 小隊：RETREAT_POWER_RATIO × (0.5 + threshold)（0.5 → ×1.0 = 舊常數 0.7；
  //   0 → ×0.5 更敢戰、1 → ×1.5 比值 1.05 ≈ 死戰不撤）。
  const retreatHpFactor = 0.4 + 1.2 * clampSlider(eff.retreatThreshold)
  const squadRetreatRatio = RETREAT_POWER_RATIO * (0.5 + clampSlider(eff.retreatThreshold))

  // 個體撤退：hp < retreatHpPct × maxHp → 脫離戰鬥（JSON 門檻 × 滑桿因子）。
  const disengaged: number[] = []
  const ready: Unit[] = []
  for (const unit of world.units) {
    if (unit.player !== playerId || unit.hp <= 0) continue
    const def = world.defs.units[unit.defId]
    const maxHp = def?.stats.hp ?? 0
    const threshold = maxHp * (def?.ai.retreatHpPct ?? 0) * retreatHpFactor
    if (def !== undefined && maxHp > 0 && unit.hp < threshold) disengaged.push(unit.id)
    else ready.push(unit)
  }
  ready.sort((a, b) => a.id - b.id)

  const sizing = squadSizing(eff)

  // 全體存活單位索引（含傷兵，供補位與重心計算共用）。
  const unitById = new Map<number, Unit>()
  for (const unit of world.units) {
    if (unit.player === playerId && unit.hp > 0) unitById.set(unit.id, unit)
  }

  // 後期呆滯修復（Prompt 10.9）：全部單位都受傷（ready 為 0）時，傷兵也照常編隊——
  // 否則小隊數 = 0、全軍蹲集結點不推進；微操層的安全距離撤退規則會保護他們。
  const disengagedUnits = disengaged
    .map((id) => unitById.get(id))
    .filter((unit): unit is Unit => unit !== undefined)
  const groupable = ready.length > 0 ? ready : disengagedUnits
  const rawCount = countSquads(groupable.length, sizing)

  // 就近聚類編組（Prompt 10.7）：同區域的兵編成同一隊——小隊是地理群而非名冊，
  // 行軍自然成團。空群丟棄、重新編號（0..n-1）。
  // warm start＋遲滯（Prompt 10.13）：以前一循環的群心為種子、原隊在裕度內不換。
  // 前一循環的群組索引：**以 group index 為鍵**（與 `clusters`／`seedCenters` 同一索引空間），
  // 不是壓縮後的 squad.index——否則空群被丟棄、索引位移，warm start 與遲滯會指到錯的群
  // （且紅藍的位移時機不同 → 系統性偏差）。
  const previousIndex = new Map<number, number>()
  for (const squad of previous?.squads ?? []) {
    for (const id of squad.memberIds) previousIndex.set(id, squad.index)
  }
  // 接觸迎戰狀態（Prompt 10.15）：上一循環是否在迎戰——以群 index 為鍵沿續，
  // 避免 engaging 在循環間失憶（ squads 每循環全新物件）造成忽進忽停。
  const previousEngaging = new Map<number, boolean>()
  for (const squad of previous?.squads ?? []) previousEngaging.set(squad.index, squad.engaging === true)
  const seedCenters: TilePos[] = []
  for (const squad of previous?.squads ?? []) seedCenters[squad.index] = squad.centroid
  const groups = groupByProximity(groupable, rawCount, sizing.size, seedCenters, previousIndex)

  // 攻勢優勢加權（Prompt 10.18）：全局戰力比 → 出擊比例加成。
  // - 敵方**已無單位** → 加成 1.0（全軍出擊，收掉剩下的建築，不再看戲拖平手）。
  // - 我方戰力比 > 1 → 加成隨優勢成長（上限 0.6）；優勢越大越少兵力守家。
  // 兩側以同一公式各自計算（鏡像局面 → 同加成，公平性不破）。
  let myPower = 0
  let foePower = 0
  let foeUnits = 0
  for (const unit of world.units) {
    if (unit.hp <= 0) continue
    const power = unitPower(world, unit)
    if (unit.player === playerId) myPower += power
    else {
      foePower += power
      foeUnits += 1
    }
  }
  let aggressionBonus = 0
  if (foeUnits === 0) aggressionBonus = 1
  else if (foePower > 0 && myPower > foePower) {
    aggressionBonus = Math.min(0.6, ((myPower / foePower) - 1) * 0.5)
  }

  const missions = assignMissions(
    groups.filter((group) => group.length > 0).length,
    eff,
    aggressionBonus,
  )

  // squad.index ＝ group index（可能因空群而有跳號）：與上一循環的鍵同一索引空間，
  // warm start／遲滯才能跨循環對齊（微操只用 index 當 map 鍵，跳號無妨）。
  const squads: Squad[] = []
  let missionIndex = 0
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const memberIds = groups[groupIndex]
    if (memberIds === undefined || memberIds.length === 0) continue
    const squad: Squad = {
      index: groupIndex,
      mission: missions[missionIndex] ?? 'defend',
      memberIds,
      target: { x: rally.x, y: rally.y },
      targetBuildingId: null,
      power: 0,
      centroid: { x: rally.x, y: rally.y },
      engaging: previousEngaging.get(groupIndex) ?? false,
    }
    for (const id of memberIds) {
      const unit = unitById.get(id)
      if (unit === undefined) continue
      squad.power += unitPower(world, unit)
    }
    squads.push(squad)
    missionIndex += 1
  }

  // 戰力留守（Prompt 6 #reserve）：語義落在 assignMissions 的攻擊份額乘數
  // （×2×(1−reserve)：0.5 中性、0 全軍出擊、1 全軍留守、敵滅加成豁免）——
  // 此處不再做事後翻隊：無狀態重編下「比例留守」會把攻擊隊永久壓回家
  // （消融實測 24 全平）；乘數語義讓 0.5 預設零偏移、滑桿連續生效。
  // （乘數語義已上移到 assignMissions。）

  // 傷兵補位（SPEC §9.2 補註，Prompt 9.4）：脫離戰鬥的單位不閒置——
  // round-robin 補進**守備隊**尾端（attack／harass 隊不收傷兵，避免拖累行軍）。
  // 已在守備隊佔位 → micro 層撤退抵達集結點後落回行為樹，照常吃 slot 並自動接戰。
  // （ready 為 0 時傷兵已直接作為編組成員，不重複補位——Prompt 10.9。）
  if (disengaged.length > 0 && ready.length > 0) {
    const defendSquads = squads.filter((squad) => squad.mission === 'defend')
    defendSquads.forEach((squad, index) => {
      const id = disengaged[index]
      if (id === undefined) return
      const unit = unitById.get(id)
      if (unit === undefined) return
      squad.memberIds.push(id)
      squad.power += unitPower(world, unit)
    })
    // 傷兵多於守備隊時：多的依舊只留在 disengaged 清單（不進攻擊隊）。
  }

  for (const squad of squads) {
    let sumX = 0
    let sumY = 0
    for (const id of squad.memberIds) {
      const unit = unitById.get(id)
      if (unit === undefined) continue
      sumX += unit.x
      sumY += unit.y
    }
    const memberCount = Math.max(1, squad.memberIds.length)
    // 重心取格走 canonical 路徑（Prompt 10.22）：紅藍對鏡像均值同格 → 分隊與
    // 後續迎戰目標互為鏡像（全場對鏡不破）。
    squad.centroid = tileOfMeanPx(
      world.map.size,
      playerId === 'enemy',
      sumX / memberCount,
      sumY / memberCount,
    )
  }

  // 進攻／騷擾目標。
  // 蓄兵點（Prompt 10.21 B 版）：每間生產建築一個 stage 錨格——主目標固定敵方主堡，
  // 與 squad 狀態解耦（每循環確定、鏡像對稱）。在目標分配迴圈前算好。
  const stageSpawns = stageSpawnPoints(world, playerId, rally)
  // 破局相位差（Prompt 10.23）：該陣營在突變期的兩段啟動相位（hashFate 各自抽籤——
  // ramp 錨於起點、allin 錨於硬期限，兩陣通常不同）→ 門檻遞減／硬期限在實際
  // tick 上錯開 → 非對稱首接觸破局。
  const rampPhase = suddenDeathPhaseTicks(world.seed, SUDDEN_DEATH_START_TICK, playerId)
  const hardPhase = suddenDeathPhaseTicks(world.seed, SUDDEN_DEATH_HARD_TICK, playerId)
  // 蓄兵 cohort（Prompt 10.21 B 版，多點蓄兵＋同時多路進攻）：各進攻隊以
  // **重心最近蓄兵錨格**為 cohort 鍵（無生產建築 → 一律集結點 key）。
  // 同錨位的攻擊隊**共享波次門檻**——cohort 總戰力過「目標守備 × waveRatio」
  // 且合併殺得掉守軍才壓上；未成軍 → 全體轉 stage 在蓄兵點等支援。
  // 單隊兵力上限（clusterSpread 決定 4..18）不再造成死鎖：新兵出廠先到同一
  // 錨格會師、cohort 戰力持續成長，一旦成形**同循環多路一起出擊**（各隊
  // 各自鎖定目標 → 不同 cohort／不同隊可同時打不同位置與不同目標）。
  // 判定只看戰力比與錨格 → 紅藍在鏡像局面以同一公式各算，公平性不破。
  // （cohort 覆蓋單隊判定：cohort 戰力 ≥ 任一成員隊、成員集包含隊員集 →
  // cohort 過門檻 ⇔ 至少採取最寬判定，不會卡死強隊。）
  const anchorKey = (tile: TilePos): string => {
    const anchor = nearestSpawnPoint(stageSpawns, tile)
    return anchor === null ? 'rally' : `b${anchor.buildingId}`
  }
  const cohorts = new Map<string, { power: number; memberIds: number[] }>()
  for (const squad of squads) {
    if (squad.mission !== 'attack' && squad.mission !== 'harass') continue
    const key = anchorKey(squad.centroid)
    let cohort = cohorts.get(key)
    if (cohort === undefined) {
      cohort = { power: 0, memberIds: [] }
      cohorts.set(key, cohort)
    }
    cohort.power += squad.power
    cohort.memberIds.push(...squad.memberIds)
  }

  for (const squad of squads) {
    if (squad.mission !== 'attack' && squad.mission !== 'harass') continue
    let candidates = enemyTargets(world, playerId, squad.mission === 'harass')
    // 騷擾找不到敵方經濟建築時，退回一般進攻目標。
    if (candidates.length === 0 && squad.mission === 'harass') {
      candidates = enemyTargets(world, playerId, false)
      squad.mission = 'attack'
    }
    const centroidFixed = {
      x: squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
      y: squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    }
    const target = pickTarget(world, playerId, influence, centroidFixed, candidates)
    if (target === null) {
      // 沒有可攻擊目標 → 轉為守備，避免空轉。
      squad.mission = 'defend'
      squad.target = { x: rally.x, y: rally.y }
      squad.targetBuildingId = null
      continue
    }
    const center = buildingCenter(target)
    // 攻城接近格（Prompt 10.18）：優先取**射程內**的正交鄰格；退回中心附近搜尋。
    const approach =
      siegeApproachTile(world, playerId, target, squad.centroid) ??
      nearestWalkable(
        world,
        // 建築中心 px 的 fallback 取格走鏡像安全路徑（Prompt 10.23）——
        // 偶數尺寸建築（barracks/tower 2×2）的中心 px 必停格邊界，紅方直接
        // floor 翻錯邊 → 攻城接近格紅藍差一格、fullMirrorProbe 分叉。
        mirrorSafeTileOf(world.map.size, playerId === 'enemy', center.x, center.y),
        playerId === 'enemy',
      )
    if (approach === null) {
      squad.mission = 'defend'
      squad.targetBuildingId = null
      continue
    }
    squad.targetBuildingId = target.id

    // 攻擊波次門檻（Prompt 10.21）：未投入戰場的進攻／騷擾隊要等波次成形才壓上——
    // 我方戰力 ≥ 目標守備戰力 × waveRatio（clusterSpread 決定：散兵快打 ↔ 集結總攻），
    // 且交戰評估判殺得掉守軍（決定性優勢）。兩者未齊 → 轉 stage「集結待戰」：
    // 回集結點會師（就近聚類自然合流），等支援成軍，不再一味添油進攻。
    // 守衛 0（defense.powerMilli = 0）→ 門檻自動為 0 → 全軍出擊（Prompt 10.18 不回退）；
    // 已投入戰場（重心貼近目標 ≤ COMMITTED_RADIUS_TILES 格，或上一循環在迎戰）不中途翻
    // stage——開打一半掉頭比輸掉更糟；劣勢時照 Prompt 10.8 降級鏈處理。
    // 突變期（Prompt 10.23）：門檻乘 suddenDeathMultiplierMilli 遞減；硬期限後停用 stage。
    const defense = defendersNear(world, playerId, center)
    const killable = canKillGroup(
      world,
      unitById,
      squad.memberIds,
      squad.power * 1000,
      defense.powerMilli,
      defense.enemies,
    )
    // committed 距離判斷的目標格也走鏡像安全路徑（Prompt 10.23）。
    const targetTile = mirrorSafeTileOf(world.map.size, playerId === 'enemy', center.x, center.y)
    const committed =
      squad.engaging === true ||
      (squad.centroid.x - targetTile.x) ** 2 + (squad.centroid.y - targetTile.y) ** 2 <=
        COMMITTED_RADIUS_SQUARED
    // 突變期階段按**該陣營的抽籤相位**評估（Prompt 10.23）：ramp 以起點錨相位、
    // allin 以硬期限錨相位——紅藍啟動 tick 通常錯開（破局相位差）。
    const suddenStage = suddenDeathStage(world.tick, hardPhase)
    // 突變期硬期限（Prompt 10.23）：stage 停用——未成軍也直接壓上（不轉 stage），
    // committed 的 10.8 降級鏈照舊；未 committed 且 allin → 落到下方集結再攻流程。
    if (!committed && suddenStage !== 'allin') {
      // 以 cohort 總戰力過門檻（同錨位進攻隊共享波次；無同錨位隊時即自身戰力），
      // 乘以突變期遞減乘數（Prompt 10.23，按本陣營 ramp 相位評估）：
      // 門檻逐檔大跌 → 把蓄著的兵投出去；紅藍相位差 → 錯開出兵時序破局。
      const cohort = cohorts.get(anchorKey(squad.centroid))
      const cohortPower = cohort?.power ?? squad.power
      const cohortMembers = cohort?.memberIds ?? squad.memberIds
      const ratioMilli = Math.round(
        // Prompt 6：用**生效值**（節奏覆蓋後）——否則 tempo 對 clusterSpread 的
        // 時段覆蓋會在此靜默失效。
        (waveRatioMilli(eff) * suddenDeathMultiplierMilli(world.tick, rampPhase)) / 1000,
      )
      const gateMet = cohortPower * 1000 * 1000 >= defense.powerMilli * ratioMilli
      const killableCohort = canKillGroup(
        world,
        unitById,
        cohortMembers,
        cohortPower * 1000,
        defense.powerMilli,
        defense.enemies,
      )
      if (!gateMet || !killableCohort) {
        // 轉 stage「集結待戰」：回**最近一間生產建築的蓄兵點**成結（Prompt 10.21 B 版，
        // 無生產建築 → 集結點）。同錨格的進攻隊共享門檻，總戰力成形後
        // 同一循環多路一起出擊。
        squad.mission = 'stage'
        squad.target =
          nearestSpawnPoint(stageSpawns, squad.centroid)?.tile ?? { x: rally.x, y: rally.y }
        squad.targetBuildingId = null
        squad.engaging = false
        continue
      }
    } else if (committed && !killable) {
      // 交戰評估（Prompt 10.8）：目標處守軍殺不掉 → 降級等待支援。
      // attack 打不贏 → 轉 harass（改打敵方經濟）；harass 也打不贏 → 轉 defend（守家等兵）。
      if (squad.mission === 'attack') {
        const econCandidates = enemyTargets(world, playerId, true).filter(
          (candidate) => candidate.id !== target.id,
        )
        const econ = pickTarget(world, playerId, influence, centroidFixed, econCandidates)
        if (econ !== null) {
          const econCenter = buildingCenter(econ)
          const econApproach =
            siegeApproachTile(world, playerId, econ, squad.centroid) ??
            nearestWalkable(
              world,
              mirrorSafeTileOf(world.map.size, playerId === 'enemy', econCenter.x, econCenter.y),
              playerId === 'enemy',
            )
          if (econApproach !== null) {
            squad.mission = 'harass'
            squad.targetBuildingId = econ.id
            squad.target = econApproach
            continue
          }
        }
      }
      squad.mission = 'defend'
      squad.target = { x: rally.x, y: rally.y }
      squad.targetBuildingId = null
      continue
    }

    // 集結再攻（Prompt 10.7）：成員鬆散（最遠成員離重心 > REGROUP_DISTANCE_TILES）
    // → 先往「重心→目標」方向的集結點聚攏；到齊後直接鎖定目標建築。
    if (squadSpreadSquared(unitById, squad) > REGROUP_LIMIT_SQUARED) {
      // 目標格走鏡像安全路徑（Prompt 10.23）：偶數尺寸建築中心 px 必停格邊界。
      const staging = stagingPoint(
        world,
        playerId,
        squad.centroid,
        mirrorSafeTileOf(world.map.size, playerId === 'enemy', center.x, center.y),
      )
      if (staging !== null) {
        squad.target = staging
        continue
      }
    }
    squad.target = approach
  }

  // 主動防禦（Prompt 10.6）：敵軍進入守備半徑（DEFENSE_RADIUS_TILES）→ 攔截。
  // - 受威脅建築（平手時優先水晶礦場）旁的來襲敵軍重心成為守備隊的攔截目標——
  //   保護建築與水晶收入，而不是窩在集結點等敵人打上門。
  // - 全軍出擊（沒有守備隊）時：把離受威脅建築最近的一支攻擊／騷擾／集結待戰隊拉回
  //   守備；retreat 隊不拉（已在撤）。（threat 已於函式開頭偵測，集結點選點共用。）
  if (threat !== null) {
    const intercept =
      nearestWalkable(world, threat.centroid, playerId === 'enemy') ?? { x: rally.x, y: rally.y }
    let defenders = squads.filter((squad) => squad.mission === 'defend')
    if (defenders.length === 0) {
      let closest: Squad | null = null
      let closestDistance = Number.POSITIVE_INFINITY
      for (const squad of squads) {
        if (squad.mission === 'defend' || squad.mission === 'retreat') continue
        const dx = squad.centroid.x - threat.buildingCenterTile.x
        const dy = squad.centroid.y - threat.buildingCenterTile.y
        const distance = dx * dx + dy * dy
        if (distance < closestDistance) {
          closestDistance = distance
          closest = squad
        }
      }
      if (closest !== null) {
        closest.mission = 'defend'
        defenders = [closest]
      }
    }
    // 交戰評估（Prompt 10.8）：攔截打不贏來襲群 → 不前出，守在受威脅建築旁
    // （自動接戰近身敵人 + 脫戰回血 + 壓境產兵加權），等戰力翻轉再攔截包夾。
    const raiders = threat.enemyIds
      .map((id) => world.units.find((unit) => unit.id === id))
      .filter((unit): unit is Unit => unit !== undefined && unit.hp > 0)
    const totalPowerMilli = defenders.reduce((total, squad) => total + squad.power * 1000, 0)
    const memberIds = defenders.flatMap((squad) => squad.memberIds)
    const hold = !canKillGroup(
      world,
      unitById,
      memberIds,
      totalPowerMilli,
      threat.threatPower,
      raiders,
    )
    const holdTarget = hold
      ? (nearestWalkable(world, threat.buildingCenterTile, playerId === 'enemy') ?? {
          x: rally.x,
          y: rally.y,
        })
      : null
    for (const squad of defenders) {
      squad.mission = 'defend'
      squad.target = holdTarget ?? intercept
      squad.targetBuildingId = null
    }
  }

  // 隊級撤退：貼身敵軍威脅 > 自身戰力 / 0.7 → 撤回集結點。
  for (const squad of squads) {
    const centroidFixed = {
      x: squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
      y: squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    }
    const enemyThreat = enemyThreatAtPoint(world, playerId, centroidFixed.x, centroidFixed.y)
    // 撤退閾值（Prompt 6 #8）：常數改滑桿映射後的有效比（0.5 → 0.7 = 舊值）。
    const threshold = Math.round(enemyThreat * squadRetreatRatio)
    if (squad.power * 1000 < threshold) {
      squad.mission = 'retreat'
      squad.target = { x: rally.x, y: rally.y }
      squad.targetBuildingId = null
      squad.engaging = false
    }
  }

  /* ------------------------------------------------------------------ */
  /* 接觸驅動再評估與夾擊（Prompt 10.15，W1/W2）                              */
  /* ------------------------------------------------------------------ */

  const previousContact = previous?.contact ?? { replanTick: {}, known: {} }
  const contact: ContactState = { replanTick: {}, known: {} }
  /** 這循環的特殊事件（session 轉進決策日誌）。 */
  const events: ContactEvent[] = []
  /** 各小隊的本循環接觸（供夾擊呼叫；以小隊 index 為鍵）。 */
  const contactBySquad = new Map<
    number,
    { enemies: Unit[]; powerMilli: number; tile: TilePos; losing: boolean }
  >()
  /** 受襲殺不掉的小隊（新接觸評估未過 `canKillGroup` 者；無響應 → 撤退，Prompt 10.24 D）。 */
  const losingSquadIndexes = new Set<number>()
/**
 * 塔火在 `contact.known` 裡的合成 id（Prompt 10.24 D）：塔不是單位、沒有敵單位
 * id 可記——若不注入，塔火接觸的 `known` 恆空 → 「新接觸」判定恆 false →
 * 評估分支永不執行（實測：守備隊被塔點射而死、戰術層零事件）。以偏移量合成
 * id，避免與真實單位/建築 id 撞號（單位 id < 1_000_000 的上限由 unitCap 保證）。
 */
const TOWER_KNOWN_ID_OFFSET = 1_000_000

const noticeLimit = CONTACT_NOTICE_RADIUS_TILES * UNITS_PER_TILE
const replyLimit = PINCER_REPLY_RADIUS_TILES * UNITS_PER_TILE

  for (const squad of squads) {
    // 沿續接觸狀態（以 squad index 為鍵；warm start 同一索引空間）。
    contact.replanTick[squad.index] = previousContact.replanTick[squad.index] ?? 0
    contact.known[squad.index] = [...(previousContact.known[squad.index] ?? [])]

    // 撤退隊不再接觸接戰（已在撤）。
    if (squad.mission === 'retreat') continue
    const centroidFixed = {
      x: squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
      y: squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    }
    const noticeSq = noticeLimit * noticeLimit
    const seen: Unit[] = []
    let contactPower = 0
    let sumX = 0
    let sumY = 0
    for (const enemy of world.units) {
      if (enemy.player === playerId || enemy.hp <= 0) continue
      const dx = enemy.x - centroidFixed.x
      const dy = enemy.y - centroidFixed.y
      if (dx * dx + dy * dy > noticeSq) continue
      seen.push(enemy)
      contactPower += unitThreatMilli(world, enemy)
      sumX += enemy.x
      sumY += enemy.y
    }
    // 塔火（Prompt 10.24 D）：敵方帶 `defense` 的**已完工**建築若防禦射程覆蓋
    // 小隊重心 → 視為接觸——unit 掃描對塔**隱形**，守備隊會站樁被點射到死而
    // 戰術層毫無反應（接觸評估／夾擊呼叫全不觸發）。威脅 milli =
    // `dmg × attackSpeed × 1000`（每秒期望傷害，全整數）；目標格 = 塔佔地中心。
    let towerContact: Building | null = null
    let towerThreatMilli = 0
    for (const building of world.buildings) {
      if (building.player === playerId || building.hp <= 0) continue
      const def = world.defs.buildings[building.defId]
      const defense = def?.defense
      if (def === undefined || defense === undefined || !isConstructed(building)) continue
      const rangeFixed = Math.round(defense.range * UNITS_PER_TILE)
      if (distanceSquaredToBuilding(centroidFixed, building) > rangeFixed * rangeFixed) continue
      towerContact = building
      towerThreatMilli += Math.round(defense.dmg * defense.attackSpeed * 1000)
    }
    if (seen.length === 0 && towerContact === null) {
      contact.known[squad.index] = []
      squad.engaging = false // 視野內沒有敵人：迎戰狀態解除，回到原命令。
      continue
    }
    seen.sort((a, b) => a.id - b.id)

    const known = contact.known[squad.index] ?? []
    const knownIds = new Set(known)
    // 「新接觸」= 有新敵單位，**或塔火首次出現**（Prompt 10.24 D：塔不動但
    // 以合成 id 記入 known——首循環必評估，之後走既有接觸路徑不重評）。
    const towerKnownId =
      towerContact === null ? null : TOWER_KNOWN_ID_OFFSET + towerContact.id
    const hasNewContact =
      seen.some((enemy) => !knownIds.has(enemy.id)) || towerKnownId !== null
    // 迎戰目標格（敵群重心）同樣走 canonical 路徑（Prompt 10.22）；僅塔火時
    // 目標 = 塔佔地中心（鏡像安全取格）。
    const towerTile =
      towerContact === null
        ? null
        : mirrorSafeTileOf(
            world.map.size,
            playerId === 'enemy',
            (towerContact.x + towerContact.w / 2) * UNITS_PER_TILE,
            (towerContact.y + towerContact.h / 2) * UNITS_PER_TILE,
          )
    const enemyTile =
      seen.length > 0
        ? tileOfMeanPx(world.map.size, playerId === 'enemy', sumX / seen.length, sumY / seen.length)
        : (towerTile ?? squad.centroid)
    contact.known[squad.index] = [
      ...seen.map((enemy) => enemy.id),
      ...(towerKnownId !== null ? [towerKnownId] : []),
    ]

    const lastTick = contact.replanTick[squad.index] ?? 0
    const cooledDown = world.tick - lastTick >= CONTACT_REPLAN_COOLDOWN_TICKS
    if (!hasNewContact) {
      // 既有接觸：上一循環已在迎戰 → 目標跟著敵群現位走（不再重評估）。
      // 塔不會動：迎戰對象含塔時保持塔的攻城接近格（勿被敵群重心覆寫回 null）。
      if (squad.engaging === true) {
        if (towerContact !== null && towerTile !== null) {
          squad.target =
            siegeApproachTile(world, playerId, towerContact, squad.centroid) ?? towerTile
          squad.targetBuildingId = towerContact.id
        } else {
          squad.target = enemyTile
          squad.targetBuildingId = null
        }
      }
      continue
    }
    if (!cooledDown) continue

    // **新接觸 → AI 重新評估**（模擬層射程內自動接戰照舊、不受影響）：
    // 殺得掉（含塔火威脅）→ 迎戰；殺不掉 → 維持原命令（防守／蓄兵隊若最終
    // 無友隊響應 → 撤退，見下方夾擊循環後）。
    contact.replanTick[squad.index] = world.tick
    const totalContactPower = contactPower + towerThreatMilli
    const winnable = canKillGroup(
      world,
      unitById,
      squad.memberIds,
      squad.power * 1000,
      totalContactPower,
      seen,
    )
    if (winnable) {
      squad.engaging = true
      if (towerContact !== null && towerTile !== null) {
        // 迎戰對象含塔：目標改塔的攻城接近格（正交相鄰射程內格）。
        squad.target =
          siegeApproachTile(world, playerId, towerContact, squad.centroid) ?? towerTile
        squad.targetBuildingId = towerContact.id
      } else {
        squad.target = enemyTile
        squad.targetBuildingId = null
      }
      events.push({
        squadIndex: squad.index,
        outcome: 'engage',
        text: `小隊 #${squad.index} 遭遇敵軍（戰力 ${squad.power} vs 威脅 ${Math.round(totalContactPower / 1000)}）：重新評估 → 迎戰`,
      })
    } else {
      squad.engaging = false
      losingSquadIndexes.add(squad.index)
      events.push({
        squadIndex: squad.index,
        outcome: 'keep',
        text: `小隊 #${squad.index} 遭遇敵軍（戰力 ${squad.power} vs 威脅 ${Math.round(totalContactPower / 1000)}）：重新評估 → 維持原命令`,
      })
    }
    contactBySquad.set(squad.index, {
      enemies: seen,
      powerMilli: totalContactPower,
      tile: enemyTile,
      losing: !winnable,
    })
  }

  // 夾擊呼叫（W2）：受襲殺不掉的小隊向「附近殺得掉」的友隊求援；接應小隊
  // 自敵群重心的**不同方位**繞行接近（夾擊而非一窩蜂正面撞），方位序由
  // responder 順序決定（確定性）。**方位向量在敵方（鏡像序）取負**——
  // 否則藍方永遠從敵群東側接近、紅方也是東側，鏡射對稱會在接觸後破裂
  // （pairProbe 實測 t=211 位置分叉的根因）。
  const directions: readonly TilePos[] = [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
  ]
  const mirrorOrder = playerId === 'enemy'
  // 已有響應的受襲小隊（無響應 → 撤退，Prompt 10.24 D）。
  const respondedContacts = new Set<number>()
  // 前一計畫各小隊的目標（供「接應位沒變就不重複記事件」判斷）。
  const previousTargets = new Map<number, TilePos>()
  for (const squad of previous?.squads ?? []) previousTargets.set(squad.index, squad.target)
  for (const [contactIndex, contactSquad] of contactBySquad) {
    // 呼叫 gate（Prompt 10.24 D）：只有天真新接觸評估**殺不掉**的接觸才求援——
    // 舊版任何接觸都會把附近友隊調去迂迴，殺得掉的接觸自己迎戰即可。
    if (contactSquad.losing !== true) continue
    const losingPower = contactSquad.powerMilli
    const responders: Squad[] = []
    for (const squad of squads) {
      if (responders.length >= PINCER_MAX_RESPONDERS) break
      if (squad.index === contactIndex) continue // 不響應自己的接觸
      // 防守隊也響應（Prompt 10.24 D）：受襲點就在隔壁時，「附近殺得掉」的
      // 守備隊袖手旁觀等於看隊友死——攻擊／騷擾／防守隊皆可接應。
      if (
        squad.mission !== 'attack' &&
        squad.mission !== 'harass' &&
        squad.mission !== 'defend'
      ) {
        continue
      }
      const centroidFixed = {
        x: squad.centroid.x * UNITS_PER_TILE + UNITS_PER_TILE / 2,
        y: squad.centroid.y * UNITS_PER_TILE + UNITS_PER_TILE / 2,
      }
      const dx = centroidFixed.x - (contactSquad.tile.x + 0.5) * UNITS_PER_TILE
      const dy = centroidFixed.y - (contactSquad.tile.y + 0.5) * UNITS_PER_TILE
      if (dx * dx + dy * dy > replyLimit * replyLimit) continue
      if (
        !canKillGroup(
          world,
          unitById,
          squad.memberIds,
          squad.power * 1000,
          losingPower,
          contactSquad.enemies,
        )
      ) {
        continue
      }
      responders.push(squad)
    }
    responders.sort((a, b) => a.index - b.index)
    if (responders.length > 0) respondedContacts.add(contactIndex)
    for (const responder of responders) {
      const base = directions[responders.indexOf(responder) % directions.length] ?? { x: 0, y: 1 }
      const dir = mirrorOrder ? { x: -base.x, y: -base.y } : base
      const approach =
        nearestWalkable(
          world,
          {
            x: contactSquad.tile.x + dir.x * PINCER_STANDOFF_TILES,
            y: contactSquad.tile.y + dir.y * PINCER_STANDOFF_TILES,
          },
          mirrorOrder,
        ) ?? contactSquad.tile
      responder.engaging = true
      responder.target = approach
      responder.targetBuildingId = null
      const before = previousTargets.get(responder.index)
      if (before === undefined || before.x !== approach.x || before.y !== approach.y) {
        events.push({
          squadIndex: responder.index,
          outcome: 'pincer',
          text: `小隊 #${responder.index} 響應受襲小隊的夾擊呼叫（接應位 (${approach.x},${approach.y})）`,
        })
      }
    }
  }

  // 無響應的受襲隊 → 撤退重整（Prompt 10.24 D）：殺不掉又沒人來救，站樁就是
  // 逐 tick 白給。只對**防守／蓄兵**隊適用——攻擊／騷擾隊的「打不過」已由
  // 波次門檻與 10.8 降級鏈管轄（轉 harass／defend），不在此重複。
  for (const squad of squads) {
    if (!losingSquadIndexes.has(squad.index)) continue
    if (respondedContacts.has(squad.index)) continue
    if (squad.mission !== 'defend' && squad.mission !== 'stage') continue
    squad.mission = 'retreat'
    squad.target = { x: rally.x, y: rally.y }
    squad.targetBuildingId = null
    events.push({
      squadIndex: squad.index,
      outcome: 'retreat',
      text: `小隊 #${squad.index} 受襲殺不掉且無友隊響應：撤回集結點重整`,
    })
  }

  // 出廠集合格（Prompt 10.19）：主目標定案後才計算（每間生產建築一筆）。
  const spawns = spawnPoints(world, playerId, rally, squads)

  return {
    tick: world.tick,
    player: playerId,
    rally,
    spawns,
    squads,
    disengaged,
    influence,
    contact,
    events,
    retreatHpFactor,
    squadRetreatRatio,
  }
}


