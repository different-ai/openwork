import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  acquireEngineHistoryLease, acquireHistoryCopyLock, HistoryCopyError, historyCopyTargetConsistent, parseProcessStart,
} from "../src/opencode-v2-history-lock.js";
import { migrateOpencodeV1History, releaseInterruptedHistoryCopy, type EngineV2MigrationStatus } from "../src/opencode-v2-migration.js";
import { engineStartErrorMessage } from "../src/engine-v2-preview.js";
import { numberField, openHistoryDatabase, stringField } from "../src/opencode-v2-history-store.js";
import {
  digest, disposableProfile, exitedPid, id, processAlive, spawnServeProcess, stageConvertedCopy, waitFor, writeV1History, writeV2History,
} from "./fixtures/v2-history-safety.js";

const PENDING = "history-copy.pending";
const LEGACY_FENCE = "History copy must finish before the engine opens this database.\n";

async function present(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function chats(database: string): Promise<string[]> {
  const db = await openHistoryDatabase(database);
  try { return db.prepare("SELECT title FROM session_v2 ORDER BY title").all().map(row => stringField(row, "title")); }
  finally { db.close(); }
}

async function count(database: string, sql: string): Promise<number> {
  const db = await openHistoryDatabase(database);
  try { return numberField(db.prepare(sql).get(), "n"); } finally { db.close(); }
}

test("ps start times parse as UTC", () => {
  assert.equal(parseProcessStart("Tue Oct  7 13:18:52 2026"), Date.UTC(2026, 9, 7, 13, 18, 52));
  assert.equal(parseProcessStart("not a time"), undefined);
});

test("a busy copy lock refuses before any fence is written", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ root, target }) => {
    await writeV2History(target, [{ id: "ses_a", title: "Existing v2 chat", messages: 2 }]);
    const first = await acquireHistoryCopyLock(target);
    try {
      await assert.rejects(acquireHistoryCopyLock(target), (error: unknown) => error instanceof HistoryCopyError && error.code === "history_copy_active");
      assert.equal(await present(join(root, PENDING)), false, "a refused copy leaves no fence");
    } finally { await first.release(); }
    // Nothing was fenced, so an engine opens the history immediately afterwards.
    const lease = await acquireEngineHistoryLease(root);
    await lease.release();
  });
});

test("an engine owned by a running OpenWork refuses the copy and is never stopped", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ root, target, engine }) => {
    await writeV2History(target, [{ id: "ses_a", title: "Existing v2 chat", messages: 2 }]);
    const serving = spawnServeProcess(engine);
    const otherOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const lease = await acquireEngineHistoryLease(root, { bin: engine });
      await lease.child(serving.pid);
      await assert.rejects(acquireHistoryCopyLock(target, { stopOrphanEngines: true }),
        (error: unknown) => error instanceof HistoryCopyError && error.code === "history_engine_active");
      await lease.release();
      // The same engine leased by another live OpenWork (e.g. a second installed app).
      await writeFile(join(root, "engine-lease-shared.json"), JSON.stringify({ pid: otherOwner.pid, child: serving.pid, recordedAt: Date.now(), bin: engine }));
      await assert.rejects(acquireHistoryCopyLock(target, { stopOrphanEngines: true }),
        (error: unknown) => error instanceof HistoryCopyError && error.code === "history_engine_active");
      assert.equal(processAlive(serving.pid), true, "a shared engine keeps running");
      assert.equal(processAlive(otherOwner.pid), true);
      assert.equal(await present(join(root, "engine-lease-shared.json")), true, "its lease is kept");
      assert.equal(await present(join(root, PENDING)), false, "nothing was fenced");
    } finally { serving.kill("SIGKILL"); otherOwner.kill("SIGKILL"); }
  });
});

