package com.easyvue;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * easy-vue Java 客户端（实现 {@link VueCompiler}）。
 *
 * <p>对应 easy-vue 的 HTTP `serve` 模式。</p>
 * <ul>
 *   <li><b>客户端自定端口</b>：客户端自己挑空闲端口传给 easy-vue 进程，天然知道端口，
 *       无需读 stdout / 注册文件。</li>
 *   <li><b>指定启动进程数</b>：start 时给定 N，自动起 N 个 easy-vue serve 进程
 *       （N 个端口，N 核并行），内部轮询分发请求。</li>
 * </ul>
 *
 * <p>就绪判断：进程启动后，easy-vue 需要 ~200-350ms 初始化内嵌引擎并绑定端口。
 * 本客户端启动进程后对每个端口做<b>轮询 connect 探测</b>，真正能连上（服务就绪）
 * 才返回，避免「进程起了但端口还没好」导致首个请求失败。</p>
 *
 * <p>Java 8 兼容；无第三方依赖。</p>
 */
public class EasyVueHttpClient implements AutoCloseable, VueCompiler {

    private final int connectTimeoutMs;
    private final int readTimeoutMs;
    private final List<Backend> backends = new ArrayList<Backend>();
    private final AtomicInteger roundRobin = new AtomicInteger(0);

    private EasyVueHttpClient(int connectTimeoutMs, int readTimeoutMs) {
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
    }

    /** 后端封装：一个 easy-vue serve 进程 + 它的端口。 */
    private static final class Backend {
        final Process process;
        final String baseUrl;
        Backend(Process process, int port) {
            this.process = process;
            this.baseUrl = "http://127.0.0.1:" + port;
        }
    }

    /**
     * 启动 easy-vue 并返回客户端。
     *
     * @param binaryPath       easy-vue 可执行文件路径
     * @param processCount    启动多少个 easy-vue 进程（>=1）；N 个进程 = N 核并行
     * @param connectTimeoutMs  连接超时（毫秒）
     * @param readTimeoutMs     读超时（毫秒）
     */
    public static EasyVueHttpClient start(String binaryPath, int processCount,
                                      int connectTimeoutMs, int readTimeoutMs) throws IOException {
        EasyVueHttpClient client = new EasyVueHttpClient(connectTimeoutMs, readTimeoutMs);
        for (int i = 0; i < processCount; i++) {
            int port = findFreePort();               // 1. 客户端自挑一个空闲端口
            Process p = spawn(binaryPath, port);   // 2. 非阻塞启动 easy-vue，端口传入
            client.backends.add(new Backend(p, port));
        }
        client.waitReady();                        // 3. 轮询 connect，全部就绪才返回
        return client;
    }

    /** 便捷重载：默认连接超时 5s、读超时 30s。 */
    public static EasyVueHttpClient start(String binaryPath, int processCount) throws IOException {
        return start(binaryPath, processCount, 5000, 30000);
    }

    /**
     * 依据配置创建 easy-vue 客户端（仅供 {@link VueCache#create} 使用）。
     * 包装 IOException 为 UncheckedIOException，便于配置驱动的工厂调用。
     */
    public static EasyVueHttpClient startQuiet(VueConfig config) {
        try {
            return start(config.getVuePath(), config.getProcessCount(),
                       config.getConnectTimeoutMs(), config.getReadTimeoutMs());
        } catch (IOException e) {
            throw new UncheckedIOException("failed to start easy-vue: " + config.getVuePath(), e);
        }
    }

    /* ── 启动 ─────────────────────────────────────────────────────────────── */

