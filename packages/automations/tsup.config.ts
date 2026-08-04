import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    testing: "src/testing.ts",
  },
  external: ["@openwork/types", "zod"],
  format: ["esm"],
  target: "es2022",
})
