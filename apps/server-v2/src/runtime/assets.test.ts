import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRuntimeAssetService } from "./assets.js";
import { registerEmbeddedRuntimeBundle } from "./embedded.js";
import { resolveRuntimeTarget, type RuntimeManifest } from "./manifest.js";

const cleanupPaths: string[] = [];
const ENV_KEYS = [
  "OPENWORK_SERVER_V2_RUNTIME_BUNDLE_DIR",
  "OPENWORK_SERVER_V2_RUNTIME_SOURCE",
  "OPENWORK_SERVER_V2_RUNTIME_RELEASE_DIR",
  "OPENWORK_SERVER_V2_RUNTIME_MANIFEST_PATH",
];
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of originalEnv.entries()) {
    if (typeof value === "string") {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      fs.rmSync(target, { force: true, recursive: true });
    }
  }
  registerEmbeddedRuntimeBundle(undefined);
});

function makeTempDir(name: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  cleanupPaths.push(directory);
  return directory;
}

async function sha256(filePath: string) {
  const contents = await Bun.file(filePath).arrayBuffer();
  return createHash("sha256").update(Buffer.from(contents)).digest("hex");
}

function writeVersionedBinary(filePath: string, version: string) {
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then',
    `  echo ${JSON.stringify(version)}`,
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  fs.writeFileSync(filePath, script, "utf8");
  fs.chmodSync(filePath, 0o755);
}

