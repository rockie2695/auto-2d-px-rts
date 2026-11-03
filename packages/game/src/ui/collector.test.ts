import { describe, expect, it } from 'vitest'

import { chartDomain, chartPoints, ratioTone, ResourceSeries } from './collector.ts'

/**
 * 戰況面板純邏輯測試（Prompt 9.5 / Prompt 10）：
 * - 曲線取樣環：過期淘汰、最高 120 點、雙陣營成對取樣
 * - 收入估算：200 tick 窗口、雙方各自估算、樣本不足回 null
 * - 戰力比色階：0.7 / 1.4 邊界
 * - 曲線座標：正規化與單調性、兩條線共用絕對值域
 */

describe('ResourceSeries 取樣環', () => {
  it('push 成對累積雙陣營樣本；超出滾動窗的舊樣本被淘汰、至多 capacity 點', () => {
    const series = new ResourceSeries(5, 100)
    for (let tick = 0; tick <= 300; tick += 10) {
      series.push(tick, tick / 10, tick / 5)
    }
    const points = series.chart()
    expect(points.length).toBeLessThanOrEqual(5)
    expect(points.at(-1)?.tick).toBe(300)
    expect(points.at(-1)?.player).toBe(30)
    expect(points.at(-1)?.enemy).toBe(60)
    // 窗內（300 - 100 = 200 之後）。
    expect(points[0] !== undefined && points[0].tick >= 200).toBe(true)
  })

  it('收入估算：雙方各自以 200 tick 窗口首尾差 ÷ 跨度 × 20Hz', () => {
    const series = new ResourceSeries()
    series.push(0, 100, 50)
    series.push(400, 140, 60) // 玩家 40/400×20 = 2.0；敵方 10/400×20 = 0.5
    expect(series.playerIncome()).toBe(2)
    expect(series.enemyIncome()).toBe(0.5)
  })

  it('收入估算：只用 200 tick 窗口內的樣本（10 秒均值）', () => {
    const series = new ResourceSeries()
    series.push(0, 100, 100)
    series.push(300, 130, 130) // 舊估 30/300×20 = 2.0
    series.push(400, 140, 120) // 窗 300..400：玩家 10/100×20 = 2.0；敵方 -10/100×20 = -2
    expect(series.playerIncome()).toBe(2)
    expect(series.enemyIncome()).toBe(-2)
  })

  it('收入估算：樣本不足 2 點回 null；整好每秒 1.0 的速率回 1', () => {
    const series = new ResourceSeries()
    expect(series.playerIncome()).toBeNull()
    expect(series.enemyIncome()).toBeNull()
    series.push(0, 10, 3)
    series.push(200, 20, 7) // 玩家 1.0/s；敵方 0.4/s
    expect(series.playerIncome()).toBe(1)
    expect(series.enemyIncome()).toBe(0.4)
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

describe('chartDomain 共用值域', () => {
  it('空樣本回 null；min/max 取雙陣營合併，±10% 邊距', () => {
    expect(chartDomain([])).toBeNull()
    const domain = chartDomain([
      { tick: 0, player: 100, enemy: 200 },
      { tick: 100, player: 150, enemy: 180 },
    ])
    expect(domain?.min).toBe(100)
    expect(domain?.max).toBe(200)
    expect(domain?.bottom).toBeCloseTo(90, 6)
    expect(domain?.top).toBeCloseTo(210, 6)
  })

  it('樣本完全水平：top > bottom（不塌縮；除以 0 由 chartPoints 的 span ≥ 1 夾限保證）', () => {
    const domain = chartDomain([{ tick: 0, player: 50, enemy: 50 }])
    expect(domain !== null && domain.top > domain.bottom).toBe(true)
  })
})

describe('chartPoints 曲線座標', () => {
  it('空樣本回空陣列；x 在 0..1、y 隨水晶單調上升', () => {
    expect(chartPoints([], (p) => p.player)).toEqual([])
    const samples = [
      { tick: 0, player: 10, enemy: 90 },
      { tick: 100, player: 20, enemy: 90 },
      { tick: 200, player: 30, enemy: 90 },
    ]
    const points = chartPoints(samples, (p) => p.player)
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

  it('兩條線共用同一絕對值域（同一軸直接比較，不是各自歸一）', () => {
    const samples = [
      { tick: 0, player: 10, enemy: 200 },
      { tick: 100, player: 20, enemy: 200 },
      { tick: 200, player: 30, enemy: 200 },
    ]
    const player = chartPoints(samples, (p) => p.player)
    const enemy = chartPoints(samples, (p) => p.enemy)
    // 共用值域下，玩家線（10–30）整體壓在軸下方、敵方線（200）壓在軸上方。
    expect(player[2]!.y).toBeLessThan(0.5)
    expect(enemy[0]!.y).toBeGreaterThan(0.5)
    // 各自歸一的話玩家線會貼到頂（y = 1）——這正是要防的失真。
    expect(player[2]!.y).not.toBe(1)
    // 兩條線的 x 座標一致（同一時間軸）。
    expect(player[1]!.x).toBe(enemy[1]!.x)
  })

  it('樣本完全水平：y 不 NaN（值域至少 1）', () => {
    const points = chartPoints(
      [
        { tick: 0, player: 50, enemy: 50 },
        { tick: 100, player: 50, enemy: 50 },
      ],
      (p) => p.player,
    )
    expect(Number.isFinite(points[0]?.y)).toBe(true)
    expect(Number.isFinite(points[1]?.y)).toBe(true)
  })
})
