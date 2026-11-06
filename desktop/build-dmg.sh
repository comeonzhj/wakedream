#!/usr/bin/env bash
# 打 macOS 的 .dmg。
#
# 为什么不直接用 `tauri build` 的 dmg 步骤：那一步内部调 create-dmg，会用 osascript 驱动 Finder
# 摆放图标坐标——在没有「自动化」权限的环境（本机、以及任何无 GUI 会话的 CI）里会**一直挂住**，
# 表现为 .app 早就生成好、命令却永远不返回。所以这里用 hdiutil 直接出一个功能等价的 dmg：
# 卷名、WakeDream.app、Applications 软链、卷图标都在，差别只是没有「图标坐标美化」那一步。
#
# 如果确实想要 Tauri 那版（有坐标美化），在有 Finder 自动化权限的机器上：
#   cd app && ./desktop/node_modules/.bin/tauri build --bundles app,dmg
# 或者用 tauri 生成好的脚本跳过着色步骤（--skip-jenkins 是 create-dmg 自带的开关）：
#   cd app/src-tauri/target/release/bundle/macos
#   ../dmg/bundle_dmg.sh --volname WakeDream --icon WakeDream.app 180 170 \
#     --app-drop-link 480 170 --window-size 660 400 --hide-extension WakeDream.app \
#     --volicon ../dmg/icon.icns --skip-jenkins WakeDream_<版本>_<triple>.dmg WakeDream.app
#
# 用法：./desktop/build-dmg.sh [--app <WakeDream.app 路径>] [--out <dmg 路径>]
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"

APP="src-tauri/target/release/bundle/macos/WakeDream.app"
VERSION="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
RUSTC="${RUSTC:-$HOME/.cargo/bin/rustc}"
TRIPLE="$("$RUSTC" -vV | awk '/^host:/{print $2}')"
OUT="src-tauri/target/release/bundle/dmg/WakeDream_${VERSION}_${TRIPLE}.dmg"

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
done

[ -d "$APP" ] || { echo "找不到 $APP：先跑 ./desktop/node_modules/.bin/tauri build --bundles app" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
# 卷图标：Finder 只在卷设置了 custom-icon 位时才显示；SetFile 属于 Xcode CLT，有就用
[ -f src-tauri/icons/icon.icns ] && cp src-tauri/icons/icon.icns "$STAGE/.VolumeIcon.icns"
if command -v SetFile >/dev/null 2>&1; then
  SetFile -a C "$STAGE" || true
fi

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
echo "· 打包 $APP（$(du -sh "$APP" | cut -f1)）→ $OUT"
hdiutil create -volname WakeDream -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$OUT" >/dev/null
echo "✓ dmg：$OUT（$(du -h "$OUT" | cut -f1)）"

# 自检：挂上、确认里面真有 .app 与 Applications 软链、再卸掉
MOUNT="$(hdiutil attach -nobrowse -readonly "$OUT" | awk '/\/Volumes\//{print $NF}' | tail -1)"
trap 'hdiutil detach "$MOUNT" >/dev/null 2>&1 || true; rm -rf "$STAGE"' EXIT
test -d "$MOUNT/WakeDream.app" || { echo "dmg 里没有 WakeDream.app" >&2; exit 1; }
test -L "$MOUNT/Applications" || { echo "dmg 里没有 Applications 软链" >&2; exit 1; }
echo "✓ 自检通过：$MOUNT 里有 WakeDream.app 与 Applications 软链"
hdiutil detach "$MOUNT" >/dev/null
echo "✓ dmg 就绪：$APP_DIR/$OUT"
