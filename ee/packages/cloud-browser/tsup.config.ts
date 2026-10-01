import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "hosts/daytona": "src/hosts/daytona.ts",
    "hosts/local": "src/hosts/local.ts",
    testing: "src/testing.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  platform: "node",
  sourcemap: false,
  // Entries share one copy of the error class and CDP client.
  splitting: true,
  treeshake: true,
  external: ["@openwork-ee/cloud-runtime", "ws"],
})
