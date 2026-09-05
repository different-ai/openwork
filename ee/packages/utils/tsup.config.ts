import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "den-urls": "src/den-urls.ts",
    "inference-bearer-key": "src/inference-bearer-key.ts",
    observability: "src/observability.ts",
    typeid: "src/typeid.ts",
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
