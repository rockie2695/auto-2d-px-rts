import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** publish 產出、要放上傳（現：寫入）的三件套。 */
export interface StoredPackFiles {
  /** pack.json 內容（含 packHash）。 */
  readonly packJson: string
  /** frames.json 內容（atlas 框架表）。 */
  readonly framesJson: string
  /** atlas.png 位元組。 */
  readonly atlasPng: Buffer
}

/**
 * pack 發布的儲存後端介面。
 * 現行 LocalDiskStorage（寫 Vite public 直服目錄）；
 * 日後 R2/S3 以同介面插入，pipeline 其餘部分不動。
 */
export interface Storage {
  /** 寫入某版本的 pack 三件套，回傳 pack.json 的 URL。 */
  putPack(version: string, files: StoredPackFiles): Promise<string>
}

/** repo 根目錄（`packages/server/src/export/` 往上四層）。 */
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)

/** 預設輸出根目錄：`packages/game/public/packs`（Vite public 直服）。 */
export const DEFAULT_PACKS_DIR = resolve(REPO_ROOT, 'packages/game/public/packs')

/**
 * 本地磁碟後端：寫 `<root>/{version}/`（version 已含 v 前綴，如 `v0`）
 * 並鏡像到 `<root>/latest/`。URL 約定：`/packs/{version}/pack.json`
 * （latest 由遊戲 loader 讀取）。
 */
export class LocalDiskStorage implements Storage {
  readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  async putPack(version: string, files: StoredPackFiles): Promise<string> {
    const versionDir = join(this.rootDir, version)
    const latestDir = join(this.rootDir, 'latest')
    for (const dir of [versionDir, latestDir]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'pack.json'), files.packJson)
      writeFileSync(join(dir, 'frames.json'), files.framesJson)
      writeFileSync(join(dir, 'atlas.png'), files.atlasPng)
    }
    return `/packs/${version}/pack.json`
  }
}
