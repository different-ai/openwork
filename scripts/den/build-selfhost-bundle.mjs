#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const templateRoot = path.join(scriptDir, "selfhost");
const nodeVersion = "22.22.0";
const nodeArchives = new Map([
  ["darwin-arm64", {
    fileName: "node-v22.22.0-darwin-arm64.tar.gz",
    sha256: "5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640",
  }],
  ["darwin-x64", {
    fileName: "node-v22.22.0-darwin-x64.tar.gz",
    sha256: "5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce",
  }],
  ["linux-arm64", {
    fileName: "node-v22.22.0-linux-arm64.tar.gz",
    sha256: "25ba95dfb96871fa2ef977f11f95ea90818c8fa15c0f2110771db08d4ba423be",
  }],
  ["linux-x64", {
    fileName: "node-v22.22.0-linux-x64.tar.gz",
    sha256: "c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744",
  }],
]);
const supportedPlatforms = new Set(["darwin", "linux"]);
const supportedArchitectures = new Set(["arm64", "x64"]);

function usage() {
  return [
    "Usage: node scripts/den/build-selfhost-bundle.mjs [options]",
    "  --platform <darwin|linux>   Target platform (default: host)",
    "  --arch <arm64|x64>          Target architecture (default: host)",
    "  --version <version>         Bundle version (default: Den API app version)",
    "  --out <directory>           Output directory (default: dist-selfhost)",
    "  --node-source <download|host>  Bundled Node source (default: download)",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    platform: process.platform,
    arch: process.arch,
    version: "",
    out: "dist-selfhost",
    nodeSource: "download",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      console.log(usage());
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}\n${usage()}`);
    index += 1;
    if (flag === "--platform") options.platform = value;
    else if (flag === "--arch") options.arch = value;
    else if (flag === "--version") options.version = value;
    else if (flag === "--out") options.out = value;
    else if (flag === "--node-source") options.nodeSource = value;
    else throw new Error(`Unknown option: ${flag}\n${usage()}`);
  }
  return options;
}

async function defaultVersion() {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "apps", "desktop", "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("apps/desktop/package.json does not contain a version");
  }
  return packageJson.version.trim();
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function stageNode(destination, options, workDir) {
  if (options.nodeSource === "host") {
    if (options.platform !== process.platform || options.arch !== process.arch) {
      throw new Error("--node-source host can only build for the host platform and architecture");
    }
    const hostNode = await realpath(process.execPath);
    await copyFile(hostNode, destination);
    await chmod(destination, 0o755);
    if (process.platform === "darwin") {
      const hostLibDir = path.resolve(path.dirname(hostNode), "..", "lib");
      const nodeLibraries = (await readdir(hostLibDir).catch(() => [])).filter((name) => /^libnode\..+\.dylib$/.test(name));
      if (nodeLibraries.length > 0) {
        const bundleLibDir = path.resolve(path.dirname(destination), "..", "lib");
        await mkdir(bundleLibDir, { recursive: true });
        await Promise.all(nodeLibraries.map((name) => copyFile(path.join(hostLibDir, name), path.join(bundleLibDir, name))));
      }
    }
    return;
  }

  const archiveMetadata = nodeArchives.get(`${options.platform}-${options.arch}`);
  if (!archiveMetadata) {
    throw new Error(`No pinned Node ${nodeVersion} SHA256 for ${options.platform}-${options.arch}`);
  }
  const distribution = archiveMetadata.fileName.replace(/\.tar\.gz$/, "");
  const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveMetadata.fileName}`;
  console.log(`[den-selfhost] Downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status} ${url}`);
  const contents = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(contents).digest("hex");
  if (actualSha256 !== archiveMetadata.sha256) {
    throw new Error(
      `Node runtime checksum mismatch for ${archiveMetadata.fileName}: expected ${archiveMetadata.sha256}, got ${actualSha256}`,
    );
  }
  console.log(`[den-selfhost] Verified Node runtime SHA256 ${actualSha256} (${archiveMetadata.fileName})`);
  const archive = path.join(workDir, archiveMetadata.fileName);
  const extracted = path.join(workDir, "node-runtime");
  await writeFile(archive, contents);
  await mkdir(extracted);
  await run("tar", ["-xzf", archive, "-C", extracted, distribution + "/bin/node"]);
  await copyFile(path.join(extracted, distribution, "bin", "node"), destination);
  await chmod(destination, 0o755);
}

