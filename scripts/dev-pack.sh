#!/usr/bin/env bash
# 便利腳本（Prompt 3.5）：seed → publish API → 遊戲端最新 pack。
# Windows 使用者可直接跑等價的 `pnpm pack:dev`（不需要常駐 API）。
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"

echo "[1/3] pnpm db:seed（seed data JSON → Postgres）"
pnpm -s db:seed

echo "[2/3] 啟動 publish API（背景）並 POST /api/publish/latest"
pnpm -s --filter @auto-2d-px-rts/server api &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf "http://localhost:${PORT}/api/active-pack" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

curl -sS -X POST "http://localhost:${PORT}/api/publish/latest?version=v0"
echo
curl -sS "http://localhost:${PORT}/api/active-pack"
echo

echo "[3/3] 遊戲端 pack（LocalDiskStorage 已直寫 public/packs/latest/）"
ls -l packages/game/public/packs/latest/

echo "完成：http://localhost:5173/#/pre-game 會讀 /packs/latest/pack.json"