test("an orphaned engine is stopped only after it is positively identified; reused pids are never signalled", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ root, target, engine }) => {
    await writeV2History(target, [{ id: "ses_a", title: "Existing v2 chat", messages: 2 }]);
    const deadOwner = await exitedPid();
    const orphan = spawnServeProcess(engine);
    const unrelated = spawn("sleep", ["300"], { stdio: "ignore" });
    const lateStarter = spawnServeProcess(engine);
    try {
      await waitFor(() => processAlive(orphan.pid) && processAlive(lateStarter.pid), 5_000, "test processes start");
      await new Promise(done => setTimeout(done, 300));
      const orphanLease = join(root, "engine-lease-orphan.json");
      await writeFile(orphanLease, JSON.stringify({ pid: deadOwner, child: orphan.pid, recordedAt: Date.now(), bin: engine }));
      // Without permission to stop orphans, the copy refuses and changes nothing.
      await assert.rejects(acquireHistoryCopyLock(target), (error: unknown) => error instanceof HistoryCopyError && error.code === "history_engine_active");
      assert.equal(processAlive(orphan.pid), true);
      // A pid now used by an unrelated program, and a lease older than the process now using its pid.
      const reused = join(root, "engine-lease-reused.json");
      await writeFile(reused, JSON.stringify({ pid: deadOwner, child: unrelated.pid, recordedAt: Date.now() }));
      const stale = join(root, "engine-lease-stale.json");
      await writeFile(stale, JSON.stringify({ pid: deadOwner, child: lateStarter.pid }));
      const hourAgo = new Date(Date.now() - 3_600_000);
      await utimes(stale, hourAgo, hourAgo);
      const lock = await acquireHistoryCopyLock(target, { stopOrphanEngines: true });
      await lock.release();
      await waitFor(() => !processAlive(orphan.pid), 8_000, "the identified orphan exits");
      assert.equal(processAlive(unrelated.pid), true, "an unrelated process reusing a pid is never signalled");
      assert.equal(processAlive(lateStarter.pid), true, "a process that started after its lease was written is never signalled");
      assert.deepEqual((await readdir(root)).filter(name => name.startsWith("engine-lease-")), [], "abandoned leases are removed");
      assert.equal(await present(join(root, PENDING)), false, "acquiring the lock does not fence the target");
    } finally { orphan.kill("SIGKILL"); unrelated.kill("SIGKILL"); lateStarter.kill("SIGKILL"); }
  });
});

test("a fence left by a copy that stopped before writing no longer locks out intact v2 history", { timeout: 60_000 }, async () => {
  // The interrupted state reported from the field: a copy published its fence,
  // then refused (a live engine left by an earlier OpenWork; too little disk)
  // and exited without removing it. Every start then failed with
  // "History migration is incomplete. Resume it before opening OpenCode v2."
  await disposableProfile(async ({ root, target, engine }) => {
    await writeV2History(target, [{ id: "ses_a", title: "Weeks of v2 work", messages: 40 }, { id: "ses_b", title: "Another v2 chat", messages: 3 }]);
    await writeFile(join(root, PENDING), LEGACY_FENCE);
    const deadOwner = await exitedPid();
    const orphan = spawnServeProcess(engine);
    try {
      await writeFile(join(root, "engine-lease-orphan.json"), JSON.stringify({ pid: deadOwner, child: orphan.pid }));
      const before = await digest(target);
      const lease = await acquireEngineHistoryLease(root, { bin: engine });
      await lease.release();
      assert.equal(await present(join(root, PENDING)), false, "the abandoned fence is lifted");
      assert.equal(await digest(target), before, "v2 history is not modified");
      assert.deepEqual(await chats(target), ["Another v2 chat", "Weeks of v2 work"]);
      assert.equal(processAlive(orphan.pid), true, "starting an engine never stops another process");
    } finally { orphan.kill("SIGKILL"); }
  });
});