async function copyDeployedServices(deployRoot, bundleRoot) {
  const apiSource = path.join(deployRoot, "den-api");
  const apiTarget = path.join(bundleRoot, "services", "den-api");
  await mkdir(apiTarget, { recursive: true });
  await cp(path.join(apiSource, "dist"), path.join(apiTarget, "dist"), { recursive: true });
  await cp(path.join(apiSource, "node_modules"), path.join(apiTarget, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await copyFile(path.join(apiSource, "package.json"), path.join(apiTarget, "package.json"));

  const webSource = path.join(deployRoot, "den-web");
  const webTarget = path.join(bundleRoot, "services", "den-web");
  await mkdir(webTarget, { recursive: true });
  await cp(path.join(webSource, ".next"), path.join(webTarget, ".next"), { recursive: true });
  await rm(path.join(webTarget, ".next", "cache"), { recursive: true, force: true });
  await cp(path.join(webSource, "node_modules"), path.join(webTarget, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await copyFile(path.join(webSource, "package.json"), path.join(webTarget, "package.json"));
  await copyFile(path.join(webSource, "next.config.js"), path.join(webTarget, "next.config.js"));
  await cp(path.join(webSource, "observability"), path.join(webTarget, "observability"), { recursive: true });
  await cp(path.join(webSource, "public"), path.join(webTarget, "public"), { recursive: true });
}

async function pointWorkspacePackagesAtDist(nodeModulesDir) {
  const virtualStore = path.join(nodeModulesDir, ".pnpm");
  const entries = await readdir(virtualStore);
  const workspaceEntries = entries.filter((name) => name.startsWith("@openwork+") || name.startsWith("@openwork-ee+"));
  let typesPackages = 0;
  for (const entry of workspaceEntries) {
    const match = entry.match(/^(@openwork(?:-ee)?)\+([^@]+)@/);
    if (!match) continue;
    const packageDir = path.join(virtualStore, entry, "node_modules", match[1], match[2]);
    const packagePath = path.join(packageDir, "package.json");
    const source = await readFile(packagePath, "utf8").catch(() => "");
    if (!source) continue;
    const packageJson = JSON.parse(source);
    for (const target of Object.values(packageJson.exports ?? {})) {
      if (typeof target !== "object" || target === null || typeof target.default !== "string") continue;
      const distTarget = target.default.replace(/^\.\/src\/(.+)\.ts$/, "./dist/$1.js");
      if (distTarget !== target.default) {
        const distExists = await access(path.join(packageDir, distTarget.slice(2))).then(() => true).catch(() => false);
        if (distExists) target.default = distTarget;
      }
      if (target.default.includes("/dist/") && typeof target.development === "string") {
        target.development = target.default;
      }
    }
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    if (packageJson.name === "@openwork/types") {
      typesPackages += 1;
      await access(path.join(packageDir, "dist", "den", "inference.js"));
    }
  }
  if (typesPackages === 0) throw new Error("pnpm deploy did not include @openwork/types");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.version = options.version || await defaultVersion();
  if (!supportedPlatforms.has(options.platform)) throw new Error(`Unsupported platform: ${options.platform}`);
  if (!supportedArchitectures.has(options.arch)) throw new Error(`Unsupported architecture: ${options.arch}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(options.version)) throw new Error(`Invalid version: ${options.version}`);
  if (options.nodeSource !== "download" && options.nodeSource !== "host") {
    throw new Error(`Invalid --node-source: ${options.nodeSource}`);
  }
  if (options.platform !== process.platform || options.arch !== process.arch) {
    throw new Error(
      `Native dependencies require a native ${options.platform}-${options.arch} build host; current host is ${process.platform}-${process.arch}`,
    );
  }

  const outDir = path.resolve(repoRoot, options.out);
  const workDir = await mkdtemp(path.join(os.tmpdir(), "openwork-den-selfhost-"));
  const deployRoot = path.join(workDir, "deploy");
  const stageRoot = path.join(workDir, "stage");
  const topLevelName = `openwork-den-${options.version}`;
  const bundleRoot = path.join(stageRoot, topLevelName);
  const archiveName = `openwork-den-${options.platform}-${options.arch}-${options.version}.tar.gz`;
  const archivePath = path.join(outDir, archiveName);
  const buildEnv = {
    ...process.env,
    CI: "true",
    DEN_API_LATEST_APP_VERSION: options.version,
    DEN_UPLOAD_SENTRY_SOURCEMAPS: "0",
    DEN_WEB_UPLOAD_SENTRY_SOURCEMAPS: "0",
    NEXT_PUBLIC_POSTHOG_API_KEY: "",
    NEXT_PUBLIC_POSTHOG_KEY: "",
  };

  try {
    await mkdir(deployRoot, { recursive: true });
    await mkdir(bundleRoot, { recursive: true });
    await mkdir(path.join(bundleRoot, "bin"), { recursive: true });
    await stageNode(path.join(bundleRoot, "bin", "node"), options, workDir);
    console.log("[den-selfhost] Building Den API and Den Web");
    await run("pnpm", ["--filter", "@openwork/types", "build"], { env: buildEnv });
    await run("pnpm", ["--filter", "@openwork-ee/den-api", "build"], { env: buildEnv });
    await run("pnpm", ["--filter", "@openwork-ee/den-web", "build"], { env: buildEnv });

    console.log("[den-selfhost] Deploying production dependencies");
    for (const [filter, name] of [["@openwork-ee/den-api", "den-api"], ["@openwork-ee/den-web", "den-web"]]) {
      await run("pnpm", [
        "--config.inject-workspace-packages=true",
        "--filter",
        filter,
        "deploy",
        "--prod",
        path.join(deployRoot, name),
      ], { env: buildEnv });
    }
    await pointWorkspacePackagesAtDist(path.join(deployRoot, "den-api", "node_modules"));

    await copyDeployedServices(deployRoot, bundleRoot);
    await cp(templateRoot, bundleRoot, { recursive: true });
    await writeFile(path.join(bundleRoot, "VERSION"), `${options.version}\n`, "utf8");
    await chmod(path.join(bundleRoot, "install.sh"), 0o755);
    await chmod(path.join(bundleRoot, "bin", "openwork-den"), 0o755);

    await access(path.join(bundleRoot, "services", "den-api", "node_modules", "@openwork-ee", "den-db", "dist", "scripts", "bootstrap.js"));
    await access(path.join(bundleRoot, "services", "den-api", "node_modules", "@openwork-ee", "den-db", "dist", "current-schema.sql"));
    await access(path.join(bundleRoot, "services", "den-web", ".next", "BUILD_ID"));

    await mkdir(outDir, { recursive: true });
    await rm(archivePath, { force: true });
    console.log(`[den-selfhost] Creating ${archivePath}`);
    await run("tar", ["-czf", archivePath, "-C", stageRoot, topLevelName]);
    console.log(archivePath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
