"""easy-vue4j 的 Python 版：FastAPI + Uvicorn + easy-vue 一体化前后端演示。

复刻 easy-vue4j 在 Java/Spring 里做的事：一个 Web 服务同时充当
前后端，浏览器请求 /views/<name>.vue 时，后端现场用 easy-vue 把
.vue 源码编译成 ESM JS 返回；vue 本体走 import map（router 懒加载）。

运行:
    pip install fastapi uvicorn
    uvicorn main:app --port 8001 --reload
    然后浏览器打开 http://127.0.0.1:8001/
"""
import atexit
import json
import subprocess
import urllib.request
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
EASYVUE = BASE / "bin" / "easy-vue-bin"      # easy-vue 可执行文件（见 README）

EV_PORT = 9942   # easy-vue 内部 serve 端口（固定；对外不可见，只被 FastAPI 内部调用）
# 你如果已把 easy-vue 装进 PATH，可用命令行直接调用；这里优先用本目录二进制，
# 缺失时回退到 PATH 里的 easy-vue。
if not EASYVUE.exists():
    from shutil import which
    found = which("easy-vue")
    if found:
        EASYVUE = Path(found)

app = FastAPI(title="Python easy-vue4j demo (FastAPI + Uvicorn + easy-vue)")
proc = None


# ---------- 管理 easy-vue 常驻子进程 ----------
def start_easyvue():
    global proc
    proc = subprocess.Popen(
        [str(EASYVUE), "serve", f"127.0.0.1:{EV_PORT}"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        # 放进独立进程组：Ctrl+C / kill 整个进程组时 easy-vue 会连坐一起退出，
        # 配合 shutdown/atexit 覆盖正常关闭；被 kill -9 单杀父进程时仍需
        # supervisord/systemd 这类进程管理器收割（见 README）。
        start_new_session=True,
    )
    for _ in range(50):
        if "__READY__" in proc.stdout.readline().decode("utf-8", "replace"):
            return
    raise RuntimeError("easy-vue failed to start (check EASYVUE / bin)")

def compile_vue(source: str, filename: str):
    # sourcemap=True：easy-vue 会把编译后的 JS 尾部附上内联 sourcemap（base64），
    # 浏览器 devtools 可直接还原 .vue 原始源码断点。
    data = json.dumps({"type": "vue", "source": source, "filename": filename,
                       "sourcemap": True}).encode()
    with urllib.request.urlopen(
        f"http://127.0.0.1:{EV_PORT}/compile", data=data, timeout=15
    ) as r:
        return json.loads(r.read().decode())


def terminate_easyvue():
    """关停 easy-vue 子进程：先 SIGTERM，等不到再 SIGKILL。"""
    global proc
    p = proc
    if p is not None and p.poll() is None:
        try:
            p.terminate()
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=3)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
    proc = None

@app.on_event("startup")
def _start(): start_easyvue()

@app.on_event("shutdown")
def _stop(): terminate_easyvue()

# 兜底：即使 Uvicorn 被强杀(非正常退出、shutdown 事件没触发)，Python 解释器退出时也会
# 关掉 easy-vue 子进程，避免变成孤儿进程残留占用端口。
atexit.register(terminate_easyvue)


BODY = """<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"vue":"/vendor/vue.esm-browser.js",
"vue-router":"/vendor/vue-router.esm-browser.js",
"@vue/devtools-api":"/vendor/devtools-api.js"}}</script>
<style>body{font-family:sans-serif;margin:40px}nav a{margin-right:12px}</style>
</head><body>
<nav><a href="#/">Home</a> | <a href="#/about">About</a></nav>
<div id="app"></div>
<script type="module">
import { createApp, h } from 'vue';
import { createRouter, createWebHashHistory, RouterView } from 'vue-router';
import Home  from '/views/home.vue';      /* ← 后端现场把 .vue 编译成 JS */
import About from '/views/about.vue';
const router = createRouter({ history: createWebHashHistory(),
  routes: [{ path: '/', component: Home }, { path: '/about', component: About }] });
// 根组件必须渲染 <router-view>，否则路由匹配到的组件无处挂载会渲染成空。
createApp({ render: () => h(RouterView) }).use(router).mount('#app');
</script></body></html>"""


@app.get("/", response_class=HTMLResponse)
def index(): return BODY


@app.get("/views/{name}")
def view(name: str):
    p = STATIC / "views" / name
    if not p.is_file():
        raise HTTPException(404, "view not found: " + name)
    try:
        res = compile_vue(p.read_text(encoding="utf-8"), f"views/{name}")
    except Exception as e:
        raise HTTPException(502, f"easy-vue failed: {e}")
    if not res.get("ok"):
        raise HTTPException(422, str(res.get("error")))
    # 必须用 text/javascript：<script type="module"> 对 ESM 强制要求 JS MIME，
    # text/html 会导致浏览器拒绝加载（Strict MIME type checking）。
    return HTMLResponse(res["js"], media_type="text/javascript")


@app.get("/vendor/{f}")
def vendor(f: str):
    p = STATIC / "vendor" / f
    if not p.is_file(): raise HTTPException(404)
    ct = "text/javascript" if f.endswith(".js") else "text/plain"
    return HTMLResponse(p.read_text(encoding="utf-8"), media_type=ct)


@app.get("/api/title")
def api_title():
    return {"title": "hello from FastAPI backend (Python easy-vue4j)"}
