import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  noExternal: ["@openwork-ee/telemetry-contracts"],
})
