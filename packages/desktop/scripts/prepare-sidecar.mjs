console.log("[prepare-sidecar] starting");

import { spawnSync } from "child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sidecarDir = join(__dirname, "..", "src-tauri", "sidecars");
const packageJsonPath = resolve(__dirname, "..", "package.json");

/* ----------------------- OpenCode version ----------------------- */

const opencodeVersion = (() => {
  if (process.env.OPENCODE_VERSION?.trim()) return process.env.OPENCODE_VERSION.trim();
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw);
    if (pkg.opencodeVersion) return String(pkg.opencodeVersion).trim();
  } catch {
    // ignore
  }
  return null;
})();

const opencodeAssetOverride = process.env.OPENCODE_ASSET?.trim() || null;

/* ----------------------- Target resolution ----------------------- */

const resolvedTargetTriple = (() => {
  const envTarget =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    process.env.CARGO_CFG_TARGET_TRIPLE ??
    process.env.TARGET;
  if (envTarget) return envTarget;

  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64"
      ? "aarch64-pc-windows-msvc"
      : "x86_64-pc-windows-msvc";
  }
  return null;
})();

const bunTarget = (() => {
  switch (resolvedTargetTriple) {
    case "aarch64-apple-darwin":
      return "bun-darwin-arm64";
    case "x86_64-apple-darwin":
      return "bun-darwin-x64";
    case "aarch64-unknown-linux-gnu":
      return "bun-linux-arm64";
    case "x86_64-unknown-linux-gnu":
      return "bun-linux-x64";
    case "x86_64-pc-windows-msvc":
      return "bun-windows-x64";
    default:
      return null;
  }
})();

/* ----------------------- Paths ----------------------- */

const opencodeBaseName = process.platform === "win32" ? "opencode.exe" : "opencode";
const opencodePath = join(sidecarDir, opencodeBaseName);

const opencodeTargetName = resolvedTargetTriple
  ? `opencode-${resolvedTargetTriple}${process.platform === "win32" ? ".exe" : ""}`
  : null;

const opencodeTargetPath = opencodeTargetName
  ? join(sidecarDir, opencodeTargetName)
  : null;

/* ----------------------- Helpers ----------------------- */

const readHeader = (filePath, length = 256) => {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const isStubBinary = (filePath) => {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return true;
    if (stat.size < 1024) return true;
    const header = readHeader(filePath);
    if (header.startsWith("#!")) return true;
    if (header.includes("Sidecar missing") || header.includes("Bun is required")) return true;
  } catch {
    return true;
  }
  return false;
};

const readDirectory = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const next = join(dir, entry.name);
      if (entry.isDirectory()) return readDirectory(next);
      if (entry.isFile()) return [next];
      return [];
    });
  } catch {
    return [];
  }
};

const findOpencodeBinary = (dir) => {
  const files = readDirectory(dir);
  return (
    files.find((f) => f.endsWith(`/${opencodeBaseName}`) || f.endsWith(`\\${opencodeBaseName}`)) ??
    null
  );
};

const readBinaryVersion = (filePath) => {
  try {
    const result = spawnSync(filePath, ["--version"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {
    // ignore
  }
  return null;
};

/* ----------------------- Validation ----------------------- */

const normalizedVersion = opencodeVersion?.startsWith("v")
  ? opencodeVersion.slice(1)
  : opencodeVersion;

if (!normalizedVersion) {
  console.error(
    "OpenCode version is not configured. Set OPENCODE_VERSION or add opencodeVersion to packages/desktop/package.json."
  );
  process.exit(1);
}

const opencodeAssetByTarget = {
  "aarch64-apple-darwin": "opencode-darwin-arm64.zip",
  "x86_64-apple-darwin": "opencode-darwin-x64-baseline.zip",
  "x86_64-unknown-linux-gnu": "opencode-linux-x64-baseline.tar.gz",
  "aarch64-unknown-linux-gnu": "opencode-linux-arm64.tar.gz",
  "x86_64-pc-windows-msvc": "opencode-windows-x64-baseline.zip",
  "aarch64-pc-windows-msvc": "opencode-windows-arm64.zip",
};

const opencodeAsset =
  opencodeAssetOverride ??
  (resolvedTargetTriple ? opencodeAssetByTarget[resolvedTargetTriple] : null);

const opencodeUrl = opencodeAsset
  ? `https://github.com/anomalyco/opencode/releases/download/v${normalizedVersion}/${opencodeAsset}`
  : null;

const opencodeCandidatePath = opencodeTargetPath ?? opencodePath;
const existingVersion =
  opencodeCandidatePath && existsSync(opencodeCandidatePath)
    ? readBinaryVersion(opencodeCandidatePath)
    : null;

const shouldDownloadOpencode =
  !opencodeCandidatePath ||
  !existsSync(opencodeCandidatePath) ||
  isStubBinary(opencodeCandidatePath) ||
  !existingVersion ||
  existingVersion !== normalizedVersion;

/* ======================= MAIN LOGIC ======================= */

if (!shouldDownloadOpencode) {
  console.log(`OpenCode sidecar already present (${existingVersion}).`);
} else {
  if (!opencodeAsset || !opencodeUrl) {
    console.error(
      `No OpenCode asset configured for target ${resolvedTargetTriple ?? "unknown"}.`
    );
    process.exit(1);
  }

  mkdirSync(sidecarDir, { recursive: true });

  const stamp = Date.now();
  const archivePath = join(tmpdir(), `opencode-${stamp}-${opencodeAsset}`);
  const extractDir = join(tmpdir(), `opencode-${stamp}`);

  mkdirSync(extractDir, { recursive: true });

  if (process.platform === "win32") {
    const psQuote = (v) => `'${v.replace(/'/g, "''")}'`;
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      `Invoke-WebRequest -Uri ${psQuote(opencodeUrl)} -OutFile ${psQuote(archivePath)}`,
      `Expand-Archive -Path ${psQuote(archivePath)} -DestinationPath ${psQuote(extractDir)} -Force`,
    ].join("; ");

    const result = spawnSync("powershell", ["-NoProfile", "-Command", psScript], {
      stdio: "inherit",
    });

    if (result.status !== 0) process.exit(result.status ?? 1);
  } else {
    const downloadResult = spawnSync("curl", ["-fsSL", "-o", archivePath, opencodeUrl], {
      stdio: "inherit",
    });
    if (downloadResult.status !== 0) process.exit(downloadResult.status ?? 1);

    if (opencodeAsset.endsWith(".zip")) {
      const unzipResult = spawnSync("unzip", ["-q", archivePath, "-d", extractDir], {
        stdio: "inherit",
      });
      if (unzipResult.status !== 0) process.exit(unzipResult.status ?? 1);
    } else if (opencodeAsset.endsWith(".tar.gz")) {
      const tarResult = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], {
        stdio: "inherit",
      });
      if (tarResult.status !== 0) process.exit(tarResult.status ?? 1);
    } else {
      console.error(`Unknown OpenCode archive type: ${opencodeAsset}`);
      process.exit(1);
    }
  }

  const extractedBinary = findOpencodeBinary(extractDir);
  if (!extractedBinary) {
    console.error("OpenCode binary not found after extraction.");
    process.exit(1);
  }

  const targets = [opencodeTargetPath, opencodePath].filter(Boolean);
  for (const target of targets) {
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {}
    copyFileSync(extractedBinary, target);
    try {
      chmodSync(target, 0o755);
    } catch {}
  }

  console.log(`OpenCode sidecar updated to ${normalizedVersion}.`);
}

console.log("[prepare-sidecar] finished successfully");
