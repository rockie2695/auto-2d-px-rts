# MVP 規格 — auto-2d-px-rts

> 狀態：Prompt 2 定稿。本文是 MVP 的唯一事實來源；
> 與本文衝突的實作一律以本文為準，改動本文需先經確認。

---

## 1. 遊戲定位

2D 像素即時戰略。

**玩家不控制單位**，只調整 5 個 Policy 滑桿；場上所有單位由傳統 AI（效用函數、
行為樹、影響力地圖，**非 LLM**）操作。玩家透過純文字面板與基本數字讀懂局勢。

一局 = 一場對稱的 1v1，最長 10 分鐘。

---

## 2. 核心硬約束

| 項目 | 值 | 來源 |
| --- | --- | --- |
| Tick 頻率 | **20 Hz**（固定，不隨幀率變動） | 規則 8 |
| Tick 間隔 | **50 ms** | `TICK_INTERVAL_MS` |
| RNG | 種子化，相同輸入必得相同輸出 | 規則 8 |
| 地圖 | **32 × 32**，單張 | 規則 11 |

### 2.1 各系統的 tick 換算（必須是整數）

| 系統 | 時間 | tick 數 |
| --- | --- | --- |
| 戰略層 | 2 s | **40** |
| 戰術層 | 500 ms | **10** |
| 微操層 | 100 ms | **2** |
| 遊戲時限 | 600 s | **12,000** |

任何非整數 tick 的排程都會破壞確定性，不允許出現。

### 2.2 數值表示

- **位置與距離**用整數固定點：**1 格 = 200 單位**。
  選 200 是為了讓兩個 `moveSpeed` 在每 tick 都是整數：
  - legionnaire `2.1 格/秒` → `2.1 × 200 ÷ 20 = 21 單位/tick`
  - archer `2.5 格/秒` → `2.5 × 200 ÷ 20 = 25 單位/tick`
- **攻擊冷卻用累積器**，不做四捨五入：
  每 tick `acc += attackSpeed / TICK_RATE_HZ`，`acc ≥ 1` 時發動攻擊並 `acc -= 1`。
  - legionnaire：`+0.06/tick`，長期平均恰為 1.2 次/秒
  - archer：`+0.05/tick`，每 20 tick 一次
- 目的：避免浮點跨平台差異破壞確定性，同時保留規格速率的長期平均值。

---

## 3. 資源

只有一種：**藍水晶 `blue_crystal`**。

- 由 **水晶礦場 `crystal_mine`** 產出：**1.0 / 秒 / 座**，自動入帳，無需單位駐守。
- 用於**所有**建築與單位。
- 來源只有礦場，無其他取得方式。

---

## 4. 單位（2 個）

| id | 類型 | tier | hp | dmg | range（格） | attackSpeed（次/秒） | moveSpeed（格/秒） | DPS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `legionnaire` | melee | small | 100 | 12 | 0.8 | 1.2 | 2.1 | **14.4** |
| `archer` | ranged | small | 60 | 8 | 3.0 | 1.0 | 2.5 | **8.0** |

- `DPS = dmg × attackSpeed`。
- `range = 0.8` 表示貼身接戰（相鄰格）；`3.0` 表示隔 3 格射擊。
- **`tier` 是 schema 欄位，MVP 戰鬥公式不使用** —— 裝甲系統屬延後清單（規則 12），
  但依規則 7 保留欄位以符合最終 schema，日後遷移不需改結構。

---

## 5. 建築

規則 11 的「2 個建築」指**作戰建築** `keep` + `barracks`；
`crystal_mine` 是蓋在資源點上的**經濟設施**，不佔建築配額。

| id | 名稱 | 類別 | hp | 成本 | 建造時間 | 佔地 | 功能 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `keep` | 主堡 | 作戰建築 | **1000** | — | — | 3×3 | 被摧毀即輸；不可建造、不可維修 |
| `barracks` | 兵營 | 作戰建築 | 600 | 200 | 15 s | 2×2 | 生產單位 |
| `crystal_mine` | 礦場 | 經濟設施 | 300 | 150 | 12 s | 1×1 | 產出 1.0 藍水晶/秒；**必須**蓋在空資源點上 |

- MVP **不做維修**。
- 建造期間可被攻擊；未完成則 hp 按完成比例折算。
- **收入結算**（Prompt 5）：每座礦場以 `incomePerSec.blue_crystal` 獨立累積，
  每 tick 以整數取出入帳，並逐礦消耗所在節點的 `amount`（入帳 1 扣 1）。
  礦場必須蓋在**空**資源點上；節點採完後礦場**保留**但收入為 0。
