# auto-2d-px-rts

自動化 2D 像素風 RTS。玩家只調 Policy 滑桿、不下直接指令，觀察 AI 對手如何演化。

> **規格見 [`docs/SPEC.md`](docs/SPEC.md)** —— MVP 的唯一事實來源。
> 實作與規格衝突時以該文件為準。

## 技術棧

| 用途 | 工具 |
| --- | --- |
| 遊戲 | Vite、TypeScript（strict）、PixiJS 8、React 19、Zod、Zustand |
| 測試 | Vitest |
| 套件管理 | pnpm workspace |

## 快速開始

```bash
pnpm install   # 安裝所有 workspace 套件
pnpm dev       # 啟動 dev server 並自動開瀏覽器 (localhost:5173)
pnpm test      # 執行所有測試
pnpm lint      # oxlint
pnpm build     # 型別檢查 + 產出 dist
```

## 目錄結構

```
packages/
  shared/                 共用型別與常數（遊戲與測試都從這裡 import）
    src/constants.ts      TICK_RATE_HZ / TICK_INTERVAL_MS / MAP_SIZE
  game/
    public/data/          遊戲內容 JSON（MVP 階段的唯一資料來源）
    src/
      sim/                純邏輯模擬
      render/             PixiJS 渲染
      ai/                 傳統 AI（效用函數、行為樹、影響力地圖）
      data/               JSON 載入與 Zod 驗證
      ui/                 React UI 覆蓋層
```

## 分層規則

`sim / render / ai / data / ui` 完全分離：

- `sim` 不得 import PixiJS 或 React。
- `render` 必須是純 PixiJS，不得依賴 React。
- `ui` 只能透過 `render` 的 API 操作 PixiJS 物件。

這些規則由 `packages/game/src/architecture.test.ts` 自動把關 —— 它會掃描各層原始碼的
**執行期 import**（`import type` 不算，因為編譯後會被移除），違反即測試失敗。

## 模擬約束

- 固定 tick **20Hz**（`TICK_INTERVAL_MS = 50`）。
- 種子化 RNG，相同輸入必得相同輸出。
- AI 只用傳統演算法，禁止 LLM。
- 玩家只能調整 Policy 滑桿，不得對單位下直接指令。

## MVP 範圍

只做：1 種資源（藍水晶）、2 個單位（melee / ranged）、2 個建築（主堡 / 兵營）、
5 個 Policy 滑桿、1 張 32x32 地圖、1 個 AI 對手。

**不做**（MVP 驗證通過後才加）：裝甲、三資源、編輯器、平衡工具、元 AI、
反事實建議、統計檢定、像素風 uPlot。

## 資料來源

MVP 階段遊戲內容存在 `packages/game/public/data/` 的本地 JSON，
**不用** Postgres、Content Pack 或 CDN。
JSON 結構會按最終 schema 設計，方便日後遷移到 DB。

## 目前進度

- [x] Prompt 1 — 專案骨架：pnpm workspace、分層目錄、PixiJS 深灰留白畫布、
      TypeScript strict、Vitest、分層邊界測試。
- [x] Prompt 2 — `docs/SPEC.md`：MVP 規格（資源、單位、建築、經濟、
      5 個 Policy 滑桿、AI 三層、勝負、文字面板、JSON schema、不做清單）。
