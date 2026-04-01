import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    schema: "src/schema.ts",
    "schema/auth": "src/schema/auth.ts",
    "schema/org": "src/schema/org.ts",
    "schema/sharables/skills": "src/schema/sharables/skills.ts",
    "schema/teams": "src/schema/teams.ts",
    "schema/workers": "src/schema/workers.ts",
    "schema/system": "src/schema/system.ts",
    drizzle: "src/drizzle.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  platform: "node",
  sourcemap: false,
  splitting: false,
  treeshake: true,
})
