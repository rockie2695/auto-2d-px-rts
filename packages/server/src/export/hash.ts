import { createHash } from 'node:crypto'

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * canonical JSON：物件 key 遞迴排序、陣列順序保留。
 * 同一份內容不管 jsonb key 順序／重組路徑為何，都會得到同一個字串，
 * hash 因此可跨 seed／publish／load 重現。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * packHash = sha256(canonicalJson(content) + atlasHash)。
 * 無 atlas 時 atlasHash 為空字串；任何內容或 atlas 變動都會改變 packHash。
 */
export function computePackHash(content: unknown, atlasHash = ''): string {
  return sha256Hex(canonicalJson(content) + atlasHash)
}
