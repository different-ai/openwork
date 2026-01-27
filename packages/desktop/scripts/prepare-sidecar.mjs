import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const TARGET_TRIPLE = "x86_64-pc-windows-msvc";
const DOWNLOAD_URL =
  "https://github.com/anomalyco/opencode/releases/latest/download/opencode-windows-x64.zip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sidecarDir = join(__dirname, "..", "src-tauri", "sidecars");
const repoRoot = join(__dirname, "..", "..");
const serverDir = join(repoRoot, "server");
const serverCli = join(serverDir, "dist", "cli.js");
const bunTypesPath = join(serverDir, "node_modules", "bun-types", "package.json");

const resolveTargetTriple = () => {
  const envTarget =
    process.env.TAURI_ENV_TARGET_TRIPLE ||
    process.env.CARGO_CFG_TARGET_TRIPLE ||
    process.env.TARGET;
  if (envTarget) return envTarget;

  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return TARGET_TRIPLE;
  }
  return null;
};

const ensureOpenworkServerSidecar = () => {
  if (process.platform === "win32") {
    console.log("OpenWork server sidecar prep is not automated on Windows.");
    return;
  }

  if (!existsSync(bunTypesPath)) {
    const install = spawnSync("pnpm", ["-C", serverDir, "install"], { stdio: "inherit" });
    if (install.status !== 0) {
      process.exit(install.status ?? 1);
    }
  }

  const build = spawnSync("pnpm", ["-C", serverDir, "build"], { stdio: "inherit" });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  mkdirSync(sidecarDir, { recursive: true });
  const nodePath = process.execPath.replace(/"/g, "\\\"");
  const cliPath = serverCli.replace(/"/g, "\\\"");
  const launcher = `#!/usr/bin/env bash\n"${nodePath}" "${cliPath}" "$@"\n`;
  const target = resolveTargetTriple();
  const devSidecarPath = join(sidecarDir, "openwork-server");
  const targetSidecarPath = target ? join(sidecarDir, `openwork-server-${target}`) : null;

  writeFileSync(devSidecarPath, launcher, "utf8");
  chmodSync(devSidecarPath, 0o755);

  if (targetSidecarPath) {
    writeFileSync(targetSidecarPath, launcher, "utf8");
    chmodSync(targetSidecarPath, 0o755);
  }
};

const ensureOpencodeWindowsSidecar = () => {
  if (process.platform !== "win32") {
    console.log("Skipping Windows sidecar download (non-Windows host).\n");
    return;
  }

  const targetSidecarPath = join(sidecarDir, `opencode-${TARGET_TRIPLE}.exe`);
  const devSidecarPath = join(sidecarDir, "opencode.exe");

  if (existsSync(targetSidecarPath)) {
    console.log(`OpenCode sidecar already present: ${targetSidecarPath}`);
    return;
  }

  mkdirSync(sidecarDir, { recursive: true });

  const stamp = Date.now();
  const zipPath = join(tmpdir(), `opencode-windows-x64-${stamp}.zip`);
  const extractDir = join(tmpdir(), `opencode-windows-x64-${stamp}`);
  const extractedExe = join(extractDir, "opencode.exe");

  const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    `Invoke-WebRequest -Uri ${psQuote(DOWNLOAD_URL)} -OutFile ${psQuote(zipPath)}`,
    `Expand-Archive -Path ${psQuote(zipPath)} -DestinationPath ${psQuote(extractDir)} -Force`,
    `if (!(Test-Path ${psQuote(extractedExe)})) { throw 'opencode.exe missing in archive' }`,
    `Copy-Item -Path ${psQuote(extractedExe)} -Destination ${psQuote(targetSidecarPath)} -Force`,
    `Copy-Item -Path ${psQuote(extractedExe)} -Destination ${psQuote(devSidecarPath)} -Force`,
  ].join("; ");

  const result = spawnSync("powershell", ["-NoProfile", "-Command", psScript], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

ensureOpenworkServerSidecar();
ensureOpencodeWindowsSidecar();
