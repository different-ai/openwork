import { readFileSync } from "node:fs"
import { defineConfig } from "tsup"

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
  noExternal: [/^@openwork\//],
  esbuildOptions(options) {
    options.conditions = ["development"]
  },
})
