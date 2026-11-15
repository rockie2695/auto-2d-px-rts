import { createHash } from 'node:crypto'

// canonical hash 演算法以 shared 為單一事實來源（publish 與遊戲 loadPack 同源）。
export { canonicalJson, computePackHash } from '@auto-2d-px-rts/shared'

/** 同步 sha256（server 端專用：atlas PNG 位元組 hash 用 node:crypto）。 */
export function sha256HexSync(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}
