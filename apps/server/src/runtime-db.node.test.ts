import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRuntimeSqliteDatabase } from "./runtime-db.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (typeof process.versions.bun !== "string") {
  test("opens and closes the runtime SQLite database with Node's driver", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-runtime-db-node-"));
    try {
      const dbPath = join(root, "nested", "runtime.sqlite");
      const runtimeDb = await openRuntimeSqliteDatabase(dbPath);
      assert.equal(runtimeDb.kind, "node");
      if (runtimeDb.kind !== "node") throw new Error("expected Node runtime DB driver");

      runtimeDb.sqlite.exec("CREATE TABLE node_driver_check (id TEXT PRIMARY KEY NOT NULL)");
      runtimeDb.sqlite.prepare("INSERT INTO node_driver_check (id) VALUES (?)").run("ok");
      const row = runtimeDb.sqlite.prepare("SELECT id FROM node_driver_check").get();
      assert.equal(isRecord(row) ? row.id : null, "ok");

      runtimeDb.close();
      assert.throws(() => runtimeDb.sqlite.exec("SELECT 1"));
      assert.equal((await stat(dbPath)).isFile(), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
