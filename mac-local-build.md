# easy-vue macOS 本机构建指南(mac-local-build.md)

本文件记录 `bin/easy-vue-bin` / `bin/easy-vue-mac-intel` 等 macOS 原生二进制是怎么构建出来的、用到哪些组件、以及如何让下次编译更快。

> 这些 `bin/` 产物已被 `.gitignore` 忽略,不进入版本库;改完 `src/*.ts` 后需按本文重新构建分发。

---

## 一、构建命令(本机 macOS 原生,x86_64 / arm64 随本机)

```bash
# 需要 cmake 在 PATH 上(--dynamic 必需,见下文「为什么要用 cmake」)
export PATH="/path/to/cmake/data/bin:$PATH"

cd /Users/apple/github/easy-vue
node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-vue-bin
```

- 本机原生产物为 `bin/easy-vue-bin`。
- 若本机是 macOS x86_64,可将该产物直接复制为 `bin/easy-vue-mac-intel`(二者同架构):
  ```bash
  cp bin/easy-vue-bin bin/easy-vue-mac-intel
  ```
- 其它平台/架构需交叉编译:用 `zig cc` 当后端并指定 `SCRIPTC_TARGET`(见 README.md「各平台 × 64 位架构」)。

---

## 二、用到了哪些组件 / 工具

| 组件 | 版本/路径 | 作用 |
|------|-----------|------|
| **scriptc** | `node_modules/.bin/scriptc`(0.0.33,已固定) | TS/JS → 原生可执行器的编译器。**生产脚本**。⚠️ 勿用 `npx scriptc` 免安装,会拉到有回归的 0.0.34 |
| **cmake** | 4.x(本机用 portable 版,非 brew) | **仅 `--dynamic` 需要**:用于配置并编译 scriptc **内嵌的 quickjs 引擎**(`@scriptc/runtime/vendor/quickjs-ng`)生成 `libqjs.a`。见 `node_modules/@scriptc/compiler/dist/backend/cc.js:ensureEngineArchive` |
| **clang / cc** | `/usr/bin/clang` / `/usr/bin/cc`(macOS 自带) | 把 scriptc 生成的 C 代码(`bin/serve.c`)编译/链接成 Mach-O |
| **ar / ranlib** | macOS 自带 | 随引擎归档使用 |
| **@vue/compiler-sfc** | npm 依赖 | `.vue` 的解析 / script / template / style 编译(运行时在 `--dynamic` 内嵌引擎里) |
| **@ampproject/remapping** | npm 依赖 | 多级 sourcemap 复合(同上,内嵌引擎运行) |
| **esbuild** | 随包分发(Go 二进制,非本工具链) | `.ts` / `lang=ts` 的 `.vue` 转换(经 `child_process` 同步调用) |

**关键点:`--dynamic` 必须开**。本项目 import 了 `@vue/compiler-sfc`、`@ampproject/remapping`,它们的 JS 实现要在 scriptc 内嵌的 JS 引擎里运行;**静态构建(默认不带 `--dynamic`)不支持导入这些 npm 包,会直接编译失败**(错误 `SC2013: importing '@vue/compiler-sfc' requires the embedded dynamic engine`)。

---

## 三、为什么 "下一次更快" —— cmake 引擎缓存的秘密

`--dynamic` 里的 cmake **只在第一次真跑**,之后会被跳过:

- 流程见 `node_modules/@scriptc/compiler/dist/backend/cc.js:ensureEngineArchive()`:
  ```js
  if (await fileExists(archive)) return archive;   // 缓存命中 → 直接复用,不跑 cmake
  ```
- 缓存里的产物是 **`node_modules/@scriptc/runtime/vendor/.cache/<...>/libqjs.a`**
  (完整路径 = `vendor/.cache/3c8f3d689539-plain-native-darwin-x64-<digest>/libqjs.a`)
- 缓存条目名包含:
  - `native-${hostPlatform}-${hostArch}`(本机为 `native-darwin-x64`)
  - 环境/`clang|cc|ar|ranlib|cmake` 可执行文件身份的 sha256 摘要(见 `vendorCacheBuildIdentity`)

**因此,让后续编译更省时的要点:**

1. **保持 cmake / clang 在这个 PATH 上不变、版本不变。**
   缓存 digest 会把这些命令的身份算进去——一旦你的 PATH 里 cmake 换成不同版本/路径,identity 变了 → 旧缓存失效 → 会重新编译整个 quickjs 引擎(慢十几秒,并多出一个 `.cache` 条目)。
2. **别删 `node_modules/@scriptc/runtime/vendor/.cache/`。**
   它被 `.gitignore` 忽略,也常在 `rm -rf node_modules` 时被清掉;清了就退回"第一次重编引擎"。
3. 所以**推荐**:把 portable cmake 放到固定路径(如 `~/.tools/cmake`),并固定写进 PATH;不要每次临时下载到 `/tmp`(临时目录被清,身份/路径变化都会打断缓存)。

> 缓存命中后,`--dynamic` 编译 = scriptc 前端(TS→C)+ `clang` 编译/链接,不再碰 cmake。
> 实测本项目稳定重建约 **30~40 秒**(clang 编译/链接是主要耗时);cmake 只在该快照的引擎缓存未命中时才额外占用。
> 这就是"快"该有的样子——尽量别切 cmake 版本/路径,否则另有几十秒叠加一次引擎重编。

---

## 四、检查 / 排错

- **产物**:`file bin/easy-vue-bin` 应是 `Mach-O 64-bit executable x86_64`(或 arm64)。
- **验证编译输出**:`echo '{...vue json...}' | ./bin/easy-vue-bin convert`,参见 README.md「快速验证」。
- **cmake 不在 PATH 时的报错**:`--dynamic builds the embedded engine once with CMake, which was not found on PATH. ... Static builds do not need it.`
- **静态构建报 `SC2013`**:这是正常的——本项目必须 `--dynamic`,不要去掉 `--dynamic`。

---

## 五、本机 portable cmake 快速准备(无 brew 时)

```bash
# 下载 cmake 的 pypi wheel(macOS universal2)并解压,得到一个自包含的 cmake
pip download cmake==4.4.2 --no-deps -d /tmp
cd /tmp && unzip -q cmake-4.4.2-py3-none-macosx_10_10_universal2.whl -d cmake_extract
export PATH="/tmp/cmake_extract/cmake/data/bin:$PATH"   # 或用固定路径 ~/.tools/cmake
cmake --version   # 4.4.2
```

> 建议放到固定目录而非 `/tmp`,以便复用引擎缓存(见第三节)。
