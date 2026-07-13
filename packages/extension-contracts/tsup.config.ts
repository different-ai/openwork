import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    schemas: "src/schemas.ts",
    selectors: "src/selectors.ts",
    validation: "src/validation.ts",
  },
  external: ["zod"],
  format: ["esm"],
  platform: "neutral",
  splitting: false,
  target: "es2022",
  treeshake: true,
})
