import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const distDir = path.join(desktopDir, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(path.join(distDir, "main"), { recursive: true });

await build({
  entryPoints: {
    "main/main": path.join(desktopDir, "src", "main", "main.ts"),
    "main/preload": path.join(desktopDir, "src", "main", "preload.ts"),
  },
  outdir: distDir,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: ["electron"],
  packages: "external",
  outExtension: {
    ".js": ".cjs",
  },
  logLevel: "info",
});
