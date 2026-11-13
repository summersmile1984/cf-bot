#!/bin/sh
# 获取 cua sidecar（Tauri externalBin，src-tauri/bin/cua-<triple>）。
# 本机已装 cua 则复制并 thin 到当前架构；198MB 级不进 git。
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)/apps/l2-desktop/src-tauri/bin"
mkdir -p "$DIR"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin" ;;
  *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac
OUT="$DIR/cua-$TRIPLE"
if [ -x "$OUT" ] && [ -s "$OUT" ]; then echo "sidecar present: $OUT ($(du -h "$OUT" | cut -f1))"; exit 0; fi
SRC="${CUA_SRC:-$HOME/.local/bin/cua}"
if [ ! -x "$SRC" ]; then
  echo "cua not found at $SRC — install via https://cua.ai (install.sh) or set CUA_SRC"; exit 1
fi
cp "$SRC" "$OUT"
lipo -thin "$ARCH" "$OUT" -output "$OUT" 2>/dev/null || true
chmod +x "$OUT"
echo "sidecar ready: $OUT ($(du -h "$OUT" | cut -f1))"
