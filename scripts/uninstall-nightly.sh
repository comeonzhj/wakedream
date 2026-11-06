#!/usr/bin/env bash
# 卸载夜间做梦定时任务。用法：scripts/uninstall-nightly.sh
set -euo pipefail
LABEL="cool.wakedream.nightly"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载 $LABEL"
else
  echo "$PLIST 不存在，无需卸载"
fi
