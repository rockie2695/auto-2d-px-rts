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
      `packages/game/public/data/` 的內容檔（Prompt 10.16 起 11 份）、Zod 驗證測試（計數、
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
- [x] Prompt 10.16 — 防禦塔（唯一會攻擊的建築）：
  **`tower` 建築與 schema `defense`**（SPEC §5：700 hp／150 成本／20 s／2×2，
  `defense {dmg: 10, range: 4.0, attackSpeed: 0.5}`——schema 新增**選用** `defense`
  欄位；**只有帶此欄位且已完工的建築會攻擊**，keep/barracks/crystal_mine 永遠不攻擊）；
  **只打單位不打建築**（SPEC §10：射程內最近敵方單位，顯式 `targetId` 優先，
  傷害進 §2.3 同一批同時結算；建築 `attackAcc`／`targetId` 進快照）；
  攻城仍只能靠單位（塔不會拆塔、不會拆家）；
  **AI 每方上限 2 座**（`TOWER_CAP`；帶 `defense` 的建築飽和度 = 數量/2）；
  **開火特效**（SPEC §12.1：快照 diff 偵測 `building.attackAcc` 掉落，發射線起點
  = 建築外框最近點；有目標的塔同時畫持續接戰線）；內容檔 3→4 個建築（共 11 份）、
  塔模擬層測試（完工才攻擊／無 defense 不攻擊／只打單位）。
  （288 個測試；塔加入後 24 種子量測 7 藍 / 8 紅 / 9 平）。
- [x] Prompt 10.17 — 集結點前移、移動意圖線與可點擊標記：
  **集結點前移（W4，SPEC §9.2 變更）**：`rallyPoint` 無威脅時由自家 keep 往**雙方
  keep 中點**方向前移 1/3（`RALLY_FORWARD_DIV`；正規化座標計算 → 紅藍集結點精確
  互為鏡像，回歸測試鎖定），待命部隊前推到中線待命、更早接觸；受威脅時仍由此
  預設點往威脅方向壓近；
  **移動意圖線（SPEC §12.1）**：有路徑的單位畫一條極淡細線（alpha 0.12）到路徑
  終點格心——與接戰線（0.28）／開火亮線三種意圖分層可讀；
  **可點擊標記（SPEC §12.1）**：集結點／生產點可點選（拾取優先權
  單位 → 建築 → 標記），點中描亮框、資訊面板顯示名稱與用途
  （`session.getMarkers`／`getMarkerInfo`）。
  （294 個測試；W4 後 24 種子量測 8 藍 / 11 紅 / 5 平，12 種子公平性測試
  3 藍 / 6 紅 / 3 平，任一方 ≤ 9 通過）。
- [x] Prompt 10.18 — 攻勢優勢加權與攻城收尾（修「有優勢卻全在守／待命」）：
  **病灶定位**（探測 seed 42：藍 6 單位／戰力 8640 vs 紅 0 單位，仍拖到 12,000 tick
  平手）——兩個獨立成因：①任務分配只看固定 `aggression`，敵方無兵也照樣半數守家；
  ②**攻城卡死**：接近格取「建築中心最近可走格」常落在對角（距外框 0.99 格 >
  近戰 0.8 格），部隊站定後 sim 打不到、微操也不再靠近；另有一個 `path = []`
  永久凍結（`stepMovement` 跳過不清理、`shouldIssueMove` 也不再下單）；
  **攻勢優勢加權**（SPEC §9.2）：敵方**已無單位** → 加成 1.0（全軍出擊收尾）、
  我方戰力比 > 1 → 加成 `min(0.6, (ratio−1)×0.5)`（優勢越大越少兵力守家）；
  **攻城接近格**（SPEC §9.2/§9.3）：`siegeApproachTile` 取與佔地正交相鄰（射程內）
  的可走格，戰術層接近點與微操編隊分支都用它；
  **空路徑不凍結**（SPEC §9.4）：空路徑視同無路徑（清 `path`／`dest`）；
  端到端回歸測試（無守軍敵堡必被攻破；敵方 0 單位 → 全軍攻擊）。
  （301 個測試；24 種子量測 **11 藍 / 12 紅 / 1 平**、12 種子 5 藍 / 6 紅 / 1 平，
  平手由 5 降到 1——僵局收斂）。
