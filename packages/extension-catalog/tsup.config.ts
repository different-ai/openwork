import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "den-marketplace": "src/den-marketplace.ts",
  },
  format: ["esm"],
  sourcemap: true,
  splitting: false,
  target: "es2022",
  treeshake: true,
})
