import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const portValue = Number.parseInt(process.env.PORT ?? "", 10);
const devPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 5183;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: {
      "@": resolve(appRoot, "src"),
    },
  },
  server: {
    port: devPort,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
