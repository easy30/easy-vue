// 通过 child_process 调用 esbuild 二进制做 TS→JS 转换（绕开 worker_threads）
import { execFileSync } from 'node:child_process';
const bin = process.env.ESBUILD_BINARY_PATH || 'esbuild';
const src = 'const n: number = 1;\nexport default n;\n';
const out = execFileSync(bin, ['--loader=ts', '--format=esm', '--target=es2020'], { input: src });
console.log('CLI_OK:', out.toString().split('\n')[0].trim());
