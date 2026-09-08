# easy-vue

**免 Node 的前端单文件编译器（原生二进制）。** 把 `.vue` / `.ts` / `@api` 源码编译成浏览器可直接运行的 ESM JS，不依赖 Node 运行时，任何后端语言（Java / Python / Go…）都能通过 HTTP 或 stdin/stdout 调用。另带 `deps` 子命令：构建期对组件库做依赖摇树，大幅削减 vendor 体积。

> 开发 / 构建 / 踩坑排查等细节见 **[develop.md](./develop.md)**。

---

## 一、获取

### 方式 A：GitHub Release（推荐，免编译）

从 https://github.com/easy30/easy-vue/releases 下载**对应你平台**的 zip 包：

| zip | 平台 |
|---|---|
| `easy-vue-mac-arm64.zip` | macOS Apple Silicon |
| `easy-vue-mac-intel.zip` | macOS Intel |
| `easy-vue-linux.zip` | Linux x86_64 |
| `easy-vue-linux-arm64.zip` | Linux arm64 |
| `easy-vue-win-x64.zip` | Windows x86_64 |
| `easy-vue-win-arm64.zip` | Windows arm64 |

每个 zip 内含 `easy-vue`（或 `easy-vue.exe`）可执行文件，**同一目录还有 `esbuild`**（编译 `.ts` / `@api` 用）。解压后二者保持在同一目录即可（easy-vue 会自动探测同目录 esbuild，无需配置；也可用 `ESBUILD_BINARY_PATH` 显式指定）。

> macOS/Linux 上如遇「无执行权限」，先 `chmod +x easy-vue`。

### 方式 B：自行编译

见 `develop.md`（需要 Node + scriptc + cmake，交叉平台还需 Zig）。

---

## 二、命令总览

| 命令 | 用途 |
|---|---|
| `serve [host:]port` | **HTTP 常驻编译服务**（推荐，可并发、可设超时、可多次复用）。必须显式指定端口；缺省绑定 `127.0.0.1`（仅本机），远程访问用 `0.0.0.0:port` |
| `convert` | **一次性编译**：stdin 读一行 JSON → 编译 → stdout 出一行 JSON → 退出 |
| `deps -c <配置.json> [--force]` | **依赖摇树**：扫描源码 → esbuild 摇树 → 产物 js/css + meta.json（详见第五章） |
| `--version` | 打印内置版本号后退出（如 `easy-vue v1.2.2`） |

```bash
# 本机 HTTP 常驻（端口 9000）
./easy-vue serve 127.0.0.1:9000

# 远程可访问
./easy-vue serve 0.0.0.0:9000

# 一次性（stdin → stdout）
./easy-vue convert

# 依赖摇树
./easy-vue deps -c easy-vue-deps.json
```

**无状态**：编译不缓存（缓存策略由调用方决定）；`deps` 自带 listHash 产物缓存。

---

## 三、编译协议（serve / convert）

### 请求体（`POST /compile`；`convert` 则作为 stdin 的一行 JSON）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 请求 id（可选），成功时随响应回显 |
| `type` | string | `vue` / `ts` / `js`；缺省按 `filename` 扩展名推断 |
| `source` | string | 源码内容（优先） |
| `filename` | string | 文件名/路径：用作编译时的名字（`__name` / sourcemap / type 推断）。有 `source` 时必须带；**serve(HTTP) 模式只允许这种方式**，绝不按 filename 读服务器本地文件 |
| `sourcemap` | boolean | `true` 时产出内联 sourcemap（默认不产） |
| `style` | string | 样式产出方式。**缺省即 `"inject"`**：`.vue` 的 `<style>` 编译结果以幂等脚本编进 js（浏览器运行时自动插 `<style>` 标签，SSR 安全、同组件/同内容不重复插标签），响应**不含** css 字段；显式传 `"separate"` 时样式走响应的 `css` 字段（供要独立 .css 文件的调用方） |

