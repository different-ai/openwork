import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "neutral",
  splitting: false,
  target: "es2022",
  treeshake: true,
})