- **庫存上限 9999**：入帳時 clamp，超額部分直接丟棄（不累積到節點外）。
- 讀取庫存的 API：`getResource(world, playerId)`。

---

## 6. 經濟數值

| 項目 | 值 |
| --- | --- |
| 開局藍水晶 | **600** |
| 礦場成本 / 建造時間 | 150 / 12 s |
| 兵營成本 / 建造時間 | 200 / 15 s |
| `legionnaire` 成本 / 生產時間 | 50 / 5 s |
| `archer` 成本 / 生產時間 | 75 / 7 s |
| 礦場上限 | 每方 **3** 座（= 資源點數）→ 滿產 **3.0 / 秒** |
| 單位上限 | 每方 **40** |
| 兵營上限 | 每方 **3** |
| 單一資源點蘊藏量 | **500**（採完 = 該礦場收入歸零） |
| 庫存上限 | **9999**（入帳時 clamp） |

**收入上限估算**：10 分鐘理論最大收入 ≈ `600 + 3.0 × 600 = 2400` 藍水晶
（需盡早補滿 3 座礦場才逼近此值）。扣除補滿礦場 2 座（300）與額外 1 座兵營（200）
共 500 的基建後，約 1900 可投入單位 → 約 38 個 `legionnaire`，
與單位上限 40 同量級，兩者都會成為實際約束
（兵營無需蓋到 3 座 —— 3 座的產能遠超單位上限）。

---

## 7. 開局配置（對稱標準局）

地圖 32×32，**中心點 180° 旋轉對稱**，雙方基地位於對角。

雙方（我方 / 敵方）各持有：

| 項目 | 數量 |
| --- | --- |
| `keep` | 1 |
| `barracks` | 1 |
| `crystal_mine` | 1（置於最近的資源點上） |
| 空資源點 | 2（加上已佔的共 3） |
| `blue_crystal` | 600 |
| `legionnaire` | 3 |

- 開局即有戰鬥力，第 1 分鐘內就會接觸。
- **無戰爭迷霧**：雙方可見全部資訊（與面板直接顯示敵方藍水晶一致）。

---

## 8. Policy 滑桿（5 個）

玩家只能調整這 5 個滑桿，**不得對單位下任何直接指令**（規則 10）。
滑桿為 0.0 – 1.0 連續值，作用點如下。

### 8.1 `econMilitary` — 0 = 全力軍事，1 = 全力經濟

作用於**戰略層**的效用排序。戰略層每 40 tick 對候選行動打分，取最高且可負擔者：

```
U(興建礦場) = econMilitary × (1 − 礦場數 / 3)
U(興建兵營) = (1 − econMilitary) × (1 − 兵營數 / 3)
U(生產單位) = (1 − econMilitary) × 進攻預算 + 防守預算
```

- `防守預算 = f(敵方戰力 / 我方戰力)`，與滑桿無關。
  因此 `econMilitary = 1` 是「重經濟」而非「完全不設防」——
  敵方集結部隊時仍會補兵自保。
- `= 0`：礦場效用恆為 0（除非一礦都沒有），收入幾乎全投軍事。

**實作補註（Prompt 6）**：權重映射為 `buildEcon = econMilitary × 2.0`、
`buildMilitary = (1 − econMilitary) × 2.0`，效用為 `weight × (1 − 飽和度)`
（飽和度 = 數量 / 上限）；不可負擔、無放置空間、無空閒節點的候選直接剔除。
「一礦都沒有」時礦場效用強制為 **3.0**（壓過一切），
保證 `econMilitary = 0` 的 AI 也有基本收入、不會餓死。
生產軌每循環取 `克制分 + tier 分 + range 分 − 稀缺性懲罰` 最高者入列。

### 8.2 `unitSize` — 0 = 大型，1 = 小型

作用於**戰術層**的**小隊編制上限**（MVP 只有兩個 small 單位，
故此滑桿不影響單位種類，只影響編隊密度）：

| 值 | 小隊上限 | 行為 |
| --- | --- | --- |
| 0 | **4** | 少而厚實的方陣 |
| 1 | **8** | 多而散的兵力 |

中間值：`上限 = round(4 + unitSize × 4)`。

