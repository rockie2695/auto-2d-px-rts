-- 0002_pack_pointer.sql — Prompt 3.5：publish / rollback 的 active pack 指標。
--
-- status 維持 draft / published（published 不可變語意不動）；
-- 「現役 pack」用 singleton 指標表表示：rollback = 把指標切回某個
-- published pack；publish 成功 = 指標切到新發布的 pack。

CREATE TABLE active_pack (
  id          integer PRIMARY KEY CHECK (id = 1),
  pack_id     uuid NOT NULL REFERENCES content_packs (id) ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
