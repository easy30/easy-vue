"""easy-vue 最简 Python 演示：标准库起一个「静态 + 现场编译」服务，零第三方依赖。

运行:
    python3 main.py
    浏览器打开 http://127.0.0.1:8800/

前置: easy-vue 可执行文件——按优先级找 bin/easy-vue-bin（本目录）、
      ../../bin/easy-vue-bin（仓库构建产物）、PATH 里的 easy-vue。
      获取方式见仓库 README「一、获取」。

工作方式:
    浏览器请求 /views/home.vue → 本服务读源码 → 调 easy-vue serve(HTTP /compile)
    现场编译成自带样式的 ESM JS（easy-vue 缺省注入样式）；其余路径当静态文件（index.html 等）。
    完整版演示（FastAPI + mock API + 缓存 + 路由过滤）见 ../python/。
"""
import json
import shutil
import socket
import subprocess
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent
WEB_PORT = 8800   # 本演示对外端口
EV_PORT = 9901    # easy-vue 内部 serve 端口（只被本服务调用）


def find_easyvue() -> str:
    for p in [BASE / "bin" / "easy-vue-bin", BASE.parent.parent / "bin" / "easy-vue-bin"]:
        if p.exists():
            return str(p)
    found = shutil.which("easy-vue")
    if found:
        return found
    raise SystemExit("找不到 easy-vue 可执行文件：见仓库 README「一、获取」")


def compile_vue(source: str, filename: str) -> str:
    """调 easy-vue 编译接口，返回自带样式的 JS。

    easy-vue 缺省即注入（style:inject）：.vue 里 <style> 的编译结果以幂等脚本
    编进 js 尾部，浏览器运行时自动插 <style> 标签，无需单独伺服 .css 文件。
    """
    data = json.dumps({"type": "vue", "source": source, "filename": filename}).encode()
    with urllib.request.urlopen(f"http://127.0.0.1:{EV_PORT}/compile", data=data, timeout=10) as r:
        res = json.loads(r.read().decode())
    if not res.get("ok"):
        raise RuntimeError(res.get("error"))
    return res["js"]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kw):
        super().__init__(*args, directory=str(BASE), **kw)   # 静态根 = 本目录

    def _send_vue(self, head_only: bool = False):
        try:
            p = (BASE / self.path.split("?")[0].lstrip("/")).resolve()   # 去查询串
            p.relative_to(BASE)                                          # 防目录穿越（.. / 绝对路径）
        except ValueError:
            self.send_error(404)
            return
        if not p.is_file():
            self.send_error(404)
            return
        try:
            js = compile_vue(p.read_text("utf-8"), p.name).encode()
        except Exception as e:
            self.send_error(502, str(e))
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/javascript")   # ESM 必须 JS MIME
        self.send_header("Cache-Control", "no-cache")         # 开发期改 .vue 即刻生效（无验证字段则浏览器启发式缓存）
        self.send_header("Content-Length", str(len(js)))
        self.end_headers()
        if not head_only:
            self.wfile.write(js)

    def do_GET(self):
        if self.path.split("?")[0].endswith(".vue"):   # 去查询串再判断（?cache-bust 场景）
            self._send_vue()
        else:
            super().do_GET()   # 其余走静态

    def do_HEAD(self):
        if self.path.split("?")[0].endswith(".vue"):
            self._send_vue(head_only=True)
        else:
            super().do_HEAD()


# 启动 easy-vue 常驻子进程（客户端自选端口，无需读其 stdout）
proc = subprocess.Popen([find_easyvue(), "serve", f"127.0.0.1:{EV_PORT}"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(30):                       # 轮询端口就绪（最多 3 秒）
    try:
        socket.create_connection(("127.0.0.1", EV_PORT), timeout=0.1).close()
        break
    except OSError:
        time.sleep(0.1)
else:
    proc.terminate()
    raise SystemExit("easy-vue 启动失败")

try:
    print(f"easy-vue 最简演示: http://127.0.0.1:{WEB_PORT}/  (Ctrl+C 退出)")
    ThreadingHTTPServer(("127.0.0.1", WEB_PORT), Handler).serve_forever()
finally:
    proc.terminate()   # 连带关停 easy-vue 子进程