**實作補註（Prompt 6）**：此滑桿**另**作用於戰略層的 tier 偏好（與編隊密度並存）：
`目標 tier 序數 = round((1 − unitSize) × 2)`（0→small、1→large），
候選單位與目標的差距越小分數越高（`1 − |差距| / 2`）。
MVP 兩單位皆為 `small`，故此作用點在合成多 tier 測試中驗證。

### 8.3 `unitRange` — 0 = 近戰，1 = 遠程

作用於**戰略層**的**生產配額**：

```
P(生產 archer)   = unitRange
P(生產 legionnaire) = 1 − unitRange
```

- `0` → 全出 `legionnaire`；`1` → 全出 `archer`。

**實作補註（Prompt 6）**：以「射程正規化接近度」實現等價配額 ——
`range 分 = 1 − |roster 內正規化射程 − unitRange|`（roster 極小/極大值正規化到 0–1）。
`0` 時近戰（正規化 0）得滿分、遠程得 0 分，反之亦然；中間值按距離線性插值。

### 8.4 `aggression` — 0 = 固守，1 = 強攻

作用於**戰術層**的**目標選擇**與**微操層**的**追擊意願**：

| 值 | 行為 |
| --- | --- |
| 0 | 小隊只在基地防禦半徑 **8 格**內接戰，不越出 |
| 1 | 小隊主動向敵方 `keep` 推進，並追擊射程外 **2 格**內的逃敵 |

中間值線性插值：允許出擊距離 `8 + aggression × 22` 格（8 → 30 格，
30 格足以涵蓋 32×32 全圖）；追擊距離 `2 × aggression` 格。

> **撤退閾值不由此滑桿控制** —— 可調的撤退閾值屬延後清單（規則 12）。
> 微操層的撤退採**固定規則**：`hp ≤ 20%` 即撤退，不開放調整。
> 該比例存放在各單位資料的 `ai.retreatHpPct`（**欄位已預留**：Prompt 3 已進 schema，
> 兩個單位皆為 0.2），由 sim 讀取 —— 資料可改，但玩家在遊戲中不可調。

### 8.5 `clusterSpread` — 0 = 分散游擊，1 = 集群推進

作用於**戰術層**的**空間分佈**：

```
目標集群數 = round(1 + (1 − clusterSpread) × 3)     // 1 ~ 4
```

- `1` → 所有小隊集中到同一個最高價值目標（集中一路）。
- `0` → 分成最多 4 個集群，攻擊不同目標（多點開花）。

---

## 9. AI 三層

全部為傳統演算法，**禁止 LLM**（規則 9）。雙方 AI 使用同一套三層架構，
敵方使用**固定預設滑桿值**（不受玩家滑桿影響）。

| 層 | 頻率 | tick 間隔 | 演算法 | 職責 |
| --- | --- | --- | --- | --- |
| **戰略** | 2 s | 40 | 效用函數 | 蓋什麼、生什麼 |
| **戰術** | 500 ms | 10 | 影響力地圖 | 小隊編成、目標分配 |
| **微操** | 100 ms | 2 | 行為樹 | 風箏、追擊、撤退 |

### 9.1 戰略層（40 tick）

依 §8.1 的效用函數挑選行動，執行於：興建 `crystal_mine`、興建 `barracks`、
生產單位。生產種類依 §8.3 配額抽籤（種子化 RNG）。

**實作補註（Prompt 6.5）**：每個實際執行的產出一條決策記錄
（`tick` / `layer` / `actor` / `action` / `target`，`reason` 內含當軌全部候選分數、
當時 5 個 Policy 滑桿、主導因素 `topFactor` 與一行中文 `explanation`）。
解釋由 `ai/explain.ts` 的規則式模板產出（不用 LLM），
且 `topFactor` 與文字出自同一條規則鏈、保證一致；`pnpm sim` 會印出最近 5 條。

### 9.2 戰術層（10 tick）

- **影響力地圖**：32×32 格網格，每格累積己方單位的戰力貢獻（距離衰減），
  用於選定小隊目標。**MVP 不做可視化**（熱力圖屬延後清單）。
- **小隊分配**：依 §8.2 編制上限重新編隊，依 §8.5 決定目標集群數，
  依 §8.4 決定是否越出防禦半徑。

