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
pnpm sim       # 跑 1000 tick AI 戰略層 CLI（固定種子 42；--econMilitary=0 等覆寫滑桿）
pnpm sim:fight # 純模擬對打 CLI（無 AI，雙方推向中心接戰）
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
- [x] Prompt 3 — 資料 schema 與內容 JSON：`packages/shared/src/schema.ts`（Zod）、
      `packages/game/public/data/` 的 10 份內容檔、Zod 驗證測試（計數、
      id 交叉引用、地圖 180° 對稱）。
- [x] Prompt 4 — 模擬核心 `packages/game/src/sim/`：內容載入器、固定點移動、
      確定性 A\*、空間雜湊自動接戰、整數精確經濟（收入／建造／生產佇列）、
      放置 API、開局配置、`GameLoop`（20Hz 累加器）、`pnpm sim`（1000 tick CLI）、
      確定性與真實內容整合測試（56 個測試）。
- [x] Prompt 5 — 單一資源經濟：節點 `amount` 蘊藏量（採完礦場保留但收入歸零）、
      庫存上限 9999、`getResource(playerId)` API、逐礦整數精確結算、
      10 tick 入帳／生兵扣費／節點耗盡／上限 clamp 測試（60 個測試）。
- [x] Prompt 6 — AI 戰略層 `packages/game/src/ai/`：5 滑桿權重映射
      （`buildEcon = econMilitary × 2`）、建築效用（飽和度懲罰 + 零礦強制 3.0）、
      單位效用（counterMatrix 克制 + tier + 射程 + 稀缺性）、每 40 tick 雙軌決策
      （蓋一棟 + 生一兵）、`pnpm sim` 組合根 CLI 與滑桿覆寫、
      4 個滑桿驗收 + 克制／均攤／確定性測試（73 個測試）。
- [x] Prompt 6.5 — AI 決策記錄：每個戰略動作產出 `DecisionRecord`
      （tick/layer/actor/action/target + 候選分數/滑桿快照/topFactor/中文解釋），
      `ai/explain.ts` 規則式模板（`topFactor` 與文字同源、無 LLM）、
      `pnpm sim` 印最近 5 條決策記錄、
      200 tick 整合 + 非空解釋 + 同 seed 一致測試（88 個測試）。
- [x] Prompt 7 — AI 戰術層 `packages/game/src/ai/`：影響力地圖（8×8 tile 粗網格、
  `threat = Σ value × hp/maxHp / (1 + dist²)`、每 500ms 重算）、小隊編組
  （`squadCount`／`squadSize` 隨 `clusterSpread`）、任務 attack／defend／harass
  （`aggression` 決定比例、目標 = 價值高 × 防守弱 × 距離近）、撤退
  （戰力劣勢回集結點、`hp < retreatHpPct` 脫離戰鬥）、`pnpm sim` 可見集結／推進／撤退
  （113 個測試）。
- [x] Prompt 8 — AI 微操層 `packages/game/src/ai/micro.ts`（每 100ms＝2 tick）：
  單位行為樹（撤退／接戰風箏／編隊／待機），`retreatHpPct` 讀 JSON、
  風箏 `preferredRange × 0.7` 邊退邊打、集火（全隊打離小隊重心最近者）、
  隊形 slot、A* 每 500ms 重算；戰術層改為只產計畫、微操層是唯一下單者；
  `pnpm sim` 可見風箏、集火、撤退（127 個測試）。
- [x] Prompt 9 — 渲染層 `packages/game/src/render/`（Pixel 完美）：邏輯 20Hz／渲染 60fps、
  前後快照線性插值、`scaleMode: 'nearest'` + 整數縮放置中、32px tile 地圖色塊 +
  單位／建築色塊 + 血條（三段色）；`<PixiCanvas>`（React 生命週期 + zustand UI 狀態）、
  組合根 `session.ts`（fetch 內容 → 建世界 → `GameLoop.advance` + AI 三層掛 tick 邊界）、
  jsdom 掛載測試（152 個測試）。
- [x] Prompt 9.1 — 原地抖動修復 + 建築資訊：
  `stepMovement` 步長夾限（路徑重排後垂直首格 × 偏心座標造成每 tick ±1 步永久乒乓，
  修復後 800 tick 診斷由 2750+ 次歸零、回歸測試鎖定）；
  點擊建築顯示資訊（`pickTarget` 單位優先 → 建築、選取框描佔地、
  面板顯示 hp／施工進度%／佔地／座標，SPEC §5 有效 maxHp 折算）；
  接戰中偶發的微操 formation↔kite 互換（≈20 tick 週期）屬決策行為、非抖動 bug，
  留待後續 prompt 觀察（162 個測試）。
- [x] Prompt 9.4 — 閒置單位診斷修復 + 決策解釋：
  **近戰打不到建築**（根因：射程判定量「佔地格中心」，相鄰格固定距離 200 ＞
  近戰 160 → 攻擊建築永遠失敗、單位原地反覆下同令）——改為量**佔地外框邊緣**
  （相鄰 100 ≤ 160，diagonal 角 141 也在射程內），回歸測試鎖定；
  **傷兵永久停擺**（`hp < retreatHpPct` 被戰術層永久排除於小隊、無回血機制 →
  站集結點整場不動）——SPEC 變更：傷兵 round-robin 補進**守備隊**
  （attack／harass 不收），微操層撤退**抵達集結點後落回行為樹**（佔守備隊 slot、
  sim 自動接戰）；已在目的地且閒置不再重下移動令（省 A*、杜絕重複命令）；
  微操決策全部附中文 `reason`（面板點單位顯示「現在在想什麼」）。
- [x] Prompt 9.5 — 四角戰況 HUD：左上資源曲線（canvas 2D 自繪、我方水晶 60 秒
  滾動折線 2px 硬邊）、右上資源面板（雙方水晶＋收入速率、戰力比
  < 0.7 紅 / 0.7–1.4 黃 / > 1.4 綠）、左下 AI 決策日誌（戰略記錄＋戰術小隊
  變動，最新 5 條：時間 + 層級 + 動作 + 原因）、右下小隊狀態（一隊一行：
  任務 + 人數 + 戰力 + 距目標距離）；單一輪詢元件 `BattleDashboard`
  （250ms）＋純邏輯 `collector.ts`（120 點環 ＝ 60s、200 tick 窗收入估算）；
  `getBattleStats()` 一次取齊（183 個測試）。
