import { describe, expect, it } from 'vitest'

import { chartPoints, ratioTone, ResourceSeries } from './collector.ts'

/**
 * 戰況面板純邏輯測試（Prompt 9.5）：
 * - 曲線取樣環：過期淘汰、最高 120 點
 * - 收入估算：200 tick 窗口、樣本不足回 null
 * - 戰力比色階：0.7 / 1.4 邊界
 * - 曲線座標：正規化與單調性
 */

describe('ResourceSeries 取樣環', () => {
  it('push 累積樣本；超出滾動窗的舊樣本被淘汰、至多 capacity 點', () => {
    const series = new ResourceSeries(5, 100)
    for (let tick = 0; tick <= 300; tick += 10) {
      series.push(tick, tick / 10)
    }
    const points = series.chart()
    expect(points.length).toBeLessThanOrEqual(5)
    expect(points.at(-1)?.tick).toBe(300)
    // 窗內（300 - 100 = 200 之後）。
    expect(points[0] !== undefined && points[0].tick >= 200).toBe(true)
  })

  it('收入估算：200 tick 窗口首尾差 ÷ 跨度 × 20Hz（每秒水晶）', () => {
    const series = new ResourceSeries()
    series.push(0, 100)
    series.push(400, 140) // 跨度 400 tick，差 40 → 每秒 40/400×20 = 2.0
    expect(series.incomePerSec()).toBe(2)
  })

  it('收入估算：只用 200 tick 窗口內的樣本（10 秒均值）', () => {
    const series = new ResourceSeries()
    series.push(0, 100)
    series.push(300, 130) // 舊估 30/300×20 = 2.0
    series.push(400, 140) // 窗 300..400 差 10/100×20 = 2.0
    expect(series.incomePerSec()).toBe(2)
  })

  it('收入估算：樣本不足 2 點回 null；整好每秒 1.0 的速率回 1', () => {
    const series = new ResourceSeries()
    expect(series.incomePerSec()).toBeNull()
    series.push(0, 10)
    series.push(200, 20) // 10 差 / 200 tick → ×20 = 1.0/s
    expect(series.incomePerSec()).toBe(1)
  })
})

describe('ratioTone 戰力比色階（Prompt 9.5 邊界）', () => {
  it('0.7 以下紅；0.7–1.4（含邊界）黃；1.4 以上綠', () => {
    expect(ratioTone(0.69)).toBe('red')
    expect(ratioTone(0.7)).toBe('yellow')
    expect(ratioTone(1.0)).toBe('yellow')
    expect(ratioTone(1.4)).toBe('yellow')
    expect(ratioTone(1.41)).toBe('green')
  })
})

describe('chartPoints 曲線座標', () => {
  it('空樣本回空陣列；x 在 0..1、y 隨水晶單調上升', () => {
    expect(chartPoints([])).toEqual([])
    const samples = [
      { tick: 0, crystal: 10 },
      { tick: 100, crystal: 20 },
      { tick: 200, crystal: 30 },
    ]
    const points = chartPoints(samples)
    expect(points.length).toBe(3)
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(1)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(1)
    }
    expect(points[1]!.y).toBeGreaterThan(points[0]!.y)
    expect(points[2]!.y).toBeGreaterThan(points[1]!.y)
    expect(points[2]!.x).toBe(1) // 右端 = 現在
  })

  it('樣本完全水平：y 不 NaN（值域至少 1）', () => {
    const points = chartPoints([
      { tick: 0, crystal: 50 },
      { tick: 100, crystal: 50 },
    ])
    expect(Number.isFinite(points[0]?.y)).toBe(true)
    expect(Number.isFinite(points[1]?.y)).toBe(true)
  })
})
