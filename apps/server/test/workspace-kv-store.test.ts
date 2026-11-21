import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { RUNTIME_SQLITE_BUSY_TIMEOUT_MS } from "../src/runtime-db.js";
import { createWorkspaceKvStore } from "../src/workspace-kv-store.js";
import type { ServerConfig } from "../src/types.js";

// Regression for DESKTOP-APP-7E: reads failed with "database is locked" when
// another connection to runtime.sqlite was mid-write (busy timeout was 0).
test("workspace kv reads are not blocked by another connection's open write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-kv-lock-"));
  const configPath = join(dir, "openwork.json");
  const config = { configPath } as ServerConfig;
  const store = createWorkspaceKvStore<{ n: number }>({
    tableName: "kv_lock_test",
    valueColumn: "value_json",
    parse: (json) => JSON.parse(json),
    serialize: (value) => JSON.stringify(value),
  });
  const other = new DatabaseSync(join(dir, "runtime.sqlite"));
  try {
    await store.set(config, "ws_1", { n: 1 });
    other.exec("BEGIN IMMEDIATE");
    other.exec("UPDATE kv_lock_test SET value_json = '{\"n\":2}' WHERE workspace_id = 'ws_1'");
    // WAL lets the reader see the last committed value while the write is open.
    assert.deepEqual(await store.get(config, "ws_1"), { n: 1 });
    assert.deepEqual(await store.getExisting(config, "ws_1"), { n: 1 });
    other.exec("COMMIT");
    assert.deepEqual(await store.get(config, "ws_1"), { n: 2 });
  } finally {
    try { other.exec("ROLLBACK"); } catch { /* already committed */ }
    other.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime sqlite connections use a non-zero busy timeout", () => {
  assert.ok(RUNTIME_SQLITE_BUSY_TIMEOUT_MS > 0);
});
