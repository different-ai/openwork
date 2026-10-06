import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts", testing: "src/testing.ts" },
  format: ["esm"],
  target: "es2022",
  dts: false,
  clean: true,
  sourcemap: true,
})
