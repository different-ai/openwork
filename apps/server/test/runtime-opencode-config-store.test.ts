import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  listRuntimeOpencodeConfigRows,
  readRuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "../src/runtime-opencode-config-store.js";
import type { ServerConfig } from "../src/types.js";

// Regression for DESKTOP-APP-7H: an updated_at beyond Number.MAX_SAFE_INTEGER
// made node:sqlite throw a RangeError and blocked desktop startup.
test("runtime config rows with an out-of-range updated_at are readable and healed on write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-runtime-config-"));
  const configPath = join(dir, "openwork.json");
  const dbPath = join(dir, "runtime.sqlite");
  const previousOverride = process.env.OPENWORK_RUNTIME_DB;
  delete process.env.OPENWORK_RUNTIME_DB;
  try {
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    seed.exec(`INSERT INTO runtime_opencode_configs VALUES ('ws_1', '{"plugin":["a"]}', 179460723497058000)`);
    seed.close();

    const config = { configPath } as ServerConfig;
    const rows = await listRuntimeOpencodeConfigRows(config);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.workspaceId, "ws_1");
    assert.equal(rows[0]?.updatedAt, 0);
    assert.deepEqual(rows[0]?.value.plugin, ["a"]);

    assert.deepEqual((await readRuntimeOpencodeConfig(config, "ws_1")).plugin, ["a"]);

    const before = Date.now();
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({ ...current, plugin: ["a", "b"] }));
    const [healed] = await listRuntimeOpencodeConfigRows(config);
    assert.ok(healed && Number.isSafeInteger(healed.updatedAt) && healed.updatedAt >= before);
    assert.deepEqual(healed?.value.plugin, ["a", "b"]);
  } finally {
    if (previousOverride === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousOverride;
    await rm(dir, { recursive: true, force: true });
  }
});
