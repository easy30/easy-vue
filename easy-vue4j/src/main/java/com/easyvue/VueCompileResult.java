package com.easyvue;

/**
 * 编译结果。对应 easy-vue 协议：\{ok, js, css, error\}。
 */
public class VueCompileResult {

    private boolean ok;
    private String js;
    private String css;
    private String error;

    public static VueCompileResult success(String js, String css) {
        VueCompileResult r = new VueCompileResult();
        r.ok = true;
        r.js = js;
        r.css = css;
        return r;
    }

    public static VueCompileResult failure(String error) {
        VueCompileResult r = new VueCompileResult();
        r.ok = false;
        r.error = error;
        return r;
    }

    public VueCompileResult() {
    }

    public boolean isOk() { return ok; }
    public void setOk(boolean ok) { this.ok = ok; }
    public String getJs() { return js; }
    public void setJs(String js) { this.js = js; }
    public String getCss() { return css; }
    public void setCss(String css) { this.css = css; }
    public String getError() { return error; }
    public void setError(String error) { this.error = error; }

    @Override
    public String toString() {
        return "VueCompileResult{ok=" + ok + ", error=" + error + "}";
    }
}
