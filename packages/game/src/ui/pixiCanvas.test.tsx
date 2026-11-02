/**
 * @vitest-environment jsdom
 */

import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `<PixiCanvas>` 掛載測試（Prompt 9 驗收：掛載後 canvas 存在）。
 *
 * jsdom 沒有 WebGL，Pixi 初始化以 `pixiApp.ts` 的 mock 取代；
 * 對局啟動（content fetch）同樣以 `session.ts` 的 mock 隔離，
 * 專測 React 掛載行為：canvas 進入 DOM、卸載後移除、StrictMode 雙掛載不留孤兒。
 */

import { PixiCanvas } from './PixiCanvas.tsx'
import { startGameSession } from '../session.ts'

type FakeApp = { canvas: HTMLCanvasElement; stage: { addChild: () => void } }

function makeFakeApp(host: HTMLElement): FakeApp {
  const canvas = document.createElement('canvas')
  host.appendChild(canvas)
  return { canvas, stage: { addChild: vi.fn() } }
}

vi.mock('../render/pixiApp.ts', () => ({
  createGameApp: vi.fn(async (host: HTMLElement) => makeFakeApp(host)),
  destroyGameApp: vi.fn((app: FakeApp) => app.canvas.remove()),
}))

vi.mock('../session.ts', () => ({
  // 對局啟動假體：PixiCanvas 會讀 scene.setSelected 並註冊 store 訂閱，
  // 缺景物件會讓 boot 在 try/catch 內靜默失敗（假綠），故明確供給。
  startGameSession: vi.fn(async () => ({
    stop: vi.fn(),
    scene: { setSelected: vi.fn() },
    getSnapshot: vi.fn(() => null),
  })),
}))

/** 把已 resolve 的非同步連續 flush 掉（createGameApp → startGameSession）。 */
async function flushAsync(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function mount(): { unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <StrictMode>
        <PixiCanvas />
      </StrictMode>,
    )
  })
  return {
    unmount: () => {
      act(() => {
        root.unmount()
      })
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('<PixiCanvas> 掛載（Prompt 9）', () => {
  it('掛載後 canvas 存在，並啟動遊戲 session', async () => {
    const view = mount()
    await flushAsync()

    expect(document.querySelectorAll('canvas')).toHaveLength(1)
    expect(startGameSession).toHaveBeenCalled()
    view.unmount()
  })

  it('卸載後 canvas 從 DOM 移除', async () => {
    const view = mount()
    await flushAsync()
    expect(document.querySelectorAll('canvas')).toHaveLength(1)

    view.unmount()
    await flushAsync()
    expect(document.querySelectorAll('canvas')).toHaveLength(0)
  })
})
