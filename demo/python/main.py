"""easy-vue4j 的 Python 版：FastAPI + Uvicorn + easy-vue 一体化前后端演示。

复刻 easy-vue4j 在 Java/Spring 里做的事：一个 Web 服务同时充当
前后端，浏览器请求 /views/<name>.vue 时，后端现场用 easy-vue 把
.vue 源码编译成 ESM JS 返回；vue/vue-router 本体走 import map 直引。

运行:
    pip install fastapi uvicorn
    uvicorn main:app --port 8001 --reload
    然后浏览器打开 http://127.0.0.1:8001/
"""
import atexit
import fnmatch
import json
import mimetypes
import subprocess
import urllib.request
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, FileResponse

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
COMPILE_CACHE = {}   # {路径: (编译后JS, 源文件mtime)} —— mtime 变了自动失效重编


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


# ---------- 请求分发（单一决策树，对齐 easy-vue4j VueFilterCore.doFilter） ----------
# 不依赖路由注册顺序：所有请求先进这里，按固定优先级判定：
#   1. /api/*           → mock JSON
#   2. 无扩展名(exclude_no_ext) → 静态文件（SPA 路由如 /about；缺省回 index.html）
#   3. EXCLUDE 匹配     → 静态文件（/favicon.ico、*.min.js、/vendor/*、/uploads/* …）
#   4. .vue/.ts/.js     → easy-vue 编译（带缓存）
#   5. 其余             → 静态文件或 404
#
# 「走静态」= _static_file() 以 FileResponse 应答（对齐 servlet forward 交默认
# Servlet 的语义）；SPA 无扩展名路由缺文件时回 index.html。

# 配置（对齐 vue4j 的 vue4j.filter.exclude / exclude-no-ext）
EXCLUDE = ["/favicon.ico", "/robots.txt", "*.min.js", "*.min.css", "/vendor/*", "/uploads/*", "/views/legacy/*"]
EXCLUDE_NO_EXT = True

# mock 数据：前端 fetch('/api/xxx') → 返回 mock.json 里 key=xxx 的 JSON；改 mock 不用动代码。
MOCK = json.loads((STATIC / "mock.json").read_text(encoding="utf-8"))

def _has_ext(path: str) -> bool:
    return "." in path.rsplit("/", 1)[-1]

def _excluded(path: str) -> bool:
    return any(fnmatch.fnmatch(path, pat) for pat in EXCLUDE)

def _static_file(path: str, spa_fallback: bool = False):
    """静态文件服务（对齐 servlet forward 语义）：
    - 存在 → FileResponse（按扩展名给 MIME，.js 强制 text/javascript）
    - spa_fallback=True（无扩展名路由）→ 缺文件时回 index.html（SPA 入口兜底）
    - 否则缺文件 → 404（真实静态资源如 favicon/min.js 不做 SPA 兜底）
    """
    rel = path.lstrip("/")
    p = (STATIC / rel).resolve()
    if not str(p).startswith(str(STATIC.resolve())):   # 防目录穿越
        raise HTTPException(403, "forbidden")
    if p.is_dir():
        p = p / "index.html"
    if not p.is_file():
        if spa_fallback:
            p = STATIC / "index.html"
        else:
            raise HTTPException(404, f"not found: {path}")
    mt = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
    if p.suffix == ".js":
        mt = "text/javascript"   # ESM 模块强制 JS MIME
    return FileResponse(p, media_type=mt)

@app.get("/{path:path}")
def dispatch(path: str):
    # 同步 def：FastAPI 自动放线程池执行，阻塞的编译 HTTP 调用不会卡事件循环。
    full = "/" + path
    # 1. mock API（显式领地，最优先）
    if full.startswith("/api/"):
        key = path[len("api/"):]
        if key not in MOCK:
            raise HTTPException(404, f"mock key not found: {key} (see static/mock.json)")
        return MOCK[key]
    # 2. 无扩展名 → 静态（SPA 路由，缺文件回 index.html）
    if EXCLUDE_NO_EXT and not _has_ext(full):
        return _static_file(full, spa_fallback=True)
    # 3. exclude 匹配 → 静态
    if _excluded(full):
        return _static_file(full)
    # 4. 需要编译的扩展名 → easy-vue
    ext = full.rsplit(".", 1)[-1].lower()
    if ext in ("vue", "ts", "js"):
        return _compile_response(full.lstrip("/"))
    # 5. 其余 → 静态（css/img 等未来资源）
    return _static_file(full)


def _compile_response(rel: str):
    """读 static/<rel> 源码，easy-vue 现场编译成 ESM JS（带 mtime 缓存）。"""
    p = STATIC / rel
    if not p.is_file():
        raise HTTPException(404, "not found: " + rel)
    ext = rel.rsplit(".", 1)[-1].lower()
    source = p.read_text(encoding="utf-8")
    mtime = p.stat().st_mtime
    hit = COMPILE_CACHE.get(rel)
    if hit and hit[1] == mtime:
        return HTMLResponse(hit[0], media_type="text/javascript")
    try:
        res = compile_any(source, rel, ext)
    except Exception as e:
        raise HTTPException(502, f"easy-vue failed: {e}")
    if not res.get("ok"):
        raise HTTPException(422, str(res.get("error")))
    COMPILE_CACHE[rel] = (res["js"], mtime)
    return HTMLResponse(res["js"], media_type="text/javascript")


def compile_any(source: str, filename: str, ext: str):
    """按扩展名编译：vue / ts（含 tsx/jsx）/ js。返回 easy-vue 的 JSON 响应。

    sourcemap=True：easy-vue 会把编译后的 JS 尾部附上内联 sourcemap（base64），
    浏览器 devtools 可直接还原 .vue/ts 原始源码断点。
    """
    typ = {"vue": "vue", "ts": "ts", "js": "js"}[ext]
    data = json.dumps({"type": typ, "source": source, "filename": filename,
                       "sourcemap": True}).encode()
    with urllib.request.urlopen(
        f"http://127.0.0.1:{EV_PORT}/compile", data=data, timeout=15
    ) as r:
        return json.loads(r.read().decode())
