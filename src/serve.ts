// easy-vue 模式1 · 无状态前端编译器（scriptc 原生二进制）
// 协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应 / HTTP POST /compile
//   入 {"id", "type":"vue"|"ts"|"js", "source", "filename"?, "sourcemap"?:boolean}
//   安全：serve(HTTP) 模式必须提供 source，filename 仅作编译时的名字/type 推断，绝不读服务器本地文件。
//         仅本地可信的 convert 模式允许只给 filename 按服务器本地文件读取。
//   出 {"id","ok","js"?,"css"?,"error"?}
// sourcemap=true 时产出内联 sourcemap，多级完整支持：
//   - ts/js    → esbuild --sourcemap=inline（--sourcefile 指向真实文件名）
//   - vue      → <script>/<script setup lang="ts"> 段经 esbuild 转译去类型后，
//               用 @ampproject/remapping 将 esbuild map 与 compiler-sfc map 逐级复合，
//               最终 source 指向原始 .vue 文件（sourcesContent 保留脚本原文）
//   - <style module>/<style module="m1">  → 注入 useCssModule 绑定（$style / 具名模块），
//               模板 .X 与样式哈希类名一致（自定义哈希，CSS 与模板共用同一映射）
// 无缓存：每次请求都重新编译（缓存策略由调用方决定）
import { readFileSync, existsSync, readSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc';
import remapping from '@ampproject/remapping';
import { EASY_VUE_VERSION } from './version';

const BUF = Buffer.alloc(1);

/**
 * 定位 esbuild 可执行文件（.ts / <script lang=ts> / @api 转译用）。
 * 优先级：
 *   1. 二进制自身同目录下的 esbuild（zip 随 easy-vue 一起分发的场景，esbuild 与该
 *      二进制放在同一目录即可，免任何环境变量）
 *   2. PATH 里的裸命令 esbuild（兜底）
 * process.argv[1] 在 scriptc 原生产物里是「二进制自身路径」（绝对或相对 cwd），
 * 由此可推导同目录布局。
 */
function resolveEsbuild(): string {
  const self = process.argv[1] as any as string;
  if (self) {
    const slash = self.lastIndexOf('/');
    // argv[1] 可能是 '/abs/easy-vue'、'./easy-vue'、'easy-vue'
    const dir = slash >= 0 ? self.substring(0, slash) : '.';
    const dirExe = slash >= 0 ? dir + '/esbuild' : 'esbuild';
    try {
      if (existsSync(dirExe)) return dirExe;
    } catch (e) {
      // 忽略 stat 失败，继续回退
    }
  }
  return 'esbuild';
}
const ESBUILD = resolveEsbuild();

// UTF-8 → base64：用 scriptc 原生 Buffer 支持
function inlineMapComment(map: unknown): string {
  const json = typeof map === 'string' ? map : JSON.stringify(map);
  const b64 = Buffer.from(json, 'utf-8').toString('base64');
  // 必须带前导和结尾换行：sourceMappingURL 是行注释，若其后紧跟（无换行的）代码，
  // 该行剩余内容会被一并注释掉。结尾换行保证后续 append 的代码（如模板 render 的
  // import ... from "vue"）从新的一行开始，不会被吞进注释。
  return '\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,' + b64 + '\n';
}

// 规范化 sourcemap 的 sources：把相对路径改成独立绝对虚拟路径（webpack://easy-vue/ 前缀）。
// 否则 devtools 会把相对 source 拼到编译后脚本所在目录，产生错误的重复路径
//（如 /views/views/home.vue），且源码与编译产物同 URL 冲突。
function normalizeMapSources(map: any): any {
  if (!map || !map.sources || typeof map.sources.length !== 'number') return map;
  const vs: string[] = [];
  for (let i = 0; i < map.sources.length; i++) {
    const s = String(map.sources[i]);
    const clean = s.replace(/^\/?/, "");
    vs.push("webpack://easy-vue/" + clean);
  }
  map.sources = vs;
  // 相对路径不再依赖 sourceRoot；清掉避免干扰
  map.sourceRoot = "";
  return map;
}


// 简单确定性哈希（8位十六进制）→ 用于 css module 类名
function cssHash(name: string, seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = ((h ^ seed.charCodeAt(i)) * 16777619) >>> 0;
  for (let i = 0; i < name.length; i++) h = ((h ^ name.charCodeAt(i)) * 16777619) >>> 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 用 esbuild 转译 TS/JS，返回 {code, map}。map 为 JSON 对象（external，未内联）。
 */
function esbuildTranspileWithMap(source: string, sourceName: string): { code: string; map: any } {
  const dir = mkdtempSync(join(tmpdir(), 'easyvue-'));
  const file = join(dir, 'input.ts');
  writeFileSync(file, source);
  const out = join(dir, 'out.js');
  execFileSync(ESBUILD, [
    '--format=esm', '--target=es2020', '--sourcemap=external',
    file, '--outfile=' + out,
  ], { maxBuffer: 64 * 1024 * 1024 });
  const code = readFileSync(out, 'utf8');
  const map = JSON.parse(readFileSync(out + '.map', 'utf8'));
  map._tempFile = file;
  return { code, map };
}

/** 顶层 ts/js 转译：内联 sourcemap，sourcefile 指向真实文件名 */
function esbuildInline(source: string, loader: string, sourceName: string): string {
  const out = execFileSync(ESBUILD, [
    '--loader=' + loader, '--format=esm', '--target=es2020', '--sourcemap=inline',
    '--sourcefile=' + sourceName,
  ], { input: source, maxBuffer: 64 * 1024 * 1024 });
  return out.toString();
}

/**
 * 对 <script lang="ts"> 的 compileScript 产物做多级转译：esbuild 去类型后，
 * 用 remapping 把 esbuild map（产物→script 内容）与 compiler-sfc map（script 内容→.vue）复合，
 * 得到最终指向 .vue 的完整 sourcemap。
 */
function transpileScriptTs(code: string, filename: string, scriptMap: any): string {
  const esb = esbuildTranspileWithMap(code, filename + '.ts');
  map: {
    const scriptMapAny = scriptMap;
    if (scriptMapAny) {
      const tempFile = esb.map._tempFile || filename + '.ts';
      const outFile = (esb.map._tempFile || '').replace(/input\.ts$/, '') + 'out.js';
      const outDir = tempFile.indexOf('/') >= 0 ? tempFile.substring(0, tempFile.lastIndexOf('/')) : '.';
      // 规范化 esbuild map source 为绝对路径（out.js 与 input.ts 同目录），并显式设置 file
      const sources: string[] = [];
      for (let k = 0; k < (esb.map.sources || []).length; k++) {
        const rel = esb.map.sources[k];
        sources.push(rel.charAt(0) === '/' ? rel : join(outDir, rel));
      }
      const rootMap = {
        version: 3,
        file: outFile,
        sources: sources,
        names: esb.map.names || [],
        mappings: esb.map.mappings,
      };
      const leafMap = {
        version: 3,
        file: sources.length > 0 ? sources[0] : tempFile,
        sourceRoot: '',
        sources: scriptMapAny.sources,
        names: scriptMapAny.names || [],
        mappings: scriptMapAny.mappings,
        sourcesContent: scriptMapAny.sourcesContent,
      };
      const loader = (f: string) => {
        const abs = f === undefined ? '' : String(f);
        let hit = abs === tempFile;
        if (!hit && sources.length > 0) hit = abs === sources[0];
        return hit ? (leafMap as any) : null;
      };
      try {
        const composed: any = remapping(rootMap as any, loader, false);
        esb.map = composed;
      } catch (e) {
        // 复合失败退回 esbuild map
      }
    }
  }
  return esb.code + inlineMapComment(normalizeMapSources(esb.map));
}

// 解析 <style module> / <style module="m1"> 的模块名（无名字返回空串=默认 $style）
function moduleNameOf(attrs: any): string {
  const v = attrs.module;
  const t = typeof v;
  if (t === 'boolean') return '';
  return String(v);
}

/**
 * 编译单个 .vue 源码 → {js, css}（同步）。
 * CSS module 类名哈希在 CSS 与模板中保持一致。
 */
function compileVue(source: string, filename: string, wantMap: boolean): { js: string; css: string } {
  const parsed = parse(source, { filename });
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error('parse errors: ' + JSON.stringify(parsed.errors));
  }
  const d: any = parsed.descriptor;

  // 1. 样式处理 + css module 映射
  const cssModules: any = {};
  const cssParts: string[] = [];
  const usedModuleNames = new Set<string>();
  if (d.styles) {
    for (let i = 0; i < d.styles.length; i++) {
      const st = d.styles[i];
      const attrs = st.attrs;
      const isModule = Boolean(attrs.module);
      const scoped = Boolean(attrs.scoped);
      const r = compileStyle({ source: st.content, filename, id: 'ev-' + i, scoped: !isModule && scoped });
      if (r.errors && r.errors.length > 0) {
        throw new Error('style errors: ' + JSON.stringify(r.errors));
      }
      let code = r.code || '';
      if (isModule) {
        const name = moduleNameOf(attrs);
        usedModuleNames.add(name);
        const mapping: any = {};
        // 重写 .class → ._class_<hash>，同步生成映射供模板使用
        code = rewriteCssModuleClasses(code, name, cssHash, mapping);
        cssModules[name] = mapping;
      }
      if (code) cssParts.push(code);
    }
  }
  const hasDefaultModule = usedModuleNames.has('');

  // 2. script / script setup
  let js = '';
  let scriptMap: any = null;
  let sfcBindings: any = null;
  if (d.scriptSetup || d.script) {
    const s = compileScript(d, { id: 'ev' });
    if (s.bindings) sfcBindings = s.bindings;
    // 把 default 导出捕获为局部变量 __sfc__，随后把模板 render 挂到它上面再导出
    let code = s.content.replace(/export default/, 'const __sfc__ =');
    if (wantMap && s.map) scriptMap = s.map;

    // 注入 css module 绑定：直接把类名映射字面量暴露到 setup 返回（$style / 具名模块）。
    // 不依赖运行时 useCssModule（它需要打包器注入 __cssModules 才有效）。
    if (usedModuleNames.size > 0) {
      const injections: string[] = [];
      if (hasDefaultModule) injections.push('const $style = ' + JSON.stringify(cssModules[''] || {}));
      for (const name of usedModuleNames) if (name) injections.push(`const ${name} = ${JSON.stringify(cssModules[name] || {})}`);
      const moduleVarNames: string[] = [];
      if (hasDefaultModule) moduleVarNames.push('$style');
      for (const name of usedModuleNames) if (name) moduleVarNames.push(name);

      code = code.replace(/(const __returned__ = \{)/, injections.join('\n') + '\n\n$1');
      const extra = moduleVarNames.join(', ');
      if (extra) {
        code = code.replace(/(const __returned__ = \{)/, `const __returned___mods = { ${extra} }\n$1`);
        code = code.replace(/(Object\.defineProperty\(__returned__)/, 'Object.assign(__returned__, __returned___mods)\n$1');
      }

      // 把 css module 变量名（$style / 具名模块）登记为 setup 绑定。
      // 这样模板里的 $style.X / m1.X 会被编译成 $setup["$style"].X（走 setup 返回的绑定），
      // 而不是 _ctx.$style（Vue 3 公开实例 Proxy 会屏蔽 $ 前缀的 setup 读，_ctx.$style 为 undefined）。
      for (const name of moduleVarNames) {
        sfcBindings = sfcBindings || {};
        sfcBindings[name] = 'setup-const';
      }
    }

    const scriptEl: any = d.scriptSetup || d.script;
    const scriptLang = scriptEl ? scriptEl.lang : null;
    if (scriptLang === 'ts' || scriptLang === 'tsx') {
      js += transpileScriptTs(code, filename, wantMap ? scriptMap : null);
    } else {
      js += code + '\n';
      if (wantMap && scriptMap) js += inlineMapComment(normalizeMapSources(scriptMap));
    }
  } else {
    js += 'const __sfc__ = {}\n';
  }

  // 3. 非 sourcemap 模式加头部注释（sourcemap 模式不加，保证 script 从第 0 行起，map 无需平移）
  if (!wantMap && !js.startsWith('// compiled by @vue/compiler-sfc via easy-vue\n')) {
    js = '// compiled by @vue/compiler-sfc via easy-vue\n' + js;
  }

  // 4. template（cssModules 使模板 $style.X / m1.X 被解析成 _ctx 引用），并挂到组件对象上。
  //    绑定 metadata（script setup 的导入/局部绑定）传下去，模板里的 <Foo/> 才能直接引用
  //    $setup["Foo"]，而不是退化为 _resolveComponent("Foo")（运行时依赖全局组件注册，会白屏）。
  const templateOptions: any = { source: d.template.content, filename, id: 'ev', cssModules };
  if (sfcBindings) {
    templateOptions.compilerOptions = { bindingMetadata: sfcBindings as any };
  }
  if (d.template) {
    const r = compileTemplate(templateOptions);
    if (r.errors && r.errors.length > 0) {
      throw new Error('template errors: ' + JSON.stringify(r.errors));
    }
    js += r.code + '\n';
    js += '__sfc__.render = render;\n';
  }
  js += 'export default __sfc__;\n';

  const css = cssParts.join('\n');
  return { js, css };
}

// 重写 css 中的 .class 选择器为哈希类名，并填充映射
// 用逐字符扫描识别选择器类名（简单实现：变量声明尽量避开引号字符串内误配）
function rewriteCssModuleClasses(css: string, moduleName: string, hashFn: (n: string, s: string) => string, mapping: any): string {
  const seed = moduleName === '' ? 'ev' : moduleName;
  let out = '';
  let i = 0;
  const n = css.length;
  while (i < n) {
    const c = css.charAt(i);
    if (c === '.') {
      // 类名开始：收集 [A-Za-z_][A-Za-z0-9_-]*
      let j = i + 1;
      const m0 = css.charAt(j);
      if ((m0 >= 'a' && m0 <= 'z') || (m0 >= 'A' && m0 <= 'Z') || m0 === '_') {
        j++;
        while (j < n) {
          const ch = css.charAt(j);
          if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '-') j++;
          else break;
        }
        const cls = css.substring(i + 1, j);
        if (!mapping[cls]) mapping[cls] = '_' + cls + '_' + hashFn(cls, seed);
        out += '.' + mapping[cls];
        i = j;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

interface Req { id?: number; type?: string; source?: string; filename?: string; sourcemap?: boolean; }
interface Resp { id: number | null; ok: boolean; js?: string; css?: string; error?: string; }

function handleReq(line: string, allowRead: boolean): string {
  const req: Req = JSON.parse(line);
  const id: number | null = req.id === undefined ? null : req.id;
  const wantMap = !!req.sourcemap;
  let type = req.type || (req.filename || '').split('.').pop() || 'js';

  let source = req.source;
  if (source === undefined) {
    if (req.filename == null) throw new Error('request needs "source" or a readable "filename"');
    // 安全：serve(HTTP) 模式下禁止按 filename 读服务器本地文件，避免任意文件读取泄露。
    // 只有本地可信的 convert 模式允许按 filename 读取。
    if (!allowRead) {
      throw new Error('reading server files by "filename" is disabled in serve mode; provide "source" instead');
    }
    if (!existsSync(req.filename)) throw new Error('file not found: ' + req.filename);
    source = readFileSync(req.filename, 'utf-8');
  }
  const filename = req.filename || 'inline.' + type;

  if (type === 'vue') {
    const out = compileVue(source, filename, wantMap);
    return JSON.stringify({ id, ok: true, js: out.js, css: out.css } as Resp);
  } else if (type === 'ts' || type === 'jsx' || type === 'tsx') {
    const js = esbuildInline(source, 'ts', filename);
    return JSON.stringify({ id, ok: true, js } as Resp);
  } else if (type === 'js') {
    if (source.includes('@api')) {
      const js = esbuildInline(source, 'js', filename);
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

function compileJson(reqJson: string, allowRead: boolean): string {
  try {
    return handleReq(reqJson, allowRead);
  } catch (e) {
    return JSON.stringify({ id: null, ok: false, error: String((e as Error).message || e) } as Resp);
  }
}

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
      if (size > 16 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (size > 16 * 1024 * 1024) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: null, ok: false, error: 'request body too large' } as Resp));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(compileJson(body, false));
    });
    req.on('error', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: null, ok: false, error: 'request error' } as Resp));
    });
  });
  server.listen(Number(listenPort), listenHost, () => {
    process.stdout.write('__READY__ easy-vue ' + EASY_VUE_VERSION + '\n');
  });
}

function convert() {
  const line = readLine();
  if (line === null) return;
  if (line) process.stdout.write(compileJson(line, true) + '\n');
}

function usage() {
  process.stdout.write('usage: easy-vue serve [host:]port | convert | --version\n' +
    '  serve      HTTP 常驻（必须指定端口，如 0.0.0.0:9000；或设 SF_HOST/SF_PORT），POST /compile\n' +
    '  convert    stdin 读一行 JSON 编译后写一行输出即退出\n' +
    '  --version  打印版本后退出\n');
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
  if (argv.indexOf('--version') >= 0 || argv.indexOf('version') >= 0) {
    process.stdout.write('easy-vue ' + EASY_VUE_VERSION + '\n');
    return;
  }
  usage();
}
main();
