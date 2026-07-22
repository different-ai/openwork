import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
  },
  format: ["esm"],
  target: "es2022",
})
