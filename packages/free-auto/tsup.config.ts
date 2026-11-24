import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    index: "src/index.ts",
    accounting: "src/accounting.ts",
    node: "src/node.ts",
  },
  format: ["esm"],
  target: "es2022",
  external: ["@openwork/types"],
})
