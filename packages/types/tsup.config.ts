import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "den/desktop-app-restrictions": "src/den/desktop-app-restrictions.ts",
    "den/desktop-policies": "src/den/desktop-policies.ts",
    "den/egress-diagnostics": "src/den/egress-diagnostics.ts",
    "den/inference": "src/den/inference.ts",
    "den/microsoft-365": "src/den/microsoft-365.ts",
  },
  tsconfig: "./tsconfig.json",
  format: ["esm"],
  dts: {
    tsconfig: "./tsconfig.json",
  },
  clean: true,
  target: "es2022",
  platform: "neutral",
  sourcemap: false,
  splitting: false,
  treeshake: true,
  external: ["zod"],
})
