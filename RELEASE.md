# easy-vue 发布流程（GitHub Actions 自动跨平台编译）

本文档记录 easy-vue 的版本发布方式：**打 tag 即自动编译全部平台二进制并发布到 GitHub Release**，以及排障过程。

---

## 一、整体机制

`.github/workflows/release.yml` 定义了一个 `release` 工作流：

- **触发**：推送 `v*` tag（如 `v1.0.0`）自动发版；也支持在 Actions 界面手动触发（`workflow_dispatch`）。
- **运行位置**：全部在 **GitHub 托管的远程 runner**（`macos-14`，Intel）上执行，**不依赖本地机器**。本地只需 `git push --tags`。
- **单台 macOS runner 交叉编译**：用 zig 一次性交叉编译出全部 6 个平台产物，最后 `softprops/action-gh-release` 把产物上传到 Release。

### 产物清单（6 个平台二进制）

| 产物 | 平台 × 架构 | 说明 |
|---|---|---|
| `easy-vue-mac-arm64` | macOS arm64 | `aarch64-macos` 交叉 |
| `easy-vue-mac-intel` | macOS x86_64 | `x86_64-macos` 交叉 |
| `easy-vue-linux` | Linux x86_64 | `x86_64-linux-musl`（纯静态） |
| `easy-vue-linux-arm64` | Linux arm64 | `aarch64-linux-musl` |
| `easy-vue-win-x64.exe` | Windows x86_64 | `win/build-win.sh`，含 POSIX shim |
| `easy-vue-win-arm64.exe` | Windows arm64 | `win/build-win.sh`，含 POSIX shim |

---

## 二、发版步骤

### 1. 提交改动并推送到 main

```bash
git add -A
git commit -m "你的改动说明"
git push origin main
```

### 2. 打 tag 并推送（触发构建）

```bash
git tag v1.0.0
git push origin v1.0.0
```

> **重建已存在的 tag**（比如修复后想重发同版本）：
> ```bash
> git push origin :refs/tags/v1.0.0     # 删远端
> git tag -d v1.0.0                      # 删本地
> git tag v1.0.0                         # 在最新 commit 重建
> git push origin v1.0.0                 # 推送触发
> ```

### 3. 查看构建与发布

- 构建进度：GitHub 仓库 → **Actions** 页
- 产物下载：仓库 → **Releases** 页

---

## 三、验证发布结果

### 用浏览器
打开 `https://github.com/easy30/easy-vue/releases`，确认 `v1.0.0` 的 6 个二进制都出现。

### 用 API（私有仓库需认证 token，可复用 git 本地凭据）

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')

# 工作流运行状态（看 conclusion 是否为 success）
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/easy30/easy-vue/actions/runs?per_page=3"

# Release 资产清单
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/easy30/easy-vue/releases/tags/v1.0.0"
```

---

## 四、排障记录（重要，务必读）

### 坑 1：Node 版本不匹配 → scriptc 启动即报错

**现象**：构建在第 9 步 `Build macOS native` 失败，日志：
```
node_modules/scriptc/dist/bootstrap.js:2
import { enableCompileCache } from "node:module";
SyntaxError: The requested module 'node:module' does not provide an export named 'enableCompileCache'
Node.js v20.20.2
```

**原因**：`scriptc@0.0.33` 使用了 `node:module` 的 `enableCompileCache`，这是 **Node 22+ 才有的 API**。而 workflow 里 `actions/setup-node` 固定了 `node-version: 20`，远程 runner 用 Node 20 运行就崩（本机没跑过 CI 所以没暴露——本机是 Node 24）。

**修复**：把 `release.yml` 的 `node-version: 20` 改为 `node-version: 22`（升到 22 或更高即可）。

**判断依据**：README 前置要求写的是 Node ≥ 20，但实际 `scriptc@0.0.33` 需要 22+。若日后升级 scriptc 大版本，需同步核对它的最低 Node 要求。

### 坑 2：中间 `.c` 文件被误传到 Release

**现象**：Release 里多了个 `serve.c`（约 1.8MB，`text/x-c`）。

**原因**：`win/build-win.sh` 交叉编译 Windows 时会生成中间 C 源码落在 `bin/serve.c`；工作流里 `Collect Windows artifacts` 只 `mv` 了 exe，但上传阶段用 `files: dist/*` 通配，把残留的中间文件也带上去了。

**修复**（两层）：
1. **清理已发布版本**：用 API 删掉该 asset：
   ```bash
   curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
     "https://api.github.com/repos/easy30/easy-vue/releases/assets/<asset_id>"
   ```
2. **防止复发**：把 `softprops/action-gh-release` 的 `files` 从 `dist/*` 改为**显式白名单**，只列 6 个二进制：
   ```yaml
   - name: Upload release assets
     uses: softprops/action-gh-release@v2
     with:
       files: |
         dist/easy-vue-mac-arm64
         dist/easy-vue-mac-intel
         dist/easy-vue-linux
         dist/easy-vue-linux-arm64
         dist/easy-vue-win-x64.exe
         dist/easy-vue-win-arm64.exe
       generate_release_notes: true
   ```

### 坑 3：`zigcc` 必须是 wrapper 而不能是软链

`scriptc` 用 `SCRIPTC_CC=zigcc` 调 zig。`win/build-win.sh` 靠**劫持 PATH 里的 `zig`** 来注入 Windows 的 POSIX shim，因此 `zigcc` 必须是「运行时按 PATH 重新解析 zig」的 **wrapper 脚本**（`exec zig cc "$@"`），不能是 zig 二进制的软链——软链会绕过劫持，导致 Windows 交叉编译失败。workflow 里有 `Ensure zigcc alias` 步骤兜底。

---

## 五、当前工作流关键点速查

- npm 依赖：`npm ci`（含 `scriptc`）
- **Zig**：`goto-bus-stop/setup-zig@v2`，版本 `0.13.0`
- **Node**：`actions/setup-node@v4`，版本 `22`
- **权限**：`permissions: contents: write`（上传 Release 资产必需）
- **cache**：`actions/cache@v4` 缓存 `node_modules` 加速
- 产物临时目录：`dist/`（已在 `.gitignore` 忽略）
