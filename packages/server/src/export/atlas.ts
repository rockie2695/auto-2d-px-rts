import sharp from 'sharp'

import type { PackFrames } from '@auto-2d-px-rts/shared'
import { PackFramesSchema } from '@auto-2d-px-rts/shared'
import { Client } from 'pg'

import { sha256HexSync } from './hash.ts'

/** atlas 合成的單一 sprite 輸入（佔位色塊：MVP render 不消費 atlas）。 */
export interface AtlasSpriteInput {
  readonly id: string
  /** `#rrggbb`（HexColorSchema 已驗證的值才可傳入，會放進 SVG 屬性）。 */
  readonly color: string
  /** 邊長 px。 */
  readonly size: number
}

/** shelf packing 的最大 atlas 寬度；超寬換下一層擱板。 */
const MAX_WIDTH = 512
const GAP = 2

/**
 * 把 sprites 合成單張 PNG atlas（色塊方塊）＋框架表。
 * 簡單 shelf packing：依輸入順序排一列，超出 MAX_WIDTH 換行。
 * atlasHash = sha256(PNG bytes)；同一組輸入必得同一張圖與同一 hash。
 */
export async function buildAtlas(
  sprites: readonly AtlasSpriteInput[],
): Promise<{ png: Buffer; frames: PackFrames }> {
  if (sprites.length === 0) {
    throw new Error('sprites 為空，無法合成 atlas')
  }

  interface Placed {
    readonly id: string
    readonly x: number
    readonly y: number
    readonly size: number
  }
  const placed: Placed[] = []
  let x = GAP
  let y = GAP
  let shelfHeight = 0
  for (const sprite of sprites) {
    const size = Math.max(1, Math.round(sprite.size))
    if (x + size + GAP > MAX_WIDTH) {
      x = GAP
      y += shelfHeight + GAP
      shelfHeight = 0
    }
    placed.push({ id: sprite.id, x, y, size })
    x += size + GAP
    shelfHeight = Math.max(shelfHeight, size)
  }
  const width = MAX_WIDTH
  const height = y + shelfHeight + GAP

  const colorOf = new Map(sprites.map((sprite) => [sprite.id, sprite.color]))
  const composites = placed.map((frame) => ({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.size}" height="${frame.size}">` +
        `<rect width="${frame.size}" height="${frame.size}" fill="${colorOf.get(frame.id)}"/>` +
        `</svg>`,
    ),
    left: frame.x,
    top: frame.y,
  }))
  const png = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png()
    .toBuffer()

  const atlasHash = sha256HexSync(png)
  const frames = PackFramesSchema.parse({
    schemaVersion: 1,
    atlasHash,
    width,
    height,
    frames: placed.map((frame) => ({
      id: frame.id,
      x: frame.x,
      y: frame.y,
      w: frame.size,
      h: frame.size,
    })),
  })
  return { png, frames }
}

/**
 * 從 DB 讀取某 pack 的 sprites（seed 產生的佔位色塊），
 * 按 sprite_id 排序（與 atlas 內容順序穩定綁定）。
 */
export async function readPackSprites(
  databaseUrl: string,
  packId: string,
): Promise<AtlasSpriteInput[]> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const rows = await client.query(
      'select sprite_id, data from sprites where pack_id = $1 order by sprite_id',
      [packId],
    )
    return rows.rows.map((row) => {
      const data = row['data'] as { color: string; size: number }
      return { id: row['sprite_id'] as string, color: data.color, size: data.size }
    })
  } finally {
    await client.end()
  }
}
