# easy-vue4j — easy-vue 的 Java 客户端

对接 easy-vue（HTTP `serve` 常驻）的 Java 客户端参考实现。

## 特性

- **客户端自定端口**：启动前自挑空闲端口传给 easy-vue 进程，天然知道端口，无需读 stdout / 注册文件。
- **指定进程数**：`start(bin, N)` 自动起 N 个 serve 进程（N 核并行），内部轮询分发请求。
- **就绪探测**：进程启动后对每个端口轮询 connect，服务真正就绪（约几百 ms）才返回，避免首个请求连不上。
- **Java 8+ 兼容**；`AutoCloseable`，用完 `close()` 关闭所有进程。
- 非阻塞启动：`ProcessBuilder.start()` 立刻返回，easy-vue 在子进程常驻；`close()` 统一清理。

## 用法

```java
// 1) 编译该单文件
//    javac -d classes src/main/java/com/easyvue/EasyVueHttpClient.java

// 2) 启动 N 个 easy-vue 进程并返回客户端
EasyVueHttpClient ef = EasyVueHttpClient.start("/path/to/easy-vue-bin", 4);
//    → 自动起 4 个 serve 进程（4 个随机端口），全部就绪后返回

// 3) 编译
String json = ef.compileVue("<template><div>{{n}}</div></template>", "hello.vue");
//    → {"ok":true,"js":"...","css":""}（或 ok=false + error）

// 4) 关闭
ef.close();
```

```java
// 指定超时（连接 5s / 读 30s）
EasyVueHttpClient ef = EasyVueHttpClient.start(bin, 2, 5000, 30000);
```

## 协议

- 请求：`POST /compile`，body JSON：`{type,source,filename,sourcemap}`
- 响应：`{ok,js,css,error}`（详见仓库根 README「三、调用协议」）
