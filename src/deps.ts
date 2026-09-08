// easy-vue deps · 依赖摇树命令（本地可信模式，同 convert：读本地文件，不经 HTTP）
// 用法: easy-vue deps -c <config.json> [--force]
// 流程: 读配置 → 扫描源码（模板标签 + 具名导入）→ 生成 entry → esbuild --bundle 摇树
//       → 产物 js/css + meta.json 原子写入 outputDir
// 缓存: listHash = hash(排序名单 + dep 配置 + 包版本)，命中 meta.json 且产物齐全 → 跳过 esbuild
// 结果: stdout 输出一行 JSON（同 convert 风格），exit 0 成功 / 1 失败
//
// 为什么用深路径导入而不是包根导入：组件库根入口（如 element-plus 的 es/index.mjs）
// 顶层副作用与 installer 链会让 esbuild 的 tree-shaking 保守地保留全部组件（实测
// 多种补丁均无效），按「每个名字一个深路径模块」导入才能精确摇树（与 Vite 依赖
// 预构建同原理）。普通 ESM 库（sideEffects 声明规范）用 root 策略从包根导入即可。
//
// scriptc 编译限制备忘：不用 Object.keys（用 Set/Map）、不用 replace(fn)（用字符循环）、
// JSON.parse 后的配置一律走 any 局部变量（同 serve.ts 对请求对象的处理方式）。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEsbuild } from './esbuild-bin';
import { EASY_VUE_VERSION } from './version';

const ESBUILD = resolveEsbuild();

// ---------- 路径与基础工具 ----------

// 相对路径以配置文件所在目录为基准（同 tsconfig 惯例）；绝对路径原样返回
function resolvePath(p: string, base: string): string {
    if (p === null || p === undefined || p === '') return p;
    if (p.charAt(0) === '/') return p;
    return join(base, p);
}

function ensureDir(dir: string): void {
    if (existsSync(dir)) return;
    const parent = dir.substring(0, dir.lastIndexOf('/'));
    if (parent && parent !== dir && !existsSync(parent)) ensureDir(parent);
    mkdirSync(dir);
}

// 原子写：先写临时名再 rename，防并发读半截文件
function writeAtomic(path: string, content: string): void {
    const tmp = path + '.tmp-' + Math.floor(Math.random() * 1000000000);
    writeFileSync(tmp, content);
    renameSync(tmp, path);
}

function sha16(s: string): string {
    return createHash('sha256').update(s).digest('hex').substring(0, 16);
}

// "table-column" → "TableColumn"
function pascal(s: string): string {
    let out = '';
    let up = true;
    for (let i = 0; i < s.length; i++) {
        const c = s.charAt(i);
        if (c === '-') { up = true; continue; }
        out += up ? c.toUpperCase() : c;
        up = false;
    }
    return out;
}

// "ElTableColumn" → "table-column"（deep 模式目录缺省推导）
function pascalToKebab(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charAt(i);
        if (c >= 'A' && c <= 'Z' && i > 0) out += '-' + c.toLowerCase();
        else out += c.toLowerCase();
    }
    return out;
}

// 在候选路径里返回第一个存在的绝对路径；都缺则返回空串（scriptc 不允许 string 函数返回 null）
function resolveFirstExisting(pkgRoot: string, template: string): string {
    const candidates = [template, template + '.mjs', template + '/index.mjs', template + '.js', template + '.css'];
    for (const c of candidates) {
        const abs = join(pkgRoot, c);
        if (existsSync(abs)) return abs;
    }
    return '';
}

// ---------- 扫描 ----------

function walk(dir: string, exts: string[], out: string[]): void {
    if (!existsSync(dir)) throw new Error('scan.roots 目录不存在: ' + dir);
    const entries = readdirSync(dir);
    for (const e of entries) {
        const full = join(dir, e);
        if (!existsSync(full)) continue;   // 竞态保护
        const st = statSync(full);
        if (st.isDirectory()) {
            walk(full, exts, out);
        } else {
            for (const x of exts) {
                if (e.length > x.length && e.substring(e.length - x.length) === x) { out.push(full); break; }
            }
        }
    }
}