    private static int findFreePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        }
        // 注：close 后到 easy-vue 真正 bind 之间有一极小竞争窗口，内网工具通常可接受。
    }

    private static Process spawn(String binaryPath, int port) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(binaryPath, "serve", "127.0.0.1:" + port);
        // 丢弃输出：避免管道缓冲阻塞 easy-vue，也不需要读。兼容 Java 8（无 DISCARD）。
        pb.redirectOutput(ProcessBuilder.Redirect.to(new File("/dev/null")));
        pb.redirectError(ProcessBuilder.Redirect.to(new File("/dev/null")));
        return pb.start();   // 非阻塞返回；easy-vue 在子进程常驻提供 HTTP
    }

    private void waitReady() throws IOException {
        long deadline = System.currentTimeMillis() + 10_000;
        for (Backend b : backends) {
            boolean ready = false;
            boolean interrupted = false;
            while (System.currentTimeMillis() < deadline) {
                try (Socket s = new Socket()) {
                    s.connect(new InetSocketAddress("127.0.0.1", urlPort(b.baseUrl)), 300);
                    ready = true;
                    break;
                } catch (IOException e) {
                    try { Thread.sleep(50); } catch (InterruptedException ie) {
                        interrupted = true;
                        break;
                    }
                }
            }
            if (interrupted) { Thread.currentThread().interrupt(); throw new IOException("interrupted"); }
            if (!ready) throw new IOException("easy-vue not ready: " + b.baseUrl);
        }
    }

    private static int urlPort(String baseUrl) {
        return Integer.parseInt(baseUrl.substring(baseUrl.lastIndexOf(':') + 1));
    }

    /* ── 编译 API ─────────────────────────────────────────────────────────── */

    /** 编译源码。type: vue / ts / js。返回编译结果的 JSON 文本（含 ok/js/css/error）。 */
    public String compile(String type, String source, String filename, Boolean sourcemap) throws IOException {
        StringBuilder body = new StringBuilder();
        body.append('{');
        body.append("\"id\":0");
        appendField(body, "type", type);
        appendField(body, "source", source);
        appendField(body, "filename", filename);
        if (sourcemap != null) {
            if (body.charAt(body.length() - 1) != '{') body.append(',');
            body.append("\"sourcemap\":").append(sourcemap);
        }
        body.append('}');
        return post(nextBackend().baseUrl + "/compile", body.toString());
    }

    /** 实现 {@link VueCompiler} 接口：将 VueCompileRequest 桥接到 HTTP 调用。 */
    @Override
    public VueCompileResult compile(VueCompileRequest request) {
        try {
            String json = compile(request.getType(), request.getSource(),
                              request.getFilename(), request.isSourcemap() ? Boolean.TRUE : null);
            VueCompileResult r = new VueCompileResult();
            if (json.contains("\"ok\":true")) {
                r.setOk(true);
                r.setJs(extractString(json, "js"));
                r.setCss(extractString(json, "css"));
                return r;
            }
            r.setOk(false);
            r.setError(extractString(json, "error"));
            return r;
        } catch (IOException e) {
            return VueCompileResult.failure(String.valueOf(e.getMessage()));
        }
    }

    /** 从简易 JSON 中抽取一个字符串字段值（服务端已内联 \n 等转义）。 */
    private static String extractString(String json, String key) {
        String needle = "\"" + key + "\":\"";
        int i = json.indexOf(needle);
        if (i < 0) return null;
        int start = i + needle.length();
        int end = start;
        while (end < json.length() && json.charAt(end) != '"') {
            if (json.charAt(end) == '\\') end++;
            end++;
        }
        if (end > json.length()) end = json.length();
        return json.substring(start, end).replace("\\n", "\n").replace("\\\"", "\"");
    }

    private Backend nextBackend() {
        if (backends.isEmpty()) throw new IllegalStateException("no easy-vue backend");
        int idx = Math.floorMod(roundRobin.getAndIncrement(), backends.size());
        return backends.get(idx);
    }

    /* ── HTTP POST ────────────────────────────────────────────────────────── */

    private String post(String url, String json) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(connectTimeoutMs);
        conn.setReadTimeout(readTimeoutMs);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(json.getBytes(StandardCharsets.UTF_8));
        }
        int code = conn.getResponseCode();
        try (InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
             BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            return sb.toString();
        }
    }

    /* ── JSON ─────────────────────────────────────────────────────────────── */

    private static void appendField(StringBuilder b, String key, String value) {
        if (value == null) return;
        if (b.charAt(b.length() - 1) != '{') b.append(',');
        b.append('\"').append(key).append("\":\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') b.append('\\');
            else if (c == '\n') { b.append("\\n"); continue; }
            else if (c == '\r') { b.append("\\r"); continue; }
            else if (c == '\t') { b.append("\\t"); continue; }
            b.append(c);
        }
        b.append('\"');
    }

    /* ── 生命周期 ────────────────────────────────────────────────────────── */

    /** 关闭所有 easy-vue 进程。 */
    @Override
    public void close() {
        for (Backend b : backends) {
            b.process.destroy();
            try { b.process.waitFor(2, TimeUnit.SECONDS); }
            catch (InterruptedException e) { b.process.destroyForcibly(); Thread.currentThread().interrupt(); }
        }
        backends.clear();
    }
}
