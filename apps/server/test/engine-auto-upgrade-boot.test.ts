import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState } from "../src/engine-v2-preview.js";
import { openHistoryDatabase } from "../src/opencode-v2-history-store.js";
import { enterEngineMutation } from "../src/engine-switch-fence.js";
import type { ServerConfig } from "../src/types.js";

async function profile(run: (config: ServerConfig, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "openwork-auto-upgrade-"));
  const overrides = {
    HOME: dir, USERPROFILE: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"), OPENWORK_RUNTIME_DB: join(dir, "runtime.sqlite"), OPENCODE_DB: join(dir, "v1.db"),
    OPENWORK_OPENCODE2_BIN: join(dir, "unavailable-opencode2"), OPENWORK_ENGINE_V2_PREVIEW: "",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
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
      assert.equal(engine.status().automaticRetryAt, persisted.autoUpgradeRetry?.retryAt);
      engine.start();
      engine.setForcePolicy({ upgrade: true });
      engine.setForcePolicy({ upgrade: true });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(errors.length, 1, "status reads and policy refreshes cannot retry in the same boot");
      assert.equal(engine.status().automaticRetryAt, persisted.autoUpgradeRetry?.retryAt);
    } finally { await engine.stop(); }
  });
});

test("policy off before idle prevents the future automatic process start", { skip: process.platform === "win32" }, async () => {
  await profile(async (config, dir) => {
    const binary = join(dir, "future-engine");
    writeFileSync(binary, '#!/bin/sh\nprintf "started\\n" >> "$0.attempts"\nexit 1\n', { mode: 0o700 });
    process.env.OPENWORK_OPENCODE2_BIN = binary;
    const idle = Promise.withResolvers<boolean>();
    let probed = false;
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: () => { probed = true; return idle.promise; } });
    try {
      assert.equal(probed, true, "witness: the automatic attempt is waiting for idle");
      engine.setForcePolicy({ upgrade: false });
      idle.resolve(true);
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(engine.status().enabled, false);
      assert.equal(existsSync(`${binary}.attempts`), false, "no future v2 process may start after policy off");
      assert.equal(engine.status().automaticRetryAt, undefined);
    } finally { await engine.stop(); }
  });
});

for (const reenabled of [false, true]) test(`policy off during the final fenced idle read prevents automatic cutover (re-enabled: ${reenabled})`, { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  await profile(async (config, dir) => {
    const binary = join(dir, "healthy-engine.mjs");
    // A real child and loopback metadata API exercise shipping startup/health;
    // no engine binary install, model request or history mutation is needed.
    writeFileSync(binary, `#!/usr/bin/env node\nimport { createServer } from 'node:http';
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(request.url?.startsWith('/api/info') ? { version: 'test', pid: process.pid } : { data: [] }));
});
server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
`, { mode: 0o700 });
    process.env.OPENWORK_OPENCODE2_BIN = binary;
    const finalIdle = Promise.withResolvers<boolean>();
    let probes = 0;
    let finalProbed = false;
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => {
      if (++probes !== 2) return true;
      finalProbed = true;
      return finalIdle.promise;
    } });
    try {
      const deadline = Date.now() + 10_000;
      while (!finalProbed && !engine.status().lastError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(finalProbed, true, JSON.stringify(engine.status()));
      assert.equal(engine.status().running, true, "witness: healthy v2 has started, but the final fenced idle read is held");
      assert.equal(engine.status().chatRouting, false);
      const acknowledged = engine.setForcePolicy({ upgrade: false });
      assert.equal(acknowledged.chatRouting, false, "policy off is acknowledged before the final read resolves");
      if (reenabled) engine.setForcePolicy({ upgrade: true });
      const waitingV1 = enterEngineMutation(config, "v1");
      finalIdle.resolve(true);
      const release = await waitingV1;
      await release();
      assert.equal(engine.status().chatRouting, false, "the obsolete attempt must not select v2 after off acknowledgement, even after off/on");
      assert.equal(readEngineV2PreviewState(config).chatRouting, false);
      assert.equal(engine.status().automaticRetryAt, undefined, "policy invalidation does not manufacture or reset a failure cooldown");
      engine.setForcePolicy({ upgrade: false });
      await engine.setChatRouting(true);
      assert.equal(engine.status().chatRouting, true, "an explicit manual selection remains usable with automatic policy off");
      assert.equal(readEngineV2PreviewState(config).engineOrigin, "manual");
      engine.setForcePolicy({ upgrade: false });
      assert.equal(engine.status().chatRouting, true, "off must also preserve the now-used manual v2 selection");
    } finally { finalIdle.resolve(true); await engine.stop(); }
  });
});

