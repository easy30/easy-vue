package com.easyvue;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Vue 编译缓存（保留原有职责）。
 *
 * <p>以 request 的（filename + source）为 key 缓存编译结果，避免同源码重复编译。
 * 编译器由配置决定：存在 easy-vue 二进制走 easy-vue，否则走纯 Java。</p>
 */
public class VueCache {

    private final VueCompiler compiler;
    private final Map<String, VueCompileResult> cache = new ConcurrentHashMap<String, VueCompileResult>();

    public VueCache(VueCompiler compiler) {
        this.compiler = compiler;
    }

    /**
     * 便捷工厂：依据配置选择编译器并返回缓存。
     *
     * <p>若 {@link VueConfig#getVuePath()} 存在 → easy-vue 实现；否则纯 Java 实现。</p>
     */
    public static VueCache create(VueConfig config) {
        VueCompiler c;
        if (config.getVuePath() != null && new java.io.File(config.getVuePath()).exists()) {
            c = EasyVueHttpClient.startQuiet(config);
        } else {
            c = new JavaVueCompiler();
        }
        return new VueCache(c);
    }

    /** 编译（带缓存）。 */
    public VueCompileResult compile(VueCompileRequest request) {
        String key = keyOf(request);
        VueCompileResult hit = cache.get(key);
        if (hit != null) return hit;
        VueCompileResult r = compiler.compile(request);
        if (r.isOk()) cache.put(key, r);
        return r;
    }

    public void clear() { cache.clear(); }

    private static String keyOf(VueCompileRequest req) {
        return (req.getFilename() == null ? "" : req.getFilename()) + "\n"
                + (req.getSource() == null ? "" : req.getSource());
    }
}
