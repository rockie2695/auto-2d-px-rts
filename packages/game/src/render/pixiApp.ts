import { Application, TextureSource } from 'pixi.js'

import { GAME_BACKGROUND_COLOR } from './constants.ts'

/**
 * 設定渲染預設值。必須在建立任何紋理之前呼叫。
 *
 * Pixi v8 的 `SCALE_MODES.NEAREST` 已棄用（呼叫會印 deprecation warning），
 * v8 的正式型別是字串 `SCALE_MODE = 'nearest' | 'linear'`。
 */
function applyRenderDefaults(): void {
  TextureSource.defaultOptions.scaleMode = 'nearest'
}

/**
 * 建立並初始化 PixiJS 應用程式。
 *
 * 這一層只依賴 pixi.js，不得 import React —— 由 ui 層負責掛載與生命週期。
 *
 * @param host 掛載 canvas 的 DOM 容器，必須已有實際尺寸
 */
export async function createGameApp(host: HTMLElement): Promise<Application> {
  applyRenderDefaults()

  const app = new Application()
  await app.init({
    background: GAME_BACKGROUND_COLOR,
    resizeTo: host,
    // 像素風：不做 MSAA，邊緣保持銳利
    antialias: false,
    // WebGL2 通吃性最佳；WebGPU 的差異留到之後需要時再評估
    preference: 'webgl',
  })

  host.appendChild(app.canvas)
  return app
}

/** 釋放畫布與 WebGL context（React StrictMode 開發期會反覆掛載）。 */
export function destroyGameApp(app: Application): void {
  app.destroy(true, { context: true })
}
