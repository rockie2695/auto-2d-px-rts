import { beforeEach, describe, expect, it } from 'vitest'

import { useUiStore } from './uiStore.ts'

/**
 * UI store 測試（Prompt 9 / 9.1）：zustand 只管理 UI 狀態
 * （選中的單位或建築、面板開關）。
 */

beforeEach(() => {
  useUiStore.setState({ selected: null, panelOpen: true })
})

describe('ui store（Prompt 9 / 9.1）', () => {
  it('select 設定選中的目標（{kind, id}）', () => {
    useUiStore.getState().select({ kind: 'unit', id: 7 })
    expect(useUiStore.getState().selected).toEqual({ kind: 'unit', id: 7 })
  })

  it('select 也能選建築（Prompt 9.1）', () => {
    useUiStore.getState().select({ kind: 'building', id: 3 })
    expect(useUiStore.getState().selected).toEqual({ kind: 'building', id: 3 })
  })

  it('select(null) 取消選取（點地圖空白處）', () => {
    useUiStore.getState().select({ kind: 'unit', id: 7 })
    useUiStore.getState().select(null)
    expect(useUiStore.getState().selected).toBeNull()
  })

  it('togglePanel 開關面板', () => {
    expect(useUiStore.getState().panelOpen).toBe(true)
    useUiStore.getState().togglePanel()
    expect(useUiStore.getState().panelOpen).toBe(false)
    useUiStore.getState().togglePanel()
    expect(useUiStore.getState().panelOpen).toBe(true)
  })

  it('select 不影響面板開關（正交的 UI 狀態）', () => {
    useUiStore.getState().togglePanel()
    useUiStore.getState().select({ kind: 'building', id: 1 })
    expect(useUiStore.getState().panelOpen).toBe(false)
  })

  it('狀態介面只有 UI 欄位，不得混入遊戲邏輯狀態', () => {
    expect(Object.keys(useUiStore.getState()).sort()).toEqual([
      'panelOpen',
      'select',
      'selected',
      'togglePanel',
    ])
  })
})
