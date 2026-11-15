/**
 * pack hash 的共用演算法（server publish 與遊戲 loadPack 兩端必須完全同源）。
 * hash = sha256(canonicalJson(content) + atlasHash)，sha256 走 WebCrypto
 * （Node 22 與瀏覽器皆有 globalThis.crypto.subtle）。
 */

const textEncoder = new TextEncoder()

/**
 * canonical JSON：物件 key 遞迴排序、陣列順序保留。
 * 同一份內容不管 jsonb key 順序／重組路徑為何，都會得到同一個字串。
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

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(text))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * packHash = sha256(canonicalJson(content) + atlasHash)。
 * 無 atlas 時 atlasHash 為空字串；任何內容或 atlas 變動都會改變 packHash。
 */
export async function computePackHash(content: unknown, atlasHash = ''): Promise<string> {
  return sha256Hex(canonicalJson(content) + atlasHash)
}
