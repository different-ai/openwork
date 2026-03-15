import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TARGET_ASSETS = {
  "aarch64-apple-darwin": "opencode-darwin-arm64.zip",
  "x86_64-apple-darwin": "opencode-darwin-x64-baseline.zip",
  "x86_64-unknown-linux-gnu": "opencode-linux-x64-baseline.tar.gz",
  "aarch64-unknown-linux-gnu": "opencode-linux-arm64.tar.gz",
  "x86_64-pc-windows-msvc": "opencode-windows-x64-baseline.zip",
};

function appendGithubEnv(name, value) {
  if (!process.env.GITHUB_ENV) return;
  const line = `${name}=${value}\n`;
  return writeFile(process.env.GITHUB_ENV, line, { flag: "a" });
}

function fail(message) {
  throw new Error(message);
}

async function resolveLatest(repo, token) {
  const apiHeaders = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openwork-ci",
  };

  if (token) {
    apiHeaders.Authorization = `Bearer ${token}`;
  }

  try {
    const apiResponse = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: apiHeaders,
    });

    if (apiResponse.ok) {
      const payload = await apiResponse.json();
      const tag = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
      const version = tag.startsWith("v") ? tag.slice(1).trim() : tag;
      if (version) return version;
    }
  } catch {
    // Fall through to the redirect-based resolution below.
  }

  const webResponse = await fetch(`https://github.com/${repo}/releases/latest`, {
    headers: { "User-Agent": "openwork-ci" },
    redirect: "follow",
  });
  const match = String(webResponse.url || "").match(/\/tag\/v([^/?#]+)/);
  if (!match) {
    fail(`Failed to resolve latest OpenCode version for ${repo}.`);
  }
  return match[1];
}

async function resolveVersion(repoRoot) {
  const pkgPath = path.join(repoRoot, "packages/desktop/package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const configuredRaw = String(process.env.OPENCODE_VERSION || pkg.opencodeVersion || "").trim();

  if (configuredRaw && configuredRaw.toLowerCase() !== "latest") {
    return configuredRaw.startsWith("v") ? configuredRaw.slice(1).trim() : configuredRaw;
  }

  const repo = (process.env.OPENCODE_GITHUB_REPO || "anomalyco/opencode").trim() || "anomalyco/opencode";
  const token = (process.env.GITHUB_TOKEN || "").trim();
  return resolveLatest(repo, token);
}

async function downloadFile(url, destination, token) {
  const headers = { "User-Agent": "openwork-ci" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok) {
    fail(`Failed to download ${url} (HTTP ${response.status}).`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, buffer);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function hasCommand(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { stdio: "ignore" });
  return result.status === 0;
}

function findBinary(dir) {
  const candidates = [path.join(dir, "opencode"), path.join(dir, "opencode.exe")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function main() {
  const repoRoot = process.cwd();
  const target = (process.env.TARGET || "").trim();
  const osType = (process.env.OS_TYPE || "").trim();
  const repo = (process.env.OPENCODE_GITHUB_REPO || "anomalyco/opencode").trim() || "anomalyco/opencode";
  const token = (process.env.GITHUB_TOKEN || "").trim();
  const asset = TARGET_ASSETS[target];

  if (!asset) {
    fail(`Unsupported target: ${target}`);
  }

  const version = await resolveVersion(repoRoot);
  await appendGithubEnv("OPENCODE_VERSION", version);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openwork-opencode-"));
  const extractDir = path.join(tmpDir, "extracted");
  const archivePath = path.join(tmpDir, asset);
  const url = `https://github.com/${repo}/releases/download/v${version}/${asset}`;

  try {
    await mkdir(extractDir, { recursive: true });
    console.log(`Resolving OpenCode ${version} for ${target}`);
    await downloadFile(url, archivePath, token);

    if (asset.endsWith(".tar.gz")) {
      run("tar", ["-xzf", archivePath, "-C", extractDir]);
    } else if (hasCommand("unzip")) {
      run("unzip", ["-q", archivePath, "-d", extractDir]);
    } else if (hasCommand("7z")) {
      run("7z", ["x", archivePath, `-o${extractDir}`]);
    } else {
      fail("No archive extractor available (expected unzip or 7z).");
    }

    const binaryPath = findBinary(extractDir);
    if (!binaryPath) {
      fail(`OpenCode binary not found after extracting ${asset}.`);
    }

    const targetName = osType === "windows" ? `opencode-${target}.exe` : `opencode-${target}`;
    const sidecarsDir = path.join(repoRoot, "packages/desktop/src-tauri/sidecars");
    const destination = path.join(sidecarsDir, targetName);

    await mkdir(sidecarsDir, { recursive: true });
    await copyFile(binaryPath, destination);
    if (osType !== "windows") {
      await chmod(destination, 0o755);
    }

    console.log(`Installed OpenCode sidecar at ${destination}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
