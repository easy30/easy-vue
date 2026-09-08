// easy-vue 模式1 · 无状态前端编译器（scriptc 原生二进制）
// 协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应 / HTTP POST /compile
//   入 {"id", "type":"vue"|"ts"|"js", "source", "filename"?, "sourcemap"?:boolean}
//   安全：serve(HTTP) 模式必须提供 source，filename 仅作编译时的名字/type 推断，绝不读服务器本地文件。
//         仅本地可信的 convert 模式允许只给 filename 按服务器本地文件读取。
//   出 {"id","ok","js"?,"css"?,"error"?}
// sourcemap=true 时产出内联 sourcemap，多级完整支持：
//   - ts/js    → esbuild --sourcemap=inline（--sourcefile 指向真实文件名）
//   - vue      → <script>/<script setup lang="ts"> 段经 esbuild 转译去类型后，
//               用 @ampproject/remapping 将 esbuild map 与 compiler-sfc map 逐级复合；
//               template 段 map（模板局部坐标）平移到全文件坐标后，与 script 段 map
//               合并为一张覆盖整个产物的 map，统一指向原始 .vue，并按规范置于产物最后一行
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
import { resolveEsbuild } from './esbuild-bin';
import { runDeps } from './deps';

const BUF = Buffer.alloc(1);

// esbuild 定位逻辑移至 ./esbuild-bin（serve 与 deps 共用）
const ESBUILD = resolveEsbuild();

