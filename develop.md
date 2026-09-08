# easy-vue（开发 / 构建指南）

> 使用指南见 **[README.md](./README.md)**（如何启动、如何调用、deps 配置）。本文件记录 easy-vue 本身的开发、编译、实现细节与踩坑排查。

由 **scriptc**（TS/JS → 原生 C 编译器）编译而成；`.vue` 用 `@vue/compiler-sfc`，`.ts`/`@api` 与 `deps` 摇树用 esbuild（Go 二进制，随包分发，经 `child_process` 调用）。

---

## 一、目录结构

```
easy-vue/
├── src/
│   ├── serve.ts           # 程序入口：serve / convert / deps / --version 模式分发
│   ├── deps.ts            # deps 依赖摇树流水线（配置→扫描→entry→esbuild→产物+缓存）
│   ├── esbuild-bin.ts     # esbuild 可执行文件定位（serve 与 deps 共用）
│   ├── version.ts         # 由 VERSION 生成（scripts/gen-version.sh），勿手改
│   ├── esbuild_cli.ts     # 测试脚本：验证 child_process 调 esbuild 的通路
│   └── stub.ts            # 测试脚本：验证 esbuild transformSync 通路
├── bin/                   # 全部编译产物集中于此（exe / 中间 .c，均可再生成）
├── win/                   # Windows 交叉编译 shim + wrapper + 一键脚本
├── scripts/gen-version.sh # 构建前从 VERSION 生成 src/version.ts
├── node_modules/          # 依赖：@vue/compiler-sfc、esbuild、scriptc@0.0.33（固定）
├── demo/                  # 集成演示：python-minimal（最简）/ python（FastAPI 完整版）
├── api-demo.ts            # 测试样例（含 @api 装饰器）
└── demo.vue               # 测试样例
```

---

## 二、模块说明

### 入口 `src/serve.ts`

模式由参数区分：

- **`serve [host:]port`** — HTTP 常驻（必须显式端口，缺省绑 127.0.0.1）；`POST /compile`。serve 模式**绝不读服务器本地文件**（安全模型：只接受 source）。
- **`convert`** — 一次性 stdin→stdout 即退出；本地可信模式，允许按 filename 读文件。
- **`deps -c <配置.json> [--force]`** — 依赖摇树（见「四、deps 实现要点」）；本地可信模式，读配置指定的本地路径。
- **`--version` / `version`** — 打印版本（版本号唯一出处是仓库根 `VERSION`，构建时经 `scripts/gen-version.sh` 注入 `src/version.ts`）。

**无状态**：编译请求不缓存（缓存策略由调用方决定）。

**样式注入**：vue 请求**缺省即注入**（`"style":"separate"` 显式关闭）：`.vue` 的 `<style>` 编译结果以幂等 IIFE 编进 js 尾部（注入位置在 sourcemap 注释**之前**，保证 `sourceMappingURL` 仍在末行），响应**不含** css 字段（避免双份传输）；`separate` 模式样式走响应 `css` 字段（供独立 .css 文件场景）。注入脚本双保险：①按文件 hash 键（`data-ev-<hash>`）幂等更新，同组件样式变更不叠标签；②内容级查重（所有注入标签带统一标记属性 `data-ev-style`，页面上已有相同 CSS 内容直接跳过——不同组件带相同全局样式块也只留一份）。注意属性选择器不能写 `style[data-ev-]`（连字符结尾非法，querySelectorAll 会抛 SyntaxError），必须用 `data-ev-style`。

**scoped 的三侧一致性（踩过的坑）**：Vue 3.5 的 scopeId 机制是「组件对象挂 `__scopeId`，runtime 渲染时经 `setCurrentRenderingInstance` 读 `instance.type.__scopeId` 再挂到每个 vnode」——**compiler 不产任何 pushScopeId 代码，`__scopeId` 由集成方自己追加**（参照 plugin-vue `attachedProps` 做法）。因此 `compileVue`：
1. 用文件名 hash 生成**文件级** `scopeShort`（所有 style 块共用，不带块序号）；
2. `compileStyle({ id: scopeShort })` 产 `[data-v-<hash>]` 选择器；
3. `compileTemplate({ id: scopeShort, scoped: hasScoped })`；
4. `compileScript({ id: scopeShort })`（v-bind CSS 变量前缀 `--<hash>-x` 与 CSS 侧一致）；
5. **有 scoped 块时给产物追加 `__sfc__.__scopeId = "data-v-<hash>"`**。
任何一侧 id 不一致（例如旧版用 `ev-<i>` 带块序号、或漏挂 `__scopeId`），scoped 样式都会**静默失效**——没有报错，只能靠运行时验证发现。

### esbuild 定位 `src/esbuild-bin.ts`

