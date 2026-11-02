import { create } from 'zustand'

/** 選中的目標（Prompt 9.1：單位或建築）。 */
export type SelectionTarget =
  | { readonly kind: 'unit'; readonly id: number }
  | { readonly kind: 'building'; readonly id: number }

/** 選取狀態：null = 未選取（點空白取消）。 */
export type Selection = SelectionTarget | null

/**
 * UI 狀態（規則 5：zustand 只出現在 ui 層，由 architecture.test.ts 把關）。
 * **只允許放 UI 狀態**（選中目標、面板開關），嚴禁放遊戲邏輯狀態 ——
 * 遊戲資料一律經 `session.ts` 的組合根取得。
 */
export interface UiState {
  /** 選中的單位／建築（含 kind 供面板與選取框分工）。 */
  selected: Selection
  /** 資訊面板是否展開。 */
  panelOpen: boolean
  /** 選取/取消選取目標（點地圖空白處傳 null）。 */
  select: (target: Selection) => void
  /** 開/關資訊面板。 */
  togglePanel: () => void
}

export const useUiStore = create<UiState>((set) => ({
  selected: null,
  panelOpen: true,
  select: (target) => set({ selected: target }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
}))
