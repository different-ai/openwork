import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "es2022",
})
