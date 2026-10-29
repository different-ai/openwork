import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    index: "src/index.ts",
    testing: "src/testing.ts",
    proactive: "src/proactive.ts",
  },
  external: ["@openwork/types", "zod"],
  format: ["esm"],
  target: "es2022",
})
