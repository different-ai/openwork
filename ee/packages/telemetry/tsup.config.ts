import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  // The contracts package exports TypeScript source (so den-web can transpile
  // it without a build step). Node consumers of this package load dist, so the
  // contracts source must be bundled in rather than left as a runtime import.
  noExternal: ["@openwork-ee/telemetry-contracts"],
})