test("an engine never opens while a copy is running, and the error suggests no binary override", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ root, target }) => {
    await writeV2History(target, [{ id: "ses_a", title: "Existing v2 chat", messages: 2 }]);
    const lock = await acquireHistoryCopyLock(target);
    await lock.beginTransfer();
    try {
      const error = await acquireEngineHistoryLease(root).then(() => undefined, (cause: unknown) => cause);
      assert.ok(error instanceof HistoryCopyError && error.code === "history_copy_active", String(error));
      assert.doesNotMatch(engineStartErrorMessage(error), /OPENWORK_OPENCODE2_BIN/);
      assert.equal(await present(join(root, PENDING)), true, "a running copy keeps its fence");
    } finally { await lock.release(); }
  });
});

test("a copy that dies mid-transfer resumes, or undoes only its unfinished chats", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ directory, root, target, storageDir, v1 }) => {
    await writeV2History(target, [{ id: "ses_existing", title: "Existing v2 chat", messages: 3 }]);
    const copied = [{ id: id("ses", 1), title: "Short v1 chat", messages: 2 }, { id: id("ses", 2), title: "Long v1 chat", messages: 150 }];
    await writeV1History(v1, directory, copied);
    await stageConvertedCopy({ storageDir, source: v1, target, chats: copied });
    const v1Before = await digest(v1);
    // Batches: the short chat's messages, its archived messages and parts (3),
    // then the long chat's first message batch: it dies with one chat complete
    // and one partly written.
    const worker = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/history-copy-crash-worker.ts", import.meta.url))], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const closed = new Promise<void>(done => worker.once("close", () => done()));
    try {
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error("The first batch did not commit")), 30_000);
        worker.once("message", () => { clearTimeout(timer); done(); });
        worker.once("exit", () => { clearTimeout(timer); fail(new Error("The worker exited early")); });
        worker.send({ source: v1, storageDir, targetDatabase: target, hangAfterBatches: 4 });
      });
    } finally { worker.kill("SIGKILL"); await closed; }
    assert.equal(await present(join(root, PENDING)), true, "process death mid-transfer keeps the fence");
    assert.equal(await historyCopyTargetConsistent(target), false);
    const blocked = await acquireEngineHistoryLease(root).then(() => undefined, (cause: unknown) => cause);
    assert.ok(blocked instanceof HistoryCopyError && blocked.code === "history_copy_interrupted", String(blocked));
    assert.match(engineStartErrorMessage(blocked), /History migration is incomplete/);
    assert.doesNotMatch(engineStartErrorMessage(blocked), /OPENWORK_OPENCODE2_BIN/, "an interrupted copy is not a binary problem");

    // When the copy cannot finish now, only its unfinished chat is removed.
    const released = await releaseInterruptedHistoryCopy({ targetDatabase: target });
    assert.equal(released.rolledBack, 1);
    assert.equal(await present(join(root, PENDING)), false);
    assert.deepEqual(await chats(target), ["Existing v2 chat", "Short v1 chat"], "existing and fully copied chats stay");
    assert.equal(await count(target, "SELECT count(*) AS n FROM session_message WHERE session_id = 'ses_existing'"), 3);
    const lease = await acquireEngineHistoryLease(root);
    await lease.release();

    // The saved stages remain, so the next copy resumes and completes.
    let status: EngineV2MigrationStatus | undefined;
    await migrateOpencodeV1History({ bin: "/unused-in-the-copying-stage", source: v1, storageDir, targetDatabase: target, progress: next => { status = next; } });
    assert.equal(status?.state, "completed", status?.error);
    assert.deepEqual(await chats(target), ["Existing v2 chat", "Long v1 chat", "Short v1 chat"]);
    assert.equal(await count(target, `SELECT count(*) AS n FROM session_message WHERE session_id = '${id("ses", 2)}'`), 150);
    assert.equal(await digest(v1), v1Before, "v1 history is only read");
  });
});

