// esbuild 可执行文件定位（serve 与 deps 共用）。
// 优先级：
//   1. 环境变量 ESBUILD_BINARY_PATH（develop.md 记载的配置方式）
//   2. 二进制自身同目录下的 esbuild（zip 随 easy-vue 一起分发的场景，esbuild 与该
//      二进制放在同一目录即可，免任何环境变量）
//   3. PATH 里的裸命令 esbuild（兜底）
// process.argv[1] 在 scriptc 原生产物里是「二进制自身路径」（绝对或相对 cwd），
// 由此可推导同目录布局。
import { existsSync } from 'node:fs';

export function resolveEsbuild(): string {
  const env = process.env.ESBUILD_BINARY_PATH;
  if (env) return env;
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
