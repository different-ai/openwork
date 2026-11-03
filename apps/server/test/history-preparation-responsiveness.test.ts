import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { historyRevision, runEngineAutoUpgrade } from "../src/engine-auto-upgrade.js";
import { readMigrationSessions } from "../src/opencode-v2-migration.js";
import { heartbeatDuring, largeHistoryFixture } from "./history-preparation-fixture.js";

test("large v1 freshness preparation keeps the host heartbeat below 250 ms and still switches unchanged history", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-synthetic-history-"));
  try {
    const database = await largeHistoryFixture(directory);
    let copied = 0;
    let switched = 0;
    const result = await heartbeatDuring(async () => {
      assert.equal((await readMigrationSessions(database)).length, 320);
      await runEngineAutoUpgrade({ signal: new AbortController().signal, idle: async () => true,
        revision: () => historyRevision(database), copy: async () => { copied++; },
        switchEngine: async () => { switched++; } });
    });
    console.log(JSON.stringify({ event: "synthetic-history-heartbeat", ...result, copied, switched }));
    assert.equal(copied, 1);
    assert.equal(switched, 1);
    assert.ok(result.ticks > 0);
    assert.ok(result.maxLagMs < 250, `main event-loop stall ${result.maxLagMs.toFixed(1)} ms exceeds 250 ms`);
    assert.equal(result.stalls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
