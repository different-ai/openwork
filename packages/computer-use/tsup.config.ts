import { defineConfig } from "tsup"

export default defineConfig({
  entry: { runtime: "src/runtime.ts", worker: "src/worker.ts" },
  loader: { ".py": "text" },
  format: ["esm"],
  platform: "node",
  target: "es2022",
  clean: true,
  dts: false,
  // Keep both interpreters and their matching Effect runtime inside the desktop artifact.
  external: ["typescript"],
  noExternal: ["@openwork/codemode", "@opencode/codemode", "effect", "acorn", "zod"],
})
