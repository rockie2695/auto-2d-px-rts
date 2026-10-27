import { describe, expect, it } from 'vitest'

import { MAP_SIZE, TICK_INTERVAL_MS, TICK_RATE_HZ } from './constants.ts'

describe('模擬時序常數（規則 8）', () => {
  it('固定 tick 為 20Hz', () => {
    expect(TICK_RATE_HZ).toBe(20)
  })

  it('tick 間隔恰為 50ms，且由頻率推導而非各自寫死', () => {
    expect(TICK_INTERVAL_MS).toBe(50)
    expect(TICK_INTERVAL_MS).toBe(1000 / TICK_RATE_HZ)
  })
})

describe('MVP 地圖尺寸（規則 11）', () => {
  it('唯一地圖為 32x32', () => {
    expect(MAP_SIZE).toBe(32)
  })
})
