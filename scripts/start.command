#!/usr/bin/env bash
# 双击启动（macOS）：起服务并打开浏览器。也可命令行直接跑。
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4680}"
cd "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node.js ≥ 22.5" >&2
  exit 1
fi

echo "WakeDream 启动中…数据目录 ${WAKEDREAM_HOME:-$HOME/.wakedream}"
node src/server/main.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

URL="http://127.0.0.1:$PORT"
if command -v open >/dev/null 2>&1; then open "$URL"; else echo "打开浏览器访问 $URL"; fi
echo "服务在 $URL（Ctrl+C 退出）"
wait $SERVER_PID