// UTF-8 → base64：用 scriptc 原生 Buffer 支持
function inlineMapComment(map: unknown): string {
  const json = typeof map === 'string' ? map : JSON.stringify(map);
  const b64 = Buffer.from(json, 'utf-8').toString('base64');
  // 必须带前导换行：sourceMappingURL 是行注释，前导换行保证它独占一行。
  // 规范要求该注释位于生成文件最后一行——现在只在整段 js 拼接完成后调用一次，天然满足。
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
    // 幂等：已带前缀的不再重复加（合并流程里可能对同一 map 多次规范化）
    if (s.indexOf('webpack://') === 0) { vs.push(s); continue; }
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
function transpileScriptTs(code: string, filename: string, scriptMap: any): { code: string; map: any } {
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
        // remapping 会把叶子 sources 解析到根 source 所在目录（临时目录），
        // 这里改成绝对虚拟路径，让最终 source 干净地落在 /views/xxx.vue
        sources: scriptMapAny.sources.map((s: string) => '/' + String(s).replace(/^\/?/, '')),
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
  // 返回未规范化的原始 map，sources 统一由 mergeBlockMaps 处理
  return { code: esb.code, map: esb.map };
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// sourcemap VLQ 编码单个整数（支持负数）
function vlqEncode(n: number): string {
  let v = n < 0 ? ((-n) << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64_CHARS.charAt(digit);
  } while (v > 0);
  return out;
}

// 解码 mappings：按生成行返回段数组（绝对坐标；仅一个字段的段表示无源位置）
function decodeMappings(map: any): any[][] {
  const out: any[][] = [];
  let srcIdx = 0, srcLine = 0, srcCol = 0, nameIdx = 0;
  const lines = String(map.mappings).split(';');
  for (let li = 0; li < lines.length; li++) {
    const segs: any[] = [];
    const line = lines[li];
    if (line !== '') {
      let genCol = 0;
      const raw = line.split(',');
      for (let si = 0; si < raw.length; si++) {
        const str = raw[si];
        if (str === '') continue;
        let i = 0;
        const nextVal = () => {
          let v = 0, shift = 0, cont = 1;
          while (cont) {
            const d = B64_CHARS.indexOf(str.charAt(i));
            i++;
            if (d < 0) throw new Error('bad vlq char');
            cont = d & 32;
            v += (d & 31) << shift;
            shift += 5;
          }
          const neg = v & 1;
          v >>= 1;
          return neg ? -v : v;
        };
        genCol += nextVal();
        if (i >= str.length) { segs.push({ genCol: genCol }); continue; }
        srcIdx += nextVal();
        srcLine += nextVal();
        srcCol += nextVal();
        const seg: any = { genCol: genCol, srcIdx: srcIdx, srcLine: srcLine, srcCol: srcCol };
        if (i < str.length) { nameIdx += nextVal(); seg.nameIdx = nameIdx; }
        segs.push(seg);
      }
    }
    out.push(segs);
  }
  return out;
}

// 把绝对坐标段数组编码回 mappings 字符串
function encodeMappings(lines: any[][]): string {
  let prevSrcIdx = 0, prevSrcLine = 0, prevSrcCol = 0, prevNameIdx = 0;
  const out: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    const parts: string[] = [];
    for (let si = 0; si < lines[li].length; si++) {
      const seg = lines[li][si];
      const prevGenCol = si === 0 ? 0 : lines[li][si - 1].genCol;
      let s = vlqEncode(seg.genCol - prevGenCol);
      if (seg.srcIdx !== undefined) {
        s += vlqEncode(seg.srcIdx - prevSrcIdx); prevSrcIdx = seg.srcIdx;
        s += vlqEncode(seg.srcLine - prevSrcLine); prevSrcLine = seg.srcLine;
        s += vlqEncode(seg.srcCol - prevSrcCol); prevSrcCol = seg.srcCol;
        if (seg.nameIdx !== undefined) { s += vlqEncode(seg.nameIdx - prevNameIdx); prevNameIdx = seg.nameIdx; }
      }
      parts.push(s);
    }
    out.push(parts.join(','));
  }
  return out.join(';');
}

/**
 * 合并 script 块与 template 块的 sourcemap 为一张覆盖整个最终模块的 map。
 * 两块在最终 js 中均为原文拼接：块内生成行 + 块起始行 = 最终模块行；
 * template map 是模板局部坐标（sourcesContent 为模板片段），先按 srcLineShift
 * 平移到 .vue 全文件坐标。sources/names 去重合并，sourcesContent 统一回填 .vue 原文。
 */
function mergeBlockMaps(scriptMap: any, templateMap: any, templateLineOffset: number, templateLineShift: number, originalSource: string): any | null {
  const parts: any[] = [];
  if (scriptMap && scriptMap.mappings) parts.push({ start: 0, srcLineShift: 0, map: scriptMap });
  if (templateMap && templateMap.mappings) parts.push({ start: templateLineOffset, srcLineShift: templateLineShift, map: templateMap });
  if (parts.length === 0) return null;
  const sources: string[] = [];
  const names: string[] = [];
  const indexOfIn = (arr: string[], s: string) => {
    for (let i = 0; i < arr.length; i++) if (arr[i] === s) return i;
    arr.push(s);
    return arr.length - 1;
  };
  const decodedParts: any[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const pSources = p.map.sources || [];
    const pNames = p.map.names || [];
    const srcMap: any = {};
    for (let k = 0; k < pSources.length; k++) {
      // 先规范化再去重，两个块指向同一 .vue 时合并为一条 source
      const s = String(pSources[k]);
      const v = s.indexOf('webpack://') === 0 ? s : 'webpack://easy-vue/' + s.replace(/^\/?/, '');
      srcMap[k] = indexOfIn(sources, v);
    }
    const nameMap: any = {};
    for (let k = 0; k < pNames.length; k++) nameMap[k] = indexOfIn(names, String(pNames[k]));
    decodedParts.push({ start: p.start, srcLineShift: p.srcLineShift, dec: decodeMappings(p.map), srcMap: srcMap, nameMap: nameMap });
  }
  decodedParts.sort((a, b) => a.start - b.start);
  const mergedLines: any[][] = [];
  let emitted = -1;
  for (let pi = 0; pi < decodedParts.length; pi++) {
    const p = decodedParts[pi];
    for (let genLine = 0; genLine < p.dec.length; genLine++) {
      const target = p.start + genLine;
      if (target <= emitted) continue;   // 块行区间重叠时跳过后者（正常布局不会发生）
      while (emitted < target - 1) { mergedLines.push([]); emitted++; }
      const segs: any[] = [];
      const segsSrc = p.dec[genLine];
      for (let si = 0; si < segsSrc.length; si++) {
        const seg = segsSrc[si];
        if (seg.srcIdx === undefined) { segs.push({ genCol: seg.genCol }); continue; }
        const mapped: any = { genCol: seg.genCol, srcIdx: p.srcMap[seg.srcIdx], srcLine: seg.srcLine + p.srcLineShift, srcCol: seg.srcCol };
        if (seg.nameIdx !== undefined) mapped.nameIdx = p.nameMap[seg.nameIdx];
        segs.push(mapped);
      }
      mergedLines.push(segs);
      emitted = target;
    }
  }
  const merged: any = { version: 3, file: 'ev-final.js', sources: sources, names: names, mappings: encodeMappings(mergedLines) };
  normalizeMapSources(merged);
  if (sources.length > 0) merged.sourcesContent = merged.sources.map(() => originalSource);
  return merged;
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
function compileVue(source: string, filename: string, wantMap: boolean, styleInject: boolean): { js: string; css: string } {
  const parsed = parse(source, { filename });
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error('parse errors: ' + JSON.stringify(parsed.errors));
  }
  const d: any = parsed.descriptor;
  // 文件级统一 scope id（官方语义，所有 style 块共用，不含块序号）：
  // compileStyle 产 [data-v-x] 选择器、compileTemplate 给 VNode 加 scopeId（由 id 内部拼 data-v- 前缀）、
  // compileScript 定 v-bind CSS 变量前缀——三侧必须同 id，否则 scoped/v-bind 静默失效
  const scopeShort = cssHash(filename, 'ev');
  const scopeId = 'data-v-' + scopeShort;

  // 1. 样式处理 + css module 映射
  const cssModules: any = {};
  const cssParts: string[] = [];
  const usedModuleNames = new Set<string>();
  // 对齐官方（plugin-vue template.ts）：任意块带 scoped 即算（module+scoped 同块也算）；
  // compileStyle 的 scoped 按块属性原样传（官方 style.ts），module 块的 scoped 不吞
  let hasScoped = false;
  if (d.styles) {
    for (let i = 0; i < d.styles.length; i++) {
      const st = d.styles[i];
      const attrs = st.attrs;
      const isModule = Boolean(attrs.module);
      const scoped = Boolean(attrs.scoped);
      if (scoped) hasScoped = true;
      const r = compileStyle({ source: st.content, filename, id: scopeShort, scoped });
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
  let scriptMap: any = null;   // script 块 map（生成行 == 最终模块行），最后与 template map 合并
  let sfcBindings: any = null;
  if (d.scriptSetup || d.script) {
    const s = compileScript(d, { id: scopeShort });
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
      const ts = transpileScriptTs(code, filename, wantMap ? scriptMap : null);
      js += ts.code + '\n';
      if (wantMap && ts.map) scriptMap = ts.map;   // esbuild 产物行 == 模块行，map 直接可用
    } else {
      js += code + '\n';   // script map 坐标即模块行（sourcemap 模式无头部注释），留待合并
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
  const templateOptions: any = { source: d.template.content, filename, id: scopeShort, scoped: hasScoped, slotted: Boolean(d.slotted) };
  if (sfcBindings) {
    templateOptions.compilerOptions = { bindingMetadata: sfcBindings as any };
  }
  let templateMap: any = null;
  let templateLineOffset = 0;   // render 代码在最终 js 里的起始行（0 基）
  let templateLineShift = 0;    // template map 局部坐标 → .vue 全文件坐标的行偏移
  if (d.template) {
    // 此前 js 必以 \n 结尾，render 代码从新的一行开始
    templateLineOffset = js.split('\n').length - 1;
    const r = compileTemplate(templateOptions);
    if (r.errors && r.errors.length > 0) {
      throw new Error('template errors: ' + JSON.stringify(r.errors));
    }
    js += r.code + '\n';
    js += '__sfc__.render = render;\n';
    // template map 是模板局部坐标（sourcesContent 为模板片段）：
    // 偏移 = <template> 标签（1 基）所在行，即模板内容首行的 0 基行号
    if (wantMap && r.map) {
      templateMap = r.map;
      templateLineShift = d.template.loc.start.line - 1;
    }
  }
  // scoped：给组件对象挂 __scopeId（Vue 3.5 机制：runtime 在 setCurrentRenderingInstance
  // 时读 instance.type.__scopeId 挂到每个 vnode，与 compileStyle 产的 [data-v-x] 选择器匹配；
  // 参照 plugin-vue main.ts 的 attachedProps 做法，compiler 不产此字段，集成方必须自己加）
  if (hasScoped) js += '__sfc__.__scopeId = ' + JSON.stringify(scopeId) + '\n';
  // css module：挂 __cssModules（plugin-vue 同款），script setup 里 useCssModule() /
  // useCssModule('名') 走 runtime 这条路；默认模块键必须是 '$style'（runtime 缺省取它）
  if (usedModuleNames.size > 0) {
    const m: any = {};
    for (const name of usedModuleNames) m[name === '' ? '$style' : name] = cssModules[name] || {};
    js += '__sfc__.__cssModules = ' + JSON.stringify(m) + '\n';
  }
  js += 'export default __sfc__;\n';

  // style:"inject"：CSS 以幂等注入脚本编进 js。必须先于 sourcemap 拼接，
  // 保证 sourceMappingURL 注释保持在文件末行（规范要求）；空样式不加脚本。
  // css 字段照旧返回，供想要独立 .css 文件的调用方使用（注入脚本幂等，两者不冲突）。
  if (styleInject && cssParts.length > 0) js += styleInjectScript(cssParts.join('\n'), filename);

  // 合并 script/template 两块 map 为一张，置于文件最后一行（规范要求 sourceMappingURL 在末行）
  if (wantMap) {
    let merged: any = null;
    try {
      merged = mergeBlockMaps(scriptMap, templateMap, templateLineOffset, templateLineShift, source);
    } catch (e) {
      merged = scriptMap ? normalizeMapSources(scriptMap) : null;   // 合并失败退回仅 script 的 map
    }
    if (merged) js += inlineMapComment(merged);
  }

  const css = cssParts.join('\n');
  return { js, css };
}

// 生成样式注入脚本：SSR 安全 + 按组件幂等（同一组件重复加载只更新不重复插标签）。
// scriptc 限制：不用模板字符串/replace(fn)/g 正则，拼接与清洗用 concat 与字符循环。
function styleInjectScript(css: string, filename: string): string {
  // 组件标识：文件名 hash（8 位 hex）作 style 标签幂等键。
  // 不用清洗文本：①清洗可产生空键/撞键（'a/b.vue' 与 'a-b-vue' 同为 a-b-vue，样式互相覆盖）；
  // ②filename='style.vue' 时清洗键 data-ev-style 会与枚举标记属性同名互相覆盖。
  const attr = 'data-ev-' + cssHash(filename, 'ev-style');
  // CSS 嵌入为合法 JS 字符串字面量；< 转义为 \u003c（防 </script> 类序列）
  const cssLit = JSON.stringify(css).split('<').join('\\u003c');
  // 注入样板取压缩形态：每个 vue 产物都会带一份，可读性让位于体积
  let code = '\n;(function(){if(typeof document=="undefined")return;var c=' + cssLit + ',a="' + attr + '",s=document.querySelector("style["+a+"]"),t=document.querySelectorAll("style[data-ev-style]"),i;for(i=0;i<t.length;i++)if(t[i].textContent===c)return;if(s){s.textContent=c;return}s=document.createElement("style");s.setAttribute("data-ev-style","");s.setAttribute(a,"");s.textContent=c;document.head.appendChild(s)})();\n';
  return code;
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

interface Req { id?: number; type?: string; source?: string; filename?: string; sourcemap?: boolean; style?: string; }
interface Resp { id: number | null; ok: boolean; js?: string; css?: string; error?: string; }

function handleReq(line: string, allowRead: boolean): string {
  const req: Req = JSON.parse(line);
  const id: number | null = req.id === undefined ? null : req.id;
  const wantMap = !!req.sourcemap;
  const styleInject = req.style !== 'separate';   // 缺省注入（新项目无需兼容旧分字段）；显式 "separate" 走 css 分字段
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
    const out = compileVue(source, filename, wantMap, styleInject);
    // 注入模式样式已在 js 内，响应省略 css 字段（避免双份传输）；需要独立 css 文件的调用方用 "style":"separate"
    const resp: Resp = { id, ok: true, js: out.js };
    if (!styleInject) resp.css = out.css;
    return JSON.stringify(resp);
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
  process.stdout.write('usage: easy-vue serve [host:]port | convert | deps -c <config.json> | --version\n' +
    '  serve      HTTP 常驻（必须指定端口，如 0.0.0.0:9000），POST /compile\n' +
    '  convert    stdin 读一行 JSON 编译后写一行输出即退出\n' +
    '  deps       依赖摇树：扫描源码 → 生成 entry → esbuild --bundle → 产物 js/css + meta.json\n' +
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
  const di = argv.indexOf('deps');
  if (di >= 0) {
    const ci = argv.indexOf('-c');
    const configPath = ci >= 0 && argv[ci + 1] ? argv[ci + 1] : null;
    if (!configPath) {
      process.stderr.write('[easy-vue deps] 缺少配置: easy-vue deps -c <config.json> [--force]\n');
      usage();
      process.exit(1);
    }
    process.exit(runDeps(configPath, argv.indexOf('--force') >= 0));
    return;
  }
  if (argv.indexOf('--version') >= 0 || argv.indexOf('version') >= 0) {
    process.stdout.write('easy-vue ' + EASY_VUE_VERSION + '\n');
    return;
  }
  usage();
}
main();
