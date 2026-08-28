# easy-vue TODO

## 待办（未排期，将来考虑）

### 单入口 vue 局部 bundle + tree-shake（element 按需）
**状态**：想法，暂不实施。先吃「共享大库走浏览器缓存」的红利，嫌重再上这个。

- **背景**：当前架构为「一 vue = 一 ESM js」，路由级按需加载，首屏只下首页用到的那几份（天然懒加载，保持不要破）。唯一重量在 import map 里的共享运行库（vue.js / element-plus 等大 JS）——它们跨页面共享、只应被下载一次，先行优化是**给这些 CDN/自托管资源配长缓存头**，与编译无关。
- **建议做法**：对**单个入口 vue** 做一次局部 bundle + tree-shake，把 `import { ElButton, ... }` 里只用到的组件摇进该文件，`vue` 本体保持 `external`（留给 import map）。每个 vue 仍是独立小文件，不破坏按需；只把 element 用到的那几个组件 local 化。
- **依赖/实现点**：esbuild 需要能解析 `.vue`（写 resolve 插件：`onResolve` 拦 `.vue` → `onLoad` 调 `@vue/compiler-sfc` 编成 JS）。当前 `serve.ts` 是 `execFileSync` 调 esbuild CLI，CLI 不支持 JS 插件，届时需改走 esbuild 的 JS API（`bundle`/`build`）。
- **取舍**：tree-shake 会把组件 JS 内联进各 vue 文件，失去跨组件共享——与"由缓存共享全量库"相比有 trade-off，故列入待办而非立即做。
