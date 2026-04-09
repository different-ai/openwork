import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pnpmCmd = process.platform === "win32" ? "corepack.cmd" : "pnpm";
const pnpmArgs = process.platform === "win32" ? ["pnpm"] : [];
const scriptDir = dirname(fileURLToPath(import.meta.url));
const tauriDebugDir = resolve(scriptDir, "../src-tauri/target/debug");
const port = Number.parseInt(process.env.PORT ?? "", 10);
const resolvedPort = Number.isFinite(port) && port > 0 ? port : 5173;
const requestedTarget = process.argv[2] === "x64" ? "x64" : null;
const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const targetArch = requestedTarget ?? hostArch;
const tauriTarget = targetArch === "x64" && hostArch === "arm64" ? "x86_64-pc-windows-msvc" : null;
const llvmBin = process.env.LLVM_BIN || "C:\\Program Files\\LLVM\\bin";

const stopStaleSidecars = () => {
  if (process.platform !== "win32") return;

  const targetDir = tauriDebugDir.replace(/\\/g, "\\\\");
  const command = [
    `$targetDir = \"${targetDir}\"`,
    "$names = @('opencode.exe','opencode-router.exe','openwork-server.exe','openwork-orchestrator.exe','chrome-devtools-mcp.exe')",
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

  if (result.status !== 0 || !result.stdout) {
    return {};
  }

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
    `${homedir()}${process.platform === "win32" ? "\\" : "/"}.openwork${process.platform === "win32" ? "\\" : "/"}openwork-orchestrator-dev`,
  OPENWORK_USE_COREPACK_PNPM: "1",
  PORT: String(resolvedPort),
  CC: process.env.CC || "clang",
  CXX: process.env.CXX || "clang++",
  CLANG_PATH: process.env.CLANG_PATH || (existsSync(llvmBin) ? `${llvmBin}\\clang.exe` : "clang"),
  ...(tauriTarget
    ? {
        CC_x86_64_pc_windows_msvc: process.env.CC_x86_64_pc_windows_msvc || "clang",
        TAURI_ENV_TARGET_TRIPLE: tauriTarget,
        CARGO_BUILD_TARGET: tauriTarget,
      }
    : {
        CC_aarch64_pc_windows_msvc: process.env.CC_aarch64_pc_windows_msvc || "clang",
      }),
};

if (mergedPath) {
  env.PATH = mergedPath;
  env.Path = mergedPath;
}

const result = spawnSync(
  pnpmCmd,
  [
    ...pnpmArgs,
    "exec",
    "tauri",
    "dev",
    ...(tauriTarget ? ["--target", tauriTarget] : []),
    "--config",
    "src-tauri/tauri.dev.conf.json",
  ],
  {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  },
);

process.exit(result.status ?? 1);
