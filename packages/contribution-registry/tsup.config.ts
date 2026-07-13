import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  platform: "browser",
  target: "es2022",
})
