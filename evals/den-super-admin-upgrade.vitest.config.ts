import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

// Isolated configuration for sequential published-version upgrade checks.
export default defineConfig({
  resolve: { alias: [{ find: /^@openwork\/testkit$/, replacement: fileURLToPath(new URL("./packages/testkit/src/index.ts", import.meta.url)) }] },
  test: { name: "den-super-admin-upgrade", environment: "node", fileParallelism: false, maxWorkers: 1, testTimeout: 600_000,
    include: ["proofs/den-super-admin-preservation.proof.test.ts"] },
})
