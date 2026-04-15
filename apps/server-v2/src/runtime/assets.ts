import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ServerWorkingDirectory } from "../database/working-directory.js";
import {
  resolveBunTarget,
  resolveRuntimeTarget,
  runtimeBinaryFilename,
  type ResolvedRuntimeBinary,
  type ResolvedRuntimeBundle,
  type RuntimeAssetName,
  type RuntimeAssetSource,
  type RuntimeManifest,
  type RuntimeTarget,
} from "./manifest.js";

type RuntimeAssetServiceOptions = {
  environment: string;
  serverVersion: string;
  workingDirectory: ServerWorkingDirectory;
};

function isTruthy(value: string | undefined) {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalizeVersion(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

function dirnameFromMetaUrl(metaUrl: string) {
  return path.dirname(fileURLToPath(metaUrl));
}

function findRepoRoot(startDir: string) {
  let current = startDir;
  while (true) {
    const constantsPath = path.join(current, "constants.json");
    const serverV2PackagePath = path.join(current, "apps", "server-v2", "package.json");
    if (fs.existsSync(constantsPath) && fs.existsSync(serverV2PackagePath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function sha256File(filePath: string) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function ensureExecutable(filePath: string) {
  if (process.platform === "win32") {
    return;
  }

  await chmod(filePath, 0o755);
}

async function fileExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function captureProcess(command: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {}) {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const timeoutMs = options.timeoutMs ?? 120_000;

  const timeout = setTimeout(() => {
    child.kill();
  }, timeoutMs);

  try {
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (exitCode !== 0) {
      const message = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      throw new Error(message || `Command failed with exit code ${exitCode}: ${command.join(" ")}`);
    }
    return { stderr, stdout };
  } finally {
    clearTimeout(timeout);
  }
}

function parseVersion(output: string) {
  const match = output.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/);
  return match?.[0] ?? null;
}

async function readBinaryVersion(binaryPath: string) {
  try {
    const result = await captureProcess([binaryPath, "--version"], { cwd: os.tmpdir(), timeoutMs: 4_000 });
    return parseVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    return null;
  }
}

function resolveOpencodeAsset(target: RuntimeTarget) {
  const assets: Record<RuntimeTarget, string> = {
    "darwin-arm64": "opencode-darwin-arm64.zip",
    "darwin-x64": "opencode-darwin-x64-baseline.zip",
    "linux-arm64": "opencode-linux-arm64.tar.gz",
    "linux-x64": "opencode-linux-x64-baseline.tar.gz",
    "windows-arm64": "opencode-windows-arm64.zip",
    "windows-x64": "opencode-windows-x64-baseline.zip",
  };
  return assets[target];
}

async function downloadToPath(url: string, destinationPath: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url} (HTTP ${response.status}).`);
  }

  const contents = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.tmp-${Date.now()}`;
  await writeFile(temporaryPath, contents);
  await rename(temporaryPath, destinationPath);
}

async function extractOpencodeArchive(archivePath: string, extractDir: string) {
  if (process.platform === "win32") {
    const quotedArchive = `'${archivePath.replace(/'/g, "''")}'`;
    const quotedExtract = `'${extractDir.replace(/'/g, "''")}'`;
    await captureProcess([
      "powershell",
      "-NoProfile",
      "-Command",
      `$ErrorActionPreference = 'Stop'; Expand-Archive -Path ${quotedArchive} -DestinationPath ${quotedExtract} -Force`,
    ]);
    return;
  }

  if (archivePath.endsWith(".zip")) {
    await captureProcess(["unzip", "-q", archivePath, "-d", extractDir]);
    return;
  }

  if (archivePath.endsWith(".tar.gz")) {
    await captureProcess(["tar", "-xzf", archivePath, "-C", extractDir]);
    return;
  }

  throw new Error(`Unsupported OpenCode archive format: ${archivePath}`);
}

async function findFileRecursively(rootDir: string, matcher: (fileName: string) => boolean): Promise<string | null> {
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }

      if (matcher(entry.name)) {
        return absolutePath;
      }
    }
  }

  return null;
}

async function writeIfChanged(filePath: string, contents: string) {
  const existing = await readFile(filePath, "utf8").catch(() => null);
  if (existing === contents) {
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

export type RuntimeAssetService = ReturnType<typeof createRuntimeAssetService>;

export function createRuntimeAssetService(options: RuntimeAssetServiceOptions) {
  const runtimeTarget = resolveRuntimeTarget();
  if (!runtimeTarget) {
    throw new Error(`Unsupported runtime target ${process.platform}/${process.arch} for Server V2 runtime assets.`);
  }

  const serverVersion = options.serverVersion;
  const repoRoot = findRepoRoot(path.resolve(dirnameFromMetaUrl(import.meta.url), "..", "..", "..", ".."));
  const runtimeSourcePreference = process.env.OPENWORK_SERVER_V2_RUNTIME_SOURCE?.trim().toLowerCase();
  const releaseRootOverride = process.env.OPENWORK_SERVER_V2_RUNTIME_RELEASE_DIR?.trim();
  const manifestPathOverride = process.env.OPENWORK_SERVER_V2_RUNTIME_MANIFEST_PATH?.trim();

  const developmentRoot = repoRoot ? path.join(repoRoot, ".local", "runtime-assets") : null;
  const releaseRoot = releaseRootOverride?.trim()
    ? path.resolve(releaseRootOverride)
    : path.join(options.workingDirectory.runtimeDir, serverVersion);

  const resolveSource = (): RuntimeAssetSource => {
    if (runtimeSourcePreference === "development") {
      if (!developmentRoot) {
        throw new Error("Development runtime assets requested, but the repo root could not be resolved.");
      }
      return "development";
    }

    if (runtimeSourcePreference === "release") {
      return "release";
    }

    if (developmentRoot) {
      return "development";
    }

    return "release";
  };

  const resolveRootDir = (source: RuntimeAssetSource) => (source === "development" ? developmentRoot! : releaseRoot);

  const readPinnedOpencodeVersion = async () => {
    const candidates = [
      repoRoot ? path.join(repoRoot, "constants.json") : null,
      path.resolve(dirnameFromMetaUrl(import.meta.url), "..", "..", "..", "..", "constants.json"),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) {
        continue;
      }

      const parsed = await readJson<{ opencodeVersion?: string }>(candidate);
      const value = parsed.opencodeVersion?.trim() ?? "";
      if (value) {
        return normalizeVersion(value);
      }
    }

    throw new Error("Unable to resolve the pinned OpenCode version from constants.json.");
  };

  const readRouterVersion = async () => {
    const candidates = [
      repoRoot ? path.join(repoRoot, "apps", "opencode-router", "package.json") : null,
      path.resolve(dirnameFromMetaUrl(import.meta.url), "..", "..", "..", "opencode-router", "package.json"),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) {
        continue;
      }

      const parsed = await readJson<{ version?: string }>(candidate);
      const value = parsed.version?.trim() ?? "";
      if (value) {
        return normalizeVersion(value);
      }
    }

    throw new Error("Unable to resolve the local opencode-router version.");
  };

  const materializeManifest = async (source: RuntimeAssetSource, opencode: ResolvedRuntimeBinary, router: ResolvedRuntimeBinary) => {
    const rootDir = resolveRootDir(source);
    const manifest: RuntimeManifest = {
      files: {
        opencode: {
          path: path.relative(rootDir, opencode.absolutePath),
          sha256: opencode.sha256,
          size: opencode.size,
        },
        "opencode-router": {
          path: path.relative(rootDir, router.absolutePath),
          sha256: router.sha256,
          size: router.size,
        },
      },
      generatedAt: new Date().toISOString(),
      manifestVersion: 1,
      opencodeVersion: opencode.version,
      rootDir,
      routerVersion: router.version,
      serverVersion,
      source,
      target: runtimeTarget,
    };

    const manifestPath =
      source === "release"
        ? manifestPathOverride?.trim()
          ? path.resolve(manifestPathOverride)
          : path.join(rootDir, "manifest.json")
        : path.join(rootDir, "manifests", runtimeTarget, `openwork-server-v2-${serverVersion}.json`);
    await writeIfChanged(`${manifestPath}`, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  };

  const buildResolvedBinary = async (
    source: RuntimeAssetSource,
    name: RuntimeAssetName,
    absolutePath: string,
    version: string,
  ): Promise<ResolvedRuntimeBinary> => {
    const details = await stat(absolutePath);
    return {
      absolutePath,
      name,
      sha256: await sha256File(absolutePath),
      size: details.size,
      source,
      stagedRoot: resolveRootDir(source),
      target: runtimeTarget,
      version,
    };
  };

  const ensureDevelopmentOpencodeBinary = async (version: string) => {
    const rootDir = resolveRootDir("development");
    const targetDir = path.join(rootDir, "opencode", runtimeTarget, `v${version}`);
    const targetPath = path.join(targetDir, runtimeBinaryFilename("opencode", runtimeTarget));
    if (await fileExists(targetPath)) {
      const actualVersion = await readBinaryVersion(targetPath);
      if (!actualVersion || actualVersion === version) {
        await ensureExecutable(targetPath);
        return targetPath;
      }
      await rm(targetPath, { force: true });
    }

    const asset = resolveOpencodeAsset(runtimeTarget);
    const archivePath = path.join(os.tmpdir(), `openwork-server-v2-opencode-${Date.now()}-${asset}`);
    const extractDir = await mkdtemp(path.join(os.tmpdir(), "openwork-server-v2-opencode-"));
    const downloadUrl = `https://github.com/anomalyco/opencode/releases/download/v${version}/${asset}`;

    try {
      await downloadToPath(downloadUrl, archivePath);
      await extractOpencodeArchive(archivePath, extractDir);
      const extractedBinary = await findFileRecursively(extractDir, (fileName) => fileName === "opencode" || fileName === "opencode.exe");
      if (!extractedBinary) {
        throw new Error(`Downloaded OpenCode archive did not contain an opencode binary for ${runtimeTarget}.`);
      }

      await mkdir(targetDir, { recursive: true });
      await copyFile(extractedBinary, targetPath);
      await ensureExecutable(targetPath);
      return targetPath;
    } catch (error) {
      throw new Error(
        `Failed to download the pinned OpenCode ${version} artifact for ${runtimeTarget}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await rm(extractDir, { force: true, recursive: true });
      await rm(archivePath, { force: true });
    }
  };

  const ensureDevelopmentRouterBinary = async (version: string) => {
    if (!repoRoot) {
      throw new Error("Cannot build opencode-router in development mode because the repo root could not be resolved.");
    }

    const rootDir = resolveRootDir("development");
    const targetDir = path.join(rootDir, "opencode-router", runtimeTarget, `v${version}`);
    const targetPath = path.join(targetDir, runtimeBinaryFilename("opencode-router", runtimeTarget));
    if (await fileExists(targetPath)) {
      const actualVersion = await readBinaryVersion(targetPath);
      if (!actualVersion || actualVersion === version) {
        await ensureExecutable(targetPath);
        return targetPath;
      }
      await rm(targetPath, { force: true });
    }

    await mkdir(targetDir, { recursive: true });
    const packageDir = path.join(repoRoot, "apps", "opencode-router");
    const entrypoint = path.join(packageDir, "src", "cli.ts");
    const outfile = targetPath;
    const bunCommand = [
      process.execPath,
      "build",
      entrypoint,
      "--compile",
      "--outfile",
      outfile,
      "--target",
      resolveBunTarget(runtimeTarget),
      "--define",
      `__OPENCODE_ROUTER_VERSION__=\"${version}\"`,
    ];

    try {
      await captureProcess(bunCommand, { cwd: packageDir, timeoutMs: 300_000 });
      await ensureExecutable(outfile);
      return outfile;
    } catch (error) {
      throw new Error(
        `Failed to build the local opencode-router ${version} binary for ${runtimeTarget}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const ensureReleaseBinary = async (name: RuntimeAssetName, version: string) => {
    const rootDir = resolveRootDir("release");
    const manifestPath = manifestPathOverride?.trim() ? path.resolve(manifestPathOverride) : path.join(rootDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Release runtime manifest not found at ${manifestPath}.`);
    }

    const manifest = await readJson<RuntimeManifest>(manifestPath);
    const entry = manifest.files[name];
    if (!entry) {
      throw new Error(`Release runtime manifest is missing the ${name} entry.`);
    }

    const binaryPath = path.resolve(rootDir, entry.path);
    if (!(await fileExists(binaryPath))) {
      throw new Error(`Release runtime binary for ${name} was expected at ${binaryPath}, but it was not found.`);
    }

    await ensureExecutable(binaryPath);
    const checksum = await sha256File(binaryPath);
    if (checksum !== entry.sha256) {
      throw new Error(`Release runtime binary checksum mismatch for ${name} at ${binaryPath}.`);
    }

    const actualVersion = await readBinaryVersion(binaryPath);
    if (actualVersion && actualVersion !== version) {
      throw new Error(`Release runtime ${name} version mismatch: expected ${version}, got ${actualVersion}.`);
    }

    return binaryPath;
  };

  const readReleaseManifestVersion = async (name: RuntimeAssetName) => {
    const rootDir = resolveRootDir("release");
    const manifestPath = manifestPathOverride?.trim() ? path.resolve(manifestPathOverride) : path.join(rootDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Release runtime manifest not found at ${manifestPath}.`);
    }

    const manifest = await readJson<RuntimeManifest>(manifestPath);
    return name === "opencode" ? manifest.opencodeVersion : manifest.routerVersion;
  };

  const ensureBinary = async (name: RuntimeAssetName) => {
    const source = resolveSource();
    const version = source === "release"
      ? await readReleaseManifestVersion(name)
      : name === "opencode"
        ? await readPinnedOpencodeVersion()
        : await readRouterVersion();

    const absolutePath = source === "development"
      ? name === "opencode"
        ? await ensureDevelopmentOpencodeBinary(version)
        : await ensureDevelopmentRouterBinary(version)
      : await ensureReleaseBinary(name, version);
    return buildResolvedBinary(source, name, absolutePath, version);
  };

  return {
    async ensureOpencodeBinary() {
      return ensureBinary("opencode");
    },

    async ensureRouterBinary() {
      return ensureBinary("opencode-router");
    },

    async getPinnedOpencodeVersion() {
      return readPinnedOpencodeVersion();
    },

    async getRouterVersion() {
      return readRouterVersion();
    },

    getSource() {
      return resolveSource();
    },

    getTarget() {
      return runtimeTarget;
    },

    getDevelopmentRoot() {
      return developmentRoot;
    },

    getReleaseRoot() {
      return releaseRoot;
    },

    async resolveRuntimeBundle(): Promise<ResolvedRuntimeBundle> {
      const [opencode, router] = await Promise.all([this.ensureOpencodeBinary(), this.ensureRouterBinary()]);
      const manifest = await materializeManifest(opencode.source, opencode, router);
      return {
        manifest,
        opencode,
        router,
      };
    },
  };
}