- [x] Prompt 10.19 — 標記語義修訂：每間生產建築一個「出廠集合格」，陣營級集結點
  轉為 AI 內部概念（不再顯示）：
  **緣起**——玩家只關心「這間建築出的兵會先到哪」；原「生產點」是陣營級單點、
  又與集結點並列顯示，語義混淆；
  **per-building 出廠集合格**（SPEC §9.2）：`TacticalPlan.spawns`（每間
  `produces` 非空的已建成建築一筆 `{buildingId, tile}`，由建築中心往主目標前移
  約 4 格）；新兵「未編隊」分支前往**最近一間**生產建築的點，AI 就近聚類編組
  不受影響（本來就不看標記）；
  **鏡射修復（偶數尺寸建築）**——2×2 兵營的中心 px 固在**格邊界**，紅方若獨立
  對鏡射 px 取 floor 會翻到錯邊的格（藍標記 (9,24) ↔ 紅落到 (22,8) 而非 (22,7)，
  session 測試發現）；改為**由正規化格鏡射而來**（紅方真格＝31−正規化格）；
  **UI**——`MarkerRef`／`MapMarker`／`UiMarkerRef` 加 `buildingId`（同一陣營多間
  兵營可分別點選），面板顯示「我方／敵方 ○○出廠集合格」；集結點仍為 AI 內部的
  守備站位／撤退目的地，只是不再畫在圖上。
  （303 個測試；24 種子量測 11 藍 / 12 紅 / 1 平；鏡射探測 pairProbe 363 檢查
  0 mismatch。）
- [x] Prompt 10.20 — 決策日誌陣營色 + 篩選：
  **陣營色帶**——每列左側 3px 色帶（藍＝我方 `player` `#7ec7ff`、紅＝敵方
  `enemy` `#ff9f7a`，與小隊列表同色板）；
  **篩選片**——標題列下方一排小按鈕（藍／紅 × 戰略／戰術／政策，兩組各一項，
  「全部」預設；選中加深），**先篩選再取最近 20 條**（單一陣營刷版不把另一陣營
  擠出視野）；無結果顯示「尚未有決策」。
  **資料層不變**——篩選是面板元件內部 state；session／replay／`LOG_LIMIT`
  （32）都不動，純 UI 任務。
  （313 個測試；面板測試 +4：陣營 class、篩選計數、篩選後仍 20 條、空結果。）
- [x] Prompt 10.21 — 攻擊波次門檻 + 多點蓄兵 + 同時多路進攻：
  **蓄兵（mission `stage`，集結待戰）**——未達出擊門檻的進攻／騷擾隊不再添油，
  回**最近一間自家生產建築的出廠集合格**成結（無生產建築退回集結點）；同一蓄兵
  錨格的 stage 隊組成 cohort **共享門檻**：`cohort 戰力×1e6 ≥ 守備 powerMilli
  × waveRatioMilli(policies)`（`round(lerp(550, 1100, clusterSpread))`，散兵快打
  ↔ 集結總攻）且合併交戰評估判殺得掉守軍；成軍後**同一循環多路一起出擊**，
  不同 cohort／不同隊可同時打不同位置與不同目標——單隊兵力上限
  （clusterSpread 決定 4..18）不再死鎖。已投入戰場（重心離目標 ≤ 8 格或
  上一循環迎戰）不中途翻 stage，改走既有 10.8 降級鏈（attack→harass→defend）。
  **CRITICAL_HP_PCT 0.1→0.2**：殘血 < 20% 一律撤回集結點。
  （309 個測試；24 種子量測 **11 藍 / 12 紅 / 1 平**，與 10.18/10.19 基線一致；
  stage 機制紅藍雙側皆真實觸發；pairProbe 363 檢查 0 mismatch。）
- [x] Prompt 10.22 — A* 移動查詢全正規化（藍方）座標（修 10.18 起的格邊界鏡像缺陷）：
  **緣由**——單位 px 恰停在**格邊界**時 `tileOf` 取格在鏡射側翻錯邊（藍佔
  (10,28)、紅鏡像 px 4400 卻取到 (22,3) 而非 (21,3)），兩側 A* 起點差一 → 同
  迴圈給出長度差一的路徑（fullMirrorProbe 實測 tick 200 path 11 vs 12；
  **乾淨 HEAD 同樣分叉，非 10.21 引入**）。同族缺陷另兩處：小隊重心／接觸
  迎戰格（tileOfMeanPx）、微操追擊目的地與風箏反向（mirrorTileOf）。
  **修法**——紅方一律在正規化座標取格再鏡回（orderMove 起終點、戰術層均值格、
  micro 的重下單/追擊/風箏判定），藍紅對鏡像局面做**同一查詢**。
  **驗證**——fullMirrorProbe 800 tick **0 mismatch**（修前 200 tick 即分叉）、
  pairProbe 363／saltMirrorProbe 363 皆 0 mismatch、309 測試全過、12 種子
  公平門通過。
  **已知副作用（後續平衡任務）**——鏡像決策逐格一致後，完美鏡像對局僵持至
  超時：24 種子平局 **1 → 12**（9 藍 / 3 紅 / 12 平）。此前紅藍路徑長度差
  帶來的對稱性雜訊反而是破局來源；現行破局噪聲僅剩**單位 id 序**（聚類種子、
  集火平手），且集中有利藍方（9:3）。公平門（任一側 ≤ 9 勝）仍過。

