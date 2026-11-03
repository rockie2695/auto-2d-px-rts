import { useEffect, useRef } from 'react'
import type { Application } from 'pixi.js'

import { MAP_SIZE } from '@auto-2d-px-rts/shared'

import { createGameApp, destroyGameApp } from '../render/pixiApp.ts'
import { pickTarget, screenToWorld } from '../render/hitTest.ts'
import { GameScene } from '../render/scene.ts'
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

    // 拖曳平移（Prompt 10.12）：超過 4px 門檻才算拖曳（否則視為點擊選取）。
    const DRAG_THRESHOLD_PX = 4
    let pointerDown = false
    let dragging = false
    let downX = 0
    let downY = 0
    let lastX = 0
    let lastY = 0

    const selectAt = (clientX: number, clientY: number): void => {
      if (canvas === null || session === null) return
      const snapshot = session.getSnapshot()
      if (snapshot === null) return
      const rect = canvas.getBoundingClientRect()
      // 打點用 scene 的相機（縮放／平移後仍精準）。
      const viewport = session.scene.viewportOf(rect.width, rect.height)
      const world = screenToWorld(clientX - rect.left, clientY - rect.top, viewport)
      const sizeOf = (defId: string) => session?.scene.buildingSizeOf(defId) ?? null
      useUiStore.getState().select(pickTarget(snapshot, world.x, world.y, sizeOf))
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      pointerDown = true
      dragging = false
      downX = lastX = event.clientX
      downY = lastY = event.clientY
    }

    const handlePointerMove = (event: PointerEvent): void => {
      if (!pointerDown || canvas === null || session === null) return
      if (!dragging) {
        const moved = Math.hypot(event.clientX - downX, event.clientY - downY)
        if (moved <= DRAG_THRESHOLD_PX) return
        dragging = true
        if (host !== null) host.style.cursor = 'grabbing'
      }
      const rect = canvas.getBoundingClientRect()
      session.scene.panBy(event.clientX - lastX, event.clientY - lastY, rect.width, rect.height)
      lastX = event.clientX
      lastY = event.clientY
    }

    const handlePointerUp = (event: PointerEvent): void => {
      if (!pointerDown) return
      pointerDown = false
      if (dragging) {
        dragging = false
        if (host !== null) host.style.cursor = 'grab'
        return
      }
      // 未拖曳 → 點擊選取。
      selectAt(event.clientX, event.clientY)
    }

    const handleWheel = (event: WheelEvent): void => {
      if (canvas === null || session === null) return
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
      session.scene.zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        factor,
        rect.width,
        rect.height,
      )
    }

    const handleDoubleClick = (): void => {
      session?.scene.resetView()
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
        canvas.addEventListener('pointerdown', handlePointerDown)
        canvas.addEventListener('pointermove', handlePointerMove)
        canvas.addEventListener('pointerup', handlePointerUp)
        canvas.addEventListener('wheel', handleWheel, { passive: false })
        canvas.addEventListener('dblclick', handleDoubleClick)
        if (host !== null) host.style.cursor = 'grab'
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
        canvas.removeEventListener('pointerdown', handlePointerDown)
        canvas.removeEventListener('pointermove', handlePointerMove)
        canvas.removeEventListener('pointerup', handlePointerUp)
        canvas.removeEventListener('wheel', handleWheel)
        canvas.removeEventListener('dblclick', handleDoubleClick)
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
