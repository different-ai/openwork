import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState } from "../src/engine-v2-preview.js";
import type { ServerConfig } from "../src/types.js";

async function profile(run: (config: ServerConfig, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "openwork-auto-upgrade-"));
  const previous = { OPENWORK_RUNTIME_DB: process.env.OPENWORK_RUNTIME_DB, OPENCODE_DB: process.env.OPENCODE_DB };
  process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  process.env.OPENCODE_DB = join(dir, "v1.db");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    engineAutoUpgrade: true,
  };
  try { await run(config, dir); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("boot never blocks: unreadable v1 history stays on v1 with a durable error and backoff", async () => {
  await profile(async (config, dir) => {
    writeFileSync(join(dir, "v1.db"), "not a SQLite database");
    const errors: string[] = [];
    const engine = createEngineV2Preview({ config, deferStart: true, autoUpgradeError: error => errors.push(error) });
    try {
      engine.start();
      // The migration is asynchronous, and the v1 route remains selected.
      assert.equal(engine.status().chatRouting, false);
      for (let check = 0; check < 100 && readEngineV2PreviewState(config).autoUpgradeRetry === undefined; check++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(errors.length, 1);
      assert.equal(engine.status().migration.state, "error");
      assert.equal(engine.status().chatRouting, false);
      const persisted = readEngineV2PreviewState(config);
      assert.equal(persisted.autoUpgradeRetry?.attempts, 1);
      assert.ok((persisted.autoUpgradeRetry?.retryAt ?? 0) > Date.now());
      assert.equal(persisted.historyCopyResult?.state, "error");
      engine.start();
      assert.equal(errors.length, 1, "no retry loop in the same boot");
    } finally { await engine.stop(); }
  });
});

test("a later boot honors persisted backoff without attempting history access", async () => {
  await profile(async (config, dir) => {
    writeFileSync(join(dir, "v1.db"), "not a SQLite database");
    const state = { enabled: false, chatRouting: false,
      autoUpgradeRetry: { attempts: 2, retryAt: Date.now() + 60_000 },
      historyCopyResult: { state: "error", error: "previous failure", imported: 0, skipped: 0, total: 0 } };
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify(state));
    const engine = createEngineV2Preview({ config, autoUpgradeError: () => assert.fail("must not retry before backoff") });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().migration.error, "previous failure");
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "engine-v2-preview.json"), "utf8")), state);
    } finally { await engine.stop(); }
  });
});

test("turning rollout off does not resume an interrupted automatic copy or delete v2 data", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    const state = { enabled: true, chatRouting: false, automaticHistoryCopy: true, v1HistoryCopyStartedAt: 1 };
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify(state));
    mkdirSync(join(dir, "opencode-v2", "state"), { recursive: true });
    writeFileSync(join(dir, "opencode-v2", "state", "opencode.db"), "checkpoint");
    const engine = createEngineV2Preview({ config });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().migration.state, "idle");
      assert.equal(engine.status().running, false);
      assert.equal(readFileSync(join(dir, "opencode-v2", "state", "opencode.db"), "utf8"), "checkpoint");
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "engine-v2-preview.json"), "utf8")), state);
    } finally { await engine.stop(); }
  });
});

test("flag off only returns a forced instance to v1", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    config.engineForcePolicy = true;
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true,
      engineOrigin: "forced", engineForced: true }));
    const engine = createEngineV2Preview({ config });
    try {
      for (let check = 0; check < 100 && engine.status().chatRouting; check++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().engineOrigin, "reverted");
      assert.equal(engine.status().engineForced, false);
      engine.setForcePolicy({ upgrade: false });
      assert.equal(engine.status().chatRouting, false, "upgrade must not refire while the flag is off");
      const persisted = readEngineV2PreviewState(config);
      assert.equal(persisted.engineOrigin, "reverted");
      assert.equal(persisted.chatRouting, false);
    } finally { await engine.stop(); }
  });
});

test("revert leaves a manually selected v2 engine untouched", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    config.engineForcePolicy = true;
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: false, chatRouting: true,
      engineOrigin: "manual", engineForced: false }));
    const engine = createEngineV2Preview({ config });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().engineOrigin, "manual");
      assert.equal(engine.status().engineForced, false);
    } finally { await engine.stop(); }
  });
});

test("revert waits for running v2 work and never interrupts it", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    config.engineForcePolicy = true;
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true,
      engineOrigin: "forced", engineForced: true }));
    let probed = false;
    const engine = createEngineV2Preview({ config, autoRevertIdle: async () => { probed = true; return false; } });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(probed, true);
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().engineForced, true);
    } finally { await engine.stop(); }
    assert.equal(readEngineV2PreviewState(config).chatRouting, true);
  });
});

test("rollout off preserves a saved v2 engine choice", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true }));
    const engine = createEngineV2Preview({ config, deferStart: true });
    assert.equal(engine.status().chatRouting, true);
    await engine.stop();
    assert.equal(readEngineV2PreviewState(config).chatRouting, true);
  });
});
