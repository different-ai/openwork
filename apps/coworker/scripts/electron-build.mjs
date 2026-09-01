import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dirnameHere = dirname(fileURLToPath(import.meta.url));
const coworkerRoot = resolve(dirnameHere, "..");
const repoRoot = resolve(coworkerRoot, "../..");
const sidecarDir = resolve(coworkerRoot, "resources", "sidecars");
const packagedServerRoot = resolve(coworkerRoot, "server");
const packagedElectronRoot = resolve(coworkerRoot, "electron-dist");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, cwd = repoRoot, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [
  resolve(repoRoot, "apps", "desktop", "scripts", "prepare-sidecar.mjs"),
  "--force",
  "--outdir",
  sidecarDir,
], coworkerRoot);
run(pnpmCommand, ["--filter", "@openwork/automations", "build"]);
run(pnpmCommand, ["--filter", "@openwork/headless-threads", "build"]);
run(pnpmCommand, ["--filter", "openwork-server", "build"]);
run(pnpmCommand, ["exec", "vite", "build"], coworkerRoot, { OPENWORK_ELECTRON_BUILD: "1" });

rmSync(packagedElectronRoot, { recursive: true, force: true });
mkdirSync(packagedElectronRoot, { recursive: true });
run(pnpmCommand, [
  "exec",
  "esbuild",
  resolve(coworkerRoot, "electron", "main.mjs"),
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  "--external:electron",
  `--outfile=${resolve(packagedElectronRoot, "main.mjs")}`,
], coworkerRoot);
copyFileSync(
  resolve(coworkerRoot, "electron", "preload.mjs"),
  resolve(packagedElectronRoot, "preload.mjs"),
);

const serverDistDir = resolve(repoRoot, "apps", "server", "dist");
const constantsSource = resolve(repoRoot, "constants.json");
copyFileSync(constantsSource, resolve(serverDistDir, "constants.json"));
const serverEntry = resolve(serverDistDir, "server.js");
const serverSource = readFileSync(serverEntry, "utf8");
const patchedServer = serverSource.replace(
  /from\s+["']\.\.\/\.\.\/\.\.\/constants\.json["']/,
  'from "./constants.json"',
);
if (patchedServer !== serverSource) writeFileSync(serverEntry, patchedServer, "utf8");

rmSync(packagedServerRoot, { recursive: true, force: true });
cpSync(serverDistDir, resolve(packagedServerRoot, "dist"), { recursive: true });
copyFileSync(resolve(repoRoot, "apps", "server", "package.json"), resolve(packagedServerRoot, "package.json"));

for (const fileName of readdirSync(resolve(coworkerRoot, "electron")).filter((name) => name.endsWith(".mjs")).sort()) {
  run(process.execPath, ["--check", resolve(coworkerRoot, "electron", fileName)]);
}
run(process.execPath, ["--check", resolve(packagedElectronRoot, "main.mjs")]);

process.stdout.write(`${JSON.stringify({
  ok: true,
  renderer: "apps/coworker/dist",
  electronMain: "apps/coworker/electron-dist/main.mjs",
  server: "apps/coworker/server/dist/embedded.js",
  sidecars: "apps/coworker/resources/sidecars",
}, null, 2)}\n`);
