#!/bin/bash
# =============================================================================
# easy-front · 在 macOS/Linux 上交叉编译出 Windows (x64/arm64) 产物
#
# 背景：zig 0.13 自带的 mingw-w64 缺 POSIX 符号(struct timespec/clock_gettime/
#       nanosleep),scriptc 交叉到 -windows-gnu 直接编译失败。本脚本用一个
#       win32_posix_shim.h 补齐,再用 zig wrapper (zigcc-win-wrapper.sh) 在
#       `zig cc` 命令上强制 -include 注入,即可在 macOS/Linux 上出 .exe。
#
# 用法:
#   ZIG=/path/to/zig-0.13.0/zig ./build-win.sh [x64|arm64|all]
#   # 默认 all;ZIG 缺省自动探测 PATH 与 /tmp
# 产物:
#   bin/easy-front-win-x64.exe   bin/easy-front-win-arm64.exe
#   （中间 .c 随 exe 一并落在 bin/，不入根路径）
# =============================================================================
set -euo pipefail

# 定位本项目根
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/bin"
SHIM="$HERE/win32_posix_shim.h"
WRAP="$HERE/zigcc-win-wrapper.sh"
mkdir -p "$OUT"

# 真实 zig 路径
ZIG="${ZIG:-}"
if [ -z "$ZIG" ]; then
  if command -v zig >/dev/null 2>&1; then ZIG="$(command -v zig)";
  elif [ -x /tmp/zig-macos-x86_64-0.13.0/zig ]; then ZIG=/tmp/zig-macos-x86_64-0.13.0/zig;
  else echo "!! 未找到 zig。请装 zig 0.13.0 并 ZIG=/path/to/zig $0"; exit 1; fi
fi
"$ZIG" version >/dev/null 2>&1 || { echo "!! 无法执行 zig: $ZIG"; exit 1; }
echo "using zig: $ZIG"

# 生成 wrapper(内联替换掉 zig 路径)
WRAP_TMP="$(mktemp)"
sed "s|^REAL_ZIG=.*|REAL_ZIG=\"$ZIG\"|; s|^SHIM=.*|SHIM=\"$SHIM\"|" "$WRAP" > "$WRAP_TMP"
chmod +x "$WRAP_TMP"
wrapdir="$(mktemp -d)"
cp "$WRAP_TMP" "$wrapdir/zig"
export PATH="$wrapdir:$PATH"

TARGET="${1:-all}"
build () {
  local t="$1" out="$2"
  echo "==== 编译 $t -> $out ===="
  ( cd "$ROOT" && \
    SCRIPTC_CC=zigcc SCRIPTC_TARGET="$t" \
      node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o "$out" )
  file "$out"
}
if [ "$TARGET" = all ] || [ "$TARGET" = x64 ];   then build x86_64-windows-gnu   "$OUT/easy-front-win-x64.exe";   fi
if [ "$TARGET" = all ] || [ "$TARGET" = arm64 ]; then build aarch64-windows-gnu  "$OUT/easy-front-win-arm64.exe"; fi

rm -f "$WRAP_TMP"; rm -rf "$wrapdir"
echo "完成 ✓  产物见 $OUT/easy-front-win-{x64,arm64}.exe"