- [x] Prompt 10.23 — 突變期確定破局＋超時總價值裁定＋鏡像清掃（收 10.22 副作用）：
  **緣由**——10.22 後鏡像自戰恆平局（探針延至 12010 tick 後 24 種子 **0/0/24 全平**，
  完美鏡像交戰逐對同 tick 互滅——平局是鏡像自戰的數學必然）。實作三件套：
  1. **鏡像清掃**：共享助手 `mirrorSafeTileOf`（紅方先 canonical 取格再鏡回）接進
     影響力圖（威脅建築中心／來襲重心）、`pickTarget`、微操四處；修 `rallyPoint`
     威脅前移中點的**捨入不對稱**（奇數座標和時 `.5` 進位紅藍反向，紅集結點多
     1 格，tick 1352 分叉）——修後 fullMirrorProbe 7200 tick **0 mismatch**。
  2. **突變期**：`tick ≥ 7200` 出兵門檻每 1200 tick ×0.75 遞減（1000→750→563→422）、
     `tick ≥ 10800` stage 停用全軍出擊；**破局相位差**——各陣營以
     `hashFate(種子，錨點，陣營)` 獨立抽 0..1200 tick 啟動相位（無偏側、可復現），
     紅藍錯開 → 非對稱首接觸撕開鏡像；7200 前鏡像探針維持 0 mismatch。
  3. **超時總價值裁定**：超時且雙主堡俱在 → 水晶＋單位／建築殘值
     （`cost × hp ÷ 有效最大 hp`）多者勝、嚴格相等才平手；手動提前結束仍平手。
  **驗證**——320/320 測試全過（新增超時值裁定、`matchSideValue`、
  `suddenDeathLogText`、突變期階段／乘數／相位差測試）、tsc＋oxlint 乾淨、
  12 種子公平門通過、24 種子 tally **11 藍 / 8 紅 / 5 平**（0/0/24 → 5 平；
  距 draw ≤ 4 目標差一場）、pnpm dev 200。
  **已知殘留（Prompt 10.24 候選）**——5 平局的共通點：keep 全程未損、終局僅剩
  1~2 兵在射程外 `tgt=null` 對峙（sim 自動接戰 0.8 格觸發不了、追擊 margin 不
  覆蓋），戰略層旋鈕（相位窗／起點／步距）實測皆不可及，需微操層收口。

- [x] Prompt 10.24 — 合併四件套：建築預備金＋塔前置＋攻擊特效修復＋受火反應與求援收口：
  **緣由**——四個實測根因：①建築軌／生產軌零預算協調，t120 後水晶永遠在 9~49
  震盪、塔卡 1/2 兵營 2/3（150~200 永遠買不起）；②開火特效判據
  `before.attackAcc ≥ 1` 只在閒置封頂後首發成立——持續交戰的逐發彈道全部丟失，
  塔特效與接戰線還依賴 sim 恆為 null 的 `building.targetId`，從未畫出；③塔開火
  對 AI 完全不可見（接觸／夾擊只掃 `world.units`），守備隊站樁被點射到死；
  ④被打但打不到的單位直接落到編隊分支站樁挨打（`!atRally` 豁免讓集結點上的
  傷兵也不撤）。
  1. **建築預備金（A）**：買不起的建築候選**不再剔除**（`affordable` 標記保留）；
     生產軌採**衝刺閾值**——下一個建築目標造價 `cost`，當前水晶 ≥ `cost × 0.5`
     才鎖下全額、否則照常產兵（「產兵幾循環 → 攒滿 → 蓋建築」自然交替）。
     全額常鎖版實測 t2000~t6000 雙方 **0 單位**、24-seed 1/1/22 全崩——衝刺版
     塔滿 2/2、兵營 3/3 且軍力節奏正常。
  2. **塔前置（B）**：帶 defense 的建築錨點朝敵方 keep **符號位移**
     `TOWER_FORWARD_TILES = 1` 格（sign 在鏡射下嚴格翻轉、無捨入——避開
     10.23 rallyPoint 的 `.5` 進位類缺陷）；敵 keep 滅 → 退回 keep 中心。
     實測 3 格 → 24-seed **24 全平**（塔進中路，雙方攻勢被塔火反覆拉回）、
     1 格 → 12-seed 5 藍/4 紅/3 平（門內）且塔位紅藍逐格鏡像。
  3. **攻擊特效修復（C，純 render 零 sim 改動）**：新檔 `render/attackFx.ts`
     （`firedThisTick`／`towerVictimOf` 純函式、不 import pixi）——開火判據改
     `after.attackAcc < before.attackAcc`（attackAcc 單調增、僅開火 −1 →
     持續交戰逐發可偵測）；塔受害者由渲染層現算（射程內最近敵單位、平手取
     id 小者——不在 sim 設 `building.targetId`，避免 id 平手破壞鏡像探針）。
  4. **受火反應＋求援（D）**：微操層——受火（hp<max 且 `tick−lastCombatTick ≤ 60`）
     非攻城時：塔火壓制（非攻城目標）→ 背離塔心脫離；打得到攻擊者
     （≤ `range+3`，有支援）→ 貼身；打不到 → 脫離不站樁；攻城換血豁免照舊。
     戰術層——塔火進入接觸評估（射程覆蓋小隊重心視為接觸、威脅 =
     `dmg×attackSpeed×1000` 整數式；以合成 id 記入接觸記憶、首循環必評估）；
     殺得掉 → 迎戰塔（`targetBuildingId` = 塔）取攻城接近格；殺不掉 →
     求援 gate 收緊（僅 losing 接觸呼叫、不響應自身接觸、defend 隊可響應）；
     無響應的防守／蓄兵隊 → 撤回集結點重整（不再維持原命令站樁）。
     （受火追擊 margin 平衡實測：4 → 24-seed 13/7 超門、2 → 10/6/8 攻勢萎縮、
     **3** → 12-seed 5/5/2 最均衡。）24-seed tally **8 藍 / 9 紅 / 7 平**
     （12 種子公平門通過、draw 較 10.23 的平局共通點不再出現 keep 淨損為零的
     對峙）。
  **驗證**——342/342 測試全過（新增 attackFx 偵測、預備金衝刺／釋放、塔前置
  位置與鏡像、受火 chase／脫離／攻城豁免、塔火接觸／夾擊／撤退共 23 測）、
  tsc＋oxlint 乾淨、fullMirrorProbe 7200 前 0 mismatch、pairProbe mirrorOK、
  saltMirrorProbe 363 采樣 0 mismatch、pnpm dev 200。

