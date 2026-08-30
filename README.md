# easy-vue

**免 Node 的前端单文件编译器（原生二进制）。** 把 `.vue` / `.ts` / `@api` 源码编译成浏览器可直接运行的 ESM JS，不依赖 Node 运行时，任何后端语言（Java / Python / Go…）都能通过 HTTP 或 stdin/stdout 调用。

> 开发 / 构建 / 交叉编译等细节见 **[develop.md](./develop.md)**。

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

每个 zip 内含 `easy-vue`（或 `easy-vue.exe`）可执行文件，**同一目录还有 `esbuild`**（编译 `.ts` / `@api` 用）。解压后二者保持在同一目录即可（easy-vue 会自动探测同目录 esbuild，无需配置）。

> macOS/Linux 上如遇「无执行权限」，先 `chmod +x easy-vue`。

### 方式 B：自行编译

见 `develop.md`（需要 Node + scriptc + cmake，交叉平台还需 Zig）。

---

## 二、启动

easy-vue 有**两种运行模式**（外加一个查询命令）：

- **`serve [host:]port`** — HTTP 常驻服务（**推荐**，可并发、可设超时、可多次复用）。必须显式指定端口；缺省绑定 `127.0.0.1`（仅本机），远程访问用 `0.0.0.0:port`。
- **`convert`** — 一次性：从 stdin 读一行 JSON → 编译 → stdout 出一行 JSON → 退出。
- **`--version` / `version`** — 打印内置版本号后退出（如 `easy-vue v1.2.0`），用于确认二进制版本。

```bash
# 本机 HTTP 常驻（端口 9000）
./easy-vue serve 127.0.0.1:9000

# 远程可访问
./easy-vue serve 0.0.0.0:9000

# 一次性（stdin → stdout）
./easy-vue convert
```

**无状态**：每次请求都重新编译、不缓存（缓存策略由调用方决定）。

**版本**：`./easy-vue --version` 输出内置版本号（如 `easy-vue v1.2.0`）；版本号唯一出处是仓库根目录 `VERSION` 文件，构建时注入二进制（见 RELEASE.md）。

---

## 三、调用协议

### 请求体（`POST /compile`；`convert` 则作为 stdin 的一行 JSON）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 请求 id（可选），成功时随响应回显 |
| `type` | string | `vue` / `ts` / `js`；缺省按 `filename` 扩展名推断 |
| `source` | string | 源码内容（优先） |
| `filename` | string | 文件名/路径：用作编译时的名字（`__name` / sourcemap / type 推断）。有 `source` 时必须带；**serve(HTTP) 模式只允许这种方式**，绝不按 filename 读服务器本地文件 |
| `sourcemap` | boolean | `true` 时产出内联 sourcemap（默认不产） |

### 响应（JSON）

| 字段 | 说明 |
|---|---|
| `id` | 回显（失败时 `null`） |
| `ok` | 是否成功 |
| `js` | 编译后 JS（尾部可带内联 sourcemap 注释） |
| `css` | `.vue` 的 `<style>` 编译结果（仅 vue 且有样式时） |
| `error` | 失败信息（`ok=false` 时） |

---

## 四、调用示例

### HTTP 常驻（推荐）

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
```

### 一次性 convert

```bash
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

## 五、sourcemap

- `.ts` → 内联 sourcemap（base64 data URI）。
- `.vue` → 仅映射 `<script>` / `<script setup>` 段，`sourcesContent` 含完整 .vue 源码，浏览器 devtools 可直接读源码、断点定位。
- sourcemap 已内联进 js，调用方无需额外处理，**原样返回 js 即可**。

---

## 六、集成到其他服务

- **Java**：推荐用 [easy-vue4j](https://github.com/easy30/easy-vue4j)，通过 `vue4j.easy-vue.path` 配置 easy-vue 可执行文件路径（缺失时自动按平台下载），内部用 HTTP 常驻模式调用。
- **任意后端**：把「启动一个 `serve` 进程 + `POST /compile`」这套协议集成进自己服务即可；多进程水平扩展 = 多开几个 `serve` 端口 + 自己调度（见 develop.md）。
