package com.easyvue;

/**
 * 一次编译请求。对应 easy-vue 协议：\{id, type, source, filename, sourcemap\}。
 * 纯 Java 实现与 EasyVueHttpClient 共用同一请求模型。
 */
public class VueCompileRequest {

    /** vue / ts / js；为空时按 filename 扩展名推断。 */
    private String type;
    /** 源码内容（优先）。 */
    private String source;
    /** 文件名/路径：有 source 时作名字；无 source 时用于读文件。 */
    private String filename;
    /** 是否产出内联 sourcemap。 */
    private boolean sourcemap;

    public static VueCompileRequest of(String type, String source, String filename) {
        return new VueCompileRequest(type, source, filename, false);
    }

    public static VueCompileRequest of(String type, String source, String filename, boolean sourcemap) {
        return new VueCompileRequest(type, source, filename, sourcemap);
    }

    public VueCompileRequest() {
    }

    public VueCompileRequest(String type, String source, String filename, boolean sourcemap) {
        this.type = type;
        this.source = source;
        this.filename = filename;
        this.sourcemap = sourcemap;
    }

    public String getType() {
        if (type != null && !type.isEmpty()) return type;
        if (filename != null) {
            int dot = filename.lastIndexOf('.');
            if (dot >= 0) return filename.substring(dot + 1).toLowerCase();
        }
        return "js";
    }
    public void setType(String type) { this.type = type; }
    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }
    public String getFilename() { return filename; }
    public void setFilename(String filename) { this.filename = filename; }
    public boolean isSourcemap() { return sourcemap; }
    public void setSourcemap(boolean sourcemap) { this.sourcemap = sourcemap; }
}