interface ScanResult {
    tagNames: Set<string>;    // 模板标签推导的组件名（deep 用）
    importNames: Set<string>; // 具名导入名
    hasDefault: boolean;      // 是否存在默认导入
}

function scanSources(cfg: any, dep: any): ScanResult {
    const tagNames = new Set<string>();
    const importNames = new Set<string>();
    let hasDefault = false;
    const scanAny: any = cfg.scan;
    const exts: string[] = scanAny.extensions && scanAny.extensions.length
        ? (scanAny.extensions as any as string[])
        : ['.vue', '.html'];
    const files: string[] = [];
    const roots: string[] = (scanAny.roots || []) as any as string[];
    for (const root of roots) walk(resolvePath(root, cfg.configDir), exts, files);
    files.sort();   // 确定性：同内容必得同名单

    // scriptc 不支持带 g 标志的 regex 匹配，扫描用纯字符串 split 实现（宁多勿漏）
    const prefix: string = (dep.componentPrefix || '') as any as string;
    const fromMarkers = ["from '" + dep.name + "'", 'from "' + dep.name + '"'];

    for (const f of files) {
        const src = readFileSync(f, 'utf8');
        // 1) 模板标签：按 '<' + 前缀 切分，段首即标签名剩余部分
        if (prefix) {
            const marker = '<' + prefix;
            const chunks = src.split(marker);
            const prefixBase = prefix.charAt(prefix.length - 1) === '-' ? prefix.substring(0, prefix.length - 1) : prefix;
            for (let i = 1; i < chunks.length; i++) {
                const seg = chunks[i];
                if (seg.length === 0) continue;
                const c0 = seg.charAt(0);
                if (!(c0 >= 'a' && c0 <= 'z')) continue;   // 标签须字母开头（<el-9x 不算）
                let j = 1;
                while (j < seg.length) {
                    const c = seg.charAt(j);
                    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-') j++;
                    else break;
                }
                tagNames.add(pascal(prefixBase) + pascal(seg.substring(0, j)));
            }
        }
        // 2) import 语句：定位每个 from '<name>' 标记，向前回溯最近的 import 关键字
        for (const marker of fromMarkers) {
            const chunks = src.split(marker);
            for (let i = 0; i < chunks.length - 1; i++) {
                const head = chunks[i];
                const impIdx = head.lastIndexOf('import');
                if (impIdx < 0) continue;
                const seg = head.substring(impIdx + 6);
                const braceOpen = seg.indexOf('{');
                const braceClose = seg.lastIndexOf('}');
                if (braceOpen >= 0 && braceClose > braceOpen) {
                    const inner = seg.substring(braceOpen + 1, braceClose);
                    for (const part of inner.split(',')) {
                        let n = part.trim();
                        if (!n) continue;
                        const asIdx = n.indexOf(' as ');
                        if (asIdx >= 0) n = n.substring(0, asIdx).trim();
                        importNames.add(n);
                    }
                    // 花括号前的裸标识符 = 默认导入（混合导入 import X, { Y })
                    const before = seg.substring(0, braceOpen).split(',').join(' ').trim();
                    if (before) hasDefault = true;
                } else {
                    const bare = seg.split(',')[0].trim();
                    if (bare) hasDefault = true;
                }
            }
        }
    }
    return { tagNames: tagNames, importNames: importNames, hasDefault: hasDefault };
}

// ---------- entry 生成 ----------

