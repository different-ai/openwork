import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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

// Load the Tauri → Electron migration-release fragment if present. Written
// by scripts/migration/01-cut-migration-release.mjs for the specific
// release commit; absent otherwise so every other build has the migration
// prompt dormant. Pre-parsed here so Vite's define/import.meta.env picks
// up the keys without a custom plugin.
function loadMigrationReleaseEnv(): Record<string, string> {
  const fragmentPath = resolve(appRoot, ".env.migration-release");
  if (!existsSync(fragmentPath)) return {};
  const out: Record<string, string> = {};
  const raw = readFileSync(fragmentPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key.startsWith("VITE_")) continue;
    out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}
const migrationReleaseEnv = loadMigrationReleaseEnv();

// Electron packaged builds load index.html via `file://`, so asset URLs
// must be relative. Tauri serves via its own protocol so absolute paths
// work there. Gate on an env var the electron build script sets.
const isElectronPackagedBuild = process.env.OPENWORK_ELECTRON_BUILD === "1";

export default defineConfig({
  base: isElectronPackagedBuild ? "./" : "/",
  define: Object.fromEntries(
    Object.entries(migrationReleaseEnv).map(([k, v]) => [
      `import.meta.env.${k}`,
      JSON.stringify(v),
    ]),
  ),
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
    react(),
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
