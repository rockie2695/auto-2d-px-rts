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
      session.ts          組合根（data + sim + ai + render 匯合；政策 API / 復盤）
      replay.ts           戰後復盤紀錄（純資料層，可重播）
      ui/                 React UI 覆蓋層（四角 HUD、政策面板、復盤頁）
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
- 種子化 RNG：**同一場內**相同輸入必得相同輸出（對局種子每場隨機、記錄進 replay 可重播）。
- AI 只用傳統演算法，禁止 LLM。
- 玩家只能調整 Policy 滑桿，不得對單位下直接指令。

## MVP 範圍

只做：1 種資源（藍水晶）、2 個單位（melee / ranged）、2 個建築（主堡 / 兵營）、
5 個 Policy 滑桿、1 張 32x32 地圖、1 個 AI 對手、戰後復盤頁（資源／單位／戰力曲線）。

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
  `getBattleStats()` 一次取齊（184 個測試）。
- [x] Prompt 10 — 政策滑桿 UI + 三項修正：
  **追擊分支**（SPEC §9.3 第 4 節補實作：射程外但 ≤ range + 1.0 格的敵人
  前壓接戰，修掉行軍中 0.84 格並行永不接戰；真實對局 1600 tick 觸發 456 次）；
  **開局 180° 點鏡射**（敵方佈局逐項鏡射玩家：nearest-first 平手裁決在鏡射下
  會反序，改先佔一邊再鏡射；地形/節點/建築/單位四層對稱測試）；
  **雙陣營資源曲線**（兩線共用絕對值域、各自收入估算，修正同一收入餵兩行的佔位 bug）；
  **政策面板**（底部中央可收合：5 滑桿、30 秒＝600 tick 冷卻由 session 強制、
  冷卻倒數禁用、AI 決策摘要、日誌新增 policy 層「此後決策受影響」）
  （201 個測試）。
- [x] Prompt 10 續 — 曲線首屏與滑桿操作修正：
  **雙線圖首屏可見**（掛載即取樣一次；敵方紅 3px 墊底、我方藍 2px 疊上——
  開局雙方經濟對稱兩線重疊時呈「藍芯紅邊」仍可辨識；線尾 3×3 色點）；
  **y 軸數值**（`chartDomain` 共用值域單一真相、3 格線標整數，即時圖與復盤圖共用）；
  **政策滑桿改草稿模型**（拖動只改草稿不觸發 session、「套用變更（N 項）」整包送出、
  「還原」回復變更前——根治拖動連續 onChange 只第一步生效的斷裂體驗）。
- [x] Prompt 10.5 — 戰後復盤頁（MVP）：
  結束偵測（keep 被毀／超時／手動「結束並復盤」）、勝負判定
  （一方被毀 → 對方勝、雙殺或水晶同數平手、超時比水晶）、
  `ReplayRecord`（每 20 tick 雙陣營資源＋存活單位數取樣、政策變更事件、
  `parseReplay` JSON 驗證）、`/post-game` 頁（勝負＋時長＋最終資源＋
  全程資源曲線＋單位數量曲線＋Policy 調整時間軸，props 純渲染
  不依賴即時 sim）、App state 路由切換與「再來一場」。
  **結束條件修正**：一方全滅（無建築且無單位）也結束（SPEC §11.2）；
  `stop()` 改 identity 檢查——修掉 StrictMode 雙掛載下舊 session 晚停
  誤拔 `activeSession`、對局結束後頁面永不切復盤頁的 bug；
  **撤退邊退邊打**（SPEC §9.3 變更：撤退途中射程內敵人保持為攻擊目標、
  移動仍朝集結點，不再是清空目標的靜默撤退）；
  **主動防禦與經濟保護**（SPEC §8.7：敵軍進入建築守備半徑 6 格 → 守備隊
  攔截來襲敵軍重心、平手優先水晶礦場；全軍出擊時拉回最近攻擊隊；
  戰略層壓境時生產 +1.0 防守加權，重經濟也持續產兵回防）；
  **圖表三指標切換**（左上面板下拉選單：資源曲線／單位數量／戰力，
  皆雙陣營 60 秒滾動兩線；`BattleStats` 新增雙方存活單位數）；
  **團隊協同強化**（SPEC §9.2/§9.3 變更：就近聚類重編組——同區域的兵同隊、
  行軍成團；集結再攻——鬆散攻擊隊先聚攏 5 格集結點再衝目標；斬殺集火——
  集火半徑 8 格內優先打 hp% 最低敵人；角色編隊——近戰內環、遠程外環）；
  **脫戰回血**（SPEC §10 變更：每秒評估、脫戰 3 秒後 hp +1/秒、上限 maxHp）；
  **追擊支援**（單兵不追風箏遠程，需 4 格內有友軍支援才包夾）；
  **交戰評估**（SPEC §9.2/§8.7 變更：`ENGAGE_POWER_RATIO` 0.9——打不贏守軍
  attack 降級 harass、harass 降級 defend；攔截打不贏來襲群改守建築等支援）；
  **公平性與可視化**（戰鬥改同時結算消除 id 先手優勢＋幾何掃描序鏡像
  （rally/編隊/建築/節點紅藍互為鏡像）＋每場隨機種子並記錄進 replay＋
  鏡像對稱測試；後期呆滯修復——全員殘血時傷兵也編隊、附近無敵不撤退；
  攻擊動畫（近戰揮擊＋受擊閃光、遠程飛行彈丸）；日誌 20 條可捲動；
  三面板標題列可拖曳；上方中央遊戲時鐘）；
  **超時判定修訂**（SPEC §11 變更：10:00 雙主堡俱在 → 一律平手，不比水晶）；
  **復盤頁戰力曲線**（replay 加 powerSeries 取樣，復盤頁三張圖：
  資源／單位數量／戰力）；
  **公平性收尾與對局多樣性**（SPEC §9.4/§6/§8.3 變更：A\* 鏡像鄰居序、
  生產出廠格鏡像座標系搜尋、命運抽籤 fate(seed⊕tick) 讓軍種組成因對局而異——
  24 隨機種子全 AI 對局 11 藍／13 紅 ≈ 平衡）；
  **視角與輸入**（SPEC §12 變更：地圖預設完整入鏡——視窗再小也整張可見，
  不再被切掉；畫布拖曳平移、滾輪以游標為中心縮放、雙擊重置視角；
  縮放／平移後點選仍精準）
  （264 個測試）。
