/**
 * @vitest-environment jsdom
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { StrictMode, act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PolicyValues } from '../ai/policy.ts'

import { PREDICTION_SEED, PreGameView } from './PreGamePage.tsx'
import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import type { ContentPack } from '@auto-2d-px-rts/shared'

/**
 * 戰前準備頁 View（Prompt 10.5 完整版）：純 props 渲染——
 * 地圖預覽、六軸雷達、60 秒開局預測、Policy/節奏預設＋「開始對戰」。
 * content pack 改讀 public/data（避免相對 fetch 依賴 dev server）；
 * jsdom 的 import.meta.url 非 file: 協議——cwd 拼資料目錄。
 */

let pack: ContentPack | null = null

function contentPack(): ContentPack {
  if (pack === null) {
    const fromRoot = join(process.cwd(), 'packages', 'game', 'public', 'data')
    const dataDir = existsSync(fromRoot) ? fromRoot : join(process.cwd(), 'public', 'data')
    pack = loadContentPackFromDir(dataDir)
  }
  return pack
}

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
  document.body.innerHTML = ''
  mounted = null
})

afterEach(() => {
  if (mounted !== null) {
    act(() => {
      mounted?.root.unmount()
    })
    mounted = null
  }
})

describe('PreGameView（/pre-game；Prompt 10.5 完整版）', () => {
  it('渲染地圖預覽＋六軸雷達＋9 滑桿＋節奏下拉＋60 秒預測列表', () => {
    const container = render(
      <MemoryRouter>
        <PreGameView content={contentPack()} onStart={() => {}} />
      </MemoryRouter>,
    )
    // 地圖與雷達 canvas。
    expect(container.querySelector('[data-testid="pre-game-map"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pre-game-radar"]')).not.toBeNull()
    // 9 支滑桿＋節奏下拉（5 選、預設 standard）。
    expect(container.querySelectorAll('input[type="range"]')).toHaveLength(9)
    const tempo = container.querySelector('[data-testid="pre-game-tempo"]') as HTMLSelectElement
    expect(tempo.value).toBe('standard')
    expect(tempo.querySelectorAll('option')).toHaveLength(5)
    // 預測（同步 headless 計算，掛載即有）：列表非空＋摘要。
    const prediction = container.querySelector('[data-testid="pre-game-prediction"]')
    expect(prediction).not.toBeNull()
    expect(prediction?.children.length ?? 0).toBeGreaterThan(0)
    expect(
      container.querySelector('[data-testid="pre-game-prediction-summary"]')?.textContent,
    ).toContain('60 秒末水晶')
  })

  it('拖滑桿即時顯示草稿值；「開始對戰」把滑桿＋節奏整包上報（onStart）', () => {
    const started: Array<PolicyValues> = []
    const container = render(
      <MemoryRouter>
        <PreGameView content={contentPack()} onStart={(values) => started.push(values)} />
      </MemoryRouter>,
    )
    // 拖 aggression 0.5 → 0.9（草稿即時顯示）。
    const slider = container.querySelector(
      '[data-testid="pre-game-slider-aggression"]',
    ) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(slider, '0.9')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const output = slider.parentElement?.querySelector('output')
    expect(output?.textContent).toBe('0.90')
    // 切節奏 rush。
    const tempo = container.querySelector('[data-testid="pre-game-tempo"]') as HTMLSelectElement
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    act(() => {
      selectSetter?.call(tempo, 'rush')
      tempo.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // 開始對戰 → onStart 帶 12+1 維草稿（一次）。
    act(() => {
      ;(container.querySelector('[data-testid="pre-game-start"]') as HTMLButtonElement).click()
    })
    expect(started).toHaveLength(1)
    expect(started[0]?.aggression).toBe(0.9)
    expect(started[0]?.tempoPreset).toBe('rush')
    // 預測種子常量可注入（頁面與測試共用）。
    expect(PREDICTION_SEED).toBe(42)
  })
})
