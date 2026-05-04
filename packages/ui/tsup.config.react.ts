import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    "react/index": "src/react/index.ts",
  },
  tsconfig: "./tsconfig.react.json",
  format: ["esm"],
  dts: {
    tsconfig: "./tsconfig.react.json",
  },
  clean: true,
  target: "es2022",
  platform: "browser",
  sourcemap: false,
  splitting: false,
  treeshake: true,
  external: ["react", "react/jsx-runtime"],
  esbuildOptions(options) {
    options.jsx = "automatic"
    options.jsxImportSource = "react"
  },
})
