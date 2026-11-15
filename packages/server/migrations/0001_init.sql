-- 0001_init.sql — 階段四 Prompt 1：內容資料源從 JSON 遷移到 Postgres 的初始 schema。
--
-- 設計要點：
-- - `content_packs` 是唯一根表；draft 可改、published 唯讀（status CHECK + 應用層守門）。
-- - 內容表（resources/factions/units/buildings/policies/palettes）以複合 PK/UNIQUE
--   `(pack_id, id)` 前導覆蓋 pack_id 查詢，不另建索引。
-- - `maps` 用 uuid PK，供 `map_tiles` / `map_resources` FK；`tiles` 陣列以 RLE
--   bytea 存進 `map_tiles`，`resourceNodes` 拆成正規化的 `map_resources`。
-- - `balance_changes` / `balance_snapshots` / `meta_ai_models` 為日後平衡與
--   meta-AI 流程預留，本階段只建表不填資料。

-- ------------------------------------------------------------------
-- 1. 根表：內容包
-- ------------------------------------------------------------------
CREATE TABLE content_packs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version     text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'published')),
  sha256      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------
-- 2. 內容表（data jsonb 由應用層以 shared 的 Zod schema 驗證）
-- ------------------------------------------------------------------
CREATE TABLE resources (
  pack_id  uuid NOT NULL REFERENCES content_packs (id) ON DELETE CASCADE,
  id       text NOT NULL,
  data     jsonb NOT NULL,
  PRIMARY KEY (pack_id, id)
);

CREATE TABLE factions (
  pack_id  uuid NOT NULL REFERENCES content_packs (id) ON DELETE CASCADE,
  id       text NOT NULL,
  data     jsonb NOT NULL,
  PRIMARY KEY (pack_id, id)
);

CREATE TABLE units (
  pack_id  uuid NOT NULL REFERENCES content_packs (id) ON DELETE CASCADE,
  id       text NOT NULL,
  data     jsonb NOT NULL,
  PRIMARY KEY (pack_id, id)
);

CREATE TABLE buildings (
  pack_id  uuid NOT NULL REFERENCES content_packs (id) ON DELETE CASCADE,
  id       text NOT NULL,
  data     jsonb NOT NULL,
  PRIMARY KEY (pack_id, id)
);

CREATE TABLE policies (
  pack_id  uuid NOT NULL REFERENCES content_packs (id) ON DELETE CASCADE,
  id       text NOT NULL,
  data     jsonb NOT NULL,
  PRIMARY KEY (pack_id, id)
);

-- 常用查詢：某 pack 內依所屬勢力篩單位／建築（jsonb 運算式索引）。
CREATE INDEX units_faction_idx ON units (pack_id, (data->>'faction'));
CREATE INDEX buildings_faction_idx ON buildings (pack_id, (data->>'faction'));

-- ------------------------------------------------------------------
-- 3. 地圖：正規化 tiles 與資源節點
-- ------------------------------------------------------------------
CREATE TABLE maps (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id  uuid NOT NULL REFERENCES content_packs (id) ON DELETE CASCADE,
  map_id   text NOT NULL,
  data     jsonb NOT NULL,  -- 去除 tiles / resourceNodes 後的 MapDef
  UNIQUE (pack_id, map_id)
);

CREATE TABLE map_tiles (
  map_id    uuid NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
  layer     text NOT NULL DEFAULT 'terrain',
  rle_data  bytea NOT NULL,   -- Run-length encoded tiles（shared rle codec）
  UNIQUE (map_id, layer)      -- btree 前導即 map_id 索引
);

CREATE TABLE map_resources (
  map_id       uuid NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
  x            integer NOT NULL CHECK (x >= 0),
  y            integer NOT NULL CHECK (y >= 0),
  resource_id  text NOT NULL,
  amount       integer NOT NULL CHECK (amount > 0),
  PRIMARY KEY (map_id, x, y)  -- btree 前導即 map_id 索引
);

-- ------------------------------------------------------------------
-- 4. 視覺資產（MVP 佔位：palettes 一列預設色、sprites 零列）
-- ------------------------------------------------------------------
CREATE TABLE palettes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id     uuid NOT NULL REFERENCES content_packs (id) ON DELETE CASCADE,
  palette_id  text NOT NULL,
  colors      jsonb NOT NULL,
  UNIQUE (pack_id, palette_id)
);

CREATE TABLE sprites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id      uuid NOT NULL REFERENCES content_packs (id) ON DELETE CASCADE,
  sprite_id    text NOT NULL,
  owner_type   text CHECK (owner_type IN ('unit', 'building', 'resource', 'terrain')),
  owner_id     text,
  palette_id   uuid REFERENCES palettes (id) ON DELETE SET NULL,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (pack_id, sprite_id)
);

-- ------------------------------------------------------------------
-- 5. 平衡調整紀錄與快照、meta-AI 模型（本階段只建表）
-- ------------------------------------------------------------------
CREATE TABLE balance_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL
              CHECK (target_type IN ('unit', 'building', 'policy', 'resource', 'map')),
  target_id   text NOT NULL,
  field       text NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  reason      text,
  changed_on  date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX balance_changes_changed_on_idx ON balance_changes (changed_on);

CREATE TABLE balance_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_version  text NOT NULL,
  snapshot      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX balance_snapshots_pack_version_idx ON balance_snapshots (pack_version);

CREATE TABLE meta_ai_models (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  model_version  text NOT NULL,
  params         jsonb NOT NULL,
  trained_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, model_version)
);