// deep：组件库。每个名字一条深路径 import（同目录合并），样式按目录聚合，
// default 导出 install 插件（只注册模板标签里出现的名字），具名导出全覆盖。
function genDeepEntry(pkgRoot: string, dep: any, names: string[], tagNames: Set<string>): string {
    const jsTemplate: string = (dep.jsTemplate || 'es/components/{dir}/index.mjs') as any as string;
    const mappings: any = dep.mappings || {};
    // 组件前缀的 Pascal 形态（el- → El）：目录缺省推导时要先剥掉它（ElButton → button）
    const prefixRaw: string = (dep.componentPrefix || '') as any as string;
    const prefixBase = prefixRaw && prefixRaw.charAt(prefixRaw.length - 1) === '-' ? prefixRaw.substring(0, prefixRaw.length - 1) : prefixRaw;
    const prefixPascal = prefixBase ? pascal(prefixBase) : '';
    // 名字 → 目录，并校验模块存在（mappings 优先，缺省剥前缀后 kebab 推导）
    const dirOf = new Map<string, string>();
    const missing: string[] = [];
    for (const n of names) {
        let dir: string;
        if (mappings[n] !== undefined) dir = mappings[n];
        else if (prefixPascal && n.substring(0, prefixPascal.length) === prefixPascal) dir = pascalToKebab(n.substring(prefixPascal.length));
        else dir = pascalToKebab(n);
        const found = resolveFirstExisting(pkgRoot, jsTemplate.replace('{dir}', dir));
        if (found) dirOf.set(n, dir);
        else missing.push(n + ' → ' + dir);
    }
    if (missing.length > 0) {
        throw new Error('以下名字在包内找不到模块（补 mappings 或 ignore）: ' + missing.join(', '));
    }
    // import 语句按目录分组（两遍扫描：scriptc 的 Map 存数组经 any 边界会复制，push 不持久化，
    // 故 dirOf 只存 string，分组靠第二遍过滤）
    const dirs: string[] = [];
    for (const n of names) {
        const d = dirOf.get(n) as any as string;
        if (dirs.indexOf(d) < 0) dirs.push(d);
    }
    dirs.sort();
    let code = '';
    for (const d of dirs) {
        const list: string[] = [];
        for (const n of names) {
            if ((dirOf.get(n) as any as string) === d) list.push(n);
        }
        list.sort();
        const mod = resolveFirstExisting(pkgRoot, jsTemplate.replace('{dir}', d));
        code += "import { " + list.join(', ') + " } from '" + mod + "';\n";
    }
    // 样式：按目录去重聚合
    if (dep.styleTemplate) {
        const styleTemplate: string = dep.styleTemplate as any as string;
        for (const d of dirs) {
            const styleAbs = resolveFirstExisting(pkgRoot, styleTemplate.replace('{dir}', d));
            if (!styleAbs) throw new Error('样式路径不存在（dir=' + d + '）: ' + styleTemplate);
            code += "import '" + styleAbs + "';\n";
        }
    }
    const styles: string[] = (dep.styles || []) as any as string[];
    for (const s of styles) {
        const abs = join(pkgRoot, s);
        if (!existsSync(abs)) throw new Error('styles 文件不存在: ' + s);
        code += "import '" + abs + "';\n";
    }
    // default 导出 install 插件：只注册模板标签里出现的名字（ElMessage 这类服务函数不注册）
    const compNames = names.filter(function (n: string): boolean { return tagNames.has(n); });
    code += 'const __comps__ = [' + compNames.join(', ') + '];\n';
    code += 'const __lite__ = { install: function(app) { __comps__.forEach(function(c) { if (c && c.name) app.component(c.name, c); }); } };\n';
    code += 'export default __lite__;\n';
    code += 'export { ' + names.join(', ') + ' };\n';
    return code;
}

// root：普通 ESM 库。从包根入口导入扫描到的具名导入即可摇树。
function genRootEntry(pkgRoot: string, dep: any, names: string[], hasDefault: boolean): string {
    let entryRel = '';
    const pj = join(pkgRoot, 'package.json');
    if (existsSync(pj)) {
        const pkg: any = JSON.parse(readFileSync(pj, 'utf8'));
        if (pkg.module) entryRel = pkg.module;
        else if (pkg.main) entryRel = pkg.main;
    }
    if (!entryRel) {
        if (existsSync(join(pkgRoot, 'index.mjs'))) entryRel = 'index.mjs';
        else if (existsSync(join(pkgRoot, 'index.js'))) entryRel = 'index.js';
    }
    if (!entryRel) throw new Error('packageRoot 缺少 package.json(module/main) 或 index.mjs/index.js');
    const entryAbs = join(pkgRoot, entryRel);
    if (!existsSync(entryAbs)) throw new Error('入口文件不存在: ' + entryAbs);
    if (names.length === 0 && !hasDefault) {
        throw new Error('未扫描到对 ' + String(dep.name) + ' 的任何导入（检查 scan.roots 是否覆盖了源码目录）');
    }
    let code = '';
    if (names.length > 0 && hasDefault) {
        code += "import __lib__, { " + names.join(', ') + " } from '" + entryAbs + "';\n";
    } else if (names.length > 0) {
        code += "import { " + names.join(', ') + " } from '" + entryAbs + "';\n";
    } else {
        code += "import __lib__ from '" + entryAbs + "';\n";
    }
    if (names.length > 0) code += 'export { ' + names.join(', ') + ' };\n';
    if (hasDefault) code += 'export default __lib__;\n';
    return code;
}

