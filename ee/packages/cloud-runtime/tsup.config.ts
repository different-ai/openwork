import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "contract/index": "src/contract/index.ts",
    "bootstrap/index": "src/bootstrap/index.ts",
    "orchestrator/index": "src/orchestrator/index.ts",
    "testing/index": "src/testing/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  platform: "node",
  sourcemap: false,
  splitting: false,
  treeshake: true,
})
