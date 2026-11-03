import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState } from "../src/engine-v2-preview.js";
import type { ServerConfig } from "../src/types.js";
import { resolveServerConfig } from "../src/config.js";

async function profile(run: (config: ServerConfig, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "openwork-auto-upgrade-"));
  const previous = { OPENWORK_RUNTIME_DB: process.env.OPENWORK_RUNTIME_DB, OPENCODE_DB: process.env.OPENCODE_DB };
  process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  process.env.OPENCODE_DB = join(dir, "v1.db");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  try { await run(config, dir); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("server configuration defaults migration on without any rollout flag", async () => {
  await profile(async (_config, dir) => {
    const previous = process.env.OPENWORK_ENGINE_AUTO_UPGRADE;
    try {
      delete process.env.OPENWORK_ENGINE_AUTO_UPGRADE;
      const defaults = await resolveServerConfig({ configPath: join(dir, "server.json"), workspaces: [] });
      assert.equal(defaults.engineAutoUpgrade, true);
      assert.equal(defaults.engineForcePolicy, undefined);
      process.env.OPENWORK_ENGINE_AUTO_UPGRADE = "0";
      const optOut = await resolveServerConfig({ configPath: join(dir, "server.json"), workspaces: [] });
      assert.equal(optOut.engineAutoUpgrade, false);
    } finally {
      if (previous === undefined) delete process.env.OPENWORK_ENGINE_AUTO_UPGRADE;
      else process.env.OPENWORK_ENGINE_AUTO_UPGRADE = previous;
    }
  });
});

for (const source of ["global-cli", "global-env", "global-file", "workspace-file"]) {
  test(`a supplied ${source} engine never automatically selects a host-local engine`, async () => {
    await profile(async (_config, dir) => {
      const configPath = join(dir, "server.json");
      const baseUrl = "http://127.0.0.1:49001";
      const previous = process.env.OPENWORK_OPENCODE_BASE_URL;
      try {
        delete process.env.OPENWORK_OPENCODE_BASE_URL;
        if (source === "global-env") process.env.OPENWORK_OPENCODE_BASE_URL = baseUrl;
        if (source === "global-file") writeFileSync(configPath, JSON.stringify({ opencodeBaseUrl: baseUrl }));
        if (source === "workspace-file") writeFileSync(configPath, JSON.stringify({ workspaces: [{ path: dir, baseUrl }, { path: join(dir, "local") }] }));
        const config = await resolveServerConfig({ configPath,
          workspaces: source === "workspace-file" ? [] : [dir],
          ...(source === "global-cli" ? { opencodeBaseUrl: baseUrl } : {}),
        });
        assert.equal(config.externalOpencode, true);
        if (source === "workspace-file") assert.equal(config.opencodeBaseUrl, undefined);
        assert.equal(config.workspaces[0]?.baseUrl, baseUrl);
        // Neither a fresh-install hint nor a positive legacy/local migration
        // setting proves that an externally supplied engine shares our DB.
        config.freshInstallEngine = "v2";
        config.engineAutoUpgrade = true;
        let probes = 0;
        const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => { probes++; return true; } });
        try {
          engine.setForcePolicy({ upgrade: true });
          await new Promise(resolve => setTimeout(resolve, 20));
          assert.equal(probes, 0);
          assert.equal(engine.status().enabled, false);
          assert.equal(engine.status().chatRouting, false);
          assert.equal(engine.status().running, false);
          assert.equal(engine.status().forceUpgradePending, false);
          assert.equal(config.workspaces[0]?.baseUrl, baseUrl);
          assert.deepEqual(readEngineV2PreviewState(config), { enabled: false, chatRouting: false });
          assert.equal(existsSync(join(dir, "engine-v2-preview.json")), false, "no automatic engine choice is persisted");
        } finally { await engine.stop(); }
      } finally {
        if (previous === undefined) delete process.env.OPENWORK_OPENCODE_BASE_URL;
        else process.env.OPENWORK_OPENCODE_BASE_URL = previous;
      }
    });
  });
}

