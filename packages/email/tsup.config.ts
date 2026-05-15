import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "templates/index": "src/templates/index.ts",
  },
  format: ["esm"],
  target: "es2022",
})
