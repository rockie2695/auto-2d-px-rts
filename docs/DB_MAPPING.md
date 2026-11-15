# DB ↔ 內容檔對應（階段四 Prompt 1）

資料源從 `packages/game/public/data/` 的 JSON 檔遷移到 Postgres（Neon 遠端庫）。
`packages/server` 負責 schema（node-pg-migrate）、seed（JSON → DB）與
export（DB → `packages/game/public/data-db/`）。遊戲 loader 優先讀
`/data-db`，探測不到才回退 `/data`。

## 指令

| 指令                | 說明 |
| ------------------- | ---- |
| `pnpm --filter @auto-2d-px-rts/server db:migrate` | 對 Neon 正式庫跑 migrations（`packages/server/migrations/*.sql`） |
| `pnpm --filter @auto-2d-px-rts/server db:seed`   | 讀 seed 來源 JSON → 驗證 → 寫入 draft pack `v0`（冪等，重跑即整包重建；已 published 拒絕覆寫） |
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

## 載入路徑

- 瀏覽器：`loadContentPackFromFetch('/data')` → probe `/data-db/match.json` 成功則整包改讀 `/data-db`，否則回退 `/data`（`loadFromFetch.ts`）。
- Node（測試／CLI）：`loadContentPackFromDir(...)`，Phase E 起指向 `data-db/`。
- 內容檔清單（17 檔）由 `content.test.ts` 的 `EXPECTED_FILES` 與 `loadFromFetch.ts` 的 `MANIFEST` 雙向鎖定。