test("release runtime assets use manifest versions without reading repo metadata", async () => {
  const target = resolveRuntimeTarget();
  if (!target) {
    throw new Error("Unsupported test target.");
  }

  const releaseRoot = makeTempDir("openwork-server-v2-release-assets");
  const opencodePath = path.join(releaseRoot, process.platform === "win32" ? "opencode.exe" : "opencode");
  const routerPath = path.join(releaseRoot, process.platform === "win32" ? "opencode-router.exe" : "opencode-router");
  writeVersionedBinary(opencodePath, "1.2.27");
  writeVersionedBinary(routerPath, "0.11.206");

  const manifest: RuntimeManifest = {
    files: {
      opencode: {
        path: path.basename(opencodePath),
        sha256: await sha256(opencodePath),
        size: fs.statSync(opencodePath).size,
      },
      "opencode-router": {
        path: path.basename(routerPath),
        sha256: await sha256(routerPath),
        size: fs.statSync(routerPath).size,
      },
    },
    generatedAt: new Date().toISOString(),
    manifestVersion: 1,
    opencodeVersion: "1.2.27",
    rootDir: releaseRoot,
    routerVersion: "0.11.206",
    serverVersion: "0.0.0-test",
    source: "release",
    target,
  };
  const manifestPath = path.join(releaseRoot, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  process.env.OPENWORK_SERVER_V2_RUNTIME_SOURCE = "release";
  process.env.OPENWORK_SERVER_V2_RUNTIME_RELEASE_DIR = releaseRoot;
  process.env.OPENWORK_SERVER_V2_RUNTIME_MANIFEST_PATH = manifestPath;

  const service = createRuntimeAssetService({
    environment: "test",
    serverVersion: "0.0.0-test",
    workingDirectory: {
      databaseDir: releaseRoot,
      databasePath: path.join(releaseRoot, "db.sqlite"),
      importsDir: path.join(releaseRoot, "imports"),
      managedDir: path.join(releaseRoot, "managed"),
      managedMcpDir: path.join(releaseRoot, "managed", "mcps"),
      managedPluginDir: path.join(releaseRoot, "managed", "plugins"),
      managedProviderDir: path.join(releaseRoot, "managed", "providers"),
      managedSkillDir: path.join(releaseRoot, "managed", "skills"),
      rootDir: releaseRoot,
      runtimeDir: releaseRoot,
      workspacesDir: path.join(releaseRoot, "workspaces"),
    },
  });

  const bundle = await service.resolveRuntimeBundle();
  expect(bundle.opencode.version).toBe("1.2.27");
  expect(bundle.router.version).toBe("0.11.206");
  expect(bundle.manifest.source).toBe("release");
});

test("release runtime assets extract into the managed runtime directory and survive source bundle removal", async () => {
  const target = resolveRuntimeTarget();
  if (!target) {
    throw new Error("Unsupported test target.");
  }

  const bundleRoot = makeTempDir("openwork-server-v2-release-bundle");
  const runtimeRoot = makeTempDir("openwork-server-v2-runtime-root");
  const runtimeDir = path.join(runtimeRoot, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });

  const opencodePath = path.join(bundleRoot, process.platform === "win32" ? "opencode.exe" : "opencode");
  const routerPath = path.join(bundleRoot, process.platform === "win32" ? "opencode-router.exe" : "opencode-router");
  writeVersionedBinary(opencodePath, "1.2.27");
  writeVersionedBinary(routerPath, "0.11.206");

  const manifest: RuntimeManifest = {
    files: {
      opencode: {
        path: path.basename(opencodePath),
        sha256: await sha256(opencodePath),
        size: fs.statSync(opencodePath).size,
      },
      "opencode-router": {
        path: path.basename(routerPath),
        sha256: await sha256(routerPath),
        size: fs.statSync(routerPath).size,
      },
    },
    generatedAt: new Date().toISOString(),
    manifestVersion: 1,
    opencodeVersion: "1.2.27",
    rootDir: bundleRoot,
    routerVersion: "0.11.206",
    serverVersion: "0.0.0-test",
    source: "release",
    target,
  };
  fs.writeFileSync(path.join(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  process.env.OPENWORK_SERVER_V2_RUNTIME_SOURCE = "release";
  process.env.OPENWORK_SERVER_V2_RUNTIME_BUNDLE_DIR = bundleRoot;

  const workingDirectory = {
    databaseDir: runtimeRoot,
    databasePath: path.join(runtimeRoot, "db.sqlite"),
    importsDir: path.join(runtimeRoot, "imports"),
    managedDir: path.join(runtimeRoot, "managed"),
    managedMcpDir: path.join(runtimeRoot, "managed", "mcps"),
    managedPluginDir: path.join(runtimeRoot, "managed", "plugins"),
    managedProviderDir: path.join(runtimeRoot, "managed", "providers"),
    managedSkillDir: path.join(runtimeRoot, "managed", "skills"),
    rootDir: runtimeRoot,
    runtimeDir,
    workspacesDir: path.join(runtimeRoot, "workspaces"),
  };

  const service = createRuntimeAssetService({
    environment: "test",
    serverVersion: "0.0.0-test",
    workingDirectory,
  });

  const firstBundle = await service.resolveRuntimeBundle();
  const extractedRoot = path.join(runtimeDir, "0.0.0-test");
  expect(firstBundle.opencode.absolutePath).toBe(path.join(extractedRoot, path.basename(opencodePath)));
  expect(firstBundle.router.absolutePath).toBe(path.join(extractedRoot, path.basename(routerPath)));
  expect(fs.existsSync(path.join(extractedRoot, "manifest.json"))).toBe(true);

  fs.rmSync(bundleRoot, { recursive: true, force: true });

  const secondBundle = await service.resolveRuntimeBundle();
  expect(secondBundle.opencode.absolutePath).toBe(firstBundle.opencode.absolutePath);
  expect(secondBundle.router.absolutePath).toBe(firstBundle.router.absolutePath);
});

test("release runtime assets can extract from an embedded runtime bundle", async () => {
  const target = resolveRuntimeTarget();
  if (!target) {
    throw new Error("Unsupported test target.");
  }

  const bundleRoot = makeTempDir("openwork-server-v2-embedded-bundle");
  const runtimeRoot = makeTempDir("openwork-server-v2-embedded-runtime-root");
  const runtimeDir = path.join(runtimeRoot, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });

  const opencodePath = path.join(bundleRoot, process.platform === "win32" ? "opencode.exe" : "opencode");
  const routerPath = path.join(bundleRoot, process.platform === "win32" ? "opencode-router.exe" : "opencode-router");
  const manifestPath = path.join(bundleRoot, "manifest.json");
  writeVersionedBinary(opencodePath, "1.2.27");
  writeVersionedBinary(routerPath, "0.11.206");

  const manifest: RuntimeManifest = {
    files: {
      opencode: {
        path: path.basename(opencodePath),
        sha256: await sha256(opencodePath),
        size: fs.statSync(opencodePath).size,
      },
      "opencode-router": {
        path: path.basename(routerPath),
        sha256: await sha256(routerPath),
        size: fs.statSync(routerPath).size,
      },
    },
    generatedAt: new Date().toISOString(),
    manifestVersion: 1,
    opencodeVersion: "1.2.27",
    rootDir: bundleRoot,
    routerVersion: "0.11.206",
    serverVersion: "0.0.0-test",
    source: "release",
    target,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  process.env.OPENWORK_SERVER_V2_RUNTIME_SOURCE = "release";
  delete process.env.OPENWORK_SERVER_V2_RUNTIME_BUNDLE_DIR;

  registerEmbeddedRuntimeBundle({
    manifestPath,
    opencodePath,
    routerPath,
  });

  const service = createRuntimeAssetService({
    environment: "test",
    serverVersion: "0.0.0-test",
    workingDirectory: {
      databaseDir: runtimeRoot,
      databasePath: path.join(runtimeRoot, "db.sqlite"),
      importsDir: path.join(runtimeRoot, "imports"),
      managedDir: path.join(runtimeRoot, "managed"),
      managedMcpDir: path.join(runtimeRoot, "managed", "mcps"),
      managedPluginDir: path.join(runtimeRoot, "managed", "plugins"),
      managedProviderDir: path.join(runtimeRoot, "managed", "providers"),
      managedSkillDir: path.join(runtimeRoot, "managed", "skills"),
      rootDir: runtimeRoot,
      runtimeDir,
      workspacesDir: path.join(runtimeRoot, "workspaces"),
    },
  });

  const bundle = await service.resolveRuntimeBundle();
  const extractedRoot = path.join(runtimeDir, "0.0.0-test");
  expect(bundle.opencode.absolutePath).toBe(path.join(extractedRoot, path.basename(opencodePath)));
  expect(bundle.router.absolutePath).toBe(path.join(extractedRoot, path.basename(routerPath)));
  expect(fs.existsSync(path.join(extractedRoot, "manifest.json"))).toBe(true);
});
