import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { receiptMatchesMigration } from "../scripts/superseded-migrations.ts";

const migrationUrl = new URL("../drizzle/0128_remove_legacy_analytics.sql", import.meta.url);

async function snapshot(name: string) {
  const source = await readFile(new URL(`../drizzle/meta/${name}`, import.meta.url), "utf8");
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || !("tables" in value)
    || typeof value.tables !== "object" || value.tables === null) throw new Error("Invalid Drizzle snapshot");
  return Object.fromEntries(Object.entries(value.tables));
}

describe("legacy analytics migration keeps every row", () => {
  test("the migration runs no destructive statement", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/--[^\n]*/g, "");
    const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
    expect(statements).toEqual(["SELECT 1"]);
  });

  test("app analytics, Gateway events, consent, accounting, and Workflow results all survive", async () => {
    // Exercise the exact migration against disposable storage, never a live database.
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE models_analytics_event (id TEXT, source TEXT, payload TEXT);");
      db.exec("INSERT INTO models_analytics_event VALUES ('gateway', 'inference', 'gateway usage'), ('desktop', 'app', 'task metadata');");
      const protectedTables = ["telemetry_event", "telemetry_session_dimension", "gateway_request_logs", "gateway_usage_rollups", "gateway_usage_bucket", "inference_usage_ledger_entries", "models_analytics_settings", "workflow_run"];
      for (const name of protectedTables) {
        db.exec(`CREATE TABLE ${name} (id TEXT, payload TEXT);`);
        db.query(`INSERT INTO ${name} VALUES (?, ?)`).run("preserve", "original data");
      }
      await readFile(migrationUrl, "utf8").then((sql) => db.exec(sql));
      expect(db.query("SELECT * FROM models_analytics_event ORDER BY id").all()).toEqual([
        { id: "desktop", source: "app", payload: "task metadata" },
        { id: "gateway", source: "inference", payload: "gateway usage" },
      ]);
      for (const name of protectedTables)
        expect(db.query(`SELECT * FROM ${name}`).all(), name).toEqual([{ id: "preserve", payload: "original data" }]);
    } finally {
      db.close();
    }
  });

  test("all other table definitions, including Gateway accounting and Workflow results, are unchanged", async () => {
    const before = await snapshot("0127_snapshot.json");
    const after = await snapshot("0128_snapshot.json");
    expect(Object.keys(before).filter((name) => !(name in after)).sort())
      .toEqual(["telemetry_event", "telemetry_session_dimension"]);
    expect(Object.keys(after).filter((name) => !(name in before))).toEqual([]);
    for (const [name, table] of Object.entries(after)) expect(table, name).toEqual(before[name]);
    for (const name of ["gateway_request_logs", "gateway_usage_rollups", "inference_usage_ledger_entries", "models_analytics_event", "models_analytics_settings", "workflow_run"])
      expect(after[name], name).toBeDefined();
  });

  test("databases that applied the original 0128 still pass the migration history check", () => {
    const migrations = readMigrationFiles({ migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
    const migration = migrations[127];
    if (!migration) throw new Error("missing 0128");
    expect(migration.folderMillis).toBe(1791246307322);
    // sha256 of 0128_remove_legacy_analytics.sql as released in v0.18.57.
    expect(receiptMatchesMigration("4a23d428e3b5c4e23fe147a2fd73cfedd3d73384c0f41e11327d203a05e802dc", migration)).toBe(true);
    expect(receiptMatchesMigration(migration.hash, migration)).toBe(true);
    expect(receiptMatchesMigration("0".repeat(64), migration)).toBe(false);
    const other = migrations[126];
    if (!other) throw new Error("missing 0127");
    expect(receiptMatchesMigration("4a23d428e3b5c4e23fe147a2fd73cfedd3d73384c0f41e11327d203a05e802dc", other)).toBe(false);
  });

  test("0135 only creates the analytics tables where they are missing", async () => {
    const sql = (await readFile(new URL("../drizzle/0135_restore_legacy_analytics.sql", import.meta.url), "utf8")).replace(/--[^\n]*/g, "");
    const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
    expect(statements.map((statement) => statement.split("(")[0]?.trim())).toEqual([
      "CREATE TABLE IF NOT EXISTS `telemetry_event`",
      "CREATE TABLE IF NOT EXISTS `telemetry_session_dimension`",
    ]);
    expect(sql).not.toMatch(/\b(DROP|DELETE|TRUNCATE|ALTER)\b/i);
  });

  test("0135 restores the analytics tables exactly as they were before 0128", async () => {
    const before = await snapshot("0127_snapshot.json");
    const after = await snapshot("0135_snapshot.json");
    for (const name of ["telemetry_event", "telemetry_session_dimension"]) expect(after[name], name).toEqual(before[name]);
  });
});
