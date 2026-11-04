import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState } from "../src/engine-v2-preview.js";
import type { ServerConfig } from "../src/types.js";
import { resolveServerConfig } from "../src/config.js";

async function profile(run: (config: ServerConfig, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "openwork-auto-upgrade-"));
  const previous = { OPENWORK_RUNTIME_DB: process.env.OPENWORK_RUNTIME_DB, OPENCODE_DB: process.env.OPENCODE_DB, OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN };
  process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  process.env.OPENCODE_DB = join(dir, "v1.db");
  process.env.OPENWORK_OPENCODE2_BIN = join(dir, "nonexistent-opencode2");
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

test("server configuration defaults automatic upgrade on without any rollout flag", async () => {
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
        // Neither a fresh-install hint nor a positive legacy/local upgrade
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

test("managed global and workspace URLs retain local upgrade ownership after hydration", async () => {
  await profile(async (_config, dir) => {
    const config = await resolveServerConfig({ configPath: join(dir, "server.json"), workspaces: [dir] });
    assert.equal(config.externalOpencode, false);
    // CLI/embedded hydrate these URLs after config resolution. Their presence
    // must not be mistaken for an originally supplied external connection.
    config.opencodeBaseUrl = "http://127.0.0.1:49002";
    const workspace = config.workspaces[0];
    assert.ok(workspace);
    workspace.baseUrl = config.opencodeBaseUrl;
    const errors: string[] = [];
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => true, autoUpgradeError: error => errors.push(error) });
    try {
      // The failure callback runs before retry state is persisted. Wait for
      // the durable outcome as well, rather than racing the asynchronous write.
      for (let check = 0; check < 2_000 && (errors.length === 0 || !readEngineV2PreviewState(config).autoUpgradeRetry); check++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(errors.length, 1, "the owned local engine upgrade is attempted");
      assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry?.attempts, 1);
      assert.equal(engine.status().chatRouting, true, "a failed v2 startup never falls back after upstream migration may have started");
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

test("default upgrade waits for idle without starting v2", async () => {
  await profile(async (config) => {
    let probes = 0;
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => { probes++; return false; } });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(probes, 1);
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().running, false);
    } finally { await engine.stop(); }
  });
});

test("boot never blocks and failed v2 startup keeps forced routing with durable backoff", async () => {
  await profile(async config => {
    const errors: string[] = [];
    const engine = createEngineV2Preview({ config, deferStart: true, autoUpgradeIdle: async () => true,
      autoUpgradeError: error => errors.push(error) });
    try {
      engine.start();
      assert.equal(engine.status().running, false);
      for (let check = 0; check < 2_000 && !readEngineV2PreviewState(config).autoUpgradeRetry; check++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(errors.length, 1);
      assert.match(engine.status().lastError ?? "", /nonexistent-opencode2/);
      assert.equal(engine.status().chatRouting, true, "upstream conversion may have begun: never reopen the DB with v1");
      assert.equal(engine.status().engineForced, true);
      const persisted = readEngineV2PreviewState(config);
      assert.equal(persisted.chatRouting, true);
      assert.equal(persisted.autoUpgradeRetry?.attempts, 1);
      assert.ok((persisted.autoUpgradeRetry?.retryAt ?? 0) > Date.now());
    } finally { await engine.stop(); }
  });
});

test("a later boot honors persisted backoff without probing or starting v2", async () => {
  await profile(async (config, dir) => {
    const state = { enabled: false, chatRouting: false,
      autoUpgradeRetry: { attempts: 2, retryAt: Date.now() + 60_000 } };
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify(state));
    const engine = createEngineV2Preview({ config,
      autoUpgradeIdle: async () => assert.fail("must not probe before backoff"),
      autoUpgradeError: () => assert.fail("must not retry before backoff") });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().running, false);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "engine-v2-preview.json"), "utf8")), state);
    } finally { await engine.stop(); }
  });
});

test("an explicit local opt-out never probes idle or starts v2", async () => {
  await profile(async config => {
    config.engineAutoUpgrade = false;
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => assert.fail("local opt-out must win") });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().running, false);
      assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry, undefined);
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

test("legacy upgrade:false cannot block the default boot upgrade", async () => {
  await profile(async (config, dir) => {
    const errors: string[] = [];
    const engine = createEngineV2Preview({ config, deferStart: true, autoUpgradeIdle: async () => true, autoUpgradeError: error => errors.push(error) });
    try {
      engine.setForcePolicy({ upgrade: false });
      engine.start();
      // The failure callback runs before retry state is persisted. Wait for
      // the durable outcome as well, rather than racing the asynchronous write.
      for (let check = 0; check < 2_000 && (errors.length === 0 || !readEngineV2PreviewState(config).autoUpgradeRetry); check++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(errors.length, 1, "default upgrade starts v2 without a rollout flag");
      assert.equal(engine.status().chatRouting, true, "a failed v2 startup must not reopen the database with v1");
    } finally { await engine.stop(); }
  });
});

test("legacy upgrade:true cannot override an explicit local opt-out", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    const engine = createEngineV2Preview({ config, autoUpgradeError: () => assert.fail("local opt-out must win") });
    try {
      engine.setForcePolicy({ upgrade: true });
      engine.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry, undefined);
    } finally { await engine.stop(); }
  });
});

test("an explicit engine environment override prevents automatic upgrade", async () => {
  await profile(async (config, dir) => {
    const previous = process.env.OPENWORK_ENGINE_V2_PREVIEW;
    process.env.OPENWORK_ENGINE_V2_PREVIEW = "0";
    const engine = createEngineV2Preview({ config, autoUpgradeError: () => assert.fail("pinned engine must win") });
    try {
      engine.setForcePolicy({ upgrade: true });
      engine.start();
      await new Promise(resolve => setTimeout(resolve, 20));
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
    // A missing binary would make any upgrade attempt fail loudly.
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({
      enabled: false, chatRouting: false, engineOrigin: "manual", engineChangedAt: "2026-10-01T12:00:00.000Z",
    }));
    const engine = createEngineV2Preview({ config, autoUpgradeError: () => assert.fail("a manual v1 choice must not be upgraded") });
    try {
      engine.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(engine.status().chatRouting, false);
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
    // Legacy v1 state: no origin and no recorded choice.
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: false, chatRouting: false }));
    const errors: string[] = [];
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => true, autoUpgradeError: error => errors.push(error) });
    try {
      engine.start();
      // The failure callback runs before retry state is persisted. Wait for
      // the durable outcome as well, rather than racing the asynchronous write.
      for (let check = 0; check < 2_000 && (errors.length === 0 || !readEngineV2PreviewState(config).autoUpgradeRetry); check++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(errors.length, 1, "the v2 startup was attempted");
      assert.equal(engine.status().chatRouting, true, "a failed attempt retains v2 after upstream migration may start");
    } finally { await engine.stop(); }
  });
});
