import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "es2022",
  platform: "neutral",
  sourcemap: false,
  splitting: false,
  treeshake: true,
})
