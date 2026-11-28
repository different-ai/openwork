import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "../src/types.js";
import { createWorkspaceKvStore } from "../src/workspace-kv-store.js";

// Regression for DESKTOP-APP-4V: a workspace KV read failed with
// "database is locked" while another connection was writing runtime.sqlite.
test("workspace kv reads succeed while another connection holds a write lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-kv-lock-"));
  const configPath = join(dir, "openwork.json");
  const dbPath = join(dir, "runtime.sqlite");
  const previousOverride = process.env.OPENWORK_RUNTIME_DB;
  delete process.env.OPENWORK_RUNTIME_DB;
  const config = { configPath } as ServerConfig;
  const store = createWorkspaceKvStore<{ name: string }>({
    tableName: "kv_lock_regression",
    valueColumn: "value_json",
    parse: (json) => JSON.parse(json) as { name: string },
    serialize: (value) => JSON.stringify(value),
  });
  let writer: DatabaseSync | undefined;
  try {
    await store.set(config, "ws_1", { name: "first" });

    writer = new DatabaseSync(dbPath);
    const journalMode = writer.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    assert.equal(journalMode.journal_mode, "wal");
    writer.exec("BEGIN EXCLUSIVE");
    writer.exec(`INSERT INTO kv_lock_regression (workspace_id, value_json, updated_at) VALUES ('ws_2', '{"name":"pending"}', 1)`);

    assert.deepEqual(await store.get(config, "ws_1"), { name: "first" });
    assert.equal(await store.get(config, "ws_2"), undefined);

    writer.exec("COMMIT");
    assert.deepEqual(await store.get(config, "ws_2"), { name: "pending" });
  } finally {
    writer?.close();
    if (previousOverride === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousOverride;
    await rm(dir, { recursive: true, force: true });
  }
});
