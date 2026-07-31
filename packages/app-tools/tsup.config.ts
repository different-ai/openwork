import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  tsconfig: "./tsconfig.json",
  format: ["esm"],
  dts: { tsconfig: "./tsconfig.json" },
  clean: true,
  target: "es2022",
  platform: "node",
  sourcemap: false,
  splitting: false,
  treeshake: true,
  external: ["@openwork/app-contract", "zod"],
})
