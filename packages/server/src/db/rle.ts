/**
 * tiles RLE 編解碼（`map_tiles.rle_data` bytea 的格式）。
 *
 * 格式：連續的三位元組組 `(value: u8, count: u16 little-endian)`，
 * 表示 value 重複 count 次。地圖 tiles 只含 0/1，通常壓縮率極高。
 */

const MAX_RUN_LENGTH = 0xffff

export function encodeTilesRle(tiles: readonly number[]): Uint8Array {
  const pairs: Array<[number, number]> = []
  for (const value of tiles) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error(`RLE 編碼僅接受 0–255 的整數，收到：${String(value)}`)
    }
    const last = pairs[pairs.length - 1]
    if (last !== undefined && last[0] === value && last[1] < MAX_RUN_LENGTH) {
      last[1] += 1
    } else {
      pairs.push([value, 1])
    }
  }
  const out = new Uint8Array(pairs.length * 3)
  let offset = 0
  for (const [value, count] of pairs) {
    out[offset] = value
    out[offset + 1] = count & 0xff
    out[offset + 2] = (count >> 8) & 0xff
    offset += 3
  }
  return out
}

export function decodeTilesRle(data: Uint8Array): number[] {
  if (data.length % 3 !== 0) {
    throw new Error(`RLE 資料長度必須是 3 的倍數，收到：${data.length}`)
  }
  const out: number[] = []
  for (let offset = 0; offset < data.length; offset += 3) {
    const value: number = data[offset]!
    const count: number = data[offset + 1]! | (data[offset + 2]! << 8)
    if (count === 0) {
      throw new Error(`RLE run length 不得為 0（偏移 ${offset}）`)
    }
    for (let k = 0; k < count; k += 1) {
      out.push(value)
    }
  }
  return out
}