优先级：`ESBUILD_BINARY_PATH` 环境变量 → 二进制同目录的 `esbuild`（zip 分发即此布局，`process.argv[1]` 推导）→ PATH 兜底。

---

## 三、编译

### 前置
- **Node ≥ 20**（仅编译期需要；产物运行不需要 Node）
- **scriptc 0.0.33**（已固定在 `node_modules/.bin/scriptc`；⚠️ 勿用 `npx scriptc` 免安装——会拉 0.0.34 有回归）
- **Zig 0.13.0**（本机原生 macOS 不需要；交叉编译其它平台需，https://ziglang.org/download/，解压后 `export PATH=/.../zig-0.13.0:$PATH`）
- **cmake**（本机原生 macOS **必需**——`--dynamic` 首次要配置/编译内嵌 quickjs 引擎；可用 portable 版，见 `mac-local-build.md`；引擎编译产物会缓存，之后不再需要）

### macOS（本机原生，架构随本机）
> 构建前先 `./scripts/gen-version.sh` 从 `VERSION` 生成 `src/version.ts`（把版本号注入二进制）。

```bash
./scripts/gen-version.sh        # 从 VERSION 生成 src/version.ts（版本注入）
node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-vue-bin
```

### 各平台 × 64 位架构（32 位不编）

本机为 macOS x86_64，其它平台/架构用 zig 交叉编译（`zig cc` 当后端）。**全部产物统一输出到 `bin/`**：

| 产物（均在 `bin/`） | 平台 × 架构 | 大小 | 命令（`SCRIPTC_CC=zigcc` + `SCRIPTC_TARGET`） |
|---|---|---|---|
| `easy-vue-mac-arm64` | macOS arm64（Apple Silicon）| ~2.0 MB | `aarch64-macos` |
| `easy-vue-mac-intel` | macOS x86_64（Intel）| ~2.0 MB | `x86_64-macos` |
| `easy-vue-linux` | Linux x86_64 | ~4.9 MB | `x86_64-linux-musl`（纯静态）|
| `easy-vue-linux-arm64` | Linux arm64 | ~5.6 MB | `aarch64-linux-musl` |
| `easy-vue-win-x64.exe` | Windows x86_64 | ~2.3 MB | `win/build-win.sh x64`（见下）|
| `easy-vue-win-arm64.exe` | Windows arm64 | ~2.1 MB | `win/build-win.sh arm64` |

```bash
# 交叉编译示例（macOS/Apple Silicon/Linux 均可一台机器出多目标）
export PATH=/tmp/zig-macos-x86_64-0.13.0:$PATH
SCRIPTC_CC=zigcc SCRIPTC_TARGET=aarch64-macos      node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-vue-mac-arm64
SCRIPTC_CC=zigcc SCRIPTC_TARGET=x86_64-macos      node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-vue-mac-intel
SCRIPTC_CC=zigcc SCRIPTC_TARGET=x86_64-linux-musl node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-vue-linux
SCRIPTC_CC=zigcc SCRIPTC_TARGET=aarch64-linux-musl node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-vue-linux-arm64
```

> **Windows（x86_64 / arm64）**：zig 0.13 自带的 mingw-w64 缺 POSIX 符号（`struct timespec` / `clock_gettime` / `nanosleep`，它们属 winpthread，非 msvcrt），直接 `zig cc` 交叉到 `-windows-gnu` 会失败。**已用一个小 hack 打通**：提供一个 `win/win32_posix_shim.h` 自足补齐这些符号（仅依赖 `windows.h` 的 `GetTickCount64`/`GetSystemTimeAsFileTime`/`Sleep`），再用 `win/zigcc-win-wrapper.sh`（PATH 劫持 `zig`）在 `zig cc` 命令上强制 `-include` 注入，即可在 macOS/Linux 一台机器上交叉出两个 Windows 64 位产物。一键脚本（中间 `.c` 一并落在 `bin/`）：

```bash
# 一键构建（ZIG 缺省自动探测；也可 ZIG=/path/to/zig ./win/build-win.sh）
./win/build-win.sh x64     # 出 bin/easy-vue-win-x64.exe
./win/build-win.sh arm64   # 出 bin/easy-vue-win-arm64.exe
./win/build-win.sh all     # 两个都出
```

> 已产出 **2 个 Windows 64 位产物**：`easy-vue-win-x64.exe`（~2.3 MB）、`easy-vue-win-arm64.exe`（~2.1 MB），PE32+ 格式、导入 `KERNEL32/WS2_32/ADVAPI32/IPHLPAPI` + UCRT（运行机需 Win10/2016+ 或装 VC++ 运行库，与 linux 的 musl 纯静态不同）。
>
> **运行时 esbuild 配套**：Windows 产物还要对应平台的 esbuild 二进制（当前 `node_modules/@esbuild/` 只装了本机 `darwin-x64`）。在目标机获得 win32-x64（或 win32-arm64）的 esbuild，启动前：
> ```bat
> set ESBUILD_BINARY_PATH=C:\path\to\esbuild.exe
> ```
> 或把 `esbuild.exe` 放在 exe 同目录即可。