test("managed global and workspace URLs retain local migration ownership after hydration", async () => {
  await profile(async (_config, dir) => {
    const config = await resolveServerConfig({ configPath: join(dir, "server.json"), workspaces: [dir] });
    assert.equal(config.externalOpencode, false);
    // CLI/embedded hydrate these URLs after config resolution. Their presence
    // must not be mistaken for an originally supplied external connection.
    config.opencodeBaseUrl = "http://127.0.0.1:49002";
    const workspace = config.workspaces[0];
    assert.ok(workspace);
    workspace.baseUrl = config.opencodeBaseUrl;
    writeFileSync(join(dir, "v1.db"), "not a SQLite database");
    const errors: string[] = [];
    const engine = createEngineV2Preview({ config, autoUpgradeError: error => errors.push(error) });
    try {
      // The failure callback runs before retry state is persisted. Wait for
      // the durable outcome as well, rather than racing the asynchronous write.
      for (let check = 0; check < 100 && (errors.length === 0 || !readEngineV2PreviewState(config).autoUpgradeRetry); check++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(errors.length, 1, "the owned local history migration is attempted");
      assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry?.attempts, 1);
      assert.equal(engine.status().chatRouting, false, "unreadable local history still fails safely");
    } finally { await engine.stop(); }
  });
});

test("direct server configs without a bootstrap snapshot also preserve supplied engines", async () => {
  await profile(async config => {
    config.opencodeBaseUrl = "https://external-engine.example";
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => assert.fail("external engine must not migrate") });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().forceUpgradePending, false);
    } finally { await engine.stop(); }
  });
});

test("external engine ownership does not overwrite an explicitly saved or pinned v2 choice", async () => {
  await profile(async (config, dir) => {
    config.externalOpencode = true;
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true, engineOrigin: "manual" }));
    const engine = createEngineV2Preview({ config, deferStart: true });
    try {
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().engineOrigin, "manual");
    } finally { await engine.stop(); }
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: false, chatRouting: false }));
    const previous = process.env.OPENWORK_ENGINE_V2_PREVIEW;
    process.env.OPENWORK_ENGINE_V2_PREVIEW = "chat";
    const pinned = createEngineV2Preview({ config, deferStart: true });
    try { assert.equal(pinned.status().chatRouting, true); }
    finally {
      await pinned.stop();
      if (previous === undefined) delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
      else process.env.OPENWORK_ENGINE_V2_PREVIEW = previous;
    }
  });
});

test("default migration waits for idle without starting v2 or touching history", async () => {
  await profile(async (config) => {
    let probes = 0;
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => { probes++; return false; } });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(probes, 1);
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().running, false);
      assert.equal(engine.status().migration.state, "idle");
    } finally { await engine.stop(); }
  });
});

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

test("an explicit local migration opt-out preserves an interrupted copy and v2 data", async () => {
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

test("legacy off policy never reverts an automatically migrated host", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    config.engineForcePolicy = true;
    const state = { enabled: true, chatRouting: true, engineOrigin: "forced", engineForced: true };
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify(state));
    const engine = createEngineV2Preview({ config, deferStart: true });
    try {
      engine.setForcePolicy({ upgrade: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().engineOrigin, "forced");
      assert.equal(engine.status().engineForced, true);
      assert.equal(engine.status().enabled, true);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "engine-v2-preview.json"), "utf8")), state);
    } finally { await engine.stop(); }
  });
});

