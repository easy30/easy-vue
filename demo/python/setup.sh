#!/bin/sh
# 一键准备 python demo 运行环境：
#   1) vendor/ 下载 vue / vue-router 的 ESM（浏览器 import map 用）
#   2) bin/    放置 easy-vue 可执行文件（优先用仓库 bin/ 里的，否则从 GitHub Release 下载）
#   3) .venv   创建虚拟环境并安装 fastapi/uvicorn
set -e
cd "$(dirname "$0")"

echo "== 1/3 下载前端运行库 (vue @ unpkg) =="
mkdir -p static/vendor
curl -fsSL -o static/vendor/vue.esm-browser.js          https://unpkg.com/vue@3.5.31/dist/vue.esm-browser.js
curl -fsSL -o static/vendor/vue-router.esm-browser.js   https://unpkg.com/vue-router@4.6.4/dist/vue-router.esm-browser.js
echo "   vue:      $(wc -c < static/vendor/vue.esm-browser.js) bytes"
echo "   vue-router: $(wc -c < static/vendor/vue-router.esm-browser.js) bytes"

echo "== 2/3 准备 easy-vue 可执行文件 =="
mkdir -p bin
if [ -x ../../bin/easy-vue-bin ]; then
  cp ../../bin/easy-vue-bin bin/easy-vue-bin
  echo "   复用仓库 bin/easy-vue-bin"
elif [ ! -x bin/easy-vue-bin ]; then
  # macOS Apple Silicon 示例；其它平台从 https://github.com/easy30/easy-vue/releases 对应 zip 解压
  echo "   未找到本地 easy-vue，请从 https://github.com/easy30/easy-vue/releases 下载对应平台 zip 解压到 bin/"
  echo "   （示例下载 macOS arm64：）"
  echo "   curl -fsSL -o /tmp/ev.zip https://github.com/easy30/easy-vue/releases/latest/download/easy-vue-mac-arm64.zip"
  echo "   unzip -o /tmp/ev.zip -d bin/"
  exit 0
fi

echo "== 3/3 创建虚拟环境并安装依赖 =="
python3 -m venv .venv
./.venv/bin/pip install -q -r requirements.txt
echo
echo "完成！启动："
echo "  ./.venv/bin/uvicorn main:app --port 8001 --reload"
echo "  然后浏览器打开 http://127.0.0.1:8001/"
