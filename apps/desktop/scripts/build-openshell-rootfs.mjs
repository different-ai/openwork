// Cross-platform builder for the Ubuntu 24.04 + Docker + OpenShell rootfs
// tarball that the OpenWork installer (installer.mjs phaseDistro) imports
// via `wsl --import` on a banker's Windows machine.
//
// Originally a bash script (build-openshell-rootfs.sh, still in tree for
// CI). On Windows that script fails because npm resolves `bash` to the
// WSL bash relay (C:\Windows\System32\bash.exe), which then tries to
// exec /bin/bash inside a default WSL distro that may not exist yet —
// chicken-and-egg if you're trying to build the rootfs for the FIRST
// WSL distro.
//
// This Node version uses only Docker (Desktop on Windows/Mac, engine on
// Linux) and Node's built-in zlib for gzip. No shell, no bash.
//
// Output: apps/desktop/resources/openshell/ubuntu-24.04-openshell.tar.gz

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const outDir = resolve(desktopRoot, "resources", "openshell");
const outFile = resolve(outDir, "ubuntu-24.04-openshell.tar.gz");
const dockerfile = resolve(scriptDir, "openshell-rootfs.Dockerfile");
const tag = `openwork/openshell-rootfs:build-${Date.now()}`;

const isWindows = process.platform === "win32";
const shellOpt = { shell: isWindows };

function fail(msg, code = 1) {
  console.error(`[rootfs] ${msg}`);
  process.exit(code);
}

function dockerSync(args, opts = {}) {
  return spawnSync("docker", args, {
    stdio: opts.stdio ?? "inherit",
    encoding: "utf8",
    ...shellOpt,
    ...opts,
  });
}

// Two-stage check: first the CLI exists, then the daemon is reachable.
// `docker --version` only validates the CLI binary; `docker info` is
// what actually pings the engine — on Windows that's Docker Desktop's
// named pipe (//./pipe/dockerDesktopLinuxEngine), which won't exist
// until Docker Desktop's whale icon goes steady.
const cliCheck = dockerSync(["--version"], { stdio: "ignore" });
if (cliCheck.status !== 0) {
  fail(
    "docker CLI not found on PATH. Install Docker Desktop " +
      "(Windows/Mac) or Docker Engine (Linux) and retry.",
  );
}
const daemonCheck = dockerSync(["info", "--format", "{{.ServerVersion}}"], {
  stdio: "pipe",
});
if (daemonCheck.status !== 0) {
  const stderr = (daemonCheck.stderr || "").trim();
  fail(
    "docker daemon is not reachable. " +
      (isWindows
        ? "Open Docker Desktop and wait for the whale icon to be steady, " +
          "then retry."
        : "Start the Docker daemon (`sudo systemctl start docker`) and retry.") +
      (stderr ? `\n  underlying error: ${stderr}` : ""),
  );
}
console.log(`[rootfs] docker daemon ok (server ${daemonCheck.stdout.trim()}).`);

mkdirSync(outDir, { recursive: true });

console.log(`[rootfs] building image ${tag}...`);
// --no-cache + --pull mirrors the bash script: the rootfs is meant to
// bundle a current snapshot at release time, so cached layers risk
// shipping stale upstream packages to bankers.
const build = dockerSync([
  "build",
  "--no-cache",
  "--pull",
  "-f",
  dockerfile,
  "-t",
  tag,
  scriptDir,
]);
if (build.status !== 0) fail("docker build failed.", build.status ?? 1);

console.log("[rootfs] creating throwaway container for export...");
const create = dockerSync(["create", tag, "/bin/true"], { stdio: "pipe" });
if (create.status !== 0) {
  console.error(create.stderr);
  fail("docker create failed.", create.status ?? 1);
}
const containerId = create.stdout.trim();
if (!containerId) fail("docker create returned no container id.");

let cleanedUp = false;
const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;
  dockerSync(["rm", "-f", containerId], { stdio: "ignore" });
  dockerSync(["image", "rm", "-f", tag], { stdio: "ignore" });
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

console.log("[rootfs] exporting rootfs → gzip → tarball...");
// docker export → stdin of our gzip stream → outFile. We can't use a
// shell pipe here (no bash on Windows) but Node's stream pipeline does
// the same job portably.
const exportProc = spawn("docker", ["export", containerId], {
  stdio: ["ignore", "pipe", "inherit"],
  ...shellOpt,
});
const gzip = createGzip({ level: 9 });
const out = createWriteStream(outFile);

exportProc.stdout.pipe(gzip).pipe(out);

await new Promise((resolveP, reject) => {
  out.on("finish", () => resolveP());
  out.on("error", reject);
  exportProc.on("error", reject);
  exportProc.on("close", (code) => {
    if (code !== 0) reject(new Error(`docker export exited ${code}`));
  });
});

const { size } = statSync(outFile);
const mb = (size / 1024 / 1024).toFixed(1);
console.log(`[rootfs] wrote ${outFile} (${mb} MB)`);
