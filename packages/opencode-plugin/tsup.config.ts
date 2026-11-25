import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: { server: "src/server.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
})
