import { useEffect, useRef } from 'react'
import type { Application } from 'pixi.js'

import { createGameApp, destroyGameApp } from '../render/pixiApp.ts'

/**
 * 把 PixiJS 留白畫布掛到全螢幕容器上。
 *
 * React 負責生命週期，Pixi 物件一律由 render 層建立與銷毀；
 * 這裡只用型別 import，不產生對 pixi.js 的執行期依賴。
 */
export function GameCanvas() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    let app: Application | null = null
    // React 19 StrictMode 在開發期會掛載→卸載→再掛載，
    // 必須擋住尚未 resolve 就已被卸載的情況，否則會留下孤立的 WebGL context。
    let disposed = false

    void createGameApp(host)
      .then((created) => {
        if (disposed) {
          destroyGameApp(created)
          return
        }
        app = created
      })
      .catch((error: unknown) => {
        // WebGL 不可用時保留 CSS 深灰背景，畫面不會變白
        console.error('[render] PixiJS 初始化失敗', error)
      })

    return () => {
      disposed = true
      if (app !== null) {
        destroyGameApp(app)
        app = null
      }
    }
  }, [])

  return <div ref={hostRef} className="game-canvas-host" />
}
