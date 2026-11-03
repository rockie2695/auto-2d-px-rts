/**
 * 戰況面板的純邏輯層（Prompt 9.5）：
 * - `ResourceSeries` 只收樣本（500ms 一推、120 點 ≈ 60s 滾動窗），
 *   ui 元件只餵 `(tick, crystal)`、取曲線座標，不做任何計算。
 * - `ratioTone`：戰力比上色門檻（< 0.7 紅、0.7–1.4 黃、> 1.4 綠）。
 * - `chartPoints`：樣本 → 0..1 正規化曲線座標（畫在 canvas 用）。
 */

export interface SamplePoint {
  /** 邏輯 tick（20Hz）。 */
  tick: number
  /** 當下的水晶存量。 */
  crystal: number
}

export interface ChartPoint {
  /** 0..1：時間軸（右端 = 現在）。 */
  x: number
  /** 0..1：值軸（下小上大；值域 = 樣本 min..max 加 10% 邊距）。 */
  y: number
}

/** 水晶曲線：120 點環（60 秒）＋ 200 tick 窗口收入估算。 */
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

  /** 推進一個樣本；過期（超出滾動窗）的舊樣本在此淘汰。 */
  push(tick: number, crystal: number): void {
    this.points.push({ tick, crystal })
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
  incomePerSec(): number | null {
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
    const income = ((latest.crystal - windowStart.crystal) / deltaTicks) * ticksPerSec
    return Math.round(income * 10) / 10
  }
}

/** 值域取整用的極小常數（樣本全平行時避免除以 0）。 */
const VALUE_EPSILON = 1

/** 樣本 → 0..1 曲線座標（x 右端 = 現在；y 下小上大、值域 = min..max±10%）。 */
export function chartPoints(samples: readonly SamplePoint[]): ChartPoint[] {
  const count = samples.length
  if (count === 0) return []
  const latest = samples[count - 1]
  if (latest === undefined) return []
  const startX = latest.tick - sampleSpan(samples)
  let minValue = Number.POSITIVE_INFINITY
  let maxValue = Number.NEGATIVE_INFINITY
  for (const sample of samples) {
    minValue = Math.min(minValue, sample.crystal)
    maxValue = Math.max(maxValue, sample.crystal)
  }
  const span = Math.max(maxValue - minValue, VALUE_EPSILON)
  const pad = span * 0.1
  const bottom = minValue - pad
  const top = maxValue + pad
  return samples.map((sample) => ({
    x: Math.max(0, Math.min(1, (sample.tick - startX) / sampleSpan(samples))),
    y: Math.max(0, Math.min(1, (sample.crystal - bottom) / (top - bottom))),
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

export type RatioTone = 'red' | 'yellow' | 'green'

/** 決策層標籤的來源型別（與 session 的 DecisionLogEntry.layer 同構）。 */
export type DecisionLayerTag = 'strategic' | 'tactical'

/** tick（20Hz）→ `m:ss` 時鐘（日誌／小隊面板共用）。 */
export function formatClock(tick: number): string {
  const seconds = Math.floor(tick / 20)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** 層級中文名：戰略／戰術。 */
export function layerLabel(layer: DecisionLayerTag): string {
  return layer === 'strategic' ? '戰略' : '戰術'
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
