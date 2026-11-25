import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "es2022",
})
