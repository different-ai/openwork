// Reproductions of the reported v2 history lockout and downgrade failures.
// Uses only APIs that exist before the fix, so the same file fails on the
// previous dev and passes with the fix. Disposable profiles only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState, type EngineV2Preview } from "../src/engine-v2-preview.js";
import { acquireEngineHistoryLease, acquireHistoryCopyLock } from "../src/opencode-v2-history-lock.js";
import { migrateOpencodeV1History, type EngineV2MigrationStatus } from "../src/opencode-v2-migration.js";
import { disposableProfile, exitedPid, id, spawnServeProcess, waitFor, writeV1History, writeV2History } from "./fixtures/v2-history-safety.js";

const PENDING = "history-copy.pending";
const LEGACY_FENCE = "History copy must finish before the engine opens this database.\n";
const V2_USER = { enabled: true, chatRouting: true, engineOrigin: "manual", engineChangedAt: "2026-10-01T00:00:00.000Z" };

async function present(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function startOutcome(engine: EngineV2Preview): Promise<{ running: boolean; lastError?: string }> {
  await waitFor(() => engine.status().running || Boolean(engine.status().lastError), 15_000, "v2 starts or reports an error").catch(() => undefined);
  return { running: engine.status().running, lastError: engine.status().lastError };
}

test("repro: a stale fence plus an orphaned engine locks a long-time v2 user out", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ config, engine, root, target, statePath }) => {
    await writeV2History(target, [{ id: "ses_a", title: "Weeks of v2 work", messages: 20 }]);
    await writeFile(join(root, PENDING), LEGACY_FENCE);
    const orphan = spawnServeProcess(engine);
    await writeFile(join(root, "engine-lease-orphan.json"), JSON.stringify({ pid: await exitedPid(), child: orphan.pid }));
    await writeFile(statePath, JSON.stringify(V2_USER));
    const preview = createEngineV2Preview({ config });
    try {
      const outcome = await startOutcome(preview);
      assert.equal(outcome.running, true, `v2 must open its intact history; got: ${outcome.lastError}`);
      assert.equal(preview.status().chatRouting, true);
    } finally { await preview.stop(); orphan.kill("SIGKILL"); }
  });
});

test("repro: a copy refused by a running engine must not leave a fence behind", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ directory, engine, root, target, storageDir, v1 }) => {
    await writeV2History(target, [{ id: "ses_a", title: "Existing v2 chat", messages: 2 }]);
    await writeV1History(v1, directory, [{ id: id("ses", 1), title: "v1 chat", messages: 2 }]);
    const serving = spawnServeProcess(engine);
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      // Another running OpenWork (for example a second installed build) has v2 open.
      await writeFile(join(root, "engine-lease-shared.json"), JSON.stringify({ pid: owner.pid, child: serving.pid, recordedAt: Date.now(), bin: engine }));
      let status: EngineV2MigrationStatus | undefined;
      await migrateOpencodeV1History({ bin: engine, source: v1, storageDir, targetDatabase: target, progress: next => { status = next; } });
      assert.equal(status?.state, "error");
      assert.equal(await present(join(root, PENDING)), false, "a refused copy must leave no fence");
      const lease = await acquireEngineHistoryLease(root);
      await lease.release();
    } finally { serving.kill("SIGKILL"); owner.kill("SIGKILL"); }
  });
});

test("repro: an engine waiting on a running copy is not told to replace its binary", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ config, target, statePath }) => {
    await writeV2History(target, [{ id: "ses_a", title: "Existing v2 chat", messages: 2 }]);
    await writeFile(statePath, JSON.stringify(V2_USER));
    const copy = await acquireHistoryCopyLock(target);
    const preview = createEngineV2Preview({ config });
    try {
      const outcome = await startOutcome(preview);
      assert.equal(outcome.running, false);
      assert.doesNotMatch(outcome.lastError ?? "", /OPENWORK_OPENCODE2_BIN/, "a history copy is not a binary problem");
    } finally { await copy.release(); await preview.stop(); }
  });
});

test("repro: state saved by the v2-only build is read as v2, not v1", async () => {
  await disposableProfile(async ({ config, statePath }) => {
    await writeFile(statePath, JSON.stringify({ v1HistoryCopiedAt: 1_700_000_000_000,
      historyCopyResult: { state: "completed", imported: 3, skipped: 0, total: 3 } }));
    const state = readEngineV2PreviewState(config);
    assert.equal(state.enabled, true, "v2-only state must keep v2 enabled");
    assert.equal(state.chatRouting, true, "v2-only state must keep chats on v2");
  });
});

test("repro: a leftover automatic-copy marker must not keep a v2 user's engine stopped", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ config, target, statePath }) => {
    await writeV2History(target, [{ id: "ses_a", title: "Existing v2 chat", messages: 2 }]);
    await writeFile(statePath, JSON.stringify({ ...V2_USER, automaticHistoryCopy: true, automaticHistoryRevision: "earlier" }));
    const preview = createEngineV2Preview({ config });
    try {
      const outcome = await startOutcome(preview);
      assert.equal(outcome.running, true, `v2 must start; got: ${outcome.lastError ?? "nothing started"}`);
    } finally { await preview.stop(); }
  });
});
