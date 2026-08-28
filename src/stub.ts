import { transformSync } from 'esbuild';
const src = 'const n: number = 1; export default n;';
const r = transformSync(src, { loader: 'ts', format: 'esm', target: 'es2020' });
console.log('ESBUILD_OK:', r.code.trim());