### 响应（JSON）

| 字段 | 说明 |
|---|---|
| `id` | 回显（失败时 `null`） |
| `ok` | 是否成功 |
| `js` | 编译后 JS（尾部可带内联 sourcemap 注释） |
| `css` | `.vue` 的 `<style>` 编译结果（仅 vue 且有样式时） |
| `error` | 失败信息（`ok=false` 时） |

### 调用示例

```bash
./easy-vue serve 127.0.0.1:9000 &   # 后台常驻

# 编译一个 .ts
curl -s -XPOST 127.0.0.1:9000/compile \
  -d '{"type":"ts","source":"const n: number=1; export default n;"}'
# → {"id":null,"ok":true,"js":"const n = 1;\n..."}

# 编译一个 .vue（script setup + 样式）
curl -s -XPOST 127.0.0.1:9000/compile \
  -d '{"type":"vue","source":"<template><div>{{n}}</div></template><script setup>const n=1</script>","filename":"views/a.vue"}'
# → {"id":null,"ok":true,"js":"...","css":"..."}

# 一次性 convert
echo '{"type":"vue","source":"<template><div>{{n}}</div></template>","filename":"a.vue"}' | ./easy-vue convert
# → {"id":null,"ok":true,"js":"...","css":""}
```

### 错误示例

```bash
# convert（本地可信）允许无 source 按 filename 读文件；文件不存在时
# → {"id":null,"ok":false,"error":"file not found: /no/such.vue"}

# serve（HTTP）模式：禁止按 filename 读服务器本地文件，只接受 source
curl -s -XPOST 127.0.0.1:9000/compile -d '{"filename":"/no/such.vue"}'
# → {"id":null,"ok":false,"error":"reading server files by \"filename\" is disabled in serve mode; provide \"source\" instead"}
```

---

## 四、sourcemap

- `.ts` → 内联 sourcemap（base64 data URI）。
- `.vue` → 仅映射 `<script>` / `<script setup>` 段，`sourcesContent` 含完整 .vue 源码，浏览器 devtools 可直接读源码、断点定位。
- sourcemap 已内联进 js，调用方无需额外处理，**原样返回 js 即可**。

---

## 五、依赖摇树（deps）

构建期把组件库按「实际用到的名字」摇树打包成 lite 产物，替换 importmap 里的全量包。典型收益：element-plus 全量 vendor JS 1.9MB → lite 417KB（gzip 438KB → 134KB），CSS 同步瘦身；扫描不到的名字（未使用的组件）不会进入产物。

### 工作流程

扫描源码（模板标签 + 具名导入）→ 生成 entry → `esbuild --bundle --format=esm` 摇树 → 产物 js/css + `meta.json` 写入 `outputDir`（临时文件 + rename 原子替换）。

- **结果契约**：stdout 输出一行 JSON `{"ok":true,"results":{...}}`（同 convert 风格），进度日志走 stderr；exit 0 成功 / 1 失败。任一 dep 失败即整体失败并停止（调用方可据此整体回退，避免半新半旧）。
- **缓存**：`listHash = hash(排序名单 + dep 配置 + 包版本)`，与 `meta.json` 中记录一致且两份产物都存在 → 跳过 esbuild（扫描照常执行）。`--force` 强制重新生成。

### 配置文件（v1）

相对路径以**配置文件所在目录**为基准。

