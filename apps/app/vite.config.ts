import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import devtools from "solid-devtools/vite";
import solid from "vite-plugin-solid";

const portValue = Number.parseInt(process.env.PORT ?? "", 10);
const devPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 5173;
const allowedHosts = new Set<string>();
const envAllowedHosts = process.env.VITE_ALLOWED_HOSTS ?? "";

const addHost = (value?: string | null) => {
  const trimmed = value?.trim();
  if (!trimmed) return;
  allowedHosts.add(trimmed);
};

envAllowedHosts.split(",").forEach(addHost);
addHost(process.env.OPENWORK_PUBLIC_HOST ?? null);
const hostname = os.hostname();
addHost(hostname);
const shortHostname = hostname.split(".")[0];
if (shortHostname && shortHostname !== hostname) {
  addHost(shortHostname);
}
const appRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const reactFiles = /\.react\.[tj]sx?$/;

export default defineConfig({
  plugins: [
    {
      name: "openwork-dev-server-id",
      configureServer(server) {
        server.middlewares.use("/__openwork_dev_server_id", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ appRoot }));
        });
      },
    },
    tailwindcss(),
    react({ include: reactFiles }),
    devtools({
      autoname: true,
      // jsxLocation is required for in-page locator: map DOM → Solid components (hold Option/Alt while hovering).
      locator: {
        targetIDE: "vscode",
        jsxLocation: true,
        componentLocation: true,
      },
    }),
    solid({ exclude: [reactFiles] }),
  ],
  server: {
    port: devPort,
    strictPort: true,
    ...(allowedHosts.size > 0 ? { allowedHosts: Array.from(allowedHosts) } : {}),
  },
  build: {
    target: "esnext",
  },
});
