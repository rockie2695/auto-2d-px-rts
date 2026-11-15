# DB ↔ 內容檔對應（階段四 Prompt 1）

資料源從 JSON 檔遷移到 Postgres（Neon 遠端庫）。
`packages/server` 負責 schema（node-pg-migrate）、seed（JSON → DB）、
export（DB → `packages/game/public/data-db/`）與 publish（DB → Content Pack
`packages/game/public/packs/`）。遊戲 loader 優先讀 `/packs/latest/pack.json`
（含 hash 驗證），載入不到才回退 `/data-db`；seed 來源 JSON 在
`packages/server/seed-data/`。

## 指令

| 指令                | 說明 |
| ------------------- | ---- |
| `pnpm build:pack`   | DB draft pack → Content Pack 三件套（pack.json／atlas.png／frames.json）→ 標記 published＋active |
| `pnpm rollback <v>` | 把某個 published pack 設為 active（draft 拒絕） |
| `pnpm api`          | 迷你 publish API（`POST /api/publish/latest`、`GET /api/active-pack`，預設埠 3000） |
| `pnpm pack:dev`     | 開發一步到位：退回 draft → seed → publish（不需常駐 API） |
| `pnpm --filter @auto-2d-px-rts/server db:migrate` | 對 Neon 正式庫跑 migrations（`packages/server/migrations/*.sql`） |
| `pnpm --filter @auto-2d-px-rts/server db:seed`   | 讀 `packages/server/seed-data` JSON → 驗證 → 寫入 draft pack `v0`（冪等，重跑即整包重建；已 published 拒絕覆寫） |
| `pnpm --filter @auto-2d-px-rts/server db:export` | 從 DB 重組內容檔 → `packages/game/public/data-db/` |

- 連線字串：root `.env` 的 `DATABASE_URL`（Neon pooler，`sslmode=verify-full&channel_binding=require`）。
- 測試庫：`neondb_test` 由測試自動建置（`DROP DATABASE ... WITH (FORCE)` → `CREATE` → 全量 migrate → seed），不碰正式庫資料。

## 表格總覽（14 張）

| 表 | 對應內容 | 說明 |
| -- | -------- | ---- |
| `content_packs` | 整包 | `version` UNIQUE（seed 用 `v0`）、`status` CHECK draft/published、`sha256`（排序後原始檔內容的 SHA-256） |
| `resources` | `resources/*.json` | 3 列；PK `(pack_id, id)`；`data` jsonb 存整份檔 JSON |
| `factions` | `factions/*.json` | 1 列；同上 |
| `units` | `units/*.json` | 4 列；同上；另有 `(pack_id, data->>'faction')` 運算式索引 |
| `buildings` | `buildings/*.json` | 6 列；同上；另有 faction 運算式索引 |
| `policies` | `policies.json` ＋ `match.json` | 2 列：id=`'policies'` 與 id=`'match'`（pack 層級 config 共用此表） |
| `maps` | `maps/*.json` | uuid PK；`data` jsonb 為**去除 `tiles`／`resourceNodes`** 後的整份檔；UNIQUE `(pack_id, map_id)` |
| `map_tiles` | `map.tiles` | `layer`（現為 `'terrain'`）＋ `rle_data` bytea（RLE 格式見下）；UNIQUE `(map_id, layer)` |
| `map_resources` | `map.resourceNodes` | 正規化為 `(map_id, x, y, resource_id, amount)`；PK `(map_id, x, y)` |
| `palettes` | （佔位） | MVP 無 palette 檔；seed 建 `default` 一列（colors 借 game 裝甲階層色） |
| `sprites` | （佔位） | MVP 零列（程序繪製）；`palette_id` FK → `palettes.id`，ON DELETE SET NULL |
| `balance_changes` | — | 平衡調整紀錄（索引 `changed_on`）；只建表未填 |
| `balance_snapshots` | — | 平衡快照（索引 `pack_version`）；只建表未填 |
| `meta_ai_models` | — | meta-AI 模型參數；只建表未填 |

所有 FK 皆 `ON DELETE CASCADE`（`sprites.palette_id` 除外）。
`pack_id` 查詢由複合 PK／UNIQUE 前導覆蓋，不另建單欄索引。

## RLE 格式（`map_tiles.rle_data`）

連續三元組 `(value: u8, count: u16 little-endian)`，表示 value 重複 count 次。
編解碼在 `packages/server/src/db/rle.ts`。32×32 地圖 1024 格壓至 99 bytes。

## 已知正規化差異（export vs 原始 JSON）

- **jsonb 不保留 key 順序**：匯出檔的欄位順序與原始檔不同（語意等價）。
- **`resourceNodes` 順序**：DB 正規化後按 `x, y` 排序輸出，與原始檔順序可能不同。
- 兩者皆不影響 Zod 驗證與遊戲行為；`export.test.ts` 的深比對會先正規化再逐格比對。

## Content Pack 發布 pipeline（Prompt 3.5）

`publishPack(version)` 七步：DB 讀表（`buildPackContent`）→ content 以
`PackContentSchema.parse` 正規化（預設值補齊，**hash 與檔案同源**）→ sharp 合成
atlas → `packHash = sha256(canonicalJson(content) + atlasHash)` →
Storage 上傳 → `content_packs` 標記 `published` 並把 `sha256` 改寫為 packHash
（seed 期是來源檔 hash，publish 後是 packHash）→ `active_pack` 指標切到本 pack。

- **Storage 介面**：現行 `LocalDiskStorage` 寫 `packages/game/public/packs/{version}/`
  並鏡像 `latest/`；R2/S3 日後以同介面插入（pipeline 其餘不動）。
- **active 指標**：`active_pack` singleton（migration 0002）；rollback＝指標切回。
- **遊戲端**：`loadPack('/packs/latest')` fetch `pack.json` → Zod 驗證 → **重算 hash**
  比對，不符即丟 `PackHashMismatchError` 拒載；`loadPackWithFallback` 在「載入不到」
  時回退 `/data-db`，但 hash 不符**不**回退（竄改防護）。
- **Replay 一致性**：`ReplayRecord.packVersion/packHash`（可缺）；復盤頁比對 replay
  與載入 pack 的 hash，不一致即拒絕反事實播放並說明原因。
- **atlas 現況**：sprites 為 seed 的佔位色塊（`sprite.color/size`），atlas 只參與
  pack 與 hash，render 仍程序繪製（frames.json 為日後像素 sprite 預留）。
- **另註**：`resetPackToDraft`（`pnpm pack:dev` 用）把已 published 同版本退回 draft
  以利迭代；正式流程不使用（published 唯讀）。

## 載入路徑

- 瀏覽器：`loadContentPackFromFetch('/data-db')`（`loadFromFetch.ts`）——
  直接讀 DB 匯出目錄，不再回退。
- Node（測試／CLI）：`loadContentPackFromDir(...)`，全部指向 `data-db/`。
- 內容檔清單（17 檔）由 `content.test.ts` 的 `EXPECTED_FILES` 與 `loadFromFetch.ts` 的 `MANIFEST` 雙向鎖定。