**實作補註（Prompt 7）**：MVP 的影響力地圖採 **8×8 tile 粗網格**
（32×32 地圖 → 4×4 = 16 格），`threat = Σ ai.value × (hp/maxHp) / (1 + dist²)`
（整數 milli；`value`／`retreatHpPct` 取自單位 JSON）。小隊編組為
`squadCount = round(lerp(4, 1, clusterSpread))`、
`squadSize = round(lerp(4, 18, clusterSpread))`，任務 attack／defend／harass
由 `aggression` 決定攻守比例（隊數 ≥ 3 且 attack ≥ 2 時派 1 隊騷擾打敵方經濟）；
進攻目標評分 = `建築ai.value × 1/(敵方格威脅+1) × 1/(1+距離)`。
撤退：隊級 `squadPower < 敵方在重心的即時威脅 × 0.7` → 回集結點；
個體 `hp < retreatHpPct × maxHp` → 脫離戰鬥。`pnpm sim` 會印出小隊任務變化與脫離事件。

### 9.3 微操層（2 tick）

行為樹節點：

1. **撤退**：`hp ≤ 20%` → 離開戰場（固定閾值，不開放調整）。
2. **風箏**：僅 `archer` —— 攻擊後後退 1 格，等待冷卻再打。
3. **接戰**：目標在 `range` 內 → 攻擊。
4. **追擊**：目標在追擊距離內（§8.4）→ 追。
5. **移動**：朝當前小隊目標前進。

### 9.4 移動與尋路

- 格線 **A\***（32×32，成本低）。
- 建築佔地為障礙；**單位之間無體積碰撞**（可穿過彼此），
  避免 MVP 陷入推擠求解。

---

## 10. 戰鬥規則

- **無護甲、無命中、無閃避**（裝甲屬延後清單，規則 12）。
- 實傷害：`hp -= dmg`，無傷害類型。
- `FactionDef.counterMatrix`（melee/ranged 2×2）**欄位已預留**：Prompt 3 已進 schema，
  但 MVP 四格恆為 1.0、戰鬥公式不讀取；傷害相剋與裝甲同屬延後範圍。
- 攻擊冷卻見 §2.2 累積器。
- 射程判定用固定點距離（§2.2）。
- `keep` hp ≤ 0 → 該方落敗。

---

## 11. 勝負條件

1. **摧毀敵方 `keep`** → 立即勝利。
2. 否則到 **12,000 tick（10 分鐘）** → 比較**當前藍水晶庫存**（不是累積採集總量），
   較高者勝。
3. 庫存相同 → 比較 `keep` 剩餘 hp，較高者勝。
4. 仍相同 → 平手。

> 「當前庫存」代表手上還剩多少，因此囤積不花並非無敵策略。

---

## 12. 戰中資訊面板（MVP：純文字）

覆蓋在畫布上的 React 文字面板，四個區塊：

```
──────────────────────────────────
我方藍水晶      620
敵方藍水晶      545
收入率         +3.0 / 秒
戰力比         1.42   (我 12,480 / 敵 8,790)
──────────────────────────────────
決策日誌（最近 5 條）
  [00420] 戰略  興建 crystal_mine @ (7,24)
  [00430] 戰術  小隊 #2 分配至東側防線
  [00432] 微操  legionnaire #17 撤退（hp 18%）
  [00440] 戰略  生產 archer ×2
  [00450] 戰術  3 個集群 → 集中上路
──────────────────────────────────
小隊狀態
  #1  集結  (16,16)  8/8  100%
  #2  防禦  (24, 8)  5/8   72%
  #3  攻擊  ( 6,20)  8/8   91%
──────────────────────────────────
```

四個區塊 = 資源（三行）＋ 戰力比 ＋ 決策日誌 ＋ 小隊狀態。

### 12.1 定義

| 指標 | 定義 |
| --- | --- |
| **收入率** | 近 10 秒（200 tick）實際入帳 ÷ 10 秒，避免瞬間跳動 |
| **戰力** | `Σ (當前 hp × dmg × attackSpeed)`，只算存活單位 |
| **戰力比** | 我方戰力 ÷ 敵方戰力 |

- `legionnaire` 滿血戰力 = `100 × 12 × 1.2 = 1440`
- `archer` 滿血戰力 = `60 × 8 × 1.0 = 480`
- **戰力比不計射程與位置**，純面板數字，用於快速判讀局勢，不是勝率預測。
- **AI 決策日誌**：每層每次決策寫一條，格式 `[tick 五位數] 層級 內容`，環狀保留 5 條。
- **小隊狀態**：`#id 任務 目標 數量/上限 hp 百分比`。

---

## 13. 資料結構（JSON，MVP 唯一資料來源）

