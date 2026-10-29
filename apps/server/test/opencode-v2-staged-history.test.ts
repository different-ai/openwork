import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { migrateOpencodeV1History, type EngineV2MigrationStatus } from "../src/opencode-v2-migration.js";
import { numberField, openHistoryDatabase, stringField } from "../src/opencode-v2-history-store.js";
import { createEngineV2Preview, readEngineV2PreviewState } from "../src/engine-v2-preview.js";
import type { ServerConfig } from "../src/types.js";

const bin = process.env.OPENWORK_OPENCODE2_BIN;
const id = (prefix: string, n: number) => `${prefix}_${n.toString().padStart(26, "0")}`;
const sessionId = id("ses", 1);
const assistantId = id("msg", 2);

async function fixture(directory: string, outputBytes = 260 * 1024 ** 2) {
  const source = join(directory, "v1.db");
  const db = await openHistoryDatabase(source);
  try {
    db.exec(await readFile(new URL("../../../evals/worlds/fixtures/opencode-v1-history/schema.sql", import.meta.url), "utf8"));
    db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', 1, 1, '[]')").run();
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, 'global', 'history', ?, 'A complete conversation', '1.18.30', 1, 2)`).run(sessionId, directory);
    const userId = id("msg", 1);
    db.prepare("INSERT INTO message VALUES (?, ?, 1, 1, ?)").run(userId, sessionId, JSON.stringify({ role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "test" } }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, 1, 1, ?)").run(id("prt", 1), userId, sessionId, JSON.stringify({ type: "text", text: "Keep this prompt. " + "界🦆\"\\\n".repeat(1000) }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, 1, 1, ?)").run(id("prt", 2), userId, sessionId,
      JSON.stringify({ type: "file", mime: "image/png", filename: "original.png", url: "data:image/png;base64," + Buffer.from("image-payload".repeat(600)).toString("base64") }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, 1, 1, ?)").run(id("prt", 3), userId, sessionId,
      JSON.stringify({ type: "file", mime: "text/plain", filename: "unicode.txt", url: "data:text/plain," + encodeURIComponent("界🦆 /%".repeat(2000)) }));
    db.prepare("INSERT INTO message VALUES (?, ?, 2, 2, ?)").run(assistantId, sessionId, JSON.stringify({ role: "assistant", parentID: userId,
      time: { created: 2, completed: 3 }, modelID: "test", providerID: "test", mode: "build", agent: "build", path: { cwd: directory, root: directory },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, 2, 2, ?)").run(id("prt", 4), assistantId, sessionId, JSON.stringify({ type: "text", text: "All original results are below." }));
    // Generate a single output above the old whole-chat export limit entirely
    // inside SQLite. The test runner never allocates a string of that size.
    db.prepare(`INSERT INTO part VALUES (?, ?, ?, 2, 2, json_object('type', 'tool', 'tool', 'bash', 'callID', 'call_original',
      'state', json_object('status', 'completed', 'input', json_object('command', 'cat report.txt'),
        'output', replace(hex(zeroblob(?)), '00', 'x'), 'metadata', json_object(), 'title', 'report.txt', 'time', json_object('start', 2, 'end', 3))))`)
      .run(id("prt", 5), assistantId, sessionId, outputBytes);
    db.prepare("UPDATE part SET data = json_set(data, '$.state.input.document', ?, '$.state.attachments', json(?)) WHERE id = ?")
      .run("An original tool input. ".repeat(300), JSON.stringify([{ id: id("prt", 999), sessionID: sessionId, messageID: assistantId,
        type: "file", mime: "image/png", filename: "tool-image.png", url: "data:image/png;base64," + Buffer.from("tool-image".repeat(800)).toString("base64") }]), id("prt", 5));
    // More than one transfer batch, with stable ordering and no big JS body.
    for (let n = 3; n <= 140; n++) {
      const messageId = id("msg", n);
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(messageId, sessionId, n + 1, n + 1,
        JSON.stringify({ role: "user", time: { created: n + 1 }, agent: "build", model: { providerID: "test", modelID: "test" } }));
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(id("prt", n + 5), messageId, sessionId, n + 1, n + 1, JSON.stringify({ type: "text", text: `Original message ${n}` }));
    }
  } finally { db.close(); }
  return source;
}

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// OpenCode v1.18.33 adds project.time_archived, which the pinned v2 target may
// not have (#6548). An archived v1 chat must still arrive unlocked (#6367).
test("v1 history with project archiving and archived chats copies as active v2 chats", { skip: !bin, timeout: 60_000 }, async () => {
  if (!bin) return;
  const directory = await mkdtemp(join(tmpdir(), "openwork-project-schema-"));
  const rootDir = join(directory, "v2");
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    const source = await fixture(directory, 0);
    const original = await openHistoryDatabase(source);
    try {
      original.exec("ALTER TABLE project ADD COLUMN time_archived integer");
      original.prepare("INSERT INTO migration (id, time_completed) VALUES ('20261010180456_project_time_archived', 1767225600000)").run();
      original.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes, time_archived) VALUES (?, ?, 1, 1, '[]', 123)")
        .run("archived-project", join(directory, "archived"));
      original.prepare("UPDATE session SET time_archived = 456 WHERE id = ?").run(sessionId);
    } finally { original.close(); }
    const before = await digest(source);
    engine = await createManagedOpencodeV2Server({ bin, rootDir, env: { OPENCODE_DISABLE_MODELS_FETCH: "1" } });
    await engine.close(); engine = undefined;
    let status: EngineV2MigrationStatus | undefined;
    await migrateOpencodeV1History({ bin, source, storageDir: join(directory, "copy"), targetDatabase: join(rootDir, "opencode.db"),
      progress: next => { status = next; } });
    assert.equal(status?.state, "completed", status?.error);
    const target = await openHistoryDatabase(join(rootDir, "opencode.db"));
    try {
      assert.equal(numberField(target.prepare("SELECT count(*) AS n FROM project WHERE id = 'archived-project'").get(), "n"), 1);
      // A target engine that knows project archiving keeps the value.
      if (target.prepare("SELECT 1 FROM pragma_table_info('project') WHERE name = 'time_archived'").get()) {
        assert.equal(numberField(target.prepare("SELECT time_archived AS n FROM project WHERE id = 'archived-project'").get(), "n"), 123);
      }
      assert.equal(numberField(target.prepare("SELECT count(*) AS n FROM session_v2 WHERE id = ? AND time_archived IS NULL").get(sessionId), "n"), 1);
      assert.equal(numberField(target.prepare("SELECT json_extract(data, '$.time_archived') AS n FROM openwork_v1_session WHERE id = ?").get(sessionId), "n"), 456);
    } finally { target.close(); }
    assert.equal(await digest(source), before);
    engine = await createManagedOpencodeV2Server({ bin, rootDir, env: { OPENCODE_DISABLE_MODELS_FETCH: "1" } });
    assert.equal((await engine.fetchJson("/api/session/active")).status, 200);
  } finally { await engine?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a complete large-thread copy resumes committed batches and repeated runs preserve v2 messages", { skip: !bin, timeout: 300_000 }, async () => {
  if (!bin) return;
  const directory = await mkdtemp(join(tmpdir(), "openwork-staged-history-"));
  const targetRoot = join(directory, "v2");
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    const source = await fixture(directory);
    const before = await digest(source);
    engine = await createManagedOpencodeV2Server({ bin, rootDir: targetRoot, env: { OPENCODE_DISABLE_MODELS_FETCH: "1", HOME: directory } });
    assert.equal((await engine.fetchJson("/api/session/active")).status, 200);
    await engine.close(); engine = undefined;
    let status: EngineV2MigrationStatus | undefined;
    const request = { bin, source, storageDir: join(directory, "copy"), targetDatabase: join(targetRoot, "opencode.db"),
      progress: (next: EngineV2MigrationStatus) => { status = next; } };
    const child = spawn(process.execPath, [process.env.OPENWORK_TEST_HISTORY_WORKER ?? fileURLToPath(new URL("./fixtures/staged-history-worker.ts", import.meta.url))],
      { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The first history batch did not commit")), 90_000);
        child.once("message", () => { clearTimeout(timer); resolve(); });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("The history worker exited before its batch committed")); });
        child.send({ bin, source, storageDir: request.storageDir, targetDatabase: request.targetDatabase });
      });
    } finally { child.kill("SIGKILL"); await closed; }
    await assert.rejects(createManagedOpencodeV2Server({ bin, rootDir: targetRoot }), /History migration is incomplete/);
    let target = await openHistoryDatabase(request.targetDatabase);
    assert.equal(numberField(target.prepare("SELECT count(*) AS n FROM session_message").get(), "n"), 64);
    target.close();
    await migrateOpencodeV1History(request);
    assert.equal(status?.state, "completed", status?.error);
    assert.equal(status?.resumed, true);
    target = await openHistoryDatabase(request.targetDatabase);
    try {
      // The native conversion includes its deterministic tool-availability message.
      assert.equal(numberField(target.prepare("SELECT count(*) AS n FROM session_message").get(), "n"), 141);
      const outputLength = numberField(target.prepare("SELECT length(json_extract(data, '$.content[1].state.content[0].text')) AS n FROM session_message WHERE id = ?").get(assistantId), "n");
      assert.equal(outputLength, 260 * 1024 ** 2);
      assert.equal(numberField(target.prepare("SELECT count(*) AS n FROM openwork_v1_part").get(), "n"), 143);
      assert.equal(stringField(target.prepare("SELECT json_extract(data, '$.text') AS value FROM session_message WHERE id = ?").get(id("msg", 1)), "value"), "Keep this prompt. " + "界🦆\"\\\n".repeat(1000));
      assert.equal(stringField(target.prepare("SELECT json_extract(data, '$.files[0].data') AS value FROM session_message WHERE id = ?").get(id("msg", 1)), "value"), Buffer.from("image-payload".repeat(600)).toString("base64"));
      assert.equal(stringField(target.prepare("SELECT json_extract(data, '$.files[1].data') AS value FROM session_message WHERE id = ?").get(id("msg", 1)), "value"), Buffer.from("界🦆 /%".repeat(2000)).toString("base64"));
      target.prepare("UPDATE session_message SET data = json_set(data, '$.metadata.userNote', 'Keep this v2 edit') WHERE id = ?").run(assistantId);
      const newer = id("msg", 999);
      const newerData = JSON.stringify({ text: "A newer v2 message must survive another migration", time: { created: 1000 } });
      target.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'user', 1000, 1000, 1000, ?)").run(newer, sessionId, newerData);
      target.prepare("UPDATE event_sequence SET seq = 1001 WHERE aggregate_id = ?").run(sessionId);
      target.close();
      await migrateOpencodeV1History(request);
      assert.equal(status?.state, "completed", status?.error);
      target = await openHistoryDatabase(request.targetDatabase);
      assert.equal(numberField(target.prepare("SELECT length(json_extract(data, '$.content[1].state.content[0].text')) AS n FROM session_message WHERE id = ?").get(assistantId), "n"), outputLength);
      assert.equal(stringField(target.prepare("SELECT json_extract(data, '$.metadata.userNote') AS value FROM session_message WHERE id = ?").get(assistantId), "value"), "Keep this v2 edit");
      assert.equal(stringField(target.prepare("SELECT json_extract(data, '$.content[1].state.input.document') AS value FROM session_message WHERE id = ?").get(assistantId), "value"), "An original tool input. ".repeat(300));
      assert.equal(stringField(target.prepare("SELECT json_extract(data, '$.content[1].state.content[1].uri') AS value FROM session_message WHERE id = ?").get(assistantId), "value"), "data:image/png;base64," + Buffer.from("tool-image".repeat(800)).toString("base64"));
      assert.equal(stringField(target.prepare("SELECT json_extract(data, '$.content[1].state.content[1].mime') AS value FROM session_message WHERE id = ?").get(assistantId), "value"), "image/png");
      assert.equal(numberField(target.prepare("SELECT count(*) AS n FROM session_message WHERE id = ?").get(id("msg", 100)), "n"), 1);
      assert.equal(stringField(target.prepare("SELECT data FROM session_message WHERE id = ?").get(newer), "data"), newerData);
      assert.equal(stringField(target.prepare("SELECT id FROM session_message ORDER BY seq DESC LIMIT 1").get(), "id"), newer);
      assert.ok(numberField(target.prepare("SELECT seq FROM event_sequence WHERE aggregate_id = ?").get(sessionId), "seq") >= 1001);
      assert.equal(await digest(source), before);
    } finally { target.close(); }
    // A fresh native process must read the resulting projection and cursors.
    engine = await createManagedOpencodeV2Server({ bin, rootDir: targetRoot, env: { OPENCODE_DISABLE_MODELS_FETCH: "1", HOME: directory } });
    const read = await engine.fetchJson(`/api/session/${sessionId}/message?limit=1&order=desc`, { directory });
    assert.equal(read.status, 200, JSON.stringify(read.json));
    const appended = await engine.fetchJson(`/api/session/${sessionId}/synthetic`, { method: "POST", directory,
      body: { text: "A new native event after migration", metadata: {}, resume: false } });
    assert.equal(appended.status, 200, JSON.stringify(appended.json));
  } finally {
    await engine?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("active engines block the copy and diverged chats merge without losing native turns", { skip: !bin, timeout: 60_000 }, async () => {
  if (!bin) return;
  const directory = await mkdtemp(join(tmpdir(), "openwork-history-existing-"));
  const rootDir = join(directory, "v2");
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    const source = await fixture(directory, 8192);
    engine = await createManagedOpencodeV2Server({ bin, rootDir, env: { OPENCODE_DISABLE_MODELS_FETCH: "1", HOME: directory } });
    let status: EngineV2MigrationStatus | undefined;
    const request = { bin, source, storageDir: join(directory, "copy"), targetDatabase: join(rootDir, "opencode.db"),
      progress: (value: EngineV2MigrationStatus) => { status = value; } };
    await migrateOpencodeV1History(request);
    assert.equal(status?.state, "error");
    assert.match(status?.error ?? "", /Another OpenCode v2 engine/);
    assert.equal((await engine.health()).healthy, true);
    const created = await engine.fetchJson("/api/session", { method: "POST", directory,
      body: { id: sessionId, title: "An existing v2 chat", location: { directory } } });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    await engine.close(); engine = undefined;
    let db = await openHistoryDatabase(request.targetDatabase);
    const existingData = JSON.stringify({ text: "Only in v2", time: { created: 1000 } });
    db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'user', 50, 1000, 1000, ?)")
      .run(id("msg", 999), sessionId, existingData);
    db.close();
    await migrateOpencodeV1History(request);
    assert.equal(status?.state, "completed", status?.error);
    assert.equal(status?.imported, 1);
    assert.equal(status?.skipped, 0);
    db = await openHistoryDatabase(request.targetDatabase);
    try {
      assert.equal(stringField(db.prepare("SELECT title FROM session_v2 WHERE id = ?").get(sessionId), "title"), "An existing v2 chat");
      assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM session_message").get(), "n"), 142);
      assert.equal(stringField(db.prepare("SELECT data FROM session_message WHERE id = ?").get(id("msg", 999)), "data"), existingData);
      assert.equal(stringField(db.prepare("SELECT id FROM session_message ORDER BY seq DESC LIMIT 1").get(), "id"), id("msg", 999));
      assert.equal(numberField(db.prepare("SELECT seq FROM openwork_v2_replaced_message WHERE id = ?").get(id("msg", 999)), "seq"), 50);
    } finally { db.close(); }
  } finally { await engine?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("default boot copies history and selects healthy v2 despite legacy off policy", { skip: !bin, timeout: 60_000 }, async () => {
  if (!bin) return;
  const directory = await mkdtemp(join(tmpdir(), "openwork-default-history-"));
  const overrides = { OPENWORK_RUNTIME_DB: join(directory, "runtime.sqlite"), OPENCODE_DB: join(directory, "v1.db"),
    OPENWORK_ENGINE_V2_PREVIEW: "", OPENCODE_DISABLE_MODELS_FETCH: "1" };
  const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  let preview: ReturnType<typeof createEngineV2Preview> | undefined;
  try {
    const source = await fixture(directory, 8192);
    const before = await digest(source);
    Object.assign(process.env, overrides);
    const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "test", configPath: join(directory, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [directory], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
    preview = createEngineV2Preview({ config, deferStart: true, autoUpgradeIdle: async () => true });
    preview.setForcePolicy({ upgrade: false });
    preview.start();
    preview.setForcePolicy({ upgrade: false });
    assert.equal(preview.status().chatRouting, false, "v1 remains selected while copying");
    const deadline = Date.now() + 45_000;
    while (!preview.status().chatRouting) {
      assert.notEqual(preview.status().migration.state, "error", preview.status().migration.error);
      assert.ok(Date.now() < deadline, "the default automatic migration selects v2");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(preview.status().running, true);
    assert.equal(preview.status().engineOrigin, "forced");
    assert.equal(preview.status().migration.state, "completed");
    assert.equal(preview.status().migration.imported, 1);
    assert.ok(preview.status().migration.backupPath, "automatic migration retains its pre-copy backup");
    assert.equal(await digest(source), before, "the original v1 history is never modified");
    preview.setForcePolicy({ upgrade: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(preview.status().chatRouting, true, "a late legacy off response cannot revert migration");
    assert.ok(preview.connection());
    assert.equal(readEngineV2PreviewState(config).automaticHistoryCopy, undefined);
    assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry, undefined);
  } finally {
    await preview?.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing OpenWork pauses a copy and startup resumes it before serving v2", { skip: !bin, timeout: 60_000 }, async () => {
  if (!bin) return;
  const directory = await mkdtemp(join(tmpdir(), "openwork-history-lifecycle-"));
  const previous = { db: process.env.OPENWORK_RUNTIME_DB, source: process.env.OPENCODE_DB, preview: process.env.OPENWORK_ENGINE_V2_PREVIEW };
  let preview: ReturnType<typeof createEngineV2Preview> | undefined;
  try {
    const source = await fixture(directory, 8192);
    process.env.OPENWORK_RUNTIME_DB = join(directory, "runtime.sqlite");
    process.env.OPENCODE_DB = source;
    delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
    const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "test", configPath: join(directory, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [directory], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
    const targetRoot = join(directory, "opencode-v2", "state");
    const engine = await createManagedOpencodeV2Server({ bin, rootDir: targetRoot, env: { OPENCODE_DISABLE_MODELS_FETCH: "1", HOME: directory } });
    await engine.close();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true, v1HistoryCopyStartedAt: 1 }));
    preview = createEngineV2Preview({ config, deferStart: true });
    assert.equal(preview.status().migration.resumed, true);
    assert.equal(preview.connection(), undefined);
    preview.start();
    const deadline = Date.now() + 30_000;
    while (preview.status().migration.phase !== "converting") {
      assert.equal(preview.status().migration.state, "running", preview.status().migration.error);
      assert.ok(Date.now() < deadline, "the resumed copy reaches conversion");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await preview.stop(); preview = undefined;
    assert.ok(readEngineV2PreviewState(config).v1HistoryCopyStartedAt !== undefined);
    preview = createEngineV2Preview({ config, deferStart: true });
    assert.equal(preview.status().migration.state, "running");
    assert.equal(preview.connection(), undefined);
    preview.start();
    while (preview.status().migration.state === "running") {
      assert.ok(Date.now() < deadline, "startup finishes the saved copy");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(preview.status().migration.state, "completed", preview.status().migration.error);
    assert.ok(preview.connection());
    assert.equal(readEngineV2PreviewState(config).v1HistoryCopyStartedAt, undefined);
    assert.equal(readEngineV2PreviewState(config).historyCopyResult?.state, "completed");
  } finally {
    await preview?.stop();
    for (const [key, value] of [["OPENWORK_RUNTIME_DB", previous.db], ["OPENCODE_DB", previous.source], ["OPENWORK_ENGINE_V2_PREVIEW", previous.preview]]) {
      if (value === undefined) delete process.env[String(key)]; else process.env[String(key)] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
