import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    index: "src/index.ts",
    testing: "src/testing.ts",
    proactive: "src/proactive.ts",
    "proactive-brief": "src/proactive-brief.ts",
  },
  external: ["@openwork/types", "zod", "@openwork/automations/proactive"],
  format: ["esm"],
  target: "es2022",
})
