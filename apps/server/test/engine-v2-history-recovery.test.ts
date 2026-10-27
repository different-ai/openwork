import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState, type EngineV2Preview } from "../src/engine-v2-preview.js";
import { ApiError } from "../src/errors.js";
import { createManagedOpencodeV2Server, fetchOpencodeV2Json } from "../src/managed-opencode-v2.js";
import { numberField, openHistoryDatabase } from "../src/opencode-v2-history-store.js";
import { digest, disposableProfile, exitedPid, id, processAlive, spawnServeProcess, stageConvertedCopy, waitFor, writeV1History, writeV2History } from "./fixtures/v2-history-safety.js";

const PENDING = "history-copy.pending";
const LEGACY_FENCE = "History copy must finish before the engine opens this database.\n";
const LOW_DISK = async () => 0;

async function present(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Engine selection as the latest published build (v0.18.63) reads it:
 * readEngineV2PreviewState treats a file without a boolean `enabled` as v1,
 * and startWhenReady resumes a saved copy or skips v2 mid automatic copy.
 */
function olderBuildServesV2(raw: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const enabled: unknown = Reflect.get(parsed, "enabled");
  const chatRouting: unknown = Reflect.get(parsed, "chatRouting");
  if (typeof enabled !== "boolean" || (chatRouting !== undefined && typeof chatRouting !== "boolean")) return false;
  const automaticHistoryCopy = Reflect.get(parsed, "automaticHistoryCopy") === true;
  const resuming = typeof Reflect.get(parsed, "v1HistoryCopyStartedAt") === "number" && !automaticHistoryCopy;
  return enabled && chatRouting === true && !resuming && !automaticHistoryCopy && Reflect.get(parsed, "engineOrigin") !== "reverted";
}

/** Read the chats the running engine itself serves from its database. */
async function servedChats(engine: EngineV2Preview): Promise<string[]> {
  const connection = engine.connection();
  assert.ok(connection, "v2 serves chats");
  const response = await fetch(`${connection.url}/api/session`, {
    headers: { Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}` },
  });
  const body: unknown = await response.json();
  const data = typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data) ? body.data : [];
  return data.map((row: unknown) => typeof row === "object" && row !== null && "title" in row && typeof row.title === "string" ? row.title : "").sort();
}

async function messageCount(database: string): Promise<number> {
  const db = await openHistoryDatabase(database);
  try { return numberField(db.prepare("SELECT count(*) AS n FROM session_message").get(), "n"); } finally { db.close(); }
}

async function settled(engine: EngineV2Preview, label: string): Promise<void> {
  await waitFor(() => engine.status().migration.state !== "running" && (engine.status().running || Boolean(engine.status().lastError)), 20_000, label);
}

const V2_USER = { enabled: true, chatRouting: true, engineOrigin: "manual", engineChangedAt: "2026-10-01T00:00:00.000Z", engineForced: false };

test("the reported interrupted state on start: stale fence, orphaned engine, weeks of v2 chats", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ directory, config, engine, root, target, v1, statePath }) => {
    await writeV2History(target, [{ id: "ses_a", title: "Weeks of v2 work", messages: 40 }, { id: "ses_b", title: "Another v2 chat", messages: 3 }]);
    await writeV1History(v1, directory, [{ id: id("ses", 9), title: "Old v1 chat", messages: 3 }]);
    await writeFile(join(root, PENDING), LEGACY_FENCE);
    const orphan = spawnServeProcess(engine);
    await writeFile(join(root, "engine-lease-orphan.json"), JSON.stringify({ pid: await exitedPid(), child: orphan.pid }));
    await writeFile(statePath, JSON.stringify(V2_USER));
    const preview = createEngineV2Preview({ config, historyCopyFreeBytes: LOW_DISK });
    try {
      await settled(preview, "v2 starts");
      const status = preview.status();
      assert.equal(status.running, true, status.lastError);
      assert.equal(status.chatRouting, true);
      assert.deepEqual(await servedChats(preview), ["Another v2 chat", "Weeks of v2 work"], "the engine serves the existing v2 history");
      assert.equal(await present(join(root, PENDING)), false);
      assert.equal(processAlive(orphan.pid), true, "starting v2 does not stop other processes");

      // Copying earlier chats on a full disk is refused before v2 stops.
      const pid = status.pid;
      preview.migrateHistory();
      await settled(preview, "the refused copy settles");
      const after = preview.status();
      assert.equal(after.migration.state, "error");
      assert.match(after.migration.error ?? "", /Not enough free disk space/);
      assert.equal(after.running, true);
      assert.equal(after.pid, pid, "v2 kept running: the refusal came before it stopped");
      assert.doesNotMatch(after.lastError ?? "", /OPENWORK_OPENCODE2_BIN/);
      assert.equal(await present(join(root, PENDING)), false);
      assert.equal(await messageCount(target), 43, "v2 history is not modified");
    } finally { await preview.stop(); orphan.kill("SIGKILL"); }
    const saved = await readFile(statePath, "utf8");
    assert.equal(olderBuildServesV2(saved), true, `an older build still selects v2: ${saved}`);
    assert.equal(readEngineV2PreviewState(config).v1HistoryCopyStartedAt, undefined);
  });
});

test("state saved by the v2-only build keeps v2 selected here and in older builds after a failed resume", { timeout: 60_000 }, async () => {
  // Upgrade to the reverted v2-only build, which saved no engine selection and
  // left a copy marked as started, then run this build on a nearly full disk.
  await disposableProfile(async ({ directory, config, root, target, v1, statePath }) => {
    await writeV2History(target, [{ id: "ses_a", title: "Weeks of v2 work", messages: 10 }]);
    await writeV1History(v1, directory, [{ id: id("ses", 9), title: "Old v1 chat", messages: 3 }]);
    await writeFile(join(root, PENDING), LEGACY_FENCE);
    const v2OnlyBuildState = JSON.stringify({ v1HistoryCopyStartedAt: 1_700_000_000_000,
      historyCopyResult: { state: "error", imported: 0, skipped: 0, total: 1, error: "Not enough free disk space to upgrade safely." },
      autoUpgradeRetry: { attempts: 1, retryAt: 0 } });
    assert.equal(olderBuildServesV2(v2OnlyBuildState), false, "regression being fixed: older readers route this file to v1");
    await writeFile(statePath, v2OnlyBuildState);
    assert.equal(readEngineV2PreviewState(config).chatRouting, true, "this build reads a v2-only file as v2");
    const preview = createEngineV2Preview({ config, historyCopyFreeBytes: LOW_DISK });
    try {
      await waitFor(() => preview.status().running, 20_000, "v2 starts after the resume is refused");
      assert.equal(preview.status().chatRouting, true);
      assert.match(preview.status().migration.error ?? "", /Not enough free disk space/);
      assert.deepEqual(await servedChats(preview), ["Weeks of v2 work"]);
    } finally { await preview.stop(); }
    const saved = await readFile(statePath, "utf8");
    assert.equal(olderBuildServesV2(saved), true, `downgrading still selects v2: ${saved}`);
    assert.equal(await present(join(root, PENDING)), false, "no fence an older build would block on");
  });
});

test("a copy paused mid-transfer resumes on the next start and then serves every chat", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ directory, config, root, target, storageDir, v1, statePath }) => {
    await writeV2History(target, [{ id: "ses_existing", title: "Existing v2 chat", messages: 2 }]);
    const copied = [{ id: id("ses", 1), title: "Copied v1 chat", messages: 70 }];
    await writeV1History(v1, directory, copied);
    await stageConvertedCopy({ storageDir, source: v1, target, chats: copied });
    await writeFile(join(root, PENDING), JSON.stringify({ version: 2, token: "earlier-run", pid: await exitedPid(), createdAt: 1 }));
    await writeFile(statePath, JSON.stringify({ ...V2_USER, v1HistoryCopyStartedAt: 1_000 }));
    const preview = createEngineV2Preview({ config });
    try {
      assert.equal(preview.status().migration.resumed, true);
      assert.equal(preview.connection(), undefined, "nothing is served from a fenced history");
      await waitFor(() => preview.status().migration.state === "completed" && preview.status().running, 20_000, "the resumed copy completes and v2 starts");
      assert.deepEqual(await servedChats(preview), ["Copied v1 chat", "Existing v2 chat"]);
      assert.equal(await present(join(root, PENDING)), false);
    } finally { await preview.stop(); }
    assert.equal(olderBuildServesV2(await readFile(statePath, "utf8")), true);
  });
});

test("an engine start that finds an interrupted copy resumes it once, then serves v2", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ directory, config, root, target, storageDir, v1, statePath }) => {
    await writeV2History(target, [{ id: "ses_existing", title: "Existing v2 chat", messages: 2 }]);
    const copied = [{ id: id("ses", 1), title: "Copied v1 chat", messages: 3 }];
    await writeV1History(v1, directory, copied);
    await stageConvertedCopy({ storageDir, source: v1, target, chats: copied });
    // A partly written chat and a fence, but no saved start marker (an older build crashed).
    const db = await openHistoryDatabase(target);
    try {
      db.exec(`CREATE TABLE openwork_history_copy (source_key TEXT, session_id TEXT, cursor INTEGER NOT NULL DEFAULT -1,
        completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source_key, session_id))`);
      db.prepare("INSERT INTO session_v2 (id, project_id, title, time_created) VALUES (?, 'global', 'Copied v1 chat', 1)").run(id("ses", 1));
      db.prepare("INSERT INTO openwork_history_copy (source_key, session_id, cursor) VALUES ('earlier', ?, -1)").run(id("ses", 1));
    } finally { db.close(); }
    await writeFile(join(root, PENDING), LEGACY_FENCE);
    await writeFile(statePath, JSON.stringify(V2_USER));
    const preview = createEngineV2Preview({ config });
    try {
      await waitFor(() => preview.status().running && preview.status().migration.state !== "running", 20_000, "recovery finishes and v2 starts");
      assert.equal(preview.status().migration.state, "completed", preview.status().migration.error);
      assert.deepEqual(await servedChats(preview), ["Copied v1 chat", "Existing v2 chat"]);
      assert.equal(await present(join(root, PENDING)), false);
    } finally { await preview.stop(); }
  });
});

test("v2-only rollout: a fresh install runs v2, refuses v1, and turning it off changes nothing", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ config, statePath }) => {
    const preview = createEngineV2Preview({ config, autoUpgradeIdle: async () => true, deferStart: true });
    try {
      await preview.setV2Only(true);
      await waitFor(() => preview.status().running && preview.status().chatRouting, 20_000, "v2 selected and running");
      assert.equal(preview.status().v2Only, true);
      await assert.rejects(preview.setChatRouting(false), (error: unknown) => error instanceof ApiError && error.code === "engine_v2_only");
      await assert.rejects(preview.setEnabled(false), (error: unknown) => error instanceof ApiError && error.code === "engine_v2_only");
      assert.equal(olderBuildServesV2(await readFile(statePath, "utf8")), true);
      await preview.setV2Only(false);
      assert.equal(preview.status().v2Only, false);
      assert.equal(preview.status().chatRouting, true, "a rollback never moves chats back to v1");
      assert.equal(preview.status().running, true);
    } finally { await preview.stop(); }
    assert.equal(olderBuildServesV2(await readFile(statePath, "utf8")), true);
  });
});

test("v2-only rollout: a v1 profile moves to v2 at once and a refused copy never strands it on v1", { timeout: 60_000 }, async () => {
  await disposableProfile(async ({ directory, config, root, v1, statePath }) => {
    await writeV1History(v1, directory, [{ id: id("ses", 1), title: "v1 chat", messages: 3 }]);
    await writeFile(statePath, JSON.stringify({ enabled: false, chatRouting: false, engineOrigin: "manual", engineChangedAt: "2026-10-01T00:00:00.000Z" }));
    const v1Before = await digest(v1);
    let idle = false;
    const preview = createEngineV2Preview({ config, autoUpgradeIdle: async () => idle, historyCopyFreeBytes: LOW_DISK, deferStart: true });
    try {
      await preview.setV2Only(true);
      await new Promise(done => setTimeout(done, 100));
      assert.equal(preview.status().chatRouting, false, "running v1 work is never stranded");
      await preview.setV2Only(false);
      idle = true;
      await preview.setV2Only(true);
      await waitFor(() => preview.status().running && preview.status().chatRouting && preview.status().migration.state === "error", 20_000, "v2 selected; copy refused");
      assert.match(preview.status().migration.error ?? "", /Not enough free disk space/);
      assert.equal(preview.status().engineOrigin, "forced");
      assert.equal(await present(join(root, PENDING)), false);
      assert.ok(readEngineV2PreviewState(config).autoUpgradeRetry, "the refused copy backs off");
      assert.match(await preview.describeUncopiedChat(id("ses", 1)) ?? "", /hasn't been copied yet/);
      await preview.setV2Only(false);
      assert.equal(preview.status().chatRouting, true, "turning the rollout off keeps v2");
    } finally { await preview.stop(); }
    assert.equal(await digest(v1), v1Before, "v1 history is never written");
    assert.equal(olderBuildServesV2(await readFile(statePath, "utf8")), true);
  });
});

const nativeBinary = process.env.OPENWORK_NATIVE_OPENCODE2_BIN ?? process.env.OPENWORK_OPENCODE2_BIN_FOR_RECOVERY;

/**
 * Same field state against the pinned native engine: a real v2 database with
 * a person's chat, a real orphaned `opencode2 serve` holding it, a stale
 * fence, and real v1 history. Skips without a binary (CI has none).
 */
test("native engine: stale fence and a real orphaned engine recover, then earlier chats copy in", { skip: !nativeBinary, timeout: 240_000 }, async () => {
  if (!nativeBinary) return;
  await disposableProfile(async ({ directory, config, root, target, v1, statePath }) => {
    process.env.OPENWORK_OPENCODE2_BIN = nativeBinary;
    const engineEnv = { OPENCODE_DISABLE_MODELS_FETCH: "1", HOME: directory };
    const v2Chat = id("ses", 101);
    const seed = await createManagedOpencodeV2Server({ bin: nativeBinary, rootDir: root, env: engineEnv });
    try {
      const created = await seed.fetchJson("/api/session", { method: "POST", directory, body: { id: v2Chat, title: "Weeks of v2 work", location: { directory } } });
      assert.equal(created.status, 200, JSON.stringify(created.json));
    } finally { await seed.close(); }
    // Real v1 history from the pinned schema.
    const v1Chat = id("ses", 1);
    const source = await openHistoryDatabase(v1);
    try {
      source.exec(await readFile(new URL("../../../evals/worlds/fixtures/opencode-v1-history/schema.sql", import.meta.url), "utf8"));
      source.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', 1, 1, '[]')").run();
      source.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES (?, 'global', 'earlier', ?, 'An earlier v1 chat', '1.18.30', 1, 2)`).run(v1Chat, directory);
      const message = id("msg", 1);
      source.prepare("INSERT INTO message VALUES (?, ?, 1, 1, ?)").run(message, v1Chat, JSON.stringify({ role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "test" } }));
      source.prepare("INSERT INTO part VALUES (?, ?, ?, 1, 1, ?)").run(id("prt", 1), message, v1Chat, JSON.stringify({ type: "text", text: "Keep this earlier prompt." }));
    } finally { source.close(); }
    // An engine left running by an OpenWork that exited, still holding this history.
    const orphan = spawn(nativeBinary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { stdio: "ignore",
      env: { ...process.env, ...engineEnv, OPENCODE_DB: target, OPENCODE_CONFIG_DIR: join(directory, "orphan-config"), OPENCODE_PASSWORD: "orphan" } });
    await new Promise(done => setTimeout(done, 1_500));
    await writeFile(join(root, "engine-lease-orphan.json"), JSON.stringify({ pid: await exitedPid(), child: orphan.pid }));
    await writeFile(join(root, PENDING), LEGACY_FENCE);
    await writeFile(statePath, JSON.stringify(V2_USER));
    const preview = createEngineV2Preview({ config });
    try {
      await waitFor(() => preview.status().running || Boolean(preview.status().lastError), 60_000, "native v2 starts");
      assert.equal(preview.status().running, true, preview.status().lastError);
      const connection = preview.connection();
      assert.ok(connection);
      const existing = await fetchOpencodeV2Json(connection, `/api/session/${v2Chat}/message?limit=1`, { directory });
      assert.equal(existing.status, 200, `the native engine opens the existing v2 chat: ${JSON.stringify(existing.json)}`);
      assert.equal(processAlive(orphan.pid), true, "starting v2 leaves the orphan alone");

      preview.migrateHistory();
      await waitFor(() => preview.status().migration.state !== "running" && preview.status().running, 120_000, "the copy finishes and v2 restarts");
      const migration = preview.status().migration;
      assert.equal(migration.state, "completed", migration.error);
      assert.equal(migration.imported, 1);
      assert.equal(processAlive(orphan.pid), false, "the identified orphan was stopped for the copy");
      const after = preview.connection();
      assert.ok(after);
      const earlier = await fetchOpencodeV2Json(after, `/api/session/${v1Chat}/message?limit=5`, { directory });
      assert.equal(earlier.status, 200, JSON.stringify(earlier.json));
      const still = await fetchOpencodeV2Json(after, `/api/session/${v2Chat}/message?limit=1`, { directory });
      assert.equal(still.status, 200, "the existing v2 chat is still served");
      assert.equal(await present(join(root, PENDING)), false);
    } finally { await preview.stop(); orphan.kill("SIGKILL"); }
    assert.equal(olderBuildServesV2(await readFile(statePath, "utf8")), true);
  });
});
