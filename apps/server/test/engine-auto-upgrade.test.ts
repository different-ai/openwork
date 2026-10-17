import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHistoryDatabase } from "../src/opencode-v2-history-store.js";
import { engineAutoUpgradeRetry, historyRevision, runEngineAutoUpgrade } from "../src/engine-auto-upgrade.js";

function fixture() {
  const calls: string[] = [];
  const controller = new AbortController();
  return {
    calls, controller,
    options: {
      signal: controller.signal,
      idle: async () => true,
      revision: async () => "unchanged",
      copy: async () => { calls.push("copy"); },
      switchEngine: async () => { calls.push("switch"); },
      wait: async () => { calls.push("wait"); },
      idleChecks: 3,
    },
  };
}

test("automatic upgrade copies through the existing migration before switching", async () => {
  const { calls, options } = fixture();
  await runEngineAutoUpgrade(options);
  assert.deepEqual(calls, ["copy", "switch"]);
});

test("running or unknown tasks wait for idle without being interrupted", async () => {
  const { calls, options } = fixture();
  let checks = 0;
  await runEngineAutoUpgrade({ ...options, idle: async () => ++checks > 2 });
  assert.deepEqual(calls, ["wait", "wait", "copy", "switch"]);
});

test("an engine that never becomes idle is left on v1 with no copy", async () => {
  const { calls, options } = fixture();
  await assert.rejects(runEngineAutoUpgrade({ ...options, idle: async () => false }), /not idle/);
  assert.deepEqual(calls, ["wait", "wait", "wait"]);
});

test("a failed copy never switches and is not retried in the same boot", async () => {
  const { calls, options } = fixture();
  await assert.rejects(runEngineAutoUpgrade({ ...options, copy: async () => {
    calls.push("copy"); throw new Error("copy failed");
  } }), /copy failed/);
  assert.deepEqual(calls, ["copy"]);
});

test("v1 stays selected when a task starts during the background copy", async () => {
  const { calls, options } = fixture();
  let checks = 0;
  await assert.rejects(runEngineAutoUpgrade({ ...options, idle: async () => ++checks === 1 }), /v1 changed/);
  assert.deepEqual(calls, ["copy"]);
});

test("v1 stays selected when history changes during the background copy", async () => {
  const { calls, options } = fixture();
  let revision = 0;
  await assert.rejects(runEngineAutoUpgrade({ ...options, revision: async () => String(++revision) }), /v1 changed/);
  assert.deepEqual(calls, ["copy"]);
});

test("shutdown during copy never switches engines", async () => {
  const { calls, options, controller } = fixture();
  await assert.rejects(runEngineAutoUpgrade({ ...options, copy: async () => {
    calls.push("copy"); controller.abort(new Error("shutdown"));
  } }), /shutdown/);
  assert.deepEqual(calls, ["copy"]);
});

test("history revision ignores project probes but detects changed chat content, including the WAL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openwork-history-revision-"));
  const file = join(dir, "source.db");
  const db = await openHistoryDatabase(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE project (id TEXT, time_updated INTEGER);
      CREATE TABLE session (id TEXT, title TEXT);
      CREATE TABLE message (id TEXT, data TEXT);
      CREATE TABLE part (id TEXT, data TEXT);
      INSERT INTO project VALUES ('project', 1);
      INSERT INTO session VALUES ('chat', 'Preserved chat');
      INSERT INTO message VALUES ('message', 'hello');`);
    const before = await historyRevision(file);
    db.exec("UPDATE project SET time_updated = 2");
    assert.equal(await historyRevision(file), before, "engine upkeep is not a chat mutation");
    db.exec("UPDATE message SET data = 'world'");
    assert.notEqual(await historyRevision(file), before, "same-size payload edits are detected");
    const changed = await historyRevision(file);
    db.exec("INSERT INTO part VALUES ('part', 'new part')");
    assert.notEqual(await historyRevision(file), changed);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failed boots use durable exponential backoff bounded at one day", () => {
  assert.deepEqual(engineAutoUpgradeRetry(0, 1_000), { attempts: 1, retryAt: 61_000 });
  assert.deepEqual(engineAutoUpgradeRetry(1, 1_000), { attempts: 2, retryAt: 121_000 });
  assert.deepEqual(engineAutoUpgradeRetry(31, 1_000), { attempts: 32, retryAt: 86_401_000 });
  assert.deepEqual(engineAutoUpgradeRetry(32, 1_000), { attempts: 32, retryAt: 86_401_000 });
});