test("policy off does not restart a failed sidecar, but explicit manual recovery can", { skip: process.platform === "win32" }, async () => {
  await profile(async (config, dir) => {
    const binary = join(dir, "failed-engine");
    const counter = `${binary}.attempts`;
    writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "serve" ]; then printf "started\\n" >> "$0.attempts"; fi\nexit 1\n', { mode: 0o700 });
    process.env.OPENWORK_OPENCODE2_BIN = binary;
    const starts = () => readFileSync(counter, "utf8").trim().split("\n").length;
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => true });
    try {
      const deadline = Date.now() + 10_000;
      while (readEngineV2PreviewState(config).autoUpgradeRetry === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(starts(), 1, "witness: the automatic attempt actually spawned a failing process");
      const retryAt = engine.status().automaticRetryAt;
      assert.ok(retryAt);
      for (let turn = 0; turn < 2; turn++) {
        engine.setForcePolicy({ upgrade: false });
        engine.start();
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(starts(), 1, "off/status/boot refreshes must not bypass the failed attempt's cooldown");
      }
      engine.setForcePolicy({ upgrade: true });
      engine.setForcePolicy({ upgrade: false });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(starts(), 1, "off/on cannot revive the failed attempt or create another automatic process");
      assert.equal(engine.status().automaticRetryAt, retryAt, "policy epochs must retain the existing failed-start cooldown");
      assert.equal(engine.migrateHistory().migration.state, "running", "explicit manual consent is not an automatic retry");
      const manualDeadline = Date.now() + 10_000;
      while ((engine.status().migration.state === "running" || starts() < 2) && Date.now() < manualDeadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(starts(), 2, "one explicit manual action spawns exactly one new attempt");
      assert.equal(engine.status().automaticRetryAt, undefined);
      assert.equal(engine.status().forceUpgradePending, false);
      engine.setForcePolicy({ upgrade: false });
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(starts(), 2, "the failed manual attempt is not restarted by policy observation either");
      assert.equal(engine.status().chatRouting, false);
    } finally { await engine.stop(); }
  });
});

test("a failed automatic attempt cannot undo a concurrent manual v2 choice", async () => {
  await profile(async (config, dir) => {
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: false,
      automaticHistoryCopy: true, automaticHistoryRevision: "completed-automatic-snapshot" }));
    const idle = Promise.withResolvers<boolean>();
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: () => idle.promise });
    try {
      await engine.setEnabled(true);
      await engine.setChatRouting(true);
      idle.reject(new Error("Could not verify the old engine's activity"));
      await engine.stop();
      assert.equal(engine.status().migration.state, "idle", "an obsolete attempt cannot publish a new failure over the manual choice");
      assert.equal(engine.status().automaticRetryAt, undefined);
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().engineOrigin, "manual");
      assert.equal(engine.status().engineForced, false);
      const saved = readEngineV2PreviewState(config);
      assert.equal(saved.chatRouting, true);
      assert.equal(saved.automaticHistoryCopy, undefined, "manual v2 history must not remain fenced on a later boot");
      assert.equal(saved.automaticHistoryRevision, undefined, "a later attempt must not restore an old target over manual v2 history");
    } finally { await engine.stop(); }
  });
});

test("concurrent manual choices journal in order without losing an accepted write", async () => {
  await profile(async config => {
    config.engineAutoUpgrade = false;
    const engine = createEngineV2Preview({ config, deferStart: true });
    try {
      const choices = await Promise.all(Array.from({ length: 12 }, (_, index) => engine.setChatRouting(index % 2 === 0)));
      assert.equal(choices.length, 12);
      assert.equal(readEngineV2PreviewState(config).chatRouting, engine.status().chatRouting);
      assert.equal(readEngineV2PreviewState(config).engineOrigin, "manual");
    } finally { await engine.stop(); }
  });
});

test("an unfinished saved copy must be recovered before a manual v2 selection is accepted", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: false,
      automaticHistoryCopy: true, v1HistoryCopyStartedAt: 1,
      historyCopyResult: { state: "error", error: "Copy paused", imported: 1, skipped: 0, total: 2 },
    }));
    const engine = createEngineV2Preview({ config, deferStart: true });
    try {
      await assert.rejects(engine.setChatRouting(true), { status: 409, code: "engine_migration_required" });
      assert.equal(engine.status().chatRouting, false);
      assert.equal(readEngineV2PreviewState(config).v1HistoryCopyStartedAt, 1);
    } finally { await engine.stop(); }
  });
});

test("an automatic upgrade waiting for idle cannot be duplicated by an interactive migration", async () => {
  await profile(async config => {
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => false });
    try {
      assert.equal(engine.status().migration.state, "idle");
      assert.throws(() => engine.migrateHistory(), { status: 409, code: "engine_upgrade_host_managed" });
      assert.equal(engine.status().chatRouting, false);
    } finally { await engine.stop(); }
  });
});

