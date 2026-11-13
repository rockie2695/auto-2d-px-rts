/**
 * 戰後復盤紀錄（Prompt 10.5，MVP）：純資料層——不依賴 sim 運行、pixi、react。
 * - 對局中每 `REPLAY_SAMPLE_INTERVAL_TICKS`（20 tick = 1 秒）取一次雙陣營樣本，
 *   12000 tick 上限 ≈ 600 點，canvas 直接畫得動。
 * - `ReplayRecord` 是復盤頁唯一的輸入（props 純渲染，不讀即時 sim）。
 * - `parseReplay` 負責「replay 檔」（JSON）→ `ReplayRecord` 的驗證與正規化；
 *   MVP 以記憶體物件傳遞，測試以 JSON fixture 模擬檔案，日後要存檔／分享再擴充。
 */

/** 對局結果：player = 我方勝、enemy = 敵方勝、draw = 平手（含超時水晶相同）。 */
export type MatchResult = 'player' | 'enemy' | 'draw'

/** 雙陣營取樣點（水晶存量或存活單位數）。 */
export interface ReplaySample {
  readonly tick: number
  readonly player: number
  readonly enemy: number
}

/** 一次政策滑桿變更（Prompt 10 決策日誌的結構化版本）。 */
export interface ReplayPolicyEvent {
  readonly tick: number
  readonly key: string
  readonly from: number
  readonly to: number
}

/** 投降事件（Prompt 8.6 AI / Prompt 10.6 玩家手動；舊 replay 檔缺欄 = undefined，UI 顯示 --）。 */
export interface ReplaySurrenderEvent {
  readonly tick: number
  readonly player: string
  readonly type: 'ai_surrender' | 'player_surrender'
  readonly despairAtSurrender: number
  readonly powerRatio: number
  readonly incomeRatio: number
  /** 牆鐘時間戳 ms（Prompt 10.6 玩家投降；AI 投降/舊檔 undefined）。 */
  readonly timestamp?: number
}

/** 單位死亡事件（Prompt 10.5 完整版：戰鬥時間軸資料源；player = 受害方）。 */
export interface ReplayDeathEvent {
  readonly tick: number
  readonly player: string
  readonly defId: string
  readonly tier: string
  readonly role: string
}

/** tier 級存活數樣本（Prompt 10.5 完整版：單位數量堆疊圖資料源）。 */
export interface ReplayTierSample {
  readonly tick: number
  readonly player: { readonly small: number; readonly medium: number; readonly large: number }
  readonly enemy: { readonly small: number; readonly medium: number; readonly large: number }
}

/** 節奏預設切換事件（Prompt 10.5 完整版：節奏時間軸資料源）。 */
export interface ReplayTempoEvent {
  readonly tick: number
  readonly from: string
  readonly to: string
}

/** 戰略決策記錄（Prompt 10.5 完整版：決策歸因表資料源；每個實際執行的動作一筆）。 */
export interface ReplayDecision {
  readonly tick: number
  readonly actor: string
  readonly action: 'build' | 'train'
  readonly target: string
  /** 執行當下候選排序第一名的效用分（DecisionRecord.reason.candidates[0].score）。 */
  readonly score: number
  /** 動作資源成本（藍水晶；影響力排序主鍵）。 */
  readonly cost: number
  /** 一行中文解釋（explain.ts 模板）。 */
  readonly explanation: string
  /** 實際後果（Prompt 10.5 完整版）：此決策之後出生的同 target 現存量（session finalize 時算）。 */
  readonly outcomeAlive?: number
}

/** 裝甲效益統計（Prompt 10.5 完整版；按受害方累計——單位受害者才計，建築無裝甲）。 */
export interface ReplayArmorStats {
  /** 受擊原始傷害總量（未套裝甲的帳面傷害）。 */
  readonly takenRaw: { readonly player: number; readonly enemy: number }
  /** 受擊實際傷害總量（套裝甲與 1 點地板後）。 */
  readonly takenActual: { readonly player: number; readonly enemy: number }
}

