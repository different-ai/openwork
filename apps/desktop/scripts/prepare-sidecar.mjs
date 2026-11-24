import { opencodeV1Pin, prepareOpencodeV1 } from "./prepare-opencode-v1.mjs";
import { prepareOpencodeV2 } from "./prepare-opencode-v2.mjs";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readArg = (name) => {
  const raw = process.argv.slice(2);
  const direct = raw.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.split("=")[1];
  const index = raw.indexOf(name);
  if (index >= 0 && raw[index + 1]) return raw[index + 1];
  return null;
};

const sidecarOverride = process.env.OPENWORK_SIDECAR_DIR?.trim() || readArg("--outdir");
const sidecarDir = sidecarOverride ? resolve(sidecarOverride) : join(__dirname, "..", "resources", "sidecars");
const constantsPath = resolve(__dirname, "..", "..", "..", "constants.json");

const opencodeGithubRepo = (() => {
  const raw =
    process.env.OPENCODE_GITHUB_REPO?.trim() ||
    process.env.OPENWORK_OPENCODE_GITHUB_REPO?.trim() ||
    "anomalyco/opencode";
  const normalized = raw
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    return "anomalyco/opencode";
  }
  return normalized;
})();
const opencodeVersion = (() => {
  try {
    const raw = readFileSync(constantsPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.opencodeVersion === "string" ? parsed.opencodeVersion.trim() || null : null;
  } catch {
    return null;
  }
})();

const normalizeVersion = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "latest") return null;
  return raw.startsWith("v") ? raw.slice(1) : raw;
};

const opencodeAssetOverride = process.env.OPENCODE_ASSET?.trim() || null;

// Target triple for native platform binaries
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
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return null;
})();
const isWindowsTarget = process.platform === "win32" || resolvedTargetTriple?.includes("windows") === true;

const opencodeBaseName = isWindowsTarget ? "opencode.exe" : "opencode";
const opencodePath = join(sidecarDir, opencodeBaseName);
const opencodeTargetName = resolvedTargetTriple
  ? `opencode-${resolvedTargetTriple}${isWindowsTarget ? ".exe" : ""}`
  : null;
const opencodeTargetPath = opencodeTargetName ? join(sidecarDir, opencodeTargetName) : null;

const opencodeCandidatePath = opencodeTargetPath ?? opencodePath;

// openwork-server paths
const openworkServerDir = resolve(__dirname, "..", "..", "server");

const sha256File = (filePath) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
};

const adHocSignDarwin = (filePath) => {
  if (process.platform !== "darwin" || !filePath || !existsSync(filePath)) return;
  const remove = spawnSync("codesign", ["--remove-signature", filePath], {
    encoding: "utf8",
  });
  if (remove.error && remove.error.code === "ENOENT") {
    throw new Error("codesign is required to prepare runnable macOS sidecars");
  }

  const sign = spawnSync("codesign", ["--force", "--sign", "-", filePath], {
    encoding: "utf8",
  });
  if (sign.error) {
    if (sign.error.code === "ENOENT") {
      throw new Error("codesign is required to prepare runnable macOS sidecars");
    }
    throw sign.error;
  }
  if (sign.status !== 0) {
    const stderr = sign.stderr?.trim();
    throw new Error(`Failed to codesign ${filePath}${stderr ? `: ${stderr}` : ""}`);
  }
};

const normalizedOpencodeVersion = normalizeVersion(opencodeVersion);

if (!normalizedOpencodeVersion) {
  console.error(
    `OpenCode version could not be resolved from ${constantsPath}.`
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
  opencodeAssetOverride ?? (resolvedTargetTriple ? opencodeAssetByTarget[resolvedTargetTriple] : null);

const v1Pin = opencodeV1Pin(`v${normalizedOpencodeVersion}`, opencodeAsset, opencodeGithubRepo);
prepareOpencodeV1({
  sidecarDir,
  asset: opencodeAsset,
  url: `https://github.com/${opencodeGithubRepo}/releases/download/v${normalizedOpencodeVersion}/${opencodeAsset}`,
  pin: v1Pin,
  targets: [opencodeTargetName, opencodeBaseName].filter(Boolean),
  sign: process.platform === "darwin" && resolvedTargetTriple?.includes("apple-darwin") ? adHocSignDarwin : null,
});

const opencodeV2Path = await prepareOpencodeV2(sidecarDir, resolvedTargetTriple);
const opencodeV2TargetPath = join(sidecarDir, `opencode2-${resolvedTargetTriple}${isWindowsTarget ? ".exe" : ""}`);
copyFileSync(opencodeV2Path, opencodeV2TargetPath);

const openworkServerVersion = (() => {
  try {
    const raw = readFileSync(resolve(openworkServerDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const versions = {
  opencode2: {
    version: JSON.parse(readFileSync(constantsPath, "utf8")).opencodeV2Version,
    sha256: sha256File(opencodeV2Path),
  },
  opencode: {
    version: normalizedOpencodeVersion,
    sha256: opencodeCandidatePath && existsSync(opencodeCandidatePath) ? sha256File(opencodeCandidatePath) : null,
  },
  "openwork-server": {
    version: openworkServerVersion,
    sha256: "in-process",
  },
};

const missing = Object.entries(versions)
  .filter(([, info]) => !info.version || !info.sha256)
  .map(([name]) => name);

if (missing.length) {
  console.error(`Sidecar version metadata incomplete for: ${missing.join(", ")}`);
  process.exit(1);
}

const versionsPath = join(sidecarDir, "versions.json");
try {
  mkdirSync(sidecarDir, { recursive: true });
  const content = JSON.stringify(versions, null, 2) + "\n";
  writeFileSync(versionsPath, content, "utf8");
  if (resolvedTargetTriple) {
    const targetVersionsPath = join(sidecarDir, `versions.json-${resolvedTargetTriple}`);
    writeFileSync(targetVersionsPath, content, "utf8");
  }
} catch (error) {
  console.error(`Failed to write versions.json: ${error}`);
  process.exit(1);
}