test("a failed copy undoes its unfinished chats and lifts its fence; a pause keeps both for resume", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ directory, root, target, storageDir, v1 }) => {
    await writeV2History(target, [{ id: "ses_existing", title: "Existing v2 chat", messages: 3 }]);
    const copied = [{ id: id("ses", 1), title: "Long v1 chat", messages: 150 }];
    await writeV1History(v1, directory, copied);
    await stageConvertedCopy({ storageDir, source: v1, target, chats: copied });
    let status: EngineV2MigrationStatus | undefined;
    await migrateOpencodeV1History({ bin: "/unused", source: v1, storageDir, targetDatabase: target, progress: next => { status = next; },
      batch: async () => { throw new Error("disk I/O error"); } });
    assert.equal(status?.state, "error");
    assert.equal(await present(join(root, PENDING)), false, "a failed copy lifts its own fence");
    assert.equal(await historyCopyTargetConsistent(target), true);
    assert.deepEqual(await chats(target), ["Existing v2 chat"]);

    const pause = new AbortController();
    await migrateOpencodeV1History({ bin: "/unused", source: v1, storageDir, targetDatabase: target, signal: pause.signal,
      progress: next => { status = next; }, batch: async () => { pause.abort(new Error("OpenWork is closing")); } });
    assert.equal(status?.state, "error");
    assert.equal(await present(join(root, PENDING)), true, "a pause keeps its fence for the next start");
    assert.equal(await historyCopyTargetConsistent(target), false);
    await migrateOpencodeV1History({ bin: "/unused", source: v1, storageDir, targetDatabase: target, progress: next => { status = next; } });
    assert.equal(status?.state, "completed", status?.error);
    assert.equal(status?.resumed, true);
    assert.equal(await present(join(root, PENDING)), false);
    assert.deepEqual(await chats(target), ["Existing v2 chat", "Long v1 chat"]);
  });
});

test("too little disk refuses the copy before anything is written", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ directory, root, target, storageDir, v1 }) => {
    await writeV2History(target, [{ id: "ses_existing", title: "Existing v2 chat", messages: 3 }]);
    await writeV1History(v1, directory, [{ id: id("ses", 1), title: "v1 chat", messages: 5 }]);
    const before = await digest(target);
    let status: EngineV2MigrationStatus | undefined;
    // The volume reports less room than the snapshot, workspace and backup need.
    await migrateOpencodeV1History({ bin: "/unused", source: v1, storageDir, targetDatabase: target, progress: next => { status = next; },
      freeBytes: async () => 0, backup: { database: target, directory: join(storageDir, "backups") } });
    assert.equal(status?.state, "error");
    assert.match(status?.error ?? "", /Not enough free disk space/);
    assert.equal(await present(join(root, PENDING)), false, "no fence");
    assert.equal(await present(join(storageDir, "history-copy", "checkpoint.json")), false, "no saved stage");
    assert.equal(await present(join(storageDir, "backups")), false, "no backup");
    assert.equal(await digest(target), before, "v2 history untouched");
    const lease = await acquireEngineHistoryLease(root);
    await lease.release();
  });
});

test("only engine executable failures suggest a binary override", () => {
  const spawnFailure = Object.assign(new Error("Failed to start OpenCode v2 server: spawn /missing/opencode2 ENOENT"), { code: "ENOENT" });
  assert.match(engineStartErrorMessage(spawnFailure), /OPENWORK_OPENCODE2_BIN/);
  assert.match(engineStartErrorMessage(new Error("OpenCode v2 server exited with code 1")), /OPENWORK_OPENCODE2_BIN/);
  for (const code of ["history_copy_active", "history_copy_interrupted", "history_engine_active", "history_engine_unverified"] as const) {
    assert.doesNotMatch(engineStartErrorMessage(new HistoryCopyError(code, "History migration is incomplete.")), /OPENWORK_OPENCODE2_BIN/);
  }
  assert.doesNotMatch(engineStartErrorMessage(new Error("Not enough free disk space to upgrade safely.")), /OPENWORK_OPENCODE2_BIN/);
});