```jsonc
{
  "version": 1,
  "scan": {
    "roots": ["src/main/resources/static"],   // 必填，递归扫描
    "extensions": [".vue", ".html"]           // 缺省即此值
  },
  "outputDir": "target/classes/static/vendor/gen",  // 必填，产物与 meta.json 输出目录
  "deps": [{
    "name": "element-plus",                        // 裸导入名 = importmap key
    "packageRoot": "node_modules/element-plus",    // npm 包解压根（构建机上存在）
    "strategy": "deep",                            // deep=组件库深路径摇树；缺省 root=普通 ESM 库
    "componentPrefix": "el-",                      // deep：模板标签前缀
    "mappings": {                                  // deep：名字 → 包内目录（覆盖缺省推导）
      "ElAside": "container", "ElHeader": "container", "ElMain": "container",
      "ElDropdownItem": "dropdown", "ElFormItem": "form", "ElOption": "select"
    },
    "ignore": ["ElWatermark"],                     // 从扫描结果剔除的名字
    "styleTemplate": "es/components/{dir}/style/css",  // deep：样式聚合模板；不配则不聚合 CSS
    "output": { "js": "element-plus.lite.mjs", "css": "element-plus.lite.css" }  // 缺省 <name>.lite.*
  }],
  "esbuild": {
    "target": "es2020",          // 缺省 es2020
    "minify": true,              // 缺省 true
    "external": ["vue"]          // 缺省 []；外部依赖不打进产物（vue 应 external）
  }
}
```

### 字段说明

- **deep 策略（组件库）**：按「每个名字一个深路径模块」导入才能精确摇树——组件库根入口的顶层副作用会让 esbuild 保守地保留全部组件（与 Vite 依赖预构建同原理）。名字来自 `<el-xxx>` 标签与 `import { ElXxx } from '<name>'` 并集；目录缺省推导 = 剥掉 `El` 前缀后 kebab 化（`ElTableColumn` → `table-column`），与实际目录不符的（如 `ElAside` 实际在 `container` 目录）用 `mappings` 补，确认不用的用 `ignore` 剔除；缺 mappings 会报错并列出缺失名单，不会静默漏摇。
- **root 策略（普通 ESM 库）**：从包根入口（`package.json` 的 module > main > index.mjs > index.js）导入扫描到的具名导入即可摇树，适合 sideEffects 声明规范的库（如 lodash-es）。
- **产物**：`default` 导出 install 插件（只注册模板标签里出现的组件），具名导出覆盖全部扫描名单，可直接 `app.use(lite)` + `import { ElMessage } from '<lite>'`；`meta.json` 记录每个 dep 的版本、listHash、名单与产物 hash，供集成方做 ETag / 回退判断。
- **vue 保持 external**：产物运行时仍从 importmap 取 `vue`，与宿主共享同一实例。

---

## 六、集成到其他服务

- **Java**：如果是 Java 项目，直接参考 **[easy-vue4j](https://github.com/easy30/easy-vue4j)**（生产级集成：HTTP 常驻 + 多进程轮询 + 编译缓存，`vue4j.easy-vue.path` 配置二进制路径，缺失时自动按平台下载）。
- **Python**：两个现成 demo（都不需要写任何编译逻辑，`.vue` 由 easy-vue 现场编译）：
  - [`demo/python-minimal/`](./demo/python-minimal/) — **最简演示**（推荐先看）：仅 3 个文件，Python 标准库零依赖，`python3 main.py` 后浏览器打开 http://127.0.0.1:8800/ 即跑；
  - [`demo/python/`](./demo/python/) — **完整一体化演示**：FastAPI + Uvicorn，复刻 vue4j 的请求过滤语义（mock API / 路由排除 / 编译缓存 / SPA 兜底），`./setup.sh` + `uvicorn main:app` 即跑。
- **任意后端**：把「启动一个 `serve` 进程 + `POST /compile`」这套协议集成进自己服务即可；多进程水平扩展 = 多开几个 `serve` 端口 + 自己调度（客户端自选端口的具体做法见 [develop.md](./develop.md)「水平扩展」）。
- **依赖摇树产物**：`deps` 输出到磁盘（`outputDir`），构建期调用（如 Maven/Gradle 插件、CI 脚本），运行时按 importmap 映射或网关替换加载 lite 文件即可；`meta.json` 里的 hash 可直接用作 ETag。