- [x] 階段三 Prompt 3.1 — 裝甲屬性（MVP 驗證通過後的第一個延後清單項目落地）：
  **緣由**——SPEC 規則 12 把「裝甲」列為延後；MVP 驗證通過（10.24 收口）後按
  原規劃補回。`UnitDef.stats` 從 5 值擴為 6 值：`armor`＝**減傷百分比**
  （0~0.8、預設 0；中文標籤固定「裝甲」，不用「護甲」／「防禦」）。
  1. **傷害公式**（sim/combat.ts）：單位受害者 `hp -= max(1, round(dmg × (1−armor)))`
     （最少 1 點地板）；**建築受害者不套甲**；`effectiveHp = hp / (1−armor)`
     純函式供 AI／平衡／UI 共用。
  2. **AI 生產評分**（strategy.ts）：加生存項 `survivalScoreOf × 0.15`（roster 內
     正規化有效HP/cost）——權重**刻意 < FATE_BAND 0.2**，只影響命運抽籤機率、
     不把弱甲單位擠出抽籤帶（Prompt 10.11 多樣性保留）。
  3. **平衡指標模組**（新 `balance/unitStats.ts`，原規劃 server 包——本 workspace
     無 server 落地為 game 內建）：armor／有效HP／有效HP:cost／DPS／DPS:cost
     純函式表；**靈敏度掃描**（`balance/sensitivity.test.ts`）＝等兵對撞
     armor 0→0.8 每 0.1 掃描：0 甲＝鏡像全平、勝場隨裝甲單調不減、滿甲全勝
     （健康屬性、無病態反轉）。
  4. **UI**：單位資訊面板加「裝甲 %／有效 HP／DPS」三行；戰力（面板＋復盤
     曲線）改**現值 HP 有效當量** `Σ hp/(1−armor) × dmg × attackSpeed`
     （保留隨損血下降語義）。
  5. **Seed**：legionnaire armor 0.2、archer 0；新增 **shield_guard**
     （small/melee、hp 120、dmg 6、armor **0.5**、成本 80、生產 6 s、
     有效 HP 240——小型高裝甲示範），roster 三單位。
  **驗證**——365/365 測試全過（新增 schema armor 驗證、傷害減半／取整／地板、
  effectiveHp、balance 指標、生存項分數差、shield_guard 內容鎖定、InfoPanel
  裝甲行、靈敏度掃描共 23 測）、tsc＋oxlint 乾淨、fullMirrorProbe 7200 前
  0 mismatch、pairProbe mirrorOK、saltMirrorProbe 363 采樣 0 mismatch、
  24-seed tally **8 藍 / 9 紅 / 7 平**（與 10.24 基線完全一致——裝甲雙方同式
  套用、生存項在命運帶內，平衡未漂移）、12 種子公平門通過、pnpm dev 200。
  檢查清單 grep：`armor` 正常；`armorType`／`damageType` 0 匹配；
  「護甲」僅存在於禁用說明與反測試斷言。

