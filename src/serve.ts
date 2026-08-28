// easy-vue 模式1 · 无状态前端编译器（scriptc 原生二进制）
// 协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应
//   入 {"id", "type":"vue"|"ts"|"js", "source"?|"filename"?, "sourcemap"?:boolean}
//   出 {"id","ok","js"?,"css"?,"error"?}
// sourcemap=true 时产出内联 sourcemap：
//   - ts/js    → esbuild --sourcemap=inline（base64 data URI）
//   - vue      → 仅映射 <script>/<script setup> 段（base64 内联），template/css 不出 map
// 无缓存：每次请求都重新编译（缓存策略由调用方决定）
import { readFileSync, existsSync, readSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc';

const BUF = Buffer.alloc(1);
const ESBUILD = process.env.ESBUILD_BINARY_PATH || 'esbuild';

function esbuildTranspile(source: string, loader: 'ts' | 'js', inlineMap: boolean): string {
  const args = ['--loader=' + loader, '--format=esm', '--target=es2020'];
  if (inlineMap) args.push('--sourcemap=inline');
  const out = execFileSync(ESBUILD, args, { input: source, maxBuffer: 64 * 1024 * 1024 });
  return out.toString();
}

// UTF-8 → base64：用 scriptc 原生 Buffer 支持（手写数组实现的 base64 曾触发 scriptc 运行时数组越界）
function inlineMapComment(map: unknown): string {
  const json = typeof map === 'string' ? map : JSON.stringify(map);
  const b64 = Buffer.from(json, 'utf-8').toString('base64');
  return '\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,' + b64;
}

// 编译单个 .vue 源码 → {js, css}
function compileVue(source: string, filename: string, wantMap: boolean): { js: string; css: string } {
  const parsed = parse(source, { filename });
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error('parse errors: ' + JSON.stringify(parsed.errors));
  }
  const d = parsed.descriptor;

  let js = '';
  let scriptMap: any = null;

  // script / script setup：产物放最前（第 0 行起），map 零偏移内联
  if (d.scriptSetup) {
    const s = compileScript(d, { id: 'ev' });
    js += s.content + '\n';
    if (wantMap && s.map) scriptMap = s.map;
  } else if (d.script) {
    const s = compileScript(d, { id: 'ev' });
    js += s.content + '\n';
    if (wantMap && s.map) scriptMap = s.map;
  } else {
    js += 'export default {}\n';
  }

  // 非 sourcemap 模式加头部注释；sourcemap 模式不加（保证 script 从第 0 行起，map 无需平移）
  if (!wantMap) {
    js = '// compiled by @vue/compiler-sfc via easy-vue\n' + js;
  }

  let css = '';
  if (d.styles && d.styles.length > 0) {
    const styleParts: string[] = [];
    d.styles.forEach((st, i) => {
      const r = compileStyle({ source: st.content, filename, id: 'ev-' + i, scoped: !!st.scoped });
      if (r.errors && r.errors.length > 0) {
        throw new Error('style errors: ' + JSON.stringify(r.errors));
      }
      if (r.code) styleParts.push(r.code);
    });
    css = styleParts.join('\n');
  }

  if (d.template) {
    const r = compileTemplate({ source: d.template.content, filename, id: 'ev' });
    if (r.errors && r.errors.length > 0) {
      throw new Error('template errors: ' + JSON.stringify(r.errors));
    }
    js += r.code + '\n';
  }

  if (scriptMap) {
    js += inlineMapComment(scriptMap);
  }
  return { js, css };
}

interface Req { id?: number; type?: string; source?: string; filename?: string; sourcemap?: boolean; }
interface Resp { id: number | null; ok: boolean; js?: string; css?: string; error?: string; }

