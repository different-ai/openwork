import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const pnpmCmd = process.platform === "win32" ? "corepack.cmd" : "pnpm";
const pnpmArgs = process.platform === "win32" ? ["pnpm"] : [];
const port = Number.parseInt(process.env.PORT ?? "", 10);
const resolvedPort = Number.isFinite(port) && port > 0 ? port : 5173;
const tauriTarget =
  process.platform === "win32" && process.arch === "arm64" ? "x86_64-pc-windows-msvc" : null;

const loadWindowsBuildEnv = () => {
  if (process.platform !== "win32") return {};

  const vsDevCmd =
    process.env.VSDEVCMD_PATH ||
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat";

  if (!existsSync(vsDevCmd)) return {};

  const targetArch = tauriTarget === "x86_64-pc-windows-msvc" ? "x64" : process.arch;
  const hostArch = process.arch === "arm64" ? "arm64" : "x64";
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
const mergedPath =
  windowsBuildEnv.Path || windowsBuildEnv.PATH || process.env.Path || process.env.PATH || "";

const env = {
  ...process.env,
  ...windowsBuildEnv,
  OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE || "1",
  OPENWORK_DATA_DIR:
    process.env.OPENWORK_DATA_DIR ||
    `${homedir()}${process.platform === "win32" ? "\\" : "/"}.openwork${process.platform === "win32" ? "\\" : "/"}openwork-orchestrator-dev`,
  OPENWORK_USE_COREPACK_PNPM: "1",
  PORT: String(resolvedPort),
  ...(tauriTarget
    ? {
        TAURI_ENV_TARGET_TRIPLE: tauriTarget,
        CARGO_BUILD_TARGET: tauriTarget,
      }
    : {}),
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
