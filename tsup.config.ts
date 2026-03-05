import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/local.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  // 外部依赖不打包（从 node_modules 加载）
  external: [
    '@larksuiteoapi/node-sdk',
    '@modelcontextprotocol/sdk',
    'feishu-tools',
    'dotenv',
    'zod',
    'zod-to-json-schema',
  ],
  // shebang 已在 src/local.ts 中，tsup 会自动保留
});
