import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    accounting: "src/accounting.ts",
    node: "src/node.ts",
  },
  format: ["esm"],
  target: "es2022",
  // Electron main and the desktop relay load dist/*.js at runtime; keep workspace packages external.
  external: ["@openwork/types"],
})