---

## 四、deps 实现要点（src/deps.ts）

流水线：**读配置 → 扫描源码 → 生成 entry → esbuild --bundle → 原子写产物 + meta.json**。

- **扫描**：递归 `scan.roots`（按扩展名过滤），两类名字取并集——① 模板标签 `<el-xxx>`（经 `componentPrefix` 前缀匹配，Pascal 化成组件名）；② `import { ElXxx } from '<name>'` 具名导入（支持多行与 `as`，取原始名）。再套 `ignore` 剔除。纯字符串 `split` 实现（scriptc 不支持带 `/g` 的 regex 匹配，见「六、踩坑」）。
- **entry 生成**：
  - `deep`（组件库）：每个名字一条深路径 import，同目录合并；目录取 `mappings[name]`，缺省推导 = 剥掉 `El` 前缀后 kebab 化；模块不存在 → 整体报错并列缺失名单（提示「补 mappings 或 ignore」），不静默漏摇。样式按目录去重聚合（`styleTemplate` 命中 `css.mjs`，其内部引 theme-chalk 的 .css，esbuild 提取为独立 CSS）。`default` 导出 install 插件，只注册模板标签里出现的名字；具名导出覆盖全部名单。entry 写入 `mkdtemp` 临时目录，**import 一律绝对路径**（esbuild 按入口文件位置解析相对路径）。
  - `root`（普通 ESM 库）：从包根入口（package.json 的 module > main > index.mjs > index.js）导入扫描到的具名导入。
- **esbuild 调用**：`--bundle --format=esm --platform=browser`，`define` 固定 `process.env.NODE_ENV="production"`；产物 CSS 是 **outfile 的兄弟文件 `out.css`**（不是 `out.js.css`）。
- **原子写**：产物先写 `<file>.tmp-<rand>` 再 `renameSync`，防并发读半截文件；meta.json 同样原子替换。
- **缓存**：`listHash = sha256(...).substring(0,16)`，输入为排序名单 + dep 配置（含 mappings/ignore/esbuild 选项）+ 包版本（packageRoot/package.json）。命中条件：meta.json 中同名记录 listHash 一致 **且** 两份产物文件存在 → 跳过 esbuild（扫描照常）。`--force` 绕过。
- **失败契约**：stdout 一行结果 JSON（`{"ok":true,"results":{...}}`），日志走 stderr；任一 dep 失败即停止后续 dep，exit 1。调用方（如 Maven/CI）以 exit code + ok 字段决定是否采用产物。

---

## 五、水平扩展（多进程）

单进程 `serve` 已可并发（单请求 vue 编译 ~2.7ms）。若单进程并发不够，需水平扩展到多进程 —— **由客户端自行启动多个 `serve` 端口进程**，easy-vue 本身无需改动（无状态，可随意多开）。

### 为什么不在 easy-vue 内部做 worker 池/网关
- easy-vue 是 scriptc 原生二进制，其 `child_process` 仅支持同步 `spawnSync`/`execFileSync`，**没有可靠的异步 spawn / 事件 IPC**，因此无法在单二进制内自托管多个常驻子进程做网关。
- 最简、最稳的水平扩展 = 客户端起多个 `serve` 进程 + 自己调度。

### 客户端如何知道端口（推荐：客户端自己定端口，零读取）

最优雅的方式是**客户端在启动前自己挑一个空闲端口传给 easy-vue**，这样端口天然已知，无需读 stdout、无需额外线程。

**Java（非阻塞，零线程）**
```java
// 1. 自挑一个空闲端口（内网工具可接受极小竞争窗口）
int port;
try (java.net.ServerSocket s = new java.net.ServerSocket(0)) {
    port = s.getLocalPort();
}
// 2. 非阻塞启动 easy-vue，端口已知，输出直接丢弃
ProcessBuilder pb = new ProcessBuilder("./easy-vue", "serve", "127.0.0.1:" + port);
pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
pb.redirectError(ProcessBuilder.Redirect.DISCARD);
Process p = pb.start();            // 非阻塞返回，easy-vue 在子进程常驻
// 3. 直接连 127.0.0.1:port，走现有 EasyVueHttpClient
```

**Python（非阻塞）**
```python
import socket, subprocess

# 1. 自挑一个空闲端口
s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()

# 2. 非阻塞启动，输出丢弃
proc = subprocess.Popen(
    ["./easy-vue", "serve", f"127.0.0.1:{port}"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
# 3. 直接连 127.0.0.1:port
```

