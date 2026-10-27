import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/browser.tsx", "src/model.ts", "src/office.ts", "src/office-engine.ts", "src/office-server.ts"],
  format: ["esm"],
  platform: "neutral",
  target: "es2022",
  clean: true,
  dts: false,
  // Other consumers use workbook directly from source. The Node editor must
  // carry its JavaScript instead of asking Node to load those source imports.
  noExternal: ["@openwork/workbook"],
})