位置：`/packages/game/public/data/`。
依規則 7，**不用 Postgres、Content Pack、CDN**；但結構按最終 schema 設計，
日後遷移 DB 不需改欄位。所有檔案帶 `schemaVersion: 1`。

schema 定義在 `packages/shared/src/schema.ts`（Zod）；
每份內容檔的外層固定是 `{ "schemaVersion": 1, "<種類>": { ... } }`。

### 檔案清單（共 10 個）

```
public/data/
  resources/blue_crystal.json     1 個資源
  factions/test_faction.json      1 個陣營（雙方共用）
  units/legionnaire.json          2 個單位（各一檔）
  units/archer.json
  buildings/keep.json             3 個建築（各一檔）
  buildings/barracks.json
  buildings/crystal_mine.json
  maps/test_map.json              1 張 32x32 地圖
  policies.json                   5 個滑桿
  match.json                      對局設定（tick 頻率、時限、各項上限）
```

### `resources/blue_crystal.json`

```json
{
  "schemaVersion": 1,
  "resource": { "id": "blue_crystal", "name": "藍水晶", "color": "#4fc3f7" }
}
```

### `units/*.json`（每單位一檔）

```json
{
  "schemaVersion": 1,
  "unit": {
    "id": "legionnaire",
    "faction": "test_faction",
    "tier": "small",
    "role": "melee",
    "cost": { "blue_crystal": 50 },
    "stats": { "hp": 100, "dmg": 12, "range": 0.8, "attackSpeed": 1.2, "moveSpeed": 2.1 },
    "requires": ["barracks"],
    "sprite": { "color": "#d94f4f", "size": 12 },
    "ai": { "value": 100, "preferredRange": 0.8, "retreatHpPct": 0.2 },
    "trainTimeSec": 5
  }
}
```

- `requires` = 產出此單位所需的建築。
- `ai.value` = AI 的生產評價權重；`ai.preferredRange` = 微操層偏好的交戰距離；
  `ai.retreatHpPct` 見 §8.4（資料定義，玩家不可調）。

### `buildings/*.json`（每建築一檔）

```json
{
  "schemaVersion": 1,
  "building": {
    "id": "crystal_mine",
    "faction": "test_faction",
    "cost": { "blue_crystal": 150 },
    "size": [1, 1],
    "produces": [],
    "requires": [],
    "sprite": { "color": "#38b0d8", "size": 16 },
    "ai": { "value": 300 },
    "hp": 300,
    "buildTimeSec": 12,
    "incomePerSec": { "blue_crystal": 1.0 },
    "requiresResourceNode": true
  }
}
```

- `size` = 佔地 `[寬, 高]`（格）。
- `keep` 的 `cost: 0`、`buildTimeSec: 0`：它不可建造，只能由開局配置放置。

### `factions/test_faction.json`

```json
{
  "schemaVersion": 1,
  "faction": {
    "id": "test_faction",
    "name": "Test Faction",
    "startUnits": { "legionnaire": 3 },
    "startBuildings": ["keep", "barracks", "crystal_mine"],
    "roster": ["legionnaire", "archer"],
    "buildings": ["barracks", "crystal_mine"],
    "startResources": { "blue_crystal": 600 },
    "counterMatrix": {
      "melee": { "melee": 1.0, "ranged": 1.0 },
      "ranged": { "melee": 1.0, "ranged": 1.0 }
    }
  }
}
```

- `roster` = 可訓練單位；`buildings` = **可建造**建築（不含不可建造的 `keep`）。
- 開局配置即 §7 對稱標準局；雙方共用此陣營，差別只在出生點與滑桿（敵方用固定預設值）。
- `counterMatrix` 四格皆為 **1.0**：欄位已預留，MVP 戰鬥公式不讀取（§10）。

### `policies.json`

```json
{
  "schemaVersion": 1,
  "policies": [
    { "id": "econMilitary",  "min": 0, "max": 1, "default": 0.5, "step": 0.01 },
    { "id": "unitSize",      "min": 0, "max": 1, "default": 0.5, "step": 0.01 },
    { "id": "unitRange",     "min": 0, "max": 1, "default": 0.5, "step": 0.01 },
    { "id": "aggression",    "min": 0, "max": 1, "default": 0.5, "step": 0.01 },
    { "id": "clusterSpread", "min": 0, "max": 1, "default": 0.5, "step": 0.01 }
  ]
}
```

### `maps/test_map.json`

