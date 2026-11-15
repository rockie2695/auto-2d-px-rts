import { describe, expect, it } from 'vitest'

import { decodeTilesRle, encodeTilesRle } from './rle.ts'

describe('tiles RLE 編解碼', () => {
  it('全 0 地圖 roundtrip 後長度與內容一致', () => {
    const tiles = new Array<number>(1024).fill(0)
    const encoded = encodeTilesRle(tiles)
    expect(encoded.length).toBe(3) // 單一 run
    expect(decodeTilesRle(encoded)).toEqual(tiles)
  })

  it('交替圖形 roundtrip 一致', () => {
    const tiles: number[] = []
    for (let i = 0; i < 64; i += 1) {
      tiles.push(i % 2)
    }
    expect(decodeTilesRle(encodeTilesRle(tiles))).toEqual(tiles)
  })

  it('超過 u16 上限的 run 會切段，roundtrip 仍一致', () => {
    const tiles = new Array<number>(70_000).fill(1)
    const encoded = encodeTilesRle(tiles)
    expect(encoded.length).toBe(6) // 兩個 run（65535 + 4465）
    expect(decodeTilesRle(encoded)).toEqual(tiles)
  })

  it('超出 0–255 的值拒絕編碼', () => {
    expect(() => encodeTilesRle([256])).toThrow()
    expect(() => encodeTilesRle([-1])).toThrow()
  })

  it('count 為 0 的資料拒絕解碼', () => {
    expect(() => decodeTilesRle(new Uint8Array([0, 0, 0]))).toThrow()
  })
})