test("interactive migration errors still allow an explicit retry without automatic ownership", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    writeFileSync(join(dir, "v1.db"), "isolated source");
    const engine = createEngineV2Preview({ config, deferStart: true });
    try {
      assert.equal(engine.migrateHistory().migration.state, "running");
      for (let check = 0; check < 100 && engine.status().migration.state === "running"; check++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(engine.status().migration.state, "error");
      assert.equal(engine.status().automaticRetryAt, undefined);
      assert.equal(engine.migrateHistory().migration.state, "running", "manual recovery remains explicit and usable");
    } finally { await engine.stop(); }
  });
});

test("manual consent can recover a durable automatic failure with policy off and retain its backup receipt", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    config.engineForcePolicy = true;
    const backupPath = join(dir, "retained-backup.db");
    writeFileSync(backupPath, "retained backup bytes");
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: false,
      automaticHistoryCopy: true, automaticHistoryRevision: "saved-source-revision",
      autoUpgradeRetry: { attempts: 2, retryAt: Date.now() + 60_000 },
      historyCopyResult: { state: "error", error: "Automatic attempt paused", imported: 0, skipped: 0, total: 1, backupPath },
    }));
    const engine = createEngineV2Preview({ config });
    try {
      assert.equal(engine.migrateHistory().migration.state, "running");
      const deadline = Date.now() + 10_000;
      while (engine.status().migration.state === "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(engine.status().migration.state, "error", "the unavailable fixture binary still reports a real manual failure");
      assert.equal(engine.status().automaticRetryAt, undefined);
      assert.equal(engine.status().forceUpgradePending, false);
      assert.equal(engine.status().migration.backupPath, backupPath);
      assert.equal(readFileSync(backupPath, "utf8"), "retained backup bytes");
    } finally { await engine.stop(); }
    const saved = readEngineV2PreviewState(config);
    assert.equal(saved.automaticHistoryCopy, undefined);
    assert.equal(saved.automaticHistoryRevision, undefined);
    assert.equal(saved.autoUpgradeRetry, undefined);
    assert.equal(saved.historyCopyResult?.backupPath, backupPath);
  });
});

test("a stale saved automatic copy never restores an older backup over newer v2 history", async () => {
  await profile(async (config, dir) => {
    const source = await openHistoryDatabase(join(dir, "v1.db"));
    source.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, data TEXT);
      INSERT INTO session VALUES ('v1-current', 'New v1 work', '/', NULL, 0);`);
    source.close();
    const target = join(dir, "opencode-v2", "state", "opencode.db");
    const backupPath = join(dir, "old-baseline.db");
    mkdirSync(join(dir, "opencode-v2", "state"), { recursive: true });
    const histories: Array<[string, string]> = [[target, "newer v2 reply"], [backupPath, "before the v2 reply"]];
    for (const [path, text] of histories) {
      const db = await openHistoryDatabase(path);
      db.exec("CREATE TABLE history (text TEXT)");
      db.prepare("INSERT INTO history VALUES (?)").run(text);
      db.close();
    }
    const before = readFileSync(target);
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: false,
      automaticHistoryCopy: true, automaticHistoryRevision: "older-source-revision", v1HistoryCopiedAt: 1,
      historyCopyResult: { state: "error", error: "Source advanced", imported: 1, skipped: 0, total: 1,
        startedAt: new Date(1).toISOString(), backupPath },
    }));
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => true });
    try {
      const deadline = Date.now() + 10_000;
      while (readEngineV2PreviewState(config).autoUpgradeRetry === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.match(engine.status().migration.error ?? "", /v2 history was kept unchanged/);
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().running, false);
      assert.deepEqual(readFileSync(target), before, "an older backup is not authority to replace newer v2 history");
      assert.equal(engine.status().migration.backupPath, backupPath, "the backup remains available for explicit recovery");
      assert.equal(readEngineV2PreviewState(config).historyCopyResult?.startedAt, new Date(1).toISOString());
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

test("flag off preserves a forced v2 selection across boot and repeated policy writes", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    config.engineForcePolicy = true;
    const state = { enabled: true, chatRouting: true, engineOrigin: "forced", engineForced: true };
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify(state));
    const engine = createEngineV2Preview({ config, deferStart: true });
    try {
      engine.setForcePolicy({ upgrade: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, true, "v2-only history must remain on the selected engine");
      assert.equal(engine.status().engineOrigin, "forced");
      assert.equal(engine.status().engineForced, true);
      engine.setForcePolicy({ upgrade: false });
      assert.equal(engine.status().chatRouting, true);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "engine-v2-preview.json"), "utf8")), state);
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

test("flag off never attempts an upgrade for a v1 profile", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    config.engineForcePolicy = true;
    writeFileSync(join(dir, "v1.db"), "unreadable history must not be opened with policy off");
    let probed = false;
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => { probed = true; return true; } });
    try {
      engine.setForcePolicy({ upgrade: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(probed, false);
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().migration.state, "idle");
      assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry, undefined);
    } finally { await engine.stop(); }
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
