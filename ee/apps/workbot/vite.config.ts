import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

/** The page (src/client), served by the Workbot server: through Vite in development, from dist/client otherwise. */
export default defineConfig({
  root: fileURLToPath(new URL("./src/client", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["development"] },
  // noVNC uses top-level await; development pre-bundling must match the build target.
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  build: {
    target: "es2022",
    outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
    emptyOutDir: true,
  },
})
