# 参与贡献

感谢你花时间改进 easy-vue。本文只讲「怎么跑起来改」和「怎么提」，设计细节见 [develop.md](./develop.md)。

## 提 Issue 前

- 先确认版本：`./easy-vue --version`，并写明平台（macOS arm64 / Linux x86_64 / Windows x64…）
- 给出**最小复现**：一段能直接 `POST /compile` 的 JSON 或一个 `.vue` 文件，加上期望输出与实际输出
- 涉及 `.ts` 编译的问题，请说明 `bin/` 下 `esbuild` 的来源（随 zip 附带 / `ESBUILD_BINARY_PATH` / PATH）

## 本地开发

编译 easy-vue 二进制需要 Node（**产物运行不需要 Node**）：

```bash
npm ci                       # 含 scriptc 0.0.33（勿用 npx scriptc，会拉到有回归的 0.0.34）
./scripts/gen-version.sh     # 从 VERSION 生成 src/version.ts（版本号注入）
node_modules/.bin/scriptc build src/serve.ts --dynamic --backend c -o bin/easy-vue-bin
```

- 本机原生编译还需要 **cmake**（首次要配置并编译内嵌 quickjs 引擎，产物会缓存）
- 交叉编译其它平台需要 **Zig 0.13.0**，各平台命令见 [develop.md](./develop.md) 的「三、编译」
- 自测：起 `bin/easy-vue-bin serve 127.0.0.1:9000`，用 README.zh.md「30 秒上手」的 curl 依次验证 `.vue`、`.ts`、内联 sourcemap、`style: "separate"` 四条

## 提交 Pull Request

- 一个 PR 只做一件事；改了行为请同时更新 README / develop.md 对应章节
- 提交信息格式 `type: 简述`（`feat` / `fix` / `docs` / `chore`），中英文均可
- 不要提交平台二进制（`bin/` 下的构建产物不入库）、`node_modules/`、`dist/`；`docs/` 只放文档用的轻量资源
- 发版由维护者按 [RELEASE.md](./RELEASE.md) 打 tag 完成，PR 里**不用**改 `VERSION`

## 讨论

方向不确定、或想先聊设计，去 [Discussions](https://github.com/easy30/easy-vue/discussions)。
