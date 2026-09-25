import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateOpencodeV1History, opencodeV1DatabasePath, snapshotV1Database, type EngineV2MigrationStatus } from "./opencode-v2-migration.js";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { createManagedOpencodeV2Server } from "./managed-opencode-v2.js";

test("resolves the same v1 database within the active development profile", () => {
  expect(opencodeV1DatabasePath({ HOME: "/fixture/home" })).toBe("/fixture/home/.local/share/opencode/opencode.db");
  expect(opencodeV1DatabasePath({ XDG_DATA_HOME: "/fixture/dev/data" })).toBe("/fixture/dev/data/opencode/opencode.db");
  expect(opencodeV1DatabasePath({ OPENCODE_DB: "/fixture/custom.db" })).toBe("/fixture/custom.db");
  expect(() => opencodeV1DatabasePath({ OPENCODE_DB: ":memory:" })).toThrow("In-memory");
});

test("snapshot includes uncheckpointed WAL writes without changing the original", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-history-snapshot-"));
  const source = join(root, "v1.db");
  const db = new Database(source);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE witness (text TEXT); INSERT INTO witness VALUES ('retained history');");
    await snapshotV1Database(source, join(root, "copy.db"));
    const snapshot = new Database(join(root, "copy.db"), { readonly: true });
    expect(snapshot.query("SELECT text FROM witness").get()).toEqual({ text: "retained history" });
    snapshot.close();
    expect(db.query("SELECT text FROM witness").get()).toEqual({ text: "retained history" });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("missing history reports failure without importing or creating a v1 database", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-history-missing-"));
  const updates: EngineV2MigrationStatus[] = [];
  try {
    await migrateOpencodeV1History({ source: join(root, "missing.db"), storageDir: root, bin: "unused",
      target: { fetchJson: async () => { throw new Error("must not import"); } }, progress: (status) => updates.push(status) });
    expect(updates.at(-1)?.state).toBe("error");
    expect(await Bun.file(join(root, "missing.db")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const live = process.env.OPENWORK_MIGRATION_LIVE_TEST === "1";
test.skipIf(!live)("pinned v2 converts real v1 history, imports parents first, preserves existing chats, and safely retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-history-native-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(workspace); await mkdir(home);
  const source = join(root, "v1.db");
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DB: source };
  const v1 = await createManagedOpencodeServer({ bin: process.env.OPENWORK_MIGRATION_V1_BIN, cwd: workspace, env });
  let target: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    const headers = { Authorization: `Basic ${Buffer.from(`${v1.username}:${v1.password}`).toString("base64")}`, "Content-Type": "application/json" };
    const parent = await (await fetch(`${v1.url}/session`, { method: "POST", headers, body: JSON.stringify({ title: "Migration fixture parent" }) })).json();
    const child = await (await fetch(`${v1.url}/session`, { method: "POST", headers, body: JSON.stringify({ title: "Migration fixture child", parentID: parent.id }) })).json();
    expect(typeof parent.id).toBe("string"); expect(typeof child.id).toBe("string");
    await v1.close();
    const db = new Database(source);
    const now = Date.now();
    const messageId = "msg_migrationfixture00000000001";
    db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(messageId, parent.id, now, now, JSON.stringify({ role: "user", time: { created: now }, agent: "build", model: { providerID: "fixture", modelID: "fixture" } }));
    db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run("prt_migrationfixture00000000001", messageId, parent.id, now, now, JSON.stringify({ type: "text", text: "Retain this migration witness." }));
    db.close();
    const hash = () => readFile(source).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
    const before = await hash();
    const bin = process.env.OPENWORK_OPENCODE2_BIN;
    if (!bin) throw new Error("OPENWORK_OPENCODE2_BIN is required for the live migration test");
    target = await createManagedOpencodeV2Server({ bin, rootDir: join(root, "v2"), env });
    const existing = await target.fetchJson("/api/session", { method: "POST", directory: workspace, body: { title: "Existing v2 fixture" } });
    expect(existing.status).toBe(200);
    const updates: EngineV2MigrationStatus[] = [];
    const migrate = () => migrateOpencodeV1History({ source, storageDir: root, bin, target: target!, progress: (status) => updates.push(status) });
    await migrate();
    expect(updates.at(-1)).toEqual({ state: "completed", imported: 2, skipped: 0, total: 2 });
    expect(await hash()).toBe(before);
    const exported = await target.fetchJson(`/api/session/${parent.id}/export`, { directory: workspace });
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.json)).toContain("Retain this migration witness.");
    expect(JSON.stringify(await target.fetchJson(`/api/session/${child.id}`, { directory: workspace }))).toContain(parent.id);
    await migrate();
    expect(updates.at(-1)).toEqual({ state: "completed", imported: 0, skipped: 2, total: 2 });
    const list = await target.fetchJson("/api/session", { directory: workspace });
    expect(JSON.stringify(list.json)).toContain("Existing v2 fixture");
    expect(await hash()).toBe(before);
  } finally { await v1.close(); await target?.close(); await rm(root, { recursive: true, force: true }); }
}, 180_000);
