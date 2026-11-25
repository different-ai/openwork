import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import manifest from "./opencode-v1-artifacts.json" with { type: "json" };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function opencodeV1Pin(version, asset, repo, env = process.env) {
  if (!asset || !/^[A-Za-z0-9_-]+\.(zip|tar\.gz)$/.test(asset)) throw new Error("Invalid OpenCode v1 archive name");
  if (repo !== "anomalyco/opencode" && (env.OPENCODE_ARCHIVE_SHA256 || env.OPENCODE_BINARY_SHA256)) {
    const { OPENCODE_ARCHIVE_SHA256: archive, OPENCODE_BINARY_SHA256: binary } = env;
    if (![archive, binary].every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))) {
      throw new Error("Custom OpenCode releases require both OPENCODE_ARCHIVE_SHA256 and OPENCODE_BINARY_SHA256");
    }
    return { sha256: archive, binarySha256: binary };
  }
  if (manifest.version !== version || !Object.hasOwn(manifest.assets, asset)) {
    throw new Error(`Missing OpenCode v1 integrity pin for ${version}/${asset}`);
  }
  return manifest.assets[asset];
}

// Windows bsdtar reads ZIP files; GNU tar from Git Bash on PATH does not.
function windowsTar(env = process.env) {
  const systemRoot = env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
  const bsdtar = join(systemRoot, "System32", "tar.exe");
  return existsSync(bsdtar) ? bsdtar : "tar.exe";
}

function matches(path, expected) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isFile() && sha256(readFileSync(path)) === expected;
}

function download(url, output) {
  execFileSync(process.platform === "win32" ? "curl.exe" : "curl", [
    "--fail", "--location", "--silent", "--show-error", "--retry", "2",
    "--connect-timeout", "20", "--max-time", "300", "--output", output, url,
  ], { stdio: "inherit" });
}

export function prepareOpencodeV1({ sidecarDir, asset, url, pin, targets, sign, cacheDir, fetchArchive = download }) {
  mkdirSync(sidecarDir, { recursive: true });
  if (!sign && targets.every((name) => matches(join(sidecarDir, name), pin.binarySha256))) {
    for (const name of targets) chmodSync(join(sidecarDir, name), 0o755);
    return;
  }

  const staging = mkdtempSync(join(sidecarDir, ".opencode1-"));
  try {
    const binaryName = targets.at(-1);
    const binary = join(staging, binaryName);
    // A macOS signature changes the installed bytes. Keep one verified upstream
    // archive per architecture, outside the resources shipped in the app.
    const cacheRoot = cacheDir ?? join(homedir(), ".cache", "openwork", "opencode");
    const cachedArchive = join(cacheRoot, asset);
    const archive = join(staging, asset);
    let cacheHit = false;
    if (sign && lstatSync(cachedArchive, { throwIfNoEntry: false })?.isFile()) {
      const cached = readFileSync(cachedArchive);
      if (sha256(cached) === pin.sha256) {
        writeFileSync(archive, cached);
        cacheHit = true;
      }
    }
    if (!cacheHit) {
      fetchArchive(url, archive);
      if (!matches(archive, pin.sha256)) throw new Error(`OpenCode v1 archive integrity mismatch: ${asset}`);
    }

    // All official CLI releases contain a single root-level binary. Windows
    // ships bsdtar, which also accepts ZIP files, and requires relative paths.
    if (asset.endsWith(".zip") && process.platform !== "win32") {
      execFileSync("unzip", ["-q", asset, binaryName], { cwd: staging });
    } else {
      execFileSync(process.platform === "win32" ? windowsTar() : "tar", ["-xf", asset, binaryName], { cwd: staging });
    }
    if (!matches(binary, pin.binarySha256)) throw new Error(`OpenCode v1 binary integrity mismatch: ${asset}`);
    if (sign && !cacheHit) {
      mkdirSync(cacheRoot, { recursive: true });
      const pending = mkdtempSync(join(cacheRoot, ".archive-"));
      try {
        copyFileSync(archive, join(pending, asset));
        renameSync(join(pending, asset), cachedArchive);
      } finally {
        rmSync(pending, { recursive: true, force: true });
      }
    }
    chmodSync(binary, 0o755);
    if (sign) sign(binary);
    const installedHash = sign ? sha256(readFileSync(binary)) : pin.binarySha256;
    for (const name of targets) {
      const dest = join(sidecarDir, name);
      if (matches(dest, installedHash)) {
        chmodSync(dest, 0o755);
        continue;
      }
      const pending = join(staging, "install");
      copyFileSync(binary, pending);
      renameSync(pending, dest);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
