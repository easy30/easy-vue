// 演示：.ts 模块也由 easy-vue 现场转译（esbuild 去类型）→ 浏览器可直接 import
export interface User {
  id: number;
  name: string;
  role: string;
}

export function formatUser(u: User): string {
  return `${u.name}（${u.role}）`;
}

export const APP_VERSION: string = 'v1.2.1';
