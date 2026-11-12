/**
 * 戰況面板的純邏輯層（Prompt 9.5 / Prompt 10）：
 * - `ResourceSeries` 收雙陣營樣本（500ms 一推、120 點 ≈ 60s 滾動窗），
 *   ui 元件只餵 `(tick, player, enemy)`、取曲線座標，不做任何計算。
 *   兩條線共用同一絕對值域（同一 y 軸直接比較），收入各自估算。
 * - `ratioTone`：戰力比上色門檻（< 0.7 紅、0.7–1.4 黃、> 1.4 綠）。
 * - `chartPoints`：樣本 → 0..1 正規化曲線座標（畫在 canvas 用）。
 */

export interface SamplePoint {
  /** 邏輯 tick（20Hz）。 */
  tick: number
  /** 玩家（藍）水晶存量。 */
  player: number
  /** 敵方（紅）水晶存量。 */
  enemy: number
}

export interface ChartPoint {
  /** 0..1：時間軸（右端 = 現在）。 */
  x: number
  /** 0..1：值軸（下小上大；值域 = 樣本 min..max 加 10% 邊距）。 */
  y: number
}

/** 水晶曲線：雙陣營各 120 點環（60 秒）＋ 200 tick 窗口收入估算。 */
export class ResourceSeries {
  private readonly points: SamplePoint[] = []

  /** 收入估算窗口（SPEC §5 費率都是每 20 tick 整數進帳）。 */
  private readonly incomeWindowTicks: number

  /** 環容量；預設 120 點 × 500ms ≈ 60 秒滾動窗。 */
  private readonly capacity: number
  /** 曲線覆蓋的 tick 跨度（20Hz × 60s = 1200）。 */
  private readonly spanTicks: number

  constructor(capacity: number = 120, spanTicks: number = 1200, incomeWindowTicks: number = 200) {
    this.capacity = capacity
    this.spanTicks = spanTicks
    this.incomeWindowTicks = incomeWindowTicks
  }

  /** 推進一個雙陣營樣本；過期（超出滾動窗）的舊樣本在此淘汰。 */
  push(tick: number, player: number, enemy: number): void {
    this.points.push({ tick, player, enemy })
    const cutoff = tick - this.spanTicks
    while (this.points.length > 0) {
      const oldest = this.points[0]
      if (oldest === undefined) break
      if (oldest.tick < cutoff && this.points.length > 1) {
        this.points.shift()
      } else {
        break
      }
    }
    while (this.points.length > this.capacity) {
      this.points.shift()
    }
  }

  /** 目前快照（唯讀複本，供 React state 與測試比對）。 */
  chart(): readonly SamplePoint[] {
    return [...this.points]
  }

  /**
   * 收入速率（水晶/秒）：以 200 tick（10 秒）窗口的首尾差除以實際跨度。
   * 樣本不足 2 點回傳 null（曲線還沒成形，不硬估）。
   */
  private incomePerSecOf(get: (point: SamplePoint) => number): number | null {
    const count = this.points.length
    if (count < 2) return null
    const latest = this.points[count - 1]
    const first = this.points[0]
    if (latest === undefined || first === undefined) return null
    // 窗口起點：不含最新樣本，取最舊的可入窗樣本；窗內無前序樣本 → 用第一點。
    let windowStart = first
    for (let index = 0; index < count - 1; index++) {
      const point = this.points[index]
      if (point === undefined) continue
      if (latest.tick - point.tick <= this.incomeWindowTicks) {
        windowStart = point
        break
      }
    }
    const deltaTicks = Math.max(1, latest.tick - windowStart.tick)
    const ticksPerSec = 20
    const income = ((get(latest) - get(windowStart)) / deltaTicks) * ticksPerSec
    return Math.round(income * 10) / 10
  }

  /** 玩家（藍）收入速率（水晶/秒）；樣本不足回 null。 */
  playerIncome(): number | null {
    return this.incomePerSecOf((point) => point.player)
  }

  /** 敵方（紅）收入速率（水晶/秒）；樣本不足回 null。 */
  enemyIncome(): number | null {
    return this.incomePerSecOf((point) => point.enemy)
  }
}

/** 值域取整用的極小常數（樣本全平行時避免除以 0）。 */
const VALUE_EPSILON = 1

/** 雙線共用值域（y 軸標籤與曲線座標單一真相來源）。 */
export interface ChartDomain {
  /** 資料實際最小／最大值（雙陣營合併）。 */
  min: number
  max: number
  /** 加 10% 邊距後的繪圖範圍（0 與 1 對應的值）。 */
  bottom: number
  top: number
}