export interface ReplayRecord {
  /** 對局種子（同一種子 + 同一滑桿序列 → 可逐 tick 重播）。 */
  readonly seed: number
  readonly result: MatchResult
  /** 對局總時長（tick，20Hz）。 */
  readonly durationTicks: number
  readonly finalCrystal: { readonly player: number; readonly enemy: number }
  /** 完整資源曲線（全程，非 60 秒滾動窗；藍水晶）。 */
  readonly resourceSeries: readonly ReplaySample[]
  /** 雙方存活單位數曲線。 */
  readonly unitCountSeries: readonly ReplaySample[]
  /** 雙方戰力曲線（Σ hp/(1−armor) × dmg × attackSpeed，Prompt 3.1 起有效當量）。 */
  readonly powerSeries: readonly ReplaySample[]
  /** 玩家每次改滑桿的時間點。 */
  readonly policyEvents: readonly ReplayPolicyEvent[]
  /** AI 投降事件（Prompt 8.6；最多一筆——先投方即結束對局走向）。 */
  readonly surrender?: ReplaySurrenderEvent
  /** 紅寶石曲線（Prompt 5；舊 replay 檔缺欄 = undefined，UI 顯示 --）。 */
  readonly rubySeries?: readonly ReplaySample[]
  readonly emeraldSeries?: readonly ReplaySample[]
  readonly finalRuby?: { readonly player: number; readonly enemy: number }
  readonly finalEmerald?: { readonly player: number; readonly enemy: number }
  /** 單位死亡事件（Prompt 10.5 完整版；舊檔缺欄 = undefined，UI 隱藏時間軸）。 */
  readonly deathEvents?: readonly ReplayDeathEvent[]
  /** tier 級存活數曲線（Prompt 10.5 完整版；舊檔缺欄 = undefined，UI 顯示 --）。 */
  readonly tierCountSeries?: readonly ReplayTierSample[]
  /** 節奏預設切換事件（Prompt 10.5 完整版；舊檔缺欄 = undefined）。 */
  readonly tempoEvents?: readonly ReplayTempoEvent[]
  /** 戰略決策記錄（Prompt 10.5 完整版；舊檔缺欄 = undefined，UI 隱藏歸因表）。 */
  readonly decisions?: readonly ReplayDecision[]
  /** 裝甲效益統計（Prompt 10.5 完整版；舊檔缺欄 = undefined，UI 顯示 --）。 */
  readonly armorStats?: ReplayArmorStats
}

/** 取樣間隔：20 tick（1 秒）。 */
export const REPLAY_SAMPLE_INTERVAL_TICKS = 20

/** 樣本數上限（12000 tick ÷ 20 = 600；防異常長局爆記憶體）。 */
const MAX_SAMPLES = 1200

/** 復盤紀錄器：session 在 tick 內餵樣本與政策事件，結束時 `finish` 產出紀錄。 */
export class ReplayRecorder {
  private readonly resource: ReplaySample[] = []
  private readonly unitCounts: ReplaySample[] = []
  private readonly powers: ReplaySample[] = []
  private readonly policies: ReplayPolicyEvent[] = []
  private readonly ruby: ReplaySample[] = []
  private readonly emerald: ReplaySample[] = []
  private readonly tierCounts: ReplayTierSample[] = []
  private readonly deaths: ReplayDeathEvent[] = []
  private readonly tempos: ReplayTempoEvent[] = []
  private readonly decisions: ReplayDecision[] = []
  private surrender: ReplaySurrenderEvent | null = null

  /** 對局中取一個雙陣營樣本（三資源、存活單位數、戰力，同一時刻成對）。 */
  sample(
    tick: number,
    playerCrystal: number,
    enemyCrystal: number,
    playerUnits: number,
    enemyUnits: number,
    playerPower: number,
    enemyPower: number,
    playerRuby = 0,
    enemyRuby = 0,
    playerEmerald = 0,
    enemyEmerald = 0,
  ): void {
    if (this.resource.length >= MAX_SAMPLES) return
    this.resource.push({ tick, player: playerCrystal, enemy: enemyCrystal })
    this.unitCounts.push({ tick, player: playerUnits, enemy: enemyUnits })
    this.powers.push({ tick, player: playerPower, enemy: enemyPower })
    this.ruby.push({ tick, player: playerRuby, enemy: enemyRuby })
    this.emerald.push({ tick, player: playerEmerald, enemy: enemyEmerald })
  }

  /** 記錄一次政策變更（每個實際變更的滑桿一筆）。 */
  recordPolicy(event: ReplayPolicyEvent): void {
    this.policies.push(event)
  }

  /**
   * 記錄一次 tier 級存活數樣本（Prompt 10.5 完整版）：與 `sample` 同 tick 成對呼叫——
   * 主樣本被 MAX_SAMPLES 截斷時同步跳過，維持兩陣列等長。
   */
  sampleTiers(
    tick: number,
    player: { small: number; medium: number; large: number },
    enemy: { small: number; medium: number; large: number },
  ): void {
    if (this.resource.length >= MAX_SAMPLES) return
    this.tierCounts.push({
      tick,
      player: { ...player },
      enemy: { ...enemy },
    })
  }

