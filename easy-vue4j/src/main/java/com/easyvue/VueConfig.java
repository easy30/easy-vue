package com.easyvue;

/**
 * easy-vue4j 配置。
 *
 * <p>核心约定：如果 {@link #getVuePath()}（配置项 easy-vue.path）指向的 easy-vue
 * 可执行文件存在，则使用 easy-vue（{@link EasyVueHttpClient}）实现；否则回退到
 * 纯 Java 实现（{@link JavaVueCompiler}）。</p>
 */
public class VueConfig {

    /** easy-vue 可执行文件路径（配置项：easy-vue.path）。为 null/不存在时用纯 Java 实现。 */
    private String vuePath;

    /** 启动多少个 easy-vue 进程（仅 easy-vue 实现有效，>=1；默认 1）。 */
    private int processCount = 1;

    /** 连接超时（毫秒，easy-vue 实现）。 */
    private int connectTimeoutMs = 5000;

    /** 读超时（毫秒，easy-vue 实现）。 */
    private int readTimeoutMs = 30000;

    /** 从系统属性/环境读取 easy-vue.path 的便捷工厂。 */
    public static VueConfig fromSystemProperties() {
        VueConfig c = new VueConfig();
        String path = System.getProperty("easy-vue.path");
        if (path == null) path = System.getenv("EASY_VUE_PATH");
        c.setVuePath(path);
        String n = System.getProperty("easy-vue.processes");
        if (n != null) {
            try { c.setProcessCount(Integer.parseInt(n.trim())); } catch (NumberFormatException ignored) { }
        }
        return c;
    }

    public String getVuePath() { return vuePath; }
    public void setVuePath(String vuePath) { this.vuePath = vuePath; }

    public int getProcessCount() {
        if (processCount < 1) return 1;
        return processCount;
    }
    public void setProcessCount(int processCount) { this.processCount = processCount; }

    public int getConnectTimeoutMs() { return connectTimeoutMs; }
    public void setConnectTimeoutMs(int connectTimeoutMs) { this.connectTimeoutMs = connectTimeoutMs; }

    public int getReadTimeoutMs() { return readTimeoutMs; }
    public void setReadTimeoutMs(int readTimeoutMs) { this.readTimeoutMs = readTimeoutMs; }
}