- [x] Prompt 10.13 — 集結／生產點、編組穩定與公平性回歸：
  **集結點與生產點**（SPEC §9.2 變更：集結點威脅感知——無威脅在 keep 旁、
  有威脅往受威脅建築方向前移；新增生產點＝集結點往主目標前移 4 格，
  未編隊新兵先到生產點集合；地圖標記渲染——集結點方形／生產點菱形、
  分陣營上色）；
  **等價路徑抽選**（SPEC §9.4 變更：A\* 同 f 值前緣改以 `hashFate` 鹽抽選——
  路徑長度不變、走位多樣；鹽取正規化（藍方）起點＋tick，鏡射查詢同值不破公平）；
  **編組穩定**（SPEC §9.3 變更：k-means warm start——以前一循環群心為種子；
  遲滯裕度 2 格——邊界單位在「最近距離＋裕度」內留原隊不乒乓；**修正群索引
  空間**——小隊索引改以 group index 為鍵（空群不再壓縮位移），修掉紅藍空群
  時機不同造成的系統性偏差——24 種子全 AI 對局回到 11 藍／13 紅平衡）；
  **騷擾脫離**（SPEC §9.3 變更：騷擾隊遇「附近敵威脅 > 我隊戰力 × 0.9」
  往反方向脫離、不硬拼）；
  **HP 撤退分級**（SPEC §9.3 變更：< 10% 一律回家；10–50% 僅在附近敵優勢時退；
  JSON `retreatHpPct` 0.2 → 0.5）；
  **接戰可視化**（持續淡色接戰線＋3px 開火線＋12×12 受擊閃光，`ATTACK_FX_MS` 200）；
  **單位資訊**（資訊面板新增射程（格）與移動速度（格/秒））；
  **影響力格心修正**（格心改固定點中點，維持紅藍鏡射對稱）；
  回歸測試鎖定群索引空間與路徑抽選鏡像（275 個測試）。
- [x] Prompt 10.14 — 種子活化、建築受害者可視化與公平性測試：
  **種子活化**（SPEC §8.3/§9.4 變更：`world.seed` 真正參與命運雜湊——A\* 等價
  路徑抽選鹽改 `hashFate(seed, 正規化（藍方）起點.x, .y, tick)`、生產軌命運值改
  `hashFate(seed, tick)`；修掉「種子 42/7/555 三場逐字相同」的抽籤退化——
  不同種子真的走出不同對局；同場兩側同值，鏡像對稱不破）；
  **建築受害者可視化**（SPEC §12.1 變更：開火特效與持續接戰線的受害者查詢
  `victimOf` 擴充建築——線端點 = 佔地外框最近點，修掉「單位在打建築但畫面上
  什麼都沒有」的觀感 bug）；
  **自動接戰迴歸測試**（射程內有敵單位／敵建築必掉血、顯式射程外目標不擋
  自動接戰，全程不呼叫 AI——鎖住模擬層無條件自動接戰）；
  **公平性對戰序列測試**（新 `match/fairness.test.ts`：12 種子完整對局進
  `pnpm test`——同種子重跑逐字相同、跨種子 ≥ 3 種結果簽名、任一方勝場 ≤ 9、
  每場雙方都實際造成傷害；種子活化後 12 種子量測 7 藍 / 4 紅 / 1 平）。
  （283 個測試）。
- [x] Prompt 10.15 — 接觸重評估、夾擊呼叫與小隊撤退火力：
  **接觸重評估 W1**（SPEC §9.2 變更：敵人進小隊重心 6 格算接觸，新接觸且過
  60 tick 冷卻 → `canKillGroup` 重新評估——殺得掉 `engaging = true`、目標改敵群
  重心格主動迎戰，殺不掉維持原命令；`engaging` 以群 index 沿續避免循環間失憶，
  事件進決策日誌「遭遇敵軍…重新評估 → 迎戰／維持原命令」）；
  **夾擊呼叫 W2**（受襲殺不掉的小隊向 12 格內殺得掉的友隊求援，最多 2 隊，
  自敵群重心 3 格**不同方位**繞後接近——**敵方方位向量取負**維持鏡射對稱，
  修掉 pairProbe t=211 的接觸後位置分叉）；
  **小隊撤退火力 W2**（新微操動作 `fallback`：戰術層判退的小隊邊退邊打，
  撤回集結點等待支援）；
  **追擊退閘**（24 種子量測顯示「追擊需 AI 迎戰決策」閘門系統性偏藍
  16/3/5 → 14/7/3——退掉閘門，接觸重評估只驅動小隊目標與夾擊；退閘後
  11 藍 / 7 紅 / 6 平，決出局比 11:7 在噪音範圍內）。
  （284 個測試）。
