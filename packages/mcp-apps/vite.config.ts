import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

const app = process.env.OPENWORK_MCP_APP ?? "connection-action"
if (!["connection-action", "legacy-confirmation"].includes(app)) throw new Error("Unknown MCP App entry")

export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    cssCodeSplit: false,
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: { input: `${app}.html` },
  },
})
