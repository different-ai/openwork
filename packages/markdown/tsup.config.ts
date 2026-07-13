import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    browser: "src/browser.ts",
    "text-highlights": "src/text-highlights.ts",
  },
  format: ["esm"],
  noExternal: ["emojilib"],
  platform: "browser",
  splitting: true,
  target: "es2022",
  treeshake: true,
})
