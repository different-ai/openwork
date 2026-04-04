import os from "node:os";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import devtools from "solid-devtools/vite";
import solid from "vite-plugin-solid";

const portValue = Number.parseInt(process.env.PORT ?? "", 10);
const devPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 5173;
const allowedHosts = new Set<string>();
const envAllowedHosts = process.env.VITE_ALLOWED_HOSTS ?? "";
const isReactVariant = (process.env.OPENWORK_APP_VARIANT ?? "").trim() === "react";

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

export default defineConfig({
  cacheDir: isReactVariant ? "node_modules/.vite-react" : "node_modules/.vite-solid",
  plugins: [
    tailwindcss(),
    ...(isReactVariant
      ? [react()]
      : [
          devtools({
            autoname: true,
            locator: {
              targetIDE: "vscode",
              jsxLocation: true,
              componentLocation: true,
            },
          }),
          solid(),
        ]),
  ],
  server: {
    port: devPort,
    strictPort: true,
    ...(allowedHosts.size > 0 ? { allowedHosts: Array.from(allowedHosts) } : {}),
  },
  esbuild: isReactVariant
    ? {
        jsx: "automatic",
        jsxImportSource: "react",
      }
    : undefined,
  build: {
    target: "esnext",
  },
});
