console.log("[prepare-sidecar] starting");

import { spawnSync } from "child_process";
import { createHash } from "crypto";
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
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ----------------------- args / env ----------------------- */

const readArg = (name) => {
  const raw = process.argv.slice(2);
  const direct = raw.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.split("=")[1];
  const index = raw.indexOf(name);
  if (index >= 0 && raw[index + 1]) return raw[index + 1];
  return null;
};

const sidecarOverride =
  process.env.OPENWORK_SIDECAR_DIR?.trim() || readArg("--outdir");

const sidecarDir = sidecarOverride
  ? resolve(sidecarOverride)
  : join(__dirname, "..", "src-tauri", "sidecars");

const packageJsonPath = resolve(__dirname, "..", "package.json");

/* ----------------------- versions ----------------------- */

const opencodeVersion = (() => {
  if (process.env.OPENCODE_VERSION?.trim())
    return process.env.OPENCODE_VERSION.trim();
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (pkg.opencodeVersion) return String(pkg.opencodeVersion).trim();
  } catch {}
  return null;
})();

const owpenbotVersion = (() => {
  if (process.env.OWPENBOT_VERSION?.trim())
    return process.env.OWPENBOT_VERSION.trim();
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (pkg.owpenbotVersion) return String(pkg.owpenbotVersion).trim();
  } catch {}
  return null;
})();

const normalizedOpencodeVersion = opencodeVersion?.startsWith("v")
  ? opencodeVersion.slice(1)
  : opencodeVersion;

if (!normalizedOpencodeVersion) {
  console.error(
    "OpenCode version not configured. Set OPENCODE_VERSION or opencodeVersion in package.json."
  );
  process.exit(1);
}

/* ----------------------- target resolution ----------------------- */

const resolvedTargetTriple = (() => {
  const env =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    process.env.CARGO_CFG_TARGET_TRIPLE ??
    process.env.TARGET;
  if (env) return env;

  if (process.platform === "darwin")
    return process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin";

  if (process.platform === "linux")
    return process.arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";

  if (process.platform === "win32")
    return process.arch === "arm64"
      ? "aarch64-pc-windows-msvc"
      : "x86_64-pc-windows-msvc";

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

/* ----------------------- helpers ----------------------- */

const readHeader = (filePath, length = 256) => {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const bytes = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const isStubBinary = (filePath) => {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size < 1024) return true;
    const header = readHeader(filePath);
    if (
      header.startsWith("#!") ||
      header.includes("Sidecar missing") ||
      header.includes("Bun is required")
    )
      return true;
  } catch {
    return true;
  }
  return false;
};

const readDirectory = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const next = join(dir, e.name);
      if (e.isDirectory()) return readDirectory(next);
      if (e.isFile()) return [next];
      return [];
    });
  } catch {
    return [];
  }
};

const findBinary = (dir, name) =>
  readDirectory(dir).find(
    (f) => f.endsWith(`/${name}`) || f.endsWith(`\\${name}`)
  ) ?? null;

const readBinaryVersion = (filePath) => {
  try {
    const r = spawnSync(filePath, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch {}
  return null;
};

const sha256File = (filePath) =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex");

/* ----------------------- OpenCode ----------------------- */

const opencodeBase = process.platform === "win32" ? "opencode.exe" : "opencode";
const opencodePath = join(sidecarDir, opencodeBase);
const opencodeTargetPath = resolvedTargetTriple
  ? join(
      sidecarDir,
      `opencode-${resolvedTargetTriple}${
        process.platform === "win32" ? ".exe" : ""
      }`
    )
  : null;

const opencodeAssets = {
  "aarch64-apple-darwin": "opencode-darwin-arm64.zip",
  "x86_64-apple-darwin": "opencode-darwin-x64-baseline.zip",
  "x86_64-unknown-linux-gnu": "opencode-linux-x64-baseline.tar.gz",
  "aarch64-unknown-linux-gnu": "opencode-linux-arm64.tar.gz",
  "x86_64-pc-windows-msvc": "opencode-windows-x64-baseline.zip",
  "aarch64-pc-windows-msvc": "opencode-windows-arm64.zip",
};

const opencodeAsset = resolvedTargetTriple
  ? opencodeAssets[resolvedTargetTriple]
  : null;

const opencodeUrl = opencodeAsset
  ? `https://github.com/anomalyco/opencode/releases/download/v${normalizedOpencodeVersion}/${opencodeAsset}`
  : null;

const candidate = opencodeTargetPath ?? opencodePath;
const existingVersion =
  candidate && existsSync(candidate) ? readBinaryVersion(candidate) : null;

const shouldDownload =
  !candidate ||
  !existsSync(candidate) ||
  isStubBinary(candidate) ||
  !existingVersion ||
  existingVersion !== normalizedOpencodeVersion;

/* ----------------------- download ----------------------- */

if (!shouldDownload) {
  console.log(`OpenCode sidecar already present (${existingVersion}).`);
}

if (shouldDownload) {
  if (!opencodeUrl) {
    console.error(`No OpenCode asset for ${resolvedTargetTriple}`);
    process.exit(1);
  }

  mkdirSync(sidecarDir, { recursive: true });

  const stamp = Date.now();
  const archive = join(tmpdir(), `opencode-${stamp}`);
  const extract = join(tmpdir(), `opencode-${stamp}-dir`);
  mkdirSync(extract, { recursive: true });

  if (process.platform === "win32") {
    const q = (v) => `'${v.replace(/'/g, "''")}'`;
    const ps = [
      "$ErrorActionPreference='Stop'",
      `Invoke-WebRequest -Uri ${q(opencodeUrl)} -OutFile ${q(archive)}`,
      `Expand-Archive ${q(archive)} ${q(extract)} -Force`,
    ].join("; ");

    if (
      spawnSync("powershell", ["-NoProfile", "-Command", ps], {
        stdio: "inherit",
      }).status !== 0
    )
      process.exit(1);
  } else {
    if (
      spawnSync("curl", ["-fsSL", "-o", archive, opencodeUrl], {
        stdio: "inherit",
      }).status !== 0
    )
      process.exit(1);

    if (
      spawnSync("tar", ["-xzf", archive, "-C", extract], {
        stdio: "inherit",
      }).status !== 0
    )
      process.exit(1);
  }

  const extracted = findBinary(extract, opencodeBase);
  if (!extracted) {
    console.error("OpenCode binary not found after extraction");
    process.exit(1);
  }

  for (const target of [opencodeTargetPath, opencodePath].filter(Boolean)) {
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {}
    copyFileSync(extracted, target);
    try {
      chmodSync(target, 0o755);
    } catch {}
  }

  console.log(`OpenCode sidecar updated to ${normalizedOpencodeVersion}.`);
}

/* ----------------------- versions.json ----------------------- */

const versions = {
  opencode: {
    version: normalizedOpencodeVersion,
    sha256: existsSync(opencodePath) ? sha256File(opencodePath) : null,
  },
};

mkdirSync(sidecarDir, { recursive: true });
writeFileSync(
  join(sidecarDir, "versions.json"),
  JSON.stringify(versions, null, 2) + "\n",
  "utf8"
);

console.log("[prepare-sidecar] finished successfully");
