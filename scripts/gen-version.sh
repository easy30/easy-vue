#!/bin/sh
# 从 VERSION 生成 src/version.ts（单一事实来源 → 编译期注入二进制）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="$(cat "$ROOT/VERSION" | tr -d '[:space:]')"
if [ -z "$V" ]; then
  echo "error: VERSION is empty" >&2
  exit 1
fi
cat > "$ROOT/src/version.ts" <<EOF
// 由 VERSION 文件生成（scripts/gen-version.sh），勿手改。
// 单一事实来源：仓库根目录 VERSION（唯一出处）。统一带 v 前缀，如 v1.2.0。
// git tag 也用同一版本号（v 开头），保证 tag 与二进制内置版本一致。
export const EASY_VUE_VERSION = '$V';
EOF
echo "version=${V} -> src/version.ts"