  /** 批次記錄單位死亡事件（Prompt 10.5 完整版；session 每 tick 從 sim 環抽取）。 */
  recordDeaths(events: readonly ReplayDeathEvent[]): void {
    for (const event of events) this.deaths.push({ ...event })
  }

  /** 記錄節奏預設切換（Prompt 10.5 完整版；實際變更才記）。 */
  recordTempo(event: ReplayTempoEvent): void {
    this.tempos.push({ ...event })
  }

  /** 批次記錄戰略決策（Prompt 10.5 完整版；每個實際執行的動作一筆）。 */
  recordDecisions(events: readonly ReplayDecision[]): void {
    for (const event of events) this.decisions.push({ ...event })
  }

  /** 記錄投降事件（Prompt 8.6 AI／Prompt 10.6 玩家手動；後投方不覆蓋先投方）。 */
  recordSurrender(event: ReplaySurrenderEvent): void {
    if (this.surrender === null) this.surrender = event
  }

  /** 對局結束：組出不可變的完整紀錄（陣列複本，之後再動紀錄器不影響已產出者）。 */
  finish(
    seed: number,
    result: MatchResult,
    finalCrystal: { player: number; enemy: number },
    durationTicks: number,
    finalRuby: { player: number; enemy: number } = { player: 0, enemy: 0 },
    finalEmerald: { player: number; enemy: number } = { player: 0, enemy: 0 },
  ): ReplayRecord {
    return {
      seed,
      result,
      durationTicks,
      finalCrystal: { player: finalCrystal.player, enemy: finalCrystal.enemy },
      resourceSeries: [...this.resource],
      unitCountSeries: [...this.unitCounts],
      powerSeries: [...this.powers],
      policyEvents: [...this.policies],
      rubySeries: [...this.ruby],
      emeraldSeries: [...this.emerald],
      finalRuby: { player: finalRuby.player, enemy: finalRuby.enemy },
      finalEmerald: { player: finalEmerald.player, enemy: finalEmerald.enemy },
      // Prompt 10.5 完整版：空陣列省略（與舊檔同形——缺欄 = undefined）。
      ...(this.tierCounts.length === 0 ? {} : { tierCountSeries: [...this.tierCounts] }),
      ...(this.deaths.length === 0 ? {} : { deathEvents: [...this.deaths] }),
      ...(this.tempos.length === 0 ? {} : { tempoEvents: [...this.tempos] }),
      ...(this.decisions.length === 0 ? {} : { decisions: [...this.decisions] }),
      ...(this.surrender === null ? {} : { surrender: this.surrender }),
    }
  }
}

/* ------------------------------------------------------------------ */
/* replay 檔驗證（JSON → ReplayRecord）                                */
/* ------------------------------------------------------------------ */

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`replay 欄位 ${field} 必須是有限數字`)
  }
  return value
}

function requireSamples(value: unknown, field: string): ReplaySample[] {
  if (!Array.isArray(value)) throw new Error(`replay 欄位 ${field} 必須是陣列`)
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`replay 欄位 ${field}[${index}] 必須是物件`)
    }
    const sample = item as Record<string, unknown>
    return {
      tick: requireFiniteNumber(sample.tick, `${field}[${index}].tick`),
      player: requireFiniteNumber(sample.player, `${field}[${index}].player`),
      enemy: requireFiniteNumber(sample.enemy, `${field}[${index}].enemy`),
    }
  })
}

/**
 * replay 檔（JSON）→ `ReplayRecord`：逐欄位驗證，缺欄位／壞型別擲錯。
 * 「讀檔渲染」的單一入口——MVP 測試以 JSON fixture 餵入，日後換成檔案來源不動 UI。
 */
