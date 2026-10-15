// easy-vue 最简 Go 演示：标准库起一个「静态 + 现场编译」服务，零第三方依赖。
//
// 运行:
//
//	go run main.go
//	浏览器打开 http://127.0.0.1:8800/
//
// 前置: easy-vue 可执行文件——按优先级找 bin/easy-vue-bin（本目录）、
// ../../bin/easy-vue-bin（仓库构建产物）、PATH 里的 easy-vue。
// 获取方式见仓库 README「一、获取」。
//
// 工作方式:
//
//	浏览器请求 /views/home.vue → 本服务读源码 → 让 easy-vue 现场编译成自带样式
//	的 ESM JS（easy-vue 缺省注入样式）；其余路径当静态文件（index.html 等）。
//	完整版演示（FastAPI + mock API + 缓存 + 路由过滤）见 ../python/。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	webAddr = "127.0.0.1:8800" // 本演示对外地址
	evAddr  = "127.0.0.1:9901" // easy-vue 内部 serve 地址（只被本服务调用）
)

// baseDir 静态根目录：go run 时取源文件所在目录，构建成二进制后回退到当前目录
func baseDir() string {
	if _, file, _, ok := runtime.Caller(0); ok {
		if d := filepath.Dir(file); isDir(d) {
			return d
		}
	}
	wd, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}
	return wd
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// findEasyVue 按优先级定位 easy-vue 可执行文件
func findEasyVue(root string) string {
	for _, p := range []string{
		filepath.Join(root, "bin", "easy-vue-bin"),             // 二进制与演示同目录（zip 分发布局）
		filepath.Join(root, "..", "..", "bin", "easy-vue-bin"), // 仓库构建产物
	} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	if p, err := exec.LookPath("easy-vue"); err == nil {
		return p
	}
	log.Fatal("找不到 easy-vue 可执行文件：见仓库 README「一、获取」")
	return ""
}

// compileVue 调 easy-vue 编译接口，返回自带样式的 JS。
//
// easy-vue 缺省即注入（style:inject）：.vue 里 <style> 的编译结果以幂等脚本编进
// js 尾部，浏览器运行时自动插 <style> 标签，无需单独伺服 .css 文件。
func compileVue(source, filename string) (string, error) {
	body, err := json.Marshal(map[string]string{"type": "vue", "source": source, "filename": filename})
	if err != nil {
		return "", err
	}
	resp, err := http.Post("http://"+evAddr+"/compile", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	var out struct {
		OK    bool   `json:"ok"`
		JS    string `json:"js"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	if !out.OK {
		return "", fmt.Errorf("%s", out.Error)
	}
	return out.JS, nil
}

// resolveWithin 把请求路径解析成静态根内的绝对路径（防目录穿越：.. / 绝对路径）
func resolveWithin(root, urlPath string) (string, bool) {
	p := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(urlPath, "/")))
	rel, err := filepath.Rel(root, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return p, true
}

// sendVue 现场编译 .vue，作为 ESM JS 返回
func sendVue(w http.ResponseWriter, r *http.Request, root string) {
	p, ok := resolveWithin(root, r.URL.Path)
	if !ok || !isFile(p) {
		http.NotFound(w, r)
		return
	}
	source, err := os.ReadFile(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	js, err := compileVue(string(source), filepath.Base(p))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "text/javascript") // ESM 必须 JS MIME
	w.Header().Set("Cache-Control", "no-cache")       // 开发期改 .vue 即刻生效（无验证字段则浏览器启发式缓存）
	w.Header().Set("Content-Length", strconv.Itoa(len(js)))
	_, _ = w.Write([]byte(js))
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// startEasyVue 启动 easy-vue 常驻子进程并等待端口就绪（最多 3 秒），
// 返回的 stop 用于退出时连带关停它。
func startEasyVue(exe string) func() {
	cmd := exec.Command(exe, "serve", evAddr)
	cmd.Stdout, cmd.Stderr = nil, nil // 客户端自选端口，无需读它的 stdout
	if err := cmd.Start(); err != nil {
		log.Fatalf("easy-vue 启动失败: %v", err)
	}
	stop := func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		_, _ = cmd.Process.Wait()
	}
	for i := 0; i < 30; i++ {
		if c, err := net.DialTimeout("tcp", evAddr, 100*time.Millisecond); err == nil {
			c.Close()
			return stop
		}
		time.Sleep(100 * time.Millisecond)
	}
	stop()
	log.Fatal("easy-vue 启动失败")
	return nil
}

func main() {
	root := baseDir()
	stopEasyVue := startEasyVue(findEasyVue(root))
	defer stopEasyVue() // 退出时连带关停 easy-vue 子进程

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".vue") {
			sendVue(w, r, root) // .vue 现场编译
			return
		}
		http.FileServer(http.Dir(root)).ServeHTTP(w, r) // 其余走静态
	})

	srv := &http.Server{Addr: webAddr, Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	fmt.Printf("easy-vue 最简 Go 演示: http://%s/  (Ctrl+C 退出)\n", webAddr)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
