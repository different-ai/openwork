import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServerPersistence } from "../database/persistence.js";
import { resolveRuntimeTarget, type RuntimeManifest } from "../runtime/manifest.js";
import { createRuntimeService } from "./runtime-service.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (!target) {
      continue;
    }
    fs.rmSync(target, { force: true, recursive: true });
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

async function createFakeBinary(kind: "opencode" | "router", mode: string, exitAfterMs?: number) {
  const wrapperDir = makeTempDir(`openwork-server-v2-${kind}`);
  const binaryPath = path.join(wrapperDir, kind === "opencode" ? "opencode" : "opencode-router");
  const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "fake-runtime.ts");
  const script = [
    "#!/bin/sh",
    `export FAKE_RUNTIME_KIND=${kind}`,
    `export FAKE_RUNTIME_MODE=${mode}`,
    ...(exitAfterMs ? [`export FAKE_RUNTIME_EXIT_AFTER_MS=${exitAfterMs}`] : []),
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} \"$@\"`,
    "",
  ].join("\n");
  fs.writeFileSync(binaryPath, script, "utf8");
  fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

async function createFakeAssetService(opencodePath: string, routerPath: string) {
  const target = resolveRuntimeTarget();
  if (!target) {
    throw new Error("Unsupported test target.");
  }
  const opencodeExists = fs.existsSync(opencodePath);
  const opencodeStats = opencodeExists ? fs.statSync(opencodePath) : { size: 0 };
  const routerStats = fs.statSync(routerPath);
  const manifest: RuntimeManifest = {
    files: {
      opencode: {
        path: path.basename(opencodePath),
        sha256: opencodeExists ? await sha256(opencodePath) : "missing",
        size: opencodeStats.size,
      },
      "opencode-router": {
        path: path.basename(routerPath),
        sha256: await sha256(routerPath),
        size: routerStats.size,
      },
    },
    generatedAt: new Date().toISOString(),
    manifestVersion: 1,
    opencodeVersion: "1.2.27",
    rootDir: path.dirname(opencodePath),
    routerVersion: "0.11.206",
    serverVersion: "0.0.0-test",
    source: "development",
    target,
  };

  const opencodeBinary = {
    absolutePath: opencodePath,
    name: "opencode" as const,
    sha256: manifest.files.opencode.sha256,
    size: manifest.files.opencode.size,
    source: "development" as const,
    stagedRoot: path.dirname(opencodePath),
    target,
    version: "1.2.27",
  };
  const routerBinary = {
    absolutePath: routerPath,
    name: "opencode-router" as const,
    sha256: manifest.files["opencode-router"].sha256,
    size: manifest.files["opencode-router"].size,
    source: "development" as const,
    stagedRoot: path.dirname(routerPath),
    target,
    version: "0.11.206",
  };

  return {
    ensureOpencodeBinary: async () => opencodeBinary,
    ensureRouterBinary: async () => routerBinary,
    getDevelopmentRoot: () => path.dirname(opencodePath),
    getPinnedOpencodeVersion: async () => "1.2.27",
    getReleaseRoot: () => path.dirname(opencodePath),
    getRouterVersion: async () => "0.11.206",
    getSource: () => "development" as const,
    getTarget: () => target,
    resolveRuntimeBundle: async () => ({
      manifest,
      opencode: opencodeBinary,
      router: routerBinary,
    }),
  };
}

function createPersistence() {
  const workingDirectory = makeTempDir("openwork-server-v2-runtime-service");
  return createServerPersistence({
    environment: "test",
    localServer: {
      baseUrl: null,
      hostingKind: "self_hosted",
      label: "Local OpenWork Server",
    },
    version: "0.0.0-test",
    workingDirectory,
  });
}

test("runtime bootstrap starts OpenCode successfully and persists health", async () => {
  const persistence = createPersistence();
  const opencodePath = await createFakeBinary("opencode", "success");
  const routerPath = await createFakeBinary("router", "success");
  const assetService = await createFakeAssetService(opencodePath, routerPath);
  const runtime = createRuntimeService({
    assetService,
    bootstrapPolicy: "manual",
    environment: "test",
    repositories: persistence.repositories,
    restartPolicy: { backoffMs: 25, maxAttempts: 0, windowMs: 1000 },
    serverId: persistence.registry.localServerId,
    serverVersion: "0.0.0-test",
    workingDirectory: persistence.workingDirectory,
  });

  await runtime.bootstrap();

  const opencode = runtime.getOpencodeHealth();
  expect(opencode.running).toBe(true);
  expect(opencode.status).toBe("running");
  expect(opencode.baseUrl).toContain("http://127.0.0.1:");
  expect(persistence.repositories.serverRuntimeState.getByServerId(persistence.registry.localServerId)?.opencodeStatus).toBe("running");

  await runtime.dispose();
  persistence.close();
});

