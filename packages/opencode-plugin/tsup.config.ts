import { defineConfig } from "tsup"

// OpenCode loads `<package>/server`. The plugin has no runtime dependencies:
// OpenCode provides the plugin host, so the bundle is self-contained.
export default defineConfig({
  clean: true,
  dts: true,
  entry: { server: "src/server.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
})
