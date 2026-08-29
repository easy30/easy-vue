package com.easyvue;

/**
 * 纯 Java 的 Vue 编译实现（回退方案）。
 *
 * <p>当未配置 easy-vue 二进制时使用。当前为占位骨架：
 * 这里可以接入纯 Java 的 Vue SFC 解析/转换方案（如 selenium/自研 parser、或
 * 调 nashorn/graaljs 跑 @vue/compiler-sfc），此处先实现一个最小可用语义：
 * 对非 vue 的 ts/js 简单透传，对 vue 返回不支持错误。</p>
 */
public class JavaVueCompiler implements VueCompiler {

    @Override
    public VueCompileResult compile(VueCompileRequest request) {
        String type = request.getType();
        String source = request.getSource();
        if ("vue".equalsIgnoreCase(type)) {
            return VueCompileResult.failure(
                "pure-java VueCompiler does not support .vue compilation yet; "
                + "configure easy-vue.path to use the native easy-vue binary");
        }
        // ts/js：纯 Java 下先原样返回 source 作为骨架语义
        String js = source == null ? "" : source;
        if ("ts".equalsIgnoreCase(type)) {
            js = "// pure-java ts passthrough (no transpile)\n" + js;
        }
        return VueCompileResult.success(js, null);
    }
}
