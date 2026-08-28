# easy-front

免 Node 的前端单文件编译器（原生二进制）。把 `.vue` / `.ts` / `@api` 源码编译成浏览器可直接运行的 ESM JS，**产物不依赖 Node、运行时无 node**，任何后端语言（Java / Python / Go…）都能通过 stdin/stdout JSON 协议调用。

由 **scriptc**（TS/JS → 原生 C 编译器）编译而成；`.vue` 用 `@vue/compiler-sfc`，`.ts`/`@api` 用 esbuild（Go 二进制，随包分发，经 `child_process` 调用）。

---

## 目录结构

```
easy-front/
├── src/serve.ts            # 程序入口（stdin/stdout JSON 常驻协议）
├── bin/                  # 全部编译产物集中于此（exe / 中间 .c / pdb，均可再生成）
├── win/                  # Windows 交叉编译 shim + wrapper + 一键脚本
├── node_modules/         # 依赖：@vue/compiler-sfc、esbuild、scriptc@0.0.33
├── api-demo.ts          # 测试样例（含 @api 装饰器）
└── demo.vue            # 测试样例
```

---

## 一、程序入口

入口是 `src/serve.ts`，编译为**免 Node 原生二进制**，两种模式由参数区分：

- **`serve [host:]port`** — **HTTP 常驻**服务：**必须显式指定端口**（无默认，避免冲突），`POST /compile` 编译并返回 JSON。缺省绑定 `127.0.0.1`（仅本机，安全）；远程访问须 `0.0.0.0:port`。**调用方用标准 HTTP client（可并发、可设超时、可中断），无管道僵死风险**。
- **`convert`** — **一次性**：从 stdin 读一行请求 JSON → 编译 → 写一行响应 JSON → **退出**（不常驻）。适合单次调用；多次调用建议用 `serve`（避免反复起进程）。

```
easy-front serve 127.0.0.1:9000   # 本机，显式端口
easy-front serve 0.0.0.0:9000     # 远程访问
easy-front convert           # 一次性 stdin→stdout
```

**无状态**：每次请求都重新编译，不缓存（缓存策略由调用方决定，如 Java 的 `VueCache`）。

---

## 二、编译

### 前置
- **Node ≥ 20**（仅编译期需要；产物运行不需要 Node）
- **scriptc 0.0.33**（本项目已固定到 `node_modules/.bin/scriptc`；⚠️ 勿用 `npx scriptc` 免安装——会拉 0.0.34 有回归）
- **Zig 0.13.0**（本机原生 macOS 不需要；交叉编译其它平台需，https://ziglang.org/download/，解压后 `export PATH=/.../zig-0.13.0:$PATH`）

### macOS（本机原生，架构随本机）
```bash
node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-front-bin
```

### 各平台 × 64 位架构（32 位不编）

本机为 macOS x86_64，其它平台/架构用 zig 交叉编译（`zig cc` 当后端）。**全部产物统一输出到 `bin/`**。已产出的 7 个 64 位产物：

| 产物（均在 `bin/`） | 平台 × 架构 | 大小 | 命令（`SCRIPTC_CC=zigcc` + `SCRIPTC_TARGET`） |
|---|---|---|---|
| `easy-front-bin` | macOS x86_64（本机原生）| ~2.0 MB | 本机 `--backend c` 直编 |
| `easy-front-mac-arm64` | macOS arm64（Apple Silicon）| ~2.0 MB | `aarch64-macos` |
| `easy-front-mac-intel` | macOS x86_64（Intel）| ~2.0 MB | `x86_64-macos` |
| `easy-front-linux` | Linux x86_64 | ~4.9 MB | `x86_64-linux-musl`（纯静态）|
| `easy-front-linux-arm64` | Linux arm64 | ~5.6 MB | `aarch64-linux-musl` |
| `easy-front-win-x64.exe` | Windows x86_64 | ~2.3 MB | `win/build-win.sh x64`（见 Windows 段落）|
| `easy-front-win-arm64.exe` | Windows arm64 | ~2.1 MB | `win/build-win.sh arm64` |

```bash
# 交叉编译示例（macOS/Apple Silicon/Linux 均可一台机器出多目标）
export PATH=/tmp/zig-macos-x86_64-0.13.0:$PATH
SCRIPTC_CC=zigcc SCRIPTC_TARGET=aarch64-macos      node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-front-mac-arm64
SCRIPTC_CC=zigcc SCRIPTC_TARGET=x86_64-macos      node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-front-mac-intel
SCRIPTC_CC=zigcc SCRIPTC_TARGET=x86_64-linux-musl node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-front-linux
SCRIPTC_CC=zigcc SCRIPTC_TARGET=aarch64-linux-musl node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-front-linux-arm64
```

> **Windows（x86_64 / arm64）**：zig 0.13 自带的 mingw-w64 缺 POSIX 符号（`struct timespec` / `clock_gettime` / `nanosleep`，它们属 winpthread，非 msvcrt），直接 `zig cc` 交叉到 `-windows-gnu` 会失败。**已用一个小 hack 打通**：提供一个 `win/win32_posix_shim.h` 自足补齐这些符号（仅依赖 `windows.h` 的 `GetTickCount64`/`GetSystemTimeAsFileTime`/`Sleep`），再用 `win/zigcc-win-wrapper.sh`（PATH 劫持 `zig`）在 `zig cc` 命令上强制 `-include` 注入，即可在 macOS/Linux 一台机器上交叉出两个 Windows 64 位产物。一键脚本（中间 `.c` 一并落在 `bin/`）：

