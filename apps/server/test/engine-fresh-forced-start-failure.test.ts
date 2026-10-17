import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState, seedFreshInstallEngineState, writeEngineV2PreviewState } from "../src/engine-v2-preview.js";
import type { ServerConfig } from "../src/types.js";

const nativeBinary = process.env.OPENWORK_OPENCODE2_BIN;

async function profile(run: (config: ServerConfig) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "openwork-fresh-forced-failure-"));
  const overrides = {
    HOME: directory,
    USERPROFILE: directory,
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENWORK_RUNTIME_DB: join(directory, "runtime.sqlite"),
    OPENCODE_DB: join(directory, "v1.db"),
    OPENWORK_OPENCODE2_BIN: join(directory, "nonexistent-opencode2"),
    OPENWORK_ENGINE_V2_PREVIEW: "",
  };
  const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    freshInstallEngine: "v2", engineAutoUpgrade: true, engineForcePolicy: true,
  };
  try { await run(config); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

for (const preseeded of [false, true]) test(`forced fresh start failure falls back with durable backoff (saved selection: ${preseeded})`, async () => {
  await profile(async config => {
    if (preseeded) assert.equal(seedFreshInstallEngineState(config), true);
    const errors: string[] = [];
    const engine = createEngineV2Preview({ config, deferStart: true, autoUpgradeError: error => errors.push(error) });
    try {
      engine.start();
      const deadline = Date.now() + 10_000;
      while (!readEngineV2PreviewState(config).autoUpgradeRetry && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const status = engine.status();
      assert.equal(status.running, false);
      assert.equal(status.chatRouting, false, "an unavailable forced engine is never left selected");
      assert.equal(status.enabled, false);
      assert.equal(status.engineForced, false);
      assert.match(status.migration.error ?? "", /nonexistent-opencode2/);
      assert.equal(errors.length, 1);
    } finally { await engine.stop(); }
    const saved = readEngineV2PreviewState(config);
    assert.equal(saved.historyCopyResult?.state, "error");
    assert.equal(saved.autoUpgradeRetry?.attempts, 1);
    assert.ok((saved.autoUpgradeRetry?.retryAt ?? 0) > Date.now());
    const later = createEngineV2Preview({ config, autoUpgradeError: () => assert.fail("backoff must prevent a new attempt") });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(later.status().chatRouting, false);
      assert.equal(later.status().running, false);
      assert.match(later.status().migration.error ?? "", /nonexistent-opencode2/);
      assert.deepEqual(readEngineV2PreviewState(config).autoUpgradeRetry, saved.autoUpgradeRetry);
    } finally { await later.stop(); }
  });
});

test("a later healthy fresh retry clears the error receipt and keeps forced ownership", { skip: !nativeBinary, timeout: 90_000 }, async () => {
  if (!nativeBinary) return;
  await profile(async config => {
    const first = createEngineV2Preview({ config });
    try {
      const deadline = Date.now() + 10_000;
      while (!readEngineV2PreviewState(config).autoUpgradeRetry && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(first.status().chatRouting, false);
      assert.equal(first.status().migration.state, "error");
    } finally { await first.stop(); }
    const failed = readEngineV2PreviewState(config);
    assert.ok(failed.autoUpgradeRetry);
    // Arrange an expired durable cooldown, as on a later boot; production
    // still owns all binary startup, readiness and engine switching behavior.
    await writeEngineV2PreviewState(config, { ...failed, autoUpgradeRetry: { attempts: 1, retryAt: 0 } });
    process.env.OPENWORK_OPENCODE2_BIN = nativeBinary;
    const retried = createEngineV2Preview({ config, autoUpgradeIdle: async () => true });
    try {
      const deadline = Date.now() + 60_000;
      while ((!retried.status().engineForced || readEngineV2PreviewState(config).autoUpgradeRetry !== undefined) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const status = retried.status();
      assert.equal(status.running, true, JSON.stringify(status));
      assert.equal(status.chatRouting, true);
      assert.equal(status.engineOrigin, "fresh");
      assert.equal(status.engineForced, true);
      assert.equal(status.migration.state, "idle", "a recovered fresh profile must not keep its old error");
      assert.equal(readEngineV2PreviewState(config).historyCopyResult, undefined);
      assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry, undefined);
    } finally { await retried.stop(); }
  });
});

test("a failed manually selected fresh engine is not silently changed by the force controller", async () => {
  await profile(async config => {
    assert.equal(seedFreshInstallEngineState({ ...config, engineAutoUpgrade: false }), true);
    const engine = createEngineV2Preview({ config });
    try {
      const deadline = Date.now() + 10_000;
      while (!engine.status().lastError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.match(engine.status().lastError ?? "", /nonexistent-opencode2/);
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().engineForced, false);
      assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry, undefined);
    } finally { await engine.stop(); }
  });
});
