// Windows-specific wrapper around electron-dev.mjs. Does three things the
// generic dev-loop can't:
//   1. Sources VS Build Tools env (for any future native rebuild — node-pty
//      is already prebuilt by electron-rebuild in postinstall).
//   2. Adds LLVM to PATH so clang-based rebuilds find a compiler.
//   3. Reaps stale sidecar processes from the Electron resources/sidecars
//      directory before a new dev run (an unclean Electron quit on Windows
//      can leave orphan openwork-orchestrator.exe holding ports).
//
// Targets x64 by default; pass `x64` arg explicitly for parity with the
// previous Tauri-era cross-build flow. ARM64-on-ARM64 hosts also work.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const electronSidecarDir = resolve(desktopRoot, "resources", "sidecars");
const electronDevScript = resolve(scriptDir, "electron-dev.mjs");

const requestedTarget = process.argv[2] === "x64" ? "x64" : null;
const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const targetArch = requestedTarget ?? hostArch;
const llvmBin = process.env.LLVM_BIN || "C:\\Program Files\\LLVM\\bin";

const stopStaleSidecars = () => {
  if (process.platform !== "win32") return;
  const targetDir = electronSidecarDir.replace(/\\/g, "\\\\");
  const command = [
    `$targetDir = \"${targetDir}\"`,
    "$names = @('opencode.exe','openwork-server.exe','openwork-orchestrator.exe','chrome-devtools-mcp.exe')",
    "Get-CimInstance Win32_Process | Where-Object {",
    "  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($targetDir, [System.StringComparison]::OrdinalIgnoreCase) -and $names.Contains([System.IO.Path]::GetFileName($_.ExecutablePath))",
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    stdio: "ignore",
  });
};

const loadWindowsBuildEnv = () => {
  if (process.platform !== "win32") return {};
  const vsDevCmd =
    process.env.VSDEVCMD_PATH ||
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat";
  if (!existsSync(vsDevCmd)) return {};

  const command = `\"${vsDevCmd}\" -arch=${targetArch} -host_arch=${hostArch} >nul && set`;
  const result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) return {};

  return Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
};

const windowsBuildEnv = loadWindowsBuildEnv();
stopStaleSidecars();

const mergedPath = [
  existsSync(llvmBin) ? llvmBin : null,
  windowsBuildEnv.Path || windowsBuildEnv.PATH || process.env.Path || process.env.PATH || null,
]
  .filter(Boolean)
  .join(";");

const env = {
  ...process.env,
  ...windowsBuildEnv,
  OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE || "1",
  OPENWORK_DATA_DIR:
    process.env.OPENWORK_DATA_DIR ||
    `${homedir()}\\.openwork\\openwork-orchestrator-dev`,
  OPENWORK_USE_COREPACK_PNPM: "1",
  CC: process.env.CC || "clang",
  CXX: process.env.CXX || "clang++",
  CLANG_PATH: process.env.CLANG_PATH || (existsSync(llvmBin) ? `${llvmBin}\\clang.exe` : "clang"),
};

if (mergedPath) {
  env.PATH = mergedPath;
  env.Path = mergedPath;
}

const result = spawnSync(process.execPath, [electronDevScript], {
  stdio: "inherit",
  cwd: desktopRoot,
  env,
});

process.exit(result.status ?? 1);
