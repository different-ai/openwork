import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRuntimeAssetService } from "./assets.js";
import { resolveRuntimeTarget, type RuntimeManifest } from "./manifest.js";

const cleanupPaths: string[] = [];
const ENV_KEYS = [
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
