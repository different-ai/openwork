import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { devOpenworkProxy } from "./dev-openwork-proxy";
import { devDenProxy } from "./dev-den-proxy";

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
const appPackagePath = resolve(appRoot, "package.json");
const desktopPackagePath = resolve(appRoot, "..", "desktop", "package.json");

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }

  return null;
}

function readLocalGitSha(): string | null {
  try {
    const output = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: appRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

function readPackageVersion(packagePath: string): string | null {
  if (!existsSync(packagePath)) return null;

  const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  return parsed.version?.trim() || null;
}

const buildAppVersion =
  process.env.VITE_OPENWORK_APP_VERSION?.trim() ||
  readPackageVersion(desktopPackagePath) ||
  readPackageVersion(appPackagePath) ||
  "0.0.0";
const buildSha = firstNonEmpty([
  process.env.VITE_OPENWORK_BUILD_SHA,
  process.env.OPENWORK_GIT_SHA,
  process.env.VERCEL_GIT_COMMIT_SHA,
  process.env.GITHUB_SHA,
]) ?? readLocalGitSha();
const shortBuildSha = buildSha ? buildSha.slice(0, 7) : "";

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
    const eq = trimmed.search("=");
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

// Headless-web dev (scripts/dev-headless-web.ts): serve /api/den same-origin
// from the dev server, proxied to the Den control plane, so the browser never
// issues cross-origin Den API calls (Den does not serve CORS). The app is
// pointed here via VITE_DEN_API_BASE_URL; sign-in still opens the real Den
// web app. Inert unless the launcher sets the target env. No gateway marker:
// that runtime implies a provisioned cloud instance, which local dev lacks.
export default defineConfig(({ command, isPreview }) => {
  const denProxy = devDenProxy(command === "serve" && !isPreview ? process.env : {});
  const openworkProxy = devOpenworkProxy(command === "serve" && !isPreview ? process.env : {});
  const headlessBrowserHostSuffix = Object.keys(openworkProxy).length > 0
    ? process.env.OPENWORK_DEV_BROWSER_HOST_SUFFIX
    : undefined;
  if (headlessBrowserHostSuffix && !/^\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(headlessBrowserHostSuffix)) {
    throw new Error("Invalid development browser host suffix.");
  }
  return {
    base: isElectronPackagedBuild ? "./" : "/",
    ...(process.env.OPENWORK_VITE_CACHE_DIR ? { cacheDir: process.env.OPENWORK_VITE_CACHE_DIR } : {}),
    define: {
      ...Object.fromEntries(
        Object.entries(migrationReleaseEnv).map(([k, v]) => [
          `import.meta.env.${k}`,
          JSON.stringify(v),
        ]),
      ),
      "import.meta.env.VITE_OPENWORK_APP_VERSION": JSON.stringify(buildAppVersion),
      "import.meta.env.VITE_OPENWORK_BUILD_SHA": JSON.stringify(shortBuildSha),
    },
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
      react({
        babel: {
          plugins: [["babel-plugin-react-compiler", { compilationMode: "annotation" }]],
        },
      }),
    ],
    server: {
      port: devPort,
      strictPort: true,
      ...(allowedHosts.size > 0 || headlessBrowserHostSuffix
        ? { allowedHosts: [...allowedHosts, ...(headlessBrowserHostSuffix ? [headlessBrowserHostSuffix] : [])] }
        : {}),
      proxy: {
        ...denProxy,
        ...openworkProxy,
      },
    },
    build: {
      target: "esnext",
      rollupOptions: {
        input: {
          app: resolve(appRoot, "index.html"),
          overlay: resolve(appRoot, "overlay.html"),
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve(appRoot, "src"),
      },
    },
  };
});
