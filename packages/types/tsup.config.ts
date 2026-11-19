import { readFileSync } from "node:fs"
import { defineConfig } from "tsup"

// Every export gets JavaScript, read from package.json so the two cannot drift.
// The packaged desktop loads this package from node_modules, where Node refuses
// to run TypeScript, so its copy serves every export from these files
// (apps/desktop/scripts/prepare-runtime-node-modules.mjs).
const manifest: { exports: Record<string, { development: string }> } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
)
const entry: Record<string, string> = {}
for (const target of Object.values(manifest.exports)) {
  const source = target.development.replace(/^\.\//, "")
  entry[source.replace(/^src\//, "").replace(/\.ts$/, "")] = source
}

export default defineConfig({
  entry,
  tsconfig: "./tsconfig.json",
  format: ["esm"],
  dts: false,
  clean: true,
  target: "es2022",
  platform: "neutral",
  sourcemap: false,
  splitting: false,
  treeshake: true,
  external: ["zod"],
  // Workspace packages are served from TypeScript too, so they are compiled in.
  noExternal: [/^@openwork\//],
  // An export that imports another through the package's own name must bundle
  // its source, not the dist this build is about to replace.
  esbuildOptions(options) {
    options.conditions = ["development"]
  },
})
