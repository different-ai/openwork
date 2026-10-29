import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts", "workbot-routing": "src/workbot-routing.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
})
