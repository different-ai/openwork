import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    "scripts/bootstrap": "scripts/bootstrap.ts",
  },
  format: ["esm"],
  dts: false,
  clean: false,
  target: "es2022",
  platform: "node",
  sourcemap: false,
  splitting: false,
  treeshake: true,
})
