import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    cssCodeSplit: false,
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: { input: "connection-action.html" },
  },
})