**要点**
- 客户端知端口 ⇒ 不用读 stdout/注册文件，不碰管道缓冲与死锁问题，无需额外线程。
- 多开 N 个 `serve` 即 N 核并行（编译是 CPU 密集，N 建议 ≈ CPU 核数）。
- 客户端自己对多个端口做轮询/分发即可（例：easy-vue4j 可扩展为 N 个 `EasyVueHttpClient` 轮询）。

---

## 六、常见问题与踩坑

### scriptc 0.0.33 编译限制（实测确认，写码前先对照）

| 限制 | 症状 | 解法 |
|---|---|---|
| `Object.keys` 无 lowering（SC2020） | 编译报「has no scriptc lowering」 | 名单用 `Set<string>`；分组用「Map 只存标量 + 两遍扫描」；hash 输入直接 `JSON.stringify` |
| `replace(fn)` 回调不支持（SC1120） | 编译报「replacements must be string templates」 | 字符循环拼接，或 `split`/`join` 处理 |
| 带 `/g`/`/y` 的 regex 匹配不支持 | **运行时 Abort**：`match() on a regex with the 'g' or 'y' flag is not supported` | 用 `split` 手工扫描（如 deps 的标签/导入扫描） |
| `string` 返回类型函数不能 `return null` | **运行时** `TypeError: expected string, got object`（`typeof null === 'object'`） | 返回空串哨兵，调用方判真值 |
| Map 存数组，`get()` 后 `push` 不持久化 | 修改静默丢失（any 边界返回副本） | Map 只存标量；数组放独立 `string[]`，用两遍扫描分组 |
| any 值参与字符串拼接（SC1090/SC2001） | 编译报「Error messages of type 'any'」「values of type 'unknown'」 | any 值过 `String()`；`JSON.parse` 后的配置一律走 `any` 局部变量 |
| 宿主对象（如 statSync 的 Stats）存入 any（SC1090） | 编译报「cannot cross the boundary」 | 保持强类型直接用（`const st = statSync(p)` + `st.isDirectory()`） |
| `process.stderr.write` 参数须是 string（SC2020） | 拼接 any 后报「write of non-string data」 | 先赋给 `const line: string = ...` 再 write |
| 嵌套 interface 属性访问收窄受限（SC1090） | 读 `cfg.scan.extensions` 报错 | 局部 `const scanAny: any = cfg.scan` 再取字段（同 serve.ts 对请求对象的处理） |
| 无递归 mkdir | `mkdirSync` 多级目录失败 | 自写 `ensureDir`（逐级 existsSync + mkdirSync） |
| Date 仅支持只读值 | `new Date().toISOString()` 存疑 | 时间戳用 `Date.now()`（deps 的 meta 即此做法） |
| 可用性确认 | `node:crypto`（`createHash('sha256').update(s).digest('hex')`）、`mkdtempSync`/`renameSync`/`readdirSync`/`statSync`、`process.cwd()`、Set/Map/RegExp/test、`execFileSync` 均可用 | — |

### esbuild 相关
- **产物 CSS 文件名**：`--outfile=xxx/out.js` 时 CSS 是兄弟文件 `out.css`，**不是** `out.js.css`——按 `outfile` 去掉 `.js` 后缀再拼 `.css` 找。
- **组件库根入口摇不动**：element-plus 根入口（es/index.mjs）顶层副作用会让 esbuild 保守保留全部组件，多种补丁（PURE 注释、export 预剪、sideEffects 假包）均无效；必须按深路径逐名导入（deps 的 deep 策略即为此设计）。

### scriptc 版本
- 固定 **0.0.33**（`node_modules/.bin/scriptc`），勿 `npx scriptc`——0.0.34 有 sourcemap 回归。

### 运行环境
- **macOS/Linux**：「无执行权限」先 `chmod +x easy-vue`。
- **Windows**：产物依赖 UCRT，需 Win10/2016+ 或装 VC++ 运行库；esbuild 需对应 win32 平台二进制（`ESBUILD_BINARY_PATH` 或同目录）。
- **工程位置**：源码工程勿放 `/tmp` 下（重启丢失）。
- **esbuild 定位**排查顺序：`ESBUILD_BINARY_PATH` → exe 同目录 → PATH；`deps`/`convert`/`serve` 共用同一套定位逻辑（`src/esbuild-bin.ts`）。

---

## 相关文档

- [README.md](./README.md) — 使用指南（启动、调用协议、deps 配置）
- [RELEASE.md](./RELEASE.md) — 版本发布流程（zip 打包、tag）
- [mac-local-build.md](./mac-local-build.md) — 本机 portable cmake 环境搭建
- [todo.md](./todo.md) — 待办
