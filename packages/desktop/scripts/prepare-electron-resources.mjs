import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const outDir = resolve(desktopDir, "resources", "sidecars");

mkdirSync(outDir, { recursive: true });

const result = spawnSync(process.execPath, [resolve(__dirname, "prepare-sidecar.mjs"), "--outdir", outDir], {
  cwd: desktopDir,
  stdio: "inherit",
  env: process.env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
