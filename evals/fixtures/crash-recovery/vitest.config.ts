import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// A browser-only source world does not require Den or an Electron build.
export default defineConfig({
  resolve: { alias: { '@openwork/paths': fileURLToPath(new URL('../../../packages/paths/index.mjs', import.meta.url)) } },
  test: { name: 'e2e', environment: 'node', testTimeout: 60000, hookTimeout: 120000, maxWorkers: 1, fileParallelism: false, include: ['specs/crash-recovery.e2e.test.ts'] },
});