// ---------- 单 dep 摇树 ----------

function readMeta(outDir: string): any {
    const p = join(outDir, 'meta.json');
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function shakeDep(cfg: any, dep: any, force: boolean): any {
    if (!dep.name) throw new Error('deps[] 缺少 name');
    if (!dep.packageRoot) throw new Error('deps[' + String(dep.name) + '] 缺少 packageRoot');
    const pkgRoot = resolvePath(dep.packageRoot, cfg.configDir);
    if (!existsSync(pkgRoot)) throw new Error('packageRoot 不存在: ' + pkgRoot);

    let pkgVersion = '';
    const pj = join(pkgRoot, 'package.json');
    if (existsSync(pj)) {
        try { pkgVersion = JSON.parse(readFileSync(pj, 'utf8')).version || ''; } catch (e) { pkgVersion = ''; }
    }
    const strategy = dep.strategy === 'deep' ? 'deep' : 'root';

    // 1. 扫描 → 名单
    const scan = scanSources(cfg, dep);
    const ignore = new Set<string>((dep.ignore || []) as any as string[]);
    const nameSet = new Set<string>();
    scan.tagNames.forEach(function (n: string): void { if (!ignore.has(n)) nameSet.add(n); });
    scan.importNames.forEach(function (n: string): void { if (!ignore.has(n)) nameSet.add(n); });
    const names: string[] = [];
    nameSet.forEach(function (n: string): void { names.push(n); });
    names.sort();
    if (names.length === 0 && !(strategy === 'root' && scan.hasDefault)) {
        throw new Error('未扫描到对 ' + String(dep.name) + ' 的任何导入（检查 scan.roots / componentPrefix 是否覆盖了源码）');
    }

    // 2. listHash + 缓存判断
    const eopts: any = cfg.esbuild || {};
    const mappingsJson = JSON.stringify(dep.mappings || {});
    const ignoreJson = JSON.stringify((dep.ignore || []) as any as string[]).split(',').sort().join(',');
    const target: string = (eopts.target || 'es2020') as any as string;
    const externals: string[] = ((eopts.external || []) as any as string[]).slice().sort();
    const listHash = sha16(JSON.stringify({
        schema: 1,
        name: String(dep.name),
        packageVersion: pkgVersion,
        strategy: strategy,
        names: names,
        hasDefault: scan.hasDefault,
        componentPrefix: dep.componentPrefix ? String(dep.componentPrefix) : null,
        jsTemplate: dep.jsTemplate ? String(dep.jsTemplate) : null,
        styleTemplate: dep.styleTemplate ? String(dep.styleTemplate) : null,
        styles: dep.styles ? (dep.styles as any as string[]) : [],
        mappingsJson: mappingsJson,
        ignoreJson: ignoreJson,
        esbuild: { target: target, minify: eopts.minify !== false, external: externals }
    }));
    const outDir = resolvePath(cfg.outputDir, cfg.configDir);
    const output: any = dep.output || {};
    const jsName: string = (output.js || dep.name + '.lite.mjs') as any as string;
    const cssName: string = (output.css || dep.name + '.lite.css') as any as string;
    const outJs = join(outDir, jsName);
    const outCss = join(outDir, cssName);
    const meta = readMeta(outDir);
    const prev: any = meta ? meta[dep.name] : null;
    // 3. 缓存命中：listHash 一致且两份产物都在
    if (!force && prev && prev.listHash === listHash && existsSync(outJs) && existsSync(outCss)) {
        return { cached: true, js: outJs, css: outCss, jsHash: prev.jsHash, cssHash: prev.cssHash, listHash: listHash, names: names.length, packageVersion: pkgVersion };
    }

    // 4. 生成 entry
    const entryCode = strategy === 'deep'
        ? genDeepEntry(pkgRoot, dep, names, scan.tagNames)
        : genRootEntry(pkgRoot, dep, names, scan.hasDefault);

    // 4. esbuild 摇树（define 固定 NODE_ENV=production；vue 由 external 声明）
    const tmp = mkdtempSync(join(tmpdir(), 'easyvue-deps-'));
    const entryFile = join(tmp, 'entry.js');
    writeFileSync(entryFile, entryCode);
    const tmpOut = join(tmp, 'out.js');
    const tmpCss = join(tmp, 'out.css');   // esbuild 自动产出与 outfile 同名的兄弟 .css
    const args = ['--bundle', '--format=esm', '--target=' + target, '--platform=browser', entryFile, '--outfile=' + tmpOut];
    if (eopts.minify !== false) args.push('--minify');
    for (const ext of externals) args.push('--external:' + ext);
    args.push('--define:process.env.NODE_ENV="production"');
    try {
        execFileSync(ESBUILD, args, { maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
        throw new Error('esbuild 失败: ' + String((e as Error).message || e));
    }
    const js = readFileSync(tmpOut, 'utf8');
    let css = '';
    if (existsSync(tmpCss)) css = readFileSync(tmpCss, 'utf8');

    // 5. 原子写产物 + meta
    ensureDir(outDir);
    writeAtomic(outJs, js);
    writeAtomic(outCss, css);
    const jsHash = sha16(js);
    const cssHash = sha16(css);
    const newMeta: any = meta || {};
    newMeta[dep.name] = {
        packageVersion: pkgVersion,
        listHash: listHash,
        names: names,
        js: jsName,
        css: cssName,
        jsHash: jsHash,
        cssHash: cssHash,
        generatedAtMs: Date.now(),
        tool: 'easy-vue ' + EASY_VUE_VERSION
    };
    writeAtomic(join(outDir, 'meta.json'), JSON.stringify(newMeta, null, 2));
    return { cached: false, js: outJs, css: outCss, jsHash: jsHash, cssHash: cssHash, listHash: listHash, names: names.length, packageVersion: pkgVersion };
}

// ---------- 命令入口 ----------

// 返回 exit code：0 成功 / 1 失败。结果 JSON 打到 stdout（供调用方解析），日志走 stderr。
export function runDeps(configPath: string, force: boolean): number {
    const started = Date.now();
    let cfg: any = null;
    try {
        const abs = resolvePath(configPath, process.cwd());
        if (!existsSync(abs)) throw new Error('配置文件不存在: ' + abs);
        cfg = JSON.parse(readFileSync(abs, 'utf8'));
        cfg.configDir = abs.substring(0, abs.lastIndexOf('/')) || '/';
        if (!cfg.scan || !cfg.scan.roots || cfg.scan.roots.length === 0) throw new Error('配置缺少 scan.roots');
        if (!cfg.outputDir) throw new Error('配置缺少 outputDir');
        if (!cfg.deps || cfg.deps.length === 0) throw new Error('配置缺少 deps');
    } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: String((e as Error).message || e) }) + '\n');
        return 1;
    }

    const results: any = {};
    let failed = false;
    for (const dep of cfg.deps) {
        try {
            const r: any = shakeDep(cfg, dep, !!force);
            results[String(dep.name)] = r;
            const line: string = '[easy-vue deps] ' + String(dep.name) + ': ' + (r.cached ? '缓存命中，跳过' : '已生成') + '\n';
            process.stderr.write(line);
        } catch (e) {
            failed = true;
            const line2: string = '[easy-vue deps] 失败 - ' + String(dep.name) + ': ' + String((e as Error).message || e) + '\n';
            process.stderr.write(line2);
            break;   // 一个失败即整体失败：调用方据此整体回退，避免半新半旧
        }
    }
    const out: any = { ok: !failed, tool: 'easy-vue ' + EASY_VUE_VERSION, elapsedMs: Date.now() - started, results: results };
    if (failed) out.error = '存在失败的 dep，产物未完整生成';
    process.stdout.write(JSON.stringify(out) + '\n');
    return failed ? 1 : 0;
}
