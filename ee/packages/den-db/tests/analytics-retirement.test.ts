import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const migrationUrl = new URL("../drizzle/0128_remove_legacy_analytics.sql", import.meta.url);

async function snapshot(name: string) {
  const source = await readFile(new URL(`../drizzle/meta/${name}`, import.meta.url), "utf8");
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || !("tables" in value)
    || typeof value.tables !== "object" || value.tables === null) throw new Error("Invalid Drizzle snapshot");
  return Object.fromEntries(Object.entries(value.tables));
}

describe("legacy analytics retirement preserves AI Gateway data", () => {
  test("the migration drops only adoption tables and deletes only app events", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/--[^\n]*/g, "");
    const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
    expect(statements).toEqual([
      "DROP TABLE `telemetry_event`",
      "DROP TABLE `telemetry_session_dimension`",
      "DELETE FROM `models_analytics_event` WHERE `source` = 'app'",
    ]);
  });

  test("app data is erased without deleting Gateway events, consent, accounting, or Workflow results", async () => {
    // These statements use only portable DROP/DELETE SQL. Exercise the exact
    // generated migration against disposable storage, never a live database.
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE telemetry_event (id TEXT); CREATE TABLE telemetry_session_dimension (id TEXT);");
      db.exec("CREATE TABLE models_analytics_event (id TEXT, source TEXT, payload TEXT);");
      db.exec("INSERT INTO models_analytics_event VALUES ('gateway', 'inference', 'gateway usage'), ('desktop', 'app', 'task metadata');");
      const protectedTables = ["gateway_request_logs", "gateway_usage_rollups", "gateway_usage_bucket", "inference_usage_ledger_entries", "models_analytics_settings", "workflow_run"];
      for (const name of protectedTables) {
        db.exec(`CREATE TABLE ${name} (id TEXT, payload TEXT);`);
        db.query(`INSERT INTO ${name} VALUES (?, ?)`).run("preserve", "original data");
      }
      await readFile(migrationUrl, "utf8").then((sql) => db.exec(sql));
      expect(db.query("SELECT * FROM models_analytics_event").all())
        .toEqual([{ id: "gateway", source: "inference", payload: "gateway usage" }]);
      for (const name of protectedTables)
        expect(db.query(`SELECT * FROM ${name}`).all(), name).toEqual([{ id: "preserve", payload: "original data" }]);
      expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('telemetry_event', 'telemetry_session_dimension')").all()).toEqual([]);
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
});
