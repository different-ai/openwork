import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts" },
  tsconfig: "./tsconfig.json",
  format: ["esm"],
  dts: { tsconfig: "./tsconfig.json" },
  clean: true,
  target: "es2022",
  platform: "neutral",
  sourcemap: false,
  splitting: false,
  treeshake: true,
  external: ["zod"],
})
