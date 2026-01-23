import { spawnSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const TARGET_TRIPLE = "x86_64-pc-windows-msvc";
const DOWNLOAD_URL =
  "https://github.com/anomalyco/opencode/releases/latest/download/opencode-windows-x64.zip";

if (process.platform !== "win32") {
  console.log("Skipping Windows sidecar download (non-Windows host).");
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const sidecarDir = join(__dirname, "..", "src-tauri", "sidecars");
const targetSidecarPath = join(sidecarDir, `opencode-${TARGET_TRIPLE}.exe`);
const devSidecarPath = join(sidecarDir, "opencode.exe");

if (existsSync(targetSidecarPath)) {
  console.log(`OpenCode sidecar already present: ${targetSidecarPath}`);
  process.exit(0);
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