```bash
# 一键构建（ZIG 缺省自动探测；也可 ZIG=/path/to/zig ./win/build-win.sh）
./win/build-win.sh x64     # 出 bin/easy-front-win-x64.exe
./win/build-win.sh arm64   # 出 bin/easy-front-win-arm64.exe
./win/build-win.sh all     # 两个都出
```

> 已产出 **2 个 Windows 64 位产物**：`easy-front-win-x64.exe`（~2.3 MB）、`easy-front-win-arm64.exe`（~2.1 MB），PE32+ 格式、导入 `KERNEL32/WS2_32/ADVAPI32/IPHLPAPI` + UCRT（运行机需 Win10/2016+ 或装 VC++ 运行库，与 linux 的 musl 纯静态不同）。
>
> **运行时 esbuild 配套**：Windows 产物还要对应平台的 esbuild 二进制（当前 `node_modules/@esbuild/` 只装了本机 `darwin-x64`）。在目标机获得 win32-x64（或 win32-arm64）的 esbuild，启动前：
> ```bat
> set ESBUILD_BINARY_PATH=C:\path\to\esbuild.exe
> ```
> 或把 `esbuild.exe` 放在 exe 同目录即可。

### 运行时配套 esbuild
`easy-front` 运行时通过 **`ESBUILD_BINARY_PATH`** 环境变量（或同名目录下的 `esbuild`）定位 esbuild Go 二进制做 `.ts`/`@api` 转换。分发时带上对应平台的 esbuild 二进制：
```bash
export ESBUILD_BINARY_PATH=/absolute/path/to/esbuild   # 启动前设置
```

---

## 三、调用协议

## 三、调用协议

### 请求体（HTTP `POST /compile` body；`convert` 则把该 JSON 作为 stdin 一行）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 请求 id（可选），成功时随响应回显 |
| `type` | string | `vue` / `ts` / `js`；缺省按 `filename` 扩展名推断 |
| `source` | string | 源码内容（优先） |
| `filename` | string | 文件名/路径：有 `source` 时作名字；无 `source` 时用它读文件（该文件需可读） |
| `sourcemap` | boolean | `true` 时产出内联 sourcemap（默认不产） |

### 响应（JSON）

| 字段 | 说明 |
|---|---|
| `id` | 回显（失败时 `null`） |
| `ok` | 是否成功 |
| `js` | 编译后 JS（尾部可带内联 sourcemap 注释） |
| `css` | `.vue` 的 `<style>` 编译结果（仅 vue 且有样式时） |
| `error` | 失败信息（`ok=false` 时） |

### 一次性 convert 例子

```bash
echo '{"type":"vue","source":"<template><div>{{n}}</div></template>\\n<script setup>\\nconst n=ref(1)\\n</script>","filename":"views/hello.vue"}' | ./bin/easy-front-bin convert
# → {"id":null,"ok":true,"js":"...","css":""}
```

错误（文件不存在）：`echo '{"filename":"/no/such.vue"}' | ./bin/easy-front-bin convert` → `{"ok":false,"error":"file not found: /no/such.vue"}`

### HTTP 常驻调用（推荐，多后端/多次复用）

```bash
./bin/easy-front-bin serve &            # 127.0.0.1:9000
curl -s -XPOST 127.0.0.1:9000/compile \
  -d '{"type":"ts","source":"const n: number=1; export default n;"}'
# → {"id":null,"ok":true,"js":"const n = 1;\\n..."}
```

HTTP 模式天然支持并发、可设连接/读超时、可中断 —— 调用方无僵尸风险。Java 用 easy-vue4j 的 `EasyFrontHttpClient`。

---

## 四、sourcemap 说明

- `.ts` → esbuild `--sourcemap=inline`（base64 data URI，`sources: ['<stdin>']`）
- `.vue` → **只映射 `<script>` / `<script setup>` 段**（template/css 不出 map），`sourcesContent` 含完整 .vue 源码。base64 内联进 js 尾部，浏览器 devtools 可直接读 script 源码、断点定位。
- sourcemap 已在 js 内联，调用方无需额外处理，原样返回 js 即可。

---

## 五、与 easy-vue4j 集成

easy-vue4j 通过 `VueCompiler` 接口对接本工具（**HTTP 模式**）：
- `EasyFrontHttpClient`（HTTP `POST /compile`，走 `serve` 常驻；可并发、可设超时、无僵死）

```java
EasyFrontHttpClient ef = new EasyFrontHttpClient("http://127.0.0.1:9000", 5000, 30000);
vueCache.setCompiler(new EasyFrontCompiler(ef));
```

---

## 六、易失提醒
- 本目录如置于 `/tmp` 下重启会丢失；请移到持久目录。
- scriptc 需固定 **0.0.33**（见上文），避免 0.0.34 的 sourcemap 回归。