test("legacy off policy leaves a manually selected v2 engine untouched", async () => {
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

test("legacy upgrade:false cannot block the default boot migration", async () => {
  await profile(async (config, dir) => {
    writeFileSync(join(dir, "v1.db"), "not a SQLite database");
    const errors: string[] = [];
    const engine = createEngineV2Preview({ config, deferStart: true, autoUpgradeError: error => errors.push(error) });
    try {
      engine.setForcePolicy({ upgrade: false });
      engine.start();
      // The failure callback runs before retry state is persisted. Wait for
      // the durable outcome as well, rather than racing the asynchronous write.
      for (let check = 0; check < 100 && (errors.length === 0 || !readEngineV2PreviewState(config).autoUpgradeRetry); check++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(errors.length, 1, "default migration still attempts history access without a rollout flag");
      assert.equal(engine.status().chatRouting, false, "unreadable history still fails safely");
    } finally { await engine.stop(); }
  });
});

test("legacy upgrade:true cannot override an explicit local opt-out", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    writeFileSync(join(dir, "v1.db"), "not a SQLite database");
    const engine = createEngineV2Preview({ config, autoUpgradeError: () => assert.fail("local opt-out must win") });
    try {
      engine.setForcePolicy({ upgrade: true });
      engine.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().migration.state, "idle");
      assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry, undefined);
    } finally { await engine.stop(); }
  });
});

test("an explicit engine environment override prevents automatic migration", async () => {
  await profile(async (config, dir) => {
    const previous = process.env.OPENWORK_ENGINE_V2_PREVIEW;
    process.env.OPENWORK_ENGINE_V2_PREVIEW = "0";
    writeFileSync(join(dir, "v1.db"), "not a SQLite database");
    const engine = createEngineV2Preview({ config, autoUpgradeError: () => assert.fail("pinned engine must win") });
    try {
      engine.setForcePolicy({ upgrade: true });
      engine.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().migration.state, "idle");
      assert.equal(engine.status().chatRouting, false);
    } finally {
      await engine.stop();
      if (previous === undefined) delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
      else process.env.OPENWORK_ENGINE_V2_PREVIEW = previous;
    }
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

test("a person's explicit switch back to v1 sticks: the background upgrade leaves it alone", async () => {
  await profile(async (config, dir) => {
    // Unreadable history would make any upgrade attempt fail loudly.
    writeFileSync(join(dir, "v1.db"), "not a SQLite database");
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({
      enabled: false, chatRouting: false, engineOrigin: "manual", engineChangedAt: "2026-10-01T12:00:00.000Z",
    }));
    const engine = createEngineV2Preview({ config, autoUpgradeError: () => assert.fail("a manual v1 choice must not be upgraded") });
    try {
      engine.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().migration.state === "error", false);
      assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry, undefined);
    } finally { await engine.stop(); }
  });
});

test("an explicit v1 choice made while waiting for idle prevents the automatic switch", async () => {
  await profile(async config => {
    let releaseIdle: (idle: boolean) => void = () => assert.fail("idle probe not started");
    const idle = new Promise<boolean>(resolve => { releaseIdle = resolve; });
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: () => idle,
      autoUpgradeError: () => assert.fail("a local engine choice is not an upgrade failure") });
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      await engine.setEnabled(false);
      releaseIdle(true);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().enabled, false);
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().running, false);
      assert.equal(engine.status().engineOrigin, "manual");
    } finally { releaseIdle(true); await engine.stop(); }
  });
});

test("an install that never chose an engine is still moved to v2 in the background", async () => {
  await profile(async (config, dir) => {
    writeFileSync(join(dir, "v1.db"), "not a SQLite database");
    // Legacy v1 state: no origin and no recorded choice.
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: false, chatRouting: false }));
    const errors: string[] = [];
    const engine = createEngineV2Preview({ config, autoUpgradeError: error => errors.push(error) });
    try {
      engine.start();
      // The failure callback runs before retry state is persisted. Wait for
      // the durable outcome as well, rather than racing the asynchronous write.
      for (let check = 0; check < 100 && (errors.length === 0 || !readEngineV2PreviewState(config).autoUpgradeRetry); check++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(errors.length, 1, "the upgrade was attempted (and failed safely on unreadable history)");
      assert.equal(engine.status().chatRouting, false, "a failed attempt keeps v1");
    } finally { await engine.stop(); }
  });
});