export function parseReplay(json: unknown): ReplayRecord {
  if (typeof json !== 'object' || json === null) {
    throw new Error('replay 必須是 JSON 物件')
  }
  const raw = json as Record<string, unknown>
  if (raw.result !== 'player' && raw.result !== 'enemy' && raw.result !== 'draw') {
    throw new Error('replay 欄位 result 必須是 player / enemy / draw')
  }
  if (typeof raw.finalCrystal !== 'object' || raw.finalCrystal === null) {
    throw new Error('replay 欄位 finalCrystal 必須是物件')
  }
  const finalCrystalRaw = raw.finalCrystal as Record<string, unknown>
  if (!Array.isArray(raw.policyEvents)) throw new Error('replay 欄位 policyEvents 必須是陣列')
  const policyEvents = raw.policyEvents.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`replay 欄位 policyEvents[${index}] 必須是物件`)
    }
    const event = item as Record<string, unknown>
    if (typeof event.key !== 'string') {
      throw new Error(`replay 欄位 policyEvents[${index}].key 必須是字串`)
    }
    return {
      tick: requireFiniteNumber(event.tick, `policyEvents[${index}].tick`),
      key: event.key,
      from: requireFiniteNumber(event.from, `policyEvents[${index}].from`),
      to: requireFiniteNumber(event.to, `policyEvents[${index}].to`),
    }
  })
  return {
    result: raw.result,
    seed: requireFiniteNumber(raw.seed, 'seed'),
    durationTicks: requireFiniteNumber(raw.durationTicks, 'durationTicks'),
    finalCrystal: {
      player: requireFiniteNumber(finalCrystalRaw.player, 'finalCrystal.player'),
      enemy: requireFiniteNumber(finalCrystalRaw.enemy, 'finalCrystal.enemy'),
    },
    resourceSeries: requireSamples(raw.resourceSeries, 'resourceSeries'),
    unitCountSeries: requireSamples(raw.unitCountSeries, 'unitCountSeries'),
    powerSeries: requireSamples(raw.powerSeries, 'powerSeries'),
    policyEvents,
    // Prompt 5：紅寶石／綠翡翠曲線可缺（舊 replay 檔）。
    rubySeries:
      raw.rubySeries === undefined ? undefined : requireSamples(raw.rubySeries, 'rubySeries'),
    emeraldSeries:
      raw.emeraldSeries === undefined
        ? undefined
        : requireSamples(raw.emeraldSeries, 'emeraldSeries'),
    // Prompt 8.6：投降事件可缺（舊 replay 檔）。
    surrender: raw.surrender === undefined ? undefined : requireSurrender(raw.surrender),
    // Prompt 10.5 完整版：全部可缺（舊 replay 檔）。
    deathEvents:
      raw.deathEvents === undefined ? undefined : requireDeaths(raw.deathEvents),
    tierCountSeries:
      raw.tierCountSeries === undefined
        ? undefined
        : requireTierSamples(raw.tierCountSeries),
    tempoEvents:
      raw.tempoEvents === undefined ? undefined : requireTempoEvents(raw.tempoEvents),
    decisions:
      raw.decisions === undefined ? undefined : requireDecisions(raw.decisions),
    armorStats: raw.armorStats === undefined ? undefined : requireArmorStats(raw.armorStats),
  }
}

/** 死亡事件陣列驗證（可缺；型別壞擲錯）。 */
function requireDeaths(value: unknown): ReplayDeathEvent[] {
  if (!Array.isArray(value)) throw new Error('replay 欄位 deathEvents 必須是陣列')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`replay 欄位 deathEvents[${index}] 必須是物件`)
    }
    const event = item as Record<string, unknown>
    if (
      event.player !== 'player' &&
      event.player !== 'enemy'
    ) {
      throw new Error(`replay 欄位 deathEvents[${index}].player 必須是 player / enemy`)
    }
    if (typeof event.defId !== 'string' || typeof event.tier !== 'string' || typeof event.role !== 'string') {
      throw new Error(`replay 欄位 deathEvents[${index}].defId/tier/role 必須是字串`)
    }
    return {
      tick: requireFiniteNumber(event.tick, `deathEvents[${index}].tick`),
      player: event.player,
      defId: event.defId,
      tier: event.tier,
      role: event.role,
    }
  })
}

/** tier 級樣本陣列驗證（可缺；型別壞擲錯）。 */
function requireTierSamples(value: unknown): ReplayTierSample[] {
  if (!Array.isArray(value)) throw new Error('replay 欄位 tierCountSeries 必須是陣列')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`replay 欄位 tierCountSeries[${index}] 必須是物件`)
    }
    const raw = item as Record<string, unknown>
    return {
      tick: requireFiniteNumber(raw.tick, `tierCountSeries[${index}].tick`),
      player: requireTierCounts(raw.player, `tierCountSeries[${index}].player`),
      enemy: requireTierCounts(raw.enemy, `tierCountSeries[${index}].enemy`),
    }
  })
}

function requireTierCounts(
  value: unknown,
  field: string,
): { small: number; medium: number; large: number } {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`replay 欄位 ${field} 必須是物件`)
  }
  const raw = value as Record<string, unknown>
  return {
    small: requireFiniteNumber(raw.small, `${field}.small`),
    medium: requireFiniteNumber(raw.medium, `${field}.medium`),
    large: requireFiniteNumber(raw.large, `${field}.large`),
  }
}