- [x] 階段三 Prompt 5 — 三資源經濟（藍水晶／紅寶石／綠翡翠）：
  **緣由**——SPEC §3 原只有藍水晶；三資源屬延後清單（規則 12），Prompt 5 落地。
  1. **Schema**：`ResourceAmountSchema` 三鍵化（`red_ruby`／`green_emerald`
     zod default 0——舊內容檔／replay／舊 fixture 不必補鍵）；資源節點帶
     `resourceType`（缺省 blue_crystal）；`ResourceIdSchema` 匯出。
  2. **sim**：`Player.blueCrystal` → `resources` 三鍵表（33 處引用全改）；
     收入按礦場產出資源入帳（各資源上限獨立 9999）；排兵／蓋建築**三資源
     逐一檢查逐一扣減**；礦場只能蓋在**類型匹配**的空閒節點上；
     `getResource(world, playerId, type)` ＋ `getIncome(...)`（60 tick 入帳環）。
  3. **Seed**：新增 `red_ruby`／`green_emerald` 資源檔、`ruby_mine`（0.5/s）、
     `emerald_sanctuary`（0.25/s）兩礦（與 crystal_mine 同構 150/12s/300hp）、
     `ballista`（大型 ranged、150hp/25dmg/3.0 格、**40 藍＋80 紅**、10s——
     首個雙資源單位）；地圖 6→**10 節點**（每方 3 藍＋1 紅＋1 綠，逐點鏡像、
     皆 500 蘊藏）、`mineCap` 3→**5**。
  4. **AI（內建啟發式，resourceBias 滑桿留後續 prompt）**：礦場分型
     （`producedResourceOf`）——放置找同型空閒節點、飽和分型計算；
     **藍礦永遠優先**（紅綠礦在藍礦無空閒節點前效用 0）、紅礦解鎖後
     roster 有吃紅單位 +0.4、綠礦紅礦蓋出後才解鎖且 ×0.5（零消費者、
     純資產——計入超時價值裁定）。
  5. **Metrics/UI**：`getBattleStats` 帶三資源庫存＋三收入率；資源面板
     **三行三資源**（各帶 +x.x/s）＋敵方三資源彙總行；ResourceChart 第四模式
     「三資源」＝我方藍/紅/綠三線（資源色同節點色）；replay 加
     `rubySeries`／`emeraldSeries`（舊檔缺欄相容）；平衡指標總成本 =
     三資源等權求和。
  **驗證**——379/379 測試全過（新增三礦並行/getIncome 窗口/逐資源扣費/
  節點類型匹配/per-resource 上限共 10 測、AI 啟發式 3 測、內容檔鎖值更新）、
  tsc＋oxlint 乾淨、fullMirrorProbe 7200 前 0 mismatch、pairProbe mirrorOK、
  saltMirrorProbe 363 采樣 0 mismatch、24-seed tally **6 藍 / 10 紅 / 8 平**
  （12 種子公平門 3/6/3 通過）、pnpm dev 200。grep 檢查：Player 狀態層已無
  單資源欄位（`blueCrystal` 0 匹配）。

