#!/usr/bin/env bash
# 安装夜间做梦定时任务（macOS launchd）。用法：scripts/install-nightly.sh [HH:MM] [store]
# 例：scripts/install-nightly.sh 03:30 default
set -euo pipefail

AT="${1:-03:30}"
STORE="${2:-default}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
LABEL="cool.wakedream.nightly"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="${WAKEDREAM_HOME:-$HOME/.wakedream}/logs"

if [ -z "$NODE_BIN" ]; then echo "找不到 node，请先安装 Node.js ≥ 22.5" >&2; exit 1; fi
if [ "$(uname)" != "Darwin" ]; then
  echo "非 macOS。请把下面这行加进 crontab -e：" >&2
  echo "  $(echo "$AT" | awk -F: '{print $2" "$1}') * * * cd $APP_DIR && $NODE_BIN bin/dream.js >> $LOG_DIR/dream.log 2>&1" >&2
  exit 1
fi

HH="${AT%%:*}"; MM="${AT##*:}"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_DIR/bin/dream.js</string>
    <string>--force</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$((10#$HH))</integer><key>Minute</key><integer>$((10#$MM))</integer></dict>
  <key>StandardOutPath</key><string>$LOG_DIR/dream.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/dream.err.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "已安装夜间做梦任务：每天 $AT 跑 $APP_DIR/bin/dream.js（store=$STORE）"
echo "日志：$LOG_DIR/dream.log"
echo "立即试跑：launchctl start $LABEL"
echo "卸载：scripts/uninstall-nightly.sh"