test("runtime bootstrap surfaces missing OpenCode binaries clearly", async () => {
  const persistence = createPersistence();
  const routerPath = await createFakeBinary("router", "success");
  const assetService = await createFakeAssetService(path.join(os.tmpdir(), `does-not-exist-opencode-${Date.now()}`), routerPath);
  const runtime = createRuntimeService({
    assetService,
    bootstrapPolicy: "manual",
    environment: "test",
    repositories: persistence.repositories,
    restartPolicy: { backoffMs: 25, maxAttempts: 0, windowMs: 1000 },
    serverId: persistence.registry.localServerId,
    serverVersion: "0.0.0-test",
    workingDirectory: persistence.workingDirectory,
  });

  await expect(runtime.bootstrap()).rejects.toThrow("executable not found");
  expect(runtime.getOpencodeHealth().status).toBe("error");

  await runtime.dispose();
  persistence.close();
});

test("runtime bootstrap surfaces OpenCode readiness timeouts", async () => {
  const persistence = createPersistence();
  const opencodePath = await createFakeBinary("opencode", "timeout");
  const routerPath = await createFakeBinary("router", "success");
  const assetService = await createFakeAssetService(opencodePath, routerPath);
  process.env.OPENWORK_SERVER_V2_OPENCODE_START_TIMEOUT_MS = "300";
  const runtime = createRuntimeService({
    assetService,
    bootstrapPolicy: "manual",
    environment: "test",
    repositories: persistence.repositories,
    restartPolicy: { backoffMs: 25, maxAttempts: 0, windowMs: 1000 },
    serverId: persistence.registry.localServerId,
    serverVersion: "0.0.0-test",
    workingDirectory: persistence.workingDirectory,
  });

  await expect(runtime.bootstrap()).rejects.toThrow("did not become ready");
  expect(runtime.getOpencodeHealth().status).toBe("error");
  delete process.env.OPENWORK_SERVER_V2_OPENCODE_START_TIMEOUT_MS;

  await runtime.dispose();
  persistence.close();
});

test("runtime supervisor records post-ready OpenCode crashes", async () => {
  const persistence = createPersistence();
  const opencodePath = await createFakeBinary("opencode", "success", 150);
  const routerPath = await createFakeBinary("router", "success");
  const assetService = await createFakeAssetService(opencodePath, routerPath);
  const runtime = createRuntimeService({
    assetService,
    bootstrapPolicy: "manual",
    environment: "test",
    repositories: persistence.repositories,
    restartPolicy: { backoffMs: 25, maxAttempts: 0, windowMs: 1000 },
    serverId: persistence.registry.localServerId,
    serverVersion: "0.0.0-test",
    workingDirectory: persistence.workingDirectory,
  });

  await runtime.bootstrap();
  await Bun.sleep(400);

  expect(runtime.getOpencodeHealth().status).toBe("crashed");
  expect(runtime.getOpencodeHealth().lastExit?.reason).toBe("unexpected_exit");

  await runtime.dispose();
  persistence.close();
});

test("runtime supervisor starts router when enabled and persists router state", async () => {
  const persistence = createPersistence();
  persistence.repositories.routerIdentities.upsert({
    auth: { token: "telegram-token" },
    config: {},
    displayName: "Telegram Bot",
    id: "router_identity_telegram",
    isEnabled: true,
    kind: "telegram",
    serverId: persistence.registry.localServerId,
  });
  persistence.repositories.routerBindings.upsert({
    bindingKey: "peer-1",
    config: { directory: persistence.workingDirectory.rootDir },
    id: "router_binding_one",
    isEnabled: true,
    routerIdentityId: "router_identity_telegram",
    serverId: persistence.registry.localServerId,
  });

  const opencodePath = await createFakeBinary("opencode", "success");
  const routerPath = await createFakeBinary("router", "success");
  const assetService = await createFakeAssetService(opencodePath, routerPath);
  const runtime = createRuntimeService({
    assetService,
    bootstrapPolicy: "manual",
    environment: "test",
    repositories: persistence.repositories,
    restartPolicy: { backoffMs: 25, maxAttempts: 0, windowMs: 1000 },
    serverId: persistence.registry.localServerId,
    serverVersion: "0.0.0-test",
    workingDirectory: persistence.workingDirectory,
  });

  await runtime.bootstrap();

  const router = runtime.getRouterHealth();
  expect(router.enablement.enabled).toBe(true);
  expect(router.running).toBe(true);
  expect(router.status).toBe("running");
  expect(router.materialization?.bindingCount).toBe(1);
  expect(persistence.repositories.serverRuntimeState.getByServerId(persistence.registry.localServerId)?.routerStatus).toBe("running");

  await runtime.dispose();
  persistence.close();
});

test("runtime upgrade restarts managed children and records upgrade state", async () => {
  const persistence = createPersistence();
  const opencodePath = await createFakeBinary("opencode", "success");
  const routerPath = await createFakeBinary("router", "success");
  const assetService = await createFakeAssetService(opencodePath, routerPath);
  const runtime = createRuntimeService({
    assetService,
    bootstrapPolicy: "manual",
    environment: "test",
    repositories: persistence.repositories,
    restartPolicy: { backoffMs: 25, maxAttempts: 0, windowMs: 1000 },
    serverId: persistence.registry.localServerId,
    serverVersion: "0.0.0-test",
    workingDirectory: persistence.workingDirectory,
  });

  await runtime.bootstrap();
  const upgraded = await runtime.upgradeRuntime();

  expect(upgraded.state.status).toBe("completed");
  expect(upgraded.summary.opencode.running).toBe(true);
  expect(upgraded.summary.upgrade.status).toBe("completed");

  await runtime.dispose();
  persistence.close();
});
