# easy-vue × Python 一体化前后端 Demo（FastAPI + Uvicorn + easy-vue）

复刻 **easy-vue4j** 在 Java/Spring 里做的事——一个 Python Web 服务，
前后端一体但运行时分离：

- 前端源码（`.vue` / `<script setup>`）放在工程的 `static/views/` 下；
- 浏览器请求 `/views/<name>.vue` 时，FastAPI **现场**用 easy-vue 把 `.vue`
  编译成 ESM JS 返回；
- `vue` 本体走 `<script type="importmap">`（CDN 下载到本地 `vendor/`），
  路由按需懒加载——跟 easy-vue4j 的架构一模一样。

   浏览器 ──HTTP──> Uvicorn ──> FastAPI 路由 ──HTTP──> easy-vue serve 进程
                         │                                     │
                         └── 返回编译后的 ESM JS  ◄── 编译 .vue ─┘

| 组件 | 对应 Java 生态 |
|---|---|
| FastAPI | Spring Boot（Controller 层） |
| Uvicorn | Tomcat（应用服务器） |
| easy-vue | 无 Node 的 Vue/TS 编译器（等效 @vue/compiler-sfc + esbuild） |
| importmap + vue ESM | 一体化部署、运行时前后端分离 |

## 运行

    ./setup.sh                                          # 下载 vue + 备二进制 + 建 venv
    ./.venv/bin/uvicorn main:app --port 8001 --reload   # 启动
    # 浏览器打开 http://127.0.0.1:8001/

> **easy-vue 二进制**：`setup.sh` 优先复用仓库 `../../bin/easy-vue-bin`；
> 否则需从 https://github.com/easy30/easy-vue/releases 下载对应平台 zip 解压到 `bin/`。
> 二进制不提交进仓库（在 GitHub Release 里分发）。

## 目录结构

    demo/python/
    ├── main.py                 # FastAPI 应用：托管静态 + 现场编译 .vue
    ├── setup.sh                # 一键准备环境
    ├── requirements.txt        # fastapi / uvicorn
    ├── static/
    │   ├── views/home.vue      # 前端源码（script setup）
    │   ├── views/about.vue
    │   └── vendor/             # vue / vue-router ESM（setup.sh 下载）
    ├── bin/                    # easy-vue 可执行文件（不提交）
    └── .venv/                  # Python 虚拟环境（setup.sh 建）

## 说明

- `source` + `filename` **都要传**：serve(HTTP) 模式下 easy-vue 禁止只凭
  `filename` 读服务器本地文件（安全），源码内容放在 `source`。
- 编译结果 `js` 是 ESM（`export default __sfc__`），可直接被 `import` /
  `import map` 消费；`css` 是 `<style>` 编译结果。