- [x] 階段三 Prompt 6 — 12+1 滑桿戰略層（9 數值＋3 資源偏重＋節奏預設）：
  **緣由**——規則 10 原「玩家只調 5 滑桿」；Prompt 6 擴展為完整 Policy 系統。
  1. **Schema**：`POLICY_IDS` 5→9（+expansion/techRush/reserve/retreatThreshold）、
     `TempoPresetSchema`（rush/early_pressure/standard/late_game/turtle）；
     `policies.json` 9 條（全 default 0.5）。
  2. **節奏預設**（新 `ai/tempo.ts`）：時間窗覆蓋表——每次戰略/戰術決策先以
     `effectivePolicies(用戶值, tick)` 合成生效政策（`standard` 恒等；
     rush 前 2 分鐘 econMilitary 0.1/aggression 1.0 等）；敵方固定 standard。
  3. **單位效用乘法重構**（提示詞 #5）：`counter × tier項 × range項 × 技術項 ×
     稀缺項 × 生存項 × (壓境 ? ×2 : 1)`——各項相對倍率、1.0 中性；生存項收窄
     ±10%（乘法分差過大擠出命運帶）；**命運抽籤帶改相對值** `score ≥ best×0.85`。
  4. **建築效用**（提示詞 #4）：礦場 = `econ × resourceBias[資源] × (1−分型飽和)`
     （bias max 歸一、預設全 ×1）＋科技建築 techBias 項；expansion/techRush
     控制紅/綠礦 gate（**上半段生效**曲線——全線版 0.5 預設提前蓋紅礦，
     消融實測平局 8→16）。
  5. **reserve 語義**（消融定稿）：攻擊份額乘數 `×2×(1−reserve)`——0.5 中性、
     0 全軍出擊、1 全軍留守、敵滅全軍出擊（10.18）豁免；「戰力比例事後翻隊」
     版在無狀態重編下把攻擊隊永久壓回家（消融實測 24 全平）。
  6. **retreatThreshold**（parity 乘法映射）：單位 `JSON 值 × lerp(0.4,1.6,t)`、
     小隊 `0.7 × (0.5+t)`——0.5 雙雙零偏移；TacticalPlan 帶
     `retreatHpFactor`/`squadRetreatRatio`，micro 從 plan 讀（簽名不變）。
  7. **UI**：面板 12 滑桿（兩列網格）＋節奏下拉；**節奏預設免冷卻**
     （滑桿仍 30s 冷卻）；`applyPolicies` 深合併（resourceBias 部分子鍵）。
  **驗證**——397/397 測試全過（+18：tempo 時段/合成/深合併 8、reserve 乘數 5、
  retreat parity 3、expansion/techRush/bias gates 4、UI 12 滑桿、session 免冷卻＋
  深合併）；tsc＋oxlint 乾淨；fullMirrorProbe 0 mismatch、pairProbe mirrorOK、
  saltMirrorProbe 363 采樣 0；24-seed tally **7 藍 / 9 紅 / 8 平**（消融兩輪：
  reserve 比例版→24 全平、expansion 全線→16 平，定稿後回到 Prompt 5 基線）、
  12 種子公平門通過、pnpm dev 200。

- [x] 階段三 Prompt 7.5 — AI 戰術層決策記錄：
  1. **資料模型**：`TacticalRecord`（與戰略 `DecisionRecord` 同構）＋
     `TacticalPlan.records`（每循環重建、不累積）；`TacticalTopFactor`
     任務成因 6 種＋目標成因 4 種。
  2. **產出**：mission 記錄（每隊每循環 1 條，最終 mission＋成因優先序
     stage/retreat ＞ contact ＞ aggressionBonus/reserve/mission）；target 記錄
     （本循環跑過目標選擇的隊，`pickTarget` 改回傳全候選分數分解、降冪；
     topFactor 依贏家三項歸因 defense/value/distance、騷擾隊 harassEconomy）。
  3. **消費**：session 僅變化時進決策日誌（附 topFactor＋解釋）；`pnpm sim`
     新增「最近的戰術決策（5 條）」含 top-3 候選分數；記錄純觀測。
  **驗證**——416/416 測試全過（+8：500 tick 記錄存在與結構、同 seed 序列
  deep-equal、目標記錄 winner/候選降冪/分數有效、weights 為生效政策、
  reserve/waveGate/contact/defense 成因覆蓋）；tsc＋oxlint 乾淨；三鏡像探針
  0 mismatch；24-seed tally 7/9/8 不變（純觀測零副作用）；`pnpm sim` 目視
  戰術記錄與候選分數；pnpm dev 200。

- [x] 階段三 Prompt 8.5 — AI 微操層決策記錄：
  1. **資料模型**（micro.ts）：`MicroRecord`＋純函式 `microRecords`
     （處理中狀態由呼叫端持有；sim／decisions 零影響）；
     `MicroDecision.topFactor` 於 11 個 push 點顯式標注（撤退二分支
     hpCritical/hpThreshold、harassPressured、kiteRange、inRange、
     chaseMargin、underFire、fallbackSquad、formation、rally）。
  2. **只在戰鬥狀態切換時記錄**：任一端 ∈ 戰鬥態六集合（formation↔rally
     常規切換不記；首次進入戰鬥態＝入場記錄）；同單位 20 微操循環防抖
     （40 tick；冷卻錨只在真記錄時推進，震盪不會無限後推）。
  3. **消費**：session 全量進決策日誌（新層 `'micro'`；面板加「微操」篩選
     片＋layerLabel）；`pnpm sim` 印「最近的微操決策（5 條）」取代先前的
     風箏手寫首印；不進 replay。
  **驗證**——426/426 測試全過（+10：入場／切換記錄、formation↔rally 零
  記錄、防抖壓制與錨點、explanation 格式與 target、真實世界撤退記錄
  hpCritical、500 tick 只在切換（相鄰同動作間隔 ≥ 40 tick 硬不變量）與
  數量 ≪ 決策 1/10、同 seed deep-equal＋位置一致、不同 seed 不同、成因
  覆蓋 ≥ 4 種）；tsc＋oxlint 乾淨；三鏡像探針 0 mismatch；24-seed tally
  7/9/8 不變（記錄純觀測）；`pnpm sim` 目視微操記錄（[chaseMargin]/
  [inRange]/[underFire]/[fallbackSquad]）；pnpm dev 200。

- [x] 階段三 Prompt 8.6 — AI 投降判定（確認無法翻盤才投）：
  1. **絕望指數**（`ai/surrender.ts`，0..1）：戰力／收入／領土／時間／科技
     五項劣勢加權和；權重與參數在陣營檔 `aiSurrenderConfig`（可選，缺省
     `DEFAULT_AI_SURRENDER_CONFIG`：閾 0.75、權重 0.35/0.25/0.15/0.15/0.10、
     最早 120 秒、持續 15 秒；`test_faction.json` 帶一份樣例）。
  2. **閾值修正**：有效閾 = base + 0.1×aggression + 0.05×reserve +
     0.08×techRush（默認滑桿 0.5 → 0.865；好戰／重留守／科技流更不願投）。
  3. **持續性**：連續超閾 `sustainSec` 才投；回到閾下即重置
     （`world.despairBreachSince`）；對局 < 120 秒不判定。
  4. **投降行為**：完全停戰——單位與塔停火（仍可被打）、停移動、停生產與
     採集、生產隊列清空、AI 三層不再決策；**3 秒寬限**後結束、投降方判負
     （`sim/matchResult.ts`——自 session 抽出，session 與 CLI 共用語義）。
     事件寫 `world.surrender`＋replay `surrender`（可缺）＋決策日誌＋
     結局面板橫幅（`post-game-surrender`）。
  5. **CLI**：`pnpm sim` 印「★ AI 投降」；`SURRENDER_DEMO=1`（CLI-only
     手柄）2 分 1 秒強制極端劣勢＋閾值暫降 0.5；`SEED`／`TOTAL_TICKS`
     環境變數可覆寫（24-seed tally 機讀 `RESULT` 行）。
  **驗證**——441/441 測試全過（+15：絕望公式與成分、閾值公式與夾 1、
  三政策對照投／不投、持續性三段與反轉重置、120 秒下限與邊界、JSON 配置
  生效與缺省回退、sim 閘門 20 tick（停火／停走／停產／停收＋敵方對照組）、
  定案動作（清隊列／斷令）、matchEnded 寬限與判負、replay 記錄／解析／
  舊檔相容、面板橫幅）；tsc×2＋oxlint 乾淨；session 鏡像探針 0 mismatch；
  **24-seed tally 新基線 7 藍 / 8 紅 / 9 平、自然投降 0 例**（默認閾 0.865
  ＋持續 15 秒是高門檻——正常對局 AI 不會誤投；公平門 12 種子 ≤ 9/側
  不變）；`SURRENDER_DEMO=1 TOTAL_TICKS=6000 pnpm sim` 目視：2 分 1 秒清場
  → t=2800 ★ 投降（絕望 0.70 > 閾 0.62）→ 判負 enemy；pnpm dev 200。

- [x] 階段三 Prompt 9.5a — 四象限圖表與熱力圖（純觀測輪；9.5b 視野迷霧續作）：
  1. **依賴**：`uplot` 加入 game（~50KB 純 canvas 無子依賴）。
  2. **左上**：資源曲線改 **uPlot 三線**（我方藍水晶／紅寶石／綠翡翠，
     60 秒滾動窗、tick÷20 秒軸、nearest 像素風、無平滑）＋**線尾收入率**
     （`x.x/s`，取 `playerIncomes`）；「單位數量／戰力」canvas 雙線模式
     保留為同面板下拉切換；**圖表取樣 1Hz**（與 250ms 文字輪詢分離）。
  3. **右上**：`PowerStack` 戰力對比——每陣營**原始 HP／有效 HP 兩根**
     three-tier 堆疊條（共用比例尺）＋戰力比 `ratioTone` 警示。
  4. **左下**：決策日誌最近 **10 條**、`LOG_LIMIT` 32→100；戰略條目
     **點擊展開候選柱狀圖**（最高分金色高亮＋topFactor，CSS transition）；
     政策變更後條目掛「受政策影響」標；裝甲色標（重紫／超重金，
     `render/armor.ts` 四檔色階）。
  5. **右下**：小隊狀態**色點**（撤退紅／交戰黃／其餘綠；`SquadInfo.engaging`
     進數據層；`squadTone` 撤退蓋過交戰）。
  6. **可疊加圖層**（`overlay-controls` 開關）：熱力圖（`getInfluence`
     tick 緩存 → 離屏 canvas 每格一像素紅/藍 → Texture nearest 貼地圖，
     UI 500ms 刷新、開關只切 `visible`）、迷霧層 API（9.5b 接 sight.ts）、
     路徑**逐格虛線**（替代極淡直線）。
  7. **裝甲條**：血條與單位色塊之間插 2px 條（armor > 0 才畫），
     寬度 = armor ÷ 0.8，四檔顏色（輕綠/中藍/重紫/超重金）。
  **驗證**——455/455 測試全過（+14：armor 四檔色階與邊界、條寬 armor÷0.8、
  熱力圖格顏色映射（敵紅/我藍/全透明/強度歸一）、uPlot 三序列資料構建與
  setData、日誌 10 條與篩選切片、展開柱狀圖（最高分滿寬高亮／收起）、
  裝甲色標精確色、政策標記範圍、小隊三色點、per-tier rawHp/effHp、
  小隊 engaging、戰略日誌 candidates/topFactor/armorTier、getInfluence
  同 tick 同物件跨 tick 重算）；tsc×2＋oxlint 乾淨；**24-seed tally
  7 藍/8 紅/9 平不變**（純觀測零 sim 改動）；pnpm dev 目視四象限。

- [x] 階段三 Prompt 9.5b — 真·資訊不完全（視野過濾動 AI＋迷霧層接真資料）：
  1. **單一真相來源**（新 `ai/sight.ts`）：`isVisibleTo`／`visibleTileMask`／
     `buildingSightTiles`——單位視野 **6 格**（＝守備半徑 `DEFENSE_RADIUS_TILES`，
     測試交叉守門）、建築 **6 格**、塔＝**防禦射程 + 2**；幾何全整數距離平方
     （建築以佔地外框邊緣量測，與戰鬥射程同一量測）；**無記憶**——純函式，
     敵人離開視野即從 AI 判知消失。
  2. **消費點過濾**（五點）：影響力地圖敵方貢獻只計視野內
     （`computeInfluenceMap`／`enemyThreatAtPoint`／`detectBuildingThreats`，
     我方貢獻恆計）、生產克制 `enemyRoleCounts`（看不見的爆兵不扭轉克制，
     現身即修正）、戰術接觸掃描 `seen`（半徑 6＝視野 6，防禦性檢查）、
     微操 `nearestEnemy`／`nearestEnemyWithin`／`squadFocus`（出視野即失標）。
     **刻意不過濾的全局 meta 量測**：投降絕望指數、攻勢優勢加權（10.18
     全局戰力比）、攻擊波次門 `defendersNear`（10.21）——比賽級評估非戰場判知。
  3. **迷霧層接真資料**：`session` onTick 末尾每 tick 推
     `visibleTileMask(w,'player')`；場景存 mask、開關關閉零繪製成本、
     開啟當下用已存 mask 立即補畫；不可見格半透明暗罩、最頂層。
  **驗證**——465/465 測試全過（+10：視野半徑交叉守門、6 格邊界精確
  1200/1201、死亡單位無視野、鏡像可見性對稱、32×32 mask、無記憶重算、
  影響力視野外不記入/入視野當場記入、克制視野外中性化）；tsc×2＋oxlint
  乾淨；鏡像探針 0 mismatch；受影響既有測試以**建築照視野**修復
  （建築不累積威脅，精確值斷言不污染）；**24-seed tally 新基線
  14 藍/6 紅/4 平、自然投降 0 例**（行為預期改變；12 種子公平門
  3 藍/4 紅/5 平通過 ≤ 9/側——兩組種子偏斜方向相反，屬種子方差非
  系統性陣營偏倚，記錄待平衡輪追蹤）。

- [x] 階段三 Prompt 9.5c — 接戰線真資料化＋追擊收斂閘＋守備隊錨定（修復回報）：
  1. **接戰線＝實際攻擊計算**（回報：線指錯目標且有延遲）：`sim/combat.ts`
     匯出 `computeEngageLines(world)`——對每個存活單位／塔用**與 `stepCombat`
     完全相同的解析**（抽 `resolveUnitTarget`＝顯式射程內優先 → 自動接戰；
     塔＝`acquireBuildingTarget`）現算「現在開火會打到誰」；session onTick
     每 tick 推 `scene.setEngageLines`（20Hz）。修掉舊渲染層
     `victimOf`／`towerVictimOf` 近似的兩個缺陷：(a) 顯式目標分支**無射程
     檢查**（追擊中把線畫到打不到的目標 = 指錯）；(b) 座標／`targetId` 來自
     **250ms 快照**（延遲）。端點與實際傷害結構上同源、延遲 ≤ 一 tick；
     舊近似函式刪除。純函式、零 sim 狀態污染。
  2. **追擊收斂閘**（回報：守備隊被追不上的風箏者點射到死，復發）：
     `chaseConverges`（微操分支 2.4 受火貼身／2.5 追擊共用）——追擊前判
     追不追得上：更快→可追；非風箏型（同速近戰互追）→可追；風箏型遠程且
     不慢於我 → **預演它的風箏退格**：退格被地形夾住或落入其他友軍接戰半徑
     （**包夾收頭**）→可追；退路開闊 → 不可追、受火改走既有脫離。理據：
     風箏門檻 2.1 格 > 近戰追擊半徑 1.8 格，「站定」也只是風箏間歇——
     追 = 持續走進自由傷害（10.8 支援規則＋10.24 D 受火貼身給死循環開了閘）。
  3. **守備隊錨定**（戰術層）：contact 重評估把 defend 隊迎戰目標夾回受守
     建築守備半徑（6 格）內（`clampTileWithinRadius`）——風箏者不把整隊拖走。
  **驗證**——471/471 測試全過（+6：`computeEngageLines` 六例含「顯式超射程
  目標→線指射程內實際目標」「建築外框最近點」「塔 victim」「投降不畫」；
  收斂閘四例含死循環→脫離、包夾→追、慢遠程→追、追擊距內開闊退路→不追）；
  tsc×2＋oxlint 乾淨；鏡像探針 0 mismatch；**24-seed tally 7 藍/6 紅/11 平**
  （9.5b 的 14/6/4 → 收斂閘讓雙方少送死、平局增；≤ 9/側達標）、12 種子公平門
  通過、自然投降 0 例；pnpm dev 目視：對局無 console 錯誤、時鐘推進、
  戰鬥日誌（追擊/撤退/接觸重評估）齊全、三疊加開關開合正常。
