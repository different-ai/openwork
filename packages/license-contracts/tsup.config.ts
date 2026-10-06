import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    modules: "src/modules.ts",
    resolver: "src/resolver.ts",
    errors: "src/errors.ts",
    license: "src/license.ts",
    hints: "src/hints.ts",
    payload: "src/payload.ts",
    "org-modules": "src/org-modules.ts",
  },
  format: ["esm"],
  target: "es2022",
})
