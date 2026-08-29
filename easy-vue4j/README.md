# easy-vue4j — easy-vue 的 Java 客户端

对接 easy-vue（HTTP `serve` 常驻）的 Java 客户端，**Java 8 兼容、零第三方依赖**。

## 架构

```
VueCompiler (抽象接口)
  ├── JavaVueCompiler      纯 Java 实现（未配置 easy-vue 时回退）
  └── EasyVueHttpClient   easy-vue 原生二进制实现（HTTP 常驻，支持多进程）

VueCache (缓存层，保留) —— 内部持有 VueCompiler，带编译缓存
VueConfig (配置) —— 约定：easy-vue.path 存在 → 用 easy-vue；否则纯 Java
```

### 配置驱动切换

| 配置 | 行为 |
|---|---|
| `easy-vue.path` 指向的二进制**存在** | 用 `EasyVueHttpClient`（最快，真实编译 vue/ts） |
| `easy-vue.path` 未配置 / 不存在 | 用 `JavaVueCompiler`（纯 Java 回退，vue 暂返回不支持） |

配置来源：`-Deasy-vue.path=/path/to/easy-vue` 或环境变量 `EASY_VUE_PATH`。

## 用法

```java
// 1) 配置驱动：有 easy-vue 二进制用 easy-vue，否则纯 Java
VueConfig config = VueConfig.fromSystemProperties();
VueCache cache = VueCache.create(config);   // 内部按 easy-vue.path 选择实现

// 2) 编译（带缓存）
VueCompileResult r = cache.compile(VueCompileRequest.of("vue", source, "hello.vue"));
if (r.isOk()) { String js = r.getJs(); String css = r.getCss(); }
else { String err = r.getError(); }
```

## EasyVueHttpClient 独立用法（自定端口 + 指定进程数）

```java
// 手工指定二进制 + 进程数（忽略配置，直接起 N 个 easy-vue 进程）
EasyVueHttpClient ef = EasyVueHttpClient.start("/path/to/easy-vue-bin", 4);
VueCompileResult r = ef.compile(VueCompileRequest.of("vue", source, "a.vue"));
ef.close();
```

特性：
- **客户端自定端口**：启动前自挑空闲端口传给 easy-vue，天然知端口，无需读 stdout/注册文件。
- **指定进程数**：`start(bin, N)` 自动起 N 个 serve 进程（N 核并行），内部轮询分发。
- **就绪探测**：启动后逐端口轮询 connect，服务真正就绪（约几百 ms）才返回。
- **非阻塞启动**：`ProcessBuilder.start()` 立刻返回；`close()` 统一清理子进程。

## 编译（Java 8）

```bash
javac -encoding UTF-8 -d classes src/main/java/com/easyvue/*.java
```

## 协议

- 请求：`POST /compile`，body JSON：`{type, source, filename, sourcemap}`（`id` 为可选数字，成功时回显）
- 响应：`{ok, js, css, error}`（详见仓库根 README「三、调用协议」）
