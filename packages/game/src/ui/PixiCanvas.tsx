import { useEffect, useRef } from 'react'
import type { Application } from 'pixi.js'

import { MAP_SIZE } from '@auto-2d-px-rts/shared'

import { createGameApp, destroyGameApp } from '../render/pixiApp.ts'
import { pickTarget, screenToWorld } from '../render/hitTest.ts'
import { GameScene } from '../render/scene.ts'
import { computeViewport } from '../render/viewport.ts'
import { startGameSession } from '../session.ts'
import type { GameSession } from '../session.ts'
import { useUiStore } from './uiStore.ts'

/**
 * `<PixiCanvas>`（Prompt 9）：把 PixiJS 畫布掛到全螢幕容器，並啟動遊戲對局
 * （組合根 `session.ts`）。React 只負責生命週期與 UI 狀態：
 *
 * - canvas 建立/銷毀走 render 層的 `createGameApp`/`destroyGameApp`；
 *   Pixi 顯示物件（`GameScene`）同樣由 render 層擁有。
 * - 點擊：canvas 座標 → render 的 `screenToWorld`/`pickTarget`（Prompt 9.1：
 *   單位與建築都可點）→ zustand `select`（只寫 UI 狀態，不碰遊戲邏輯）。
 * - 選中目標經 `scene.setSelected`（render API）推回顯示層畫選取框；
 *   本元件不直接操作任何 Pixi 物件。
 */
export function PixiCanvas() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    let app: Application | null = null
    let session: GameSession | null = null
    let canvas: HTMLCanvasElement | null = null
    let unsubscribe: (() => void) | null = null
    // React 19 StrictMode 在開發期會掛載→卸載→再掛載；
    // 各個 await 點之間都要擋住已被卸載的情況。
    let disposed = false

    const handleClick = (event: PointerEvent): void => {
      if (canvas === null || session === null) return
      const snapshot = session.getSnapshot()
      if (snapshot === null) return
      const rect = canvas.getBoundingClientRect()
      const viewport = computeViewport(MAP_SIZE, rect.width, rect.height)
      const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top, viewport)
      // 建築佔地由 scene 的 defs 查表（建築快照無 w/h 欄位）。
      const sizeOf = (defId: string) => session?.scene.buildingSizeOf(defId) ?? null
      useUiStore.getState().select(pickTarget(snapshot, world.x, world.y, sizeOf))
    }

    void (async () => {
      try {
        const created = await createGameApp(host)
        if (disposed) {
          destroyGameApp(created)
          return
        }
        const gameScene = new GameScene(MAP_SIZE)
        created.stage.addChild(gameScene.root)
        const started = await startGameSession(created, gameScene)
        if (disposed) {
          started.stop()
          destroyGameApp(created)
          return
        }

        app = created
        canvas = created.canvas
        canvas.addEventListener('pointerdown', handleClick)
        session = started
        // 選取狀態（zustand）→ render API 的單向推入（畫選取框）。
        started.scene.setSelected(useUiStore.getState().selected)
        unsubscribe = useUiStore.subscribe((state) => {
          started.scene.setSelected(state.selected)
        })
      } catch (error) {
        // 內容/初始化失敗保留深灰畫布與錯誤訊息，不靜默降級（SPEC §13）。
        console.error('[game] 對局啟動失敗', error)
      }
    })()

    return () => {
      disposed = true
      if (unsubscribe !== null) {
        unsubscribe()
        unsubscribe = null
      }
      if (canvas !== null) {
        canvas.removeEventListener('pointerdown', handleClick)
        canvas = null
      }
      if (session !== null) {
        session.stop()
        session = null
      }
      if (app !== null) {
        destroyGameApp(app)
        app = null
      }
    }
  }, [])

  return <div ref={hostRef} className="game-canvas-host" />
}