function handleReq(line: string): string {
  const req: Req = JSON.parse(line);
  const id: number | null = req.id === undefined ? null : req.id;
  const wantMap = !!req.sourcemap;
  let type = req.type || (req.filename || '').split('.').pop() || 'js';

  // source 缺省时从 filename 指向的路径读取（filename 同时承担"路径"与"文件名"两职）
  let source = req.source;
  if (source === undefined) {
    if (req.filename == null) throw new Error('request needs "source" or a readable "filename"');
    if (!existsSync(req.filename)) throw new Error('file not found: ' + req.filename);
    source = readFileSync(req.filename, 'utf-8');
  }
  const filename = req.filename || 'inline.' + type;

  if (type === 'vue') {
    const out = compileVue(source, filename, wantMap);
    return JSON.stringify({ id, ok: true, js: out.js, css: out.css } as Resp);
  } else if (type === 'ts' || type === 'jsx' || type === 'tsx') {
    const js = esbuildTranspile(source, 'ts', wantMap);
    return JSON.stringify({ id, ok: true, js } as Resp);
  } else if (type === 'js') {
    // 含 @api 装饰器语法时用 esbuild 转换，否则原样返回
    if (source.includes('@api')) {
      const js = esbuildTranspile(source, 'js', wantMap);
      return JSON.stringify({ id, ok: true, js } as Resp);
    }
    return JSON.stringify({ id, ok: true, js: source } as Resp);
  }
  return JSON.stringify({ id, ok: false, error: 'unknown type: ' + type } as Resp);
}

function readLine(): string | null {
  let s = '';
  for (;;) {
    const n = readSync(0, BUF, 0, 1, null);
    if (n <= 0) return s === '' ? null : s;
    const c = BUF.toString('utf-8');
    if (c === '\n') return s;
    s += c;
  }
}

// 一次性/HTTP 双入口：serve [host:port]（常驻 HTTP） | convert（stdin 一行 → stdout 一行 → 退出）
// 入口分派见文件底部。

function compileJson(reqJson: string): string {
  try {
    return handleReq(reqJson);
  } catch (e) {
    return JSON.stringify({ id: null, ok: false, error: String((e as Error).message || e) } as Resp);
  }
}

// serve：HTTP 常驻；必须显式指定端口（SF_HOST/SF_PORT env 或参数 [host:]port），无默认、避免 8080 等冲突
// createServer 回调内联处理请求（scriptc 动态边界：IncomingMessage 不能跨函数传入，只把 body string 交给 static 的 compileJson）
function serve(arg: string) {
  const m = arg.split(':');
  let listenHost = '127.0.0.1';
  let listenPort = m.length === 2 ? m[1] : m[0];
  if (m.length === 2 && m[0]) listenHost = m[0];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || (req.url || '').split('?')[0] !== '/compile') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      if (size > 16 * 1024 * 1024) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: null, ok: false, error: 'request body too large' } as Resp));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(compileJson(body));
    });
    req.on('error', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: null, ok: false, error: 'request error' } as Resp));
    });
  });
  server.listen(Number(listenPort), listenHost, () => {
    process.stdout.write('__READY__\n');
  });
}

// convert：一次性，读一行请求 → 编译 → 写一行响应 → 退出
function convert() {
  const line = readLine();
  if (line === null) return;
  if (line) process.stdout.write(compileJson(line) + '\n');
}

function usage() {
  process.stdout.write('usage: easy-vue serve [host:]port | convert\n' +
    '  serve   HTTP 常驻（必须指定端口，如 0.0.0.0:9000；或设 SF_HOST/SF_PORT），POST /compile\n' +
    '  convert stdin 读一行 JSON 编译后写一行输出即退出\n');
}

function main() {
  const argv = process.argv;
  const idx = argv.indexOf('serve');
  if (idx >= 0) {
    if (argv[idx + 1]) { serve(argv[idx + 1]); }
    else { usage(); process.exit(1); }
    return;
  }
  if (argv.indexOf('convert') >= 0) { convert(); return; }
  usage();
}
main();