```json
{
  "schemaVersion": 1,
  "map": {
    "id": "test_map",
    "size": 32,
    "tiles": [0, 0, 1, "... 長度 1024，行優先"],
    "resourceNodes": [
      { "x": 7, "y": 24, "amount": 500 }, { "x": 4, "y": 27, "amount": 500 },
      { "x": 10, "y": 27, "amount": 500 },
      { "x": 24, "y": 7, "amount": 500 }, { "x": 27, "y": 4, "amount": 500 },
      { "x": 21, "y": 4, "amount": 500 }
    ],
    "spawnPoints": [{ "x": 5, "y": 26 }, { "x": 26, "y": 5 }]
  }
}
```

- `tiles` = **可通行性**（§9.4）：`0` 可走、`1` 岩石，共 16 格岩石、180° 旋轉對稱。
- `resourceNodes`：雙方各 3 個，後 3 個是前 3 個的 180° 像；
  每個節點帶 `amount: 500`（§5：入帳 1 扣 1，採完歸零）。
- `spawnPoints`：恰好 2 個，互為 180° 像。
- **不設 `symmetry` 欄位** —— 對稱性由測試斷言（`content.test.ts`），
  座標界內、`tiles` 長度、出生點數量則由 schema 的 `superRefine` 驗證。

### `match.json`

```json
{
  "schemaVersion": 1,
  "match": {
    "tickRateHz": 20,
    "maxTicks": 12000,
    "unitCap": 40,
    "mineCap": 3,
    "barracksCap": 3
  }
}
```

- `tickRateHz` 必須等於 `TICK_RATE_HZ`、`maxTicks` 必須等於 12000（§2.1），由測試交叉驗證。
- 開局建築／單位／資源已移到 `factions/test_faction.json`
  （`startBuildings` / `startUnits` / `startResources`），此檔只保留對局上限。

### Zod 驗證（`data` 層）

- `packages/game/src/data/content.test.ts` 逐檔 `JSON.parse` → schema `.parse`，
  失敗即測試失敗，不靜默降級；同時斷言檔案清單恰為上述 10 個。
- 額外把關：id 交叉引用無斷鏈、地圖 180° 對稱、資源點與出生點可通行且互有路徑、
  `counterMatrix` 恆為 1.0、內容數值與 §4–§7 一致。
- 遊戲執行期的載入器沿用同一套 schema，載入失敗即**啟動失敗並顯示錯誤**；
  該載入器在 sim 層需要時實作（本階段只交付 schema + JSON + 測試）。

---

## 14. 分層歸屬

| 資訊 | 歸屬層 |
| --- | --- |
| tick 推進、戰鬥、尋路、勝負 | `sim` |
| 效用函數、影響力地圖、行為樹 | `ai` |
| JSON 載入、Zod 驗證 | `data` |
| PixiJS 繪製 | `render` |
| 文字面板、Policy 滑桿 | `ui` |

`sim` 不得 import PixiJS 或 React（規則 5，由 `architecture.test.ts` 把關）。

---

## 15. MVP 明確不做

以下**全部延後到 MVP 驗證通過之後**，在實作中出現即為範圍膨脹：

**遊戲系統**
- 裝甲、傷害類型、三資源、節奏預設、可調撤退閾值、投降按鈕、維修
- 戰爭迷霧、視野、單位體積碰撞

**視覺與圖表**
- 四象限圖表、熱力圖、影響力地圖可視化、uPlot、像素風圖表
  （**遊戲本體仍是像素風**，此處只禁止像素風的圖表元件）

**工具與 meta**
- 地圖編輯器、平衡工具、元 AI、反事實建議、統計檢定

**平台**
- Content Pack、Postgres、CDN、帳號與多人對戰

---

## 16. 驗收

**規格層**

- [ ] 讀完本文能回答：資源怎麼來、兩個單位差在哪、5 個滑桿各改變什麼、
      AI 三層各做什麼、怎麼贏、面板顯示什麼。
- [ ] 本文的每個數值都有明確單位，無「待定」「暫時」「TODO」。
- [ ] §15 與規則 11、12 的不做清單一致，可直接用來擋下範圍膨脹。

**實作層（後續 prompt）**

- [ ] `pnpm dev` 可啟動、`pnpm test` 通過。
- [ ] §2.1 的所有排程皆為整數 tick。
- [ ] 相同種子 + 相同滑桿序列 → 逐 tick 狀態位元組相同。
