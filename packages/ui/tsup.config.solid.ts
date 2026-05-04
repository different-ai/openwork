import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    "solid/index": "src/solid/index.ts",
  },
  tsconfig: "./tsconfig.solid.json",
  format: ["esm"],
  dts: {
    tsconfig: "./tsconfig.solid.json",
  },
  clean: false,
  target: "es2022",
  platform: "browser",
  sourcemap: false,
  splitting: false,
  treeshake: true,
  external: ["solid-js", "solid-js/jsx-runtime"],
  esbuildOptions(options) {
    options.jsx = "automatic"
    options.jsxImportSource = "solid-js/h"
  },
})