/** 節奏切換事件陣列驗證（可缺；型別壞擲錯）。 */
function requireTempoEvents(value: unknown): ReplayTempoEvent[] {
  if (!Array.isArray(value)) throw new Error('replay 欄位 tempoEvents 必須是陣列')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`replay 欄位 tempoEvents[${index}] 必須是物件`)
    }
    const event = item as Record<string, unknown>
    if (typeof event.from !== 'string' || typeof event.to !== 'string') {
      throw new Error(`replay 欄位 tempoEvents[${index}].from/to 必須是字串`)
    }
    return {
      tick: requireFiniteNumber(event.tick, `tempoEvents[${index}].tick`),
      from: event.from,
      to: event.to,
    }
  })
}

/** 戰略決策陣列驗證（可缺；型別壞擲錯）。 */
function requireDecisions(value: unknown): ReplayDecision[] {
  if (!Array.isArray(value)) throw new Error('replay 欄位 decisions 必須是陣列')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`replay 欄位 decisions[${index}] 必須是物件`)
    }
    const event = item as Record<string, unknown>
    if (event.actor !== 'player' && event.actor !== 'enemy') {
      throw new Error(`replay 欄位 decisions[${index}].actor 必須是 player / enemy`)
    }
    if (event.action !== 'build' && event.action !== 'train') {
      throw new Error(`replay 欄位 decisions[${index}].action 必須是 build / train`)
    }
    if (typeof event.target !== 'string' || typeof event.explanation !== 'string') {
      throw new Error(`replay 欄位 decisions[${index}].target/explanation 必須是字串`)
    }
    return {
      tick: requireFiniteNumber(event.tick, `decisions[${index}].tick`),
      actor: event.actor,
      action: event.action,
      target: event.target,
      score: requireFiniteNumber(event.score, `decisions[${index}].score`),
      cost: requireFiniteNumber(event.cost, `decisions[${index}].cost`),
      explanation: event.explanation,
      ...(event.outcomeAlive === undefined
        ? {}
        : { outcomeAlive: requireFiniteNumber(event.outcomeAlive, `decisions[${index}].outcomeAlive`) }),
    }
  })
}

/** 裝甲效益統計驗證（可缺；型別壞擲錯）。 */
function requireArmorStats(value: unknown): ReplayArmorStats {
  if (typeof value !== 'object' || value === null) {
    throw new Error('replay 欄位 armorStats 必須是物件')
  }
  const raw = value as Record<string, unknown>
  return {
    takenRaw: requireSidePair(raw.takenRaw, 'armorStats.takenRaw'),
    takenActual: requireSidePair(raw.takenActual, 'armorStats.takenActual'),
  }
}

function requireSidePair(
  value: unknown,
  field: string,
): { player: number; enemy: number } {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`replay 欄位 ${field} 必須是物件`)
  }
  const raw = value as Record<string, unknown>
  return {
    player: requireFiniteNumber(raw.player, `${field}.player`),
    enemy: requireFiniteNumber(raw.enemy, `${field}.enemy`),
  }
}

/** 投降事件欄位驗證（可缺；型別壞擲錯）。timestamp 可缺（舊檔/AI 投降）。 */
function requireSurrender(value: unknown): ReplaySurrenderEvent {
  if (typeof value !== 'object' || value === null) {
    throw new Error('replay 欄位 surrender 必須是物件')
  }
  const raw = value as Record<string, unknown>
  if (raw.player !== 'player' && raw.player !== 'enemy') {
    throw new Error('replay 欄位 surrender.player 必須是 player / enemy')
  }
  if (raw.type !== 'ai_surrender' && raw.type !== 'player_surrender') {
    throw new Error('replay 欄位 surrender.type 必須是 ai_surrender / player_surrender')
  }
  return {
    tick: requireFiniteNumber(raw.tick, 'surrender.tick'),
    player: raw.player,
    type: raw.type,
    despairAtSurrender: requireFiniteNumber(raw.despairAtSurrender, 'surrender.despairAtSurrender'),
    powerRatio: requireFiniteNumber(raw.powerRatio, 'surrender.powerRatio'),
    incomeRatio: requireFiniteNumber(raw.incomeRatio, 'surrender.incomeRatio'),
    ...(raw.timestamp === undefined
      ? {}
      : { timestamp: requireFiniteNumber(raw.timestamp, 'surrender.timestamp') }),
  }
}
