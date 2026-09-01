import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const siteRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
// The site renders the desktop app's own brand mark and avatar components.
// `@/` resolves exactly as it does inside apps/coworker so those files import unchanged.
const coworkerSrc = resolve(siteRoot, "../coworker/src");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  resolve: {
    alias: {
      "@": coworkerSrc,
      "~": resolve(siteRoot, "src"),
    },
  },
  server: {
    fs: { allow: [resolve(siteRoot, ".."), resolve(siteRoot, "../../node_modules")] },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
