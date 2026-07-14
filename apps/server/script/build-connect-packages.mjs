import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const manifestPath = resolve(repoRoot, "packages/connect-core/connect-runtime.manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const packages = Array.isArray(manifest.packages) ? manifest.packages : [];
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

for (const entry of packages) {
  const name = typeof entry?.name === "string" ? entry.name.trim() : "";
  if (!name) throw new Error(`Invalid Connect package entry in ${manifestPath}`);
  const result = spawnSync(pnpm, ["--filter", name, "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
