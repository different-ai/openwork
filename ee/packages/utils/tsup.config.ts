import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "den-urls": "src/den-urls.ts",
    "inference-bearer-key": "src/inference-bearer-key.ts",
    "gateway-bearer-key": "src/gateway-bearer-key.ts",
    "gateway-routing": "src/gateway-routing.ts",
    "gateway-rollups": "src/gateway-rollups.ts",
    "inference-egress": "src/inference-egress.ts",
    "inference-credentials": "src/inference-credentials.ts",
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
