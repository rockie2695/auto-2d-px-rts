/**
 * @vitest-environment jsdom
 */

import { StrictMode, act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `<InfoPanel>` 標記測試（Prompt 10.17 驗收：點集結點／生產點看到名稱與說明）。
 * session 以 mock 隔離（只驗面板把 `getMarkerInfo` 的結果畫出來）。
 */

const BARRACKS_INFO = {
  kind: 'gather' as const,
  player: 'player' as const,
  tileX: 11,
  tileY: 11,
  title: '我方兵營出廠集合格',
  description: '新兵出廠後先到此格集結：測試說明',
}

/** 單位資訊（Prompt 3.1：含裝甲／有效HP／DPS 的完整欄位）。 */
const UNIT_INFO = {
  id: 7,
  defId: 'shield_guard',
  player: 'player' as const,
  hp: 96,
  maxHp: 120,
  tileX: 5,
  tileY: 5,
  decision: null,
  squadMission: 'defend',
  rangeTiles: 0.8,
  moveSpeedTilesPerSec: 2.0,
  armor: 0.5,
  effHp: 240,
  dps: 6,
}

vi.mock('../session.ts', () => ({
  getActiveSession: () => ({
    getMarkerInfo: (ref: { kind: string; player: string; buildingId: number }) =>
      ref.kind === 'gather' && ref.player === 'player' ? BARRACKS_INFO : null,
    getUnitInfo: (unitId: number) => (unitId === UNIT_INFO.id ? UNIT_INFO : null),
  }),
}))

import { InfoPanel } from './InfoPanel.tsx'
import { useUiStore } from './uiStore.ts'

let mounted: { container: HTMLElement; root: ReturnType<typeof createRoot> } | null = null

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<StrictMode>{node}</StrictMode>)
  })
  mounted = { container, root }
  return container
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  if (mounted !== null) {
    act(() => {
      mounted?.root.unmount()
    })
    mounted = null
  }
  document.body.innerHTML = ''
  useUiStore.getState().select(null)
  vi.useRealTimers()
})

describe('<InfoPanel> 標記（Prompt 10.17）', () => {
  it('選取出廠集合格標記 → 顯示名稱、陣營、座標與用途', async () => {
    const container = render(<InfoPanel />)
    act(() => {
      useUiStore
        .getState()
        .select({ kind: 'marker', marker: { kind: 'gather', player: 'player', buildingId: 1 } })
    })
    // 面板以 200ms 輪詢拉資料；推進假計時器觸發一次。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(container.textContent).toContain('我方兵營出廠集合格')
    expect(container.textContent).toContain('我方')
    expect(container.textContent).toContain('(11, 11)')
    expect(container.textContent).toContain('測試說明')
  })

  it('查無標記資訊 → 顯示「此物件已不存在」', async () => {
    const container = render(<InfoPanel />)
    act(() => {
      useUiStore
        .getState()
        .select({ kind: 'marker', marker: { kind: 'gather', player: 'enemy', buildingId: 2 } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(container.textContent).toContain('此物件已不存在')
  })

  it('選取單位 → 顯示 裝甲／有效 HP／DPS（Prompt 3.1；標籤固定「裝甲」）', async () => {
    const container = render(<InfoPanel />)
    act(() => {
      useUiStore.getState().select({ kind: 'unit', id: UNIT_INFO.id })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(container.textContent).toContain('裝甲')
    expect(container.textContent).toContain('50%（受到傷害 −50%）')
    expect(container.textContent).toContain('240')
    expect(container.textContent).toContain('6')
    // 禁用標籤：絕不出現「護甲」。
    expect(container.textContent).not.toContain('護甲')
  })
})
