import { spawnSync } from "child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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

const resolveBun = () => {
  if (process.env.BUN_PATH) return process.env.BUN_PATH;
  const result = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (result.status === 0) return "bun";
  const which = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" });
  const bunPath = which.stdout?.trim();
  return bunPath ? bunPath : null;
};

const resolveBunTarget = (target) => {
  if (!target) return null;
  if (target === "x86_64-pc-windows-msvc") return "bun-windows-x64";
  return null;
};

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
  const target = resolveTargetTriple();
  const isWindows = process.platform === "win32";
  const devSidecarPath = join(sidecarDir, isWindows ? "openwork-server.exe" : "openwork-server");
  const targetSidecarPath = target
    ? join(sidecarDir, `openwork-server-${target}${isWindows ? ".exe" : ""}`)
    : null;

  if (targetSidecarPath && existsSync(targetSidecarPath) && existsSync(devSidecarPath)) {
    console.log(`OpenWork server sidecar already present: ${targetSidecarPath}`);
    return;
  }

  if (isWindows) {
    const bunPath = resolveBun();
    if (!bunPath) {
      console.error("Bun is required to compile the OpenWork server sidecar on Windows.");
      console.error("Install Bun or set BUN_PATH, then re-run the build.");
      process.exit(1);
    }

    if (!existsSync(bunTypesPath)) {
      const install = spawnSync("pnpm", ["-C", serverDir, "install"], { stdio: "inherit" });
      if (install.status !== 0) {
        process.exit(install.status ?? 1);
      }
    }

    const bunTarget = resolveBunTarget(target) ?? "bun-windows-x64";
    const entrypoint = join(serverDir, "src", "cli.ts");
    const outputPath = targetSidecarPath ?? devSidecarPath;

    mkdirSync(sidecarDir, { recursive: true });

    const build = spawnSync(
      bunPath,
      ["build", entrypoint, "--compile", `--target=${bunTarget}`, "--outfile", outputPath],
      { stdio: "inherit", cwd: serverDir }
    );
    if (build.status !== 0) {
      process.exit(build.status ?? 1);
    }

    if (!existsSync(outputPath)) {
      console.error(`OpenWork server sidecar was not created at ${outputPath}`);
      process.exit(1);
    }

    if (outputPath !== devSidecarPath) {
      copyFileSync(outputPath, devSidecarPath);
    }

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
  const bunPath = resolveBun();
  const cliPath = serverCli.replace(/"/g, "\\\"");
  const launcher = bunPath
    ? `#!/usr/bin/env bash\n"${bunPath.replace(/"/g, "\\\"")}" "${cliPath}" "$@"\n`
    : "#!/usr/bin/env bash\n" +
      "echo 'Bun is required to run the OpenWork server. Install bun.sh and re-run pnpm dev.'\n" +
      "exit 1\n";

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
