package com.easyvue;

/**
 * 编译器抽象接口。所有编译实现都实现本接口，供 VueCache 使用。
 *
 * <p>目前两个实现：</p>
 * <ul>
 *   <li>{@link JavaVueCompiler} —— 纯 Java 实现（不依赖 easy-vue 二进制）</li>
 *   <li>{@link EasyVueHttpClient} —— 调用 easy-vue 原生二进制（HTTP 常驻）</li>
 * </ul>
 */
public interface VueCompiler {

    /**
     * 编译一个 vue/ts/js 源码。
     *
     * @param request 编译请求
     * @return 编译结果
     */
    VueCompileResult compile(VueCompileRequest request);
}