/** 樣本 → 雙線共用值域；空樣本回 null。 */
export function chartDomain(samples: readonly SamplePoint[]): ChartDomain | null {
  if (samples.length === 0) return null
  let minValue = Number.POSITIVE_INFINITY
  let maxValue = Number.NEGATIVE_INFINITY
  for (const sample of samples) {
    minValue = Math.min(minValue, sample.player, sample.enemy)
    maxValue = Math.max(maxValue, sample.player, sample.enemy)
  }
  const span = Math.max(maxValue - minValue, VALUE_EPSILON)
  const pad = span * 0.1
  return { min: minValue, max: maxValue, bottom: minValue - pad, top: maxValue + pad }
}

/** 樣本 → 0..1 曲線座標（x 右端 = 現在；y 下小上大）。
 *  `pick` 選擇取哪一條線的值；值域固定為雙線共用的絕對 min..max±10%
 *  （兩條線畫在同一軸上直接比較，各自歸一會失真）。 */
export function chartPoints(
  samples: readonly SamplePoint[],
  pick: (point: SamplePoint) => number,
): ChartPoint[] {
  const domain = chartDomain(samples)
  if (domain === null) return []
  const latest = samples[samples.length - 1]
  if (latest === undefined) return []
  const span = Math.max(domain.top - domain.bottom, VALUE_EPSILON)
  const startX = latest.tick - sampleSpan(samples)
  return samples.map((sample) => ({
    x: Math.max(0, Math.min(1, (sample.tick - startX) / sampleSpan(samples))),
    y: Math.max(0, Math.min(1, (pick(sample) - domain.bottom) / span)),
  }))
}

/** 樣本覆蓋的 tick 跨度（窗未滿時以現有首尾為準）。 */
function sampleSpan(samples: readonly SamplePoint[]): number {
  const count = samples.length
  if (count === 0) return 1
  const latest = samples[count - 1]
  const first = samples[0]
  if (latest === undefined || first === undefined) return 1
  return Math.max(1, latest.tick - first.tick)
}

/**
 * 三資源樣本 → uPlot 資料（Prompt 9.5 完整版）：
 * `[x[], 藍[], 紅[], 綠[]]`，x = tick ÷ 20（秒）。取 player 值（uPlot 三線
 * 為我方三資源存量）；對齊問題不需要處理——三個環同一輪詢同時推進。
 * 測試直接驗證數值，不需真 uPlot 實例。
 */
export function uplotTripleData(
  crystal: readonly SamplePoint[],
  ruby: readonly SamplePoint[],
  emerald: readonly SamplePoint[],
): [number[], number[], number[], number[]] {
  return [
    crystal.map((point) => point.tick / 20),
    crystal.map((point) => point.player),
    ruby.map((point) => point.player),
    emerald.map((point) => point.player),
  ]
}

export type RatioTone = 'red' | 'yellow' | 'green'

/** 決策層標籤的來源型別（與 session 的 DecisionLogEntry.layer 同構）。 */
export type DecisionLayerTag = 'strategic' | 'tactical' | 'policy' | 'micro'

/** tick（20Hz）→ `m:ss` 時鐘（日誌／小隊面板共用）。 */
export function formatClock(tick: number): string {
  const seconds = Math.floor(tick / 20)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** 層級中文名：戰略／戰術／政策／微操。 */
export function layerLabel(layer: DecisionLayerTag): string {
  if (layer === 'strategic') return '戰略'
  if (layer === 'micro') return '微操'
  return layer === 'policy' ? '政策' : '戰術'
}

/**
 * 戰力比上色（Prompt 9.5 驗收 boundaries）：
 * < 0.7 紅（劣勢）；0.7 ≦ ratio ≦ 1.4 黃（均衡）；> 1.4 綠（優勢）。
 */
export function ratioTone(ratio: number): RatioTone {
  if (ratio < 0.7) return 'red'
  if (ratio <= 1.4) return 'yellow'
  return 'green'
}

/** 小隊狀態色（Prompt 9.5 完整版）：紅＝撤退中、黃＝交戰中、其餘綠（安全）。 */
export type SquadTone = 'red' | 'yellow' | 'green'

/** mission/engaging → 狀態色（retreat 最優先——「撤退中」蓋過交戰）。 */
export function squadTone(mission: string, engaging: boolean): SquadTone {
  if (mission === 'retreat') return 'red'
  if (engaging) return 'yellow'
  return 'green'
}

/** 小隊狀態色的 CSS 值（單一真相來源；面板與測試共用）。 */
export function squadToneColor(tone: SquadTone): string {
  if (tone === 'red') return '#ff7a7a'
  if (tone === 'yellow') return '#ffd866'
  return '#7ce38b'
}
