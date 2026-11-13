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
