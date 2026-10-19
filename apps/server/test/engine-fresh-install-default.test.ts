import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readEngineV2PreviewState } from "../src/engine-v2-preview.js";

function withProfile(run: (config: { configPath: string }, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "openwork-v2-only-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  try { run({ configPath: join(dir, "server.json") }, dir); }
  finally {
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("new and formerly v1 profiles both use v2", () => {
  withProfile((config, dir) => {
    assert.deepEqual(readEngineV2PreviewState(config), { enabled: true, chatRouting: true });
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: false, chatRouting: false }));
    assert.deepEqual(readEngineV2PreviewState(config), { enabled: true, chatRouting: true });
  });
});

test("retiring engine selection preserves interrupted history copies and receipts", () => {
  withProfile((config, dir) => {
    const checkpoint = { v1HistoryCopiedAt: 10, v1HistoryCopyStartedAt: 20,
      historyCopyResult: { state: "error", imported: 1, skipped: 0, total: 2, error: "Copy paused" } };
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: false, chatRouting: false, ...checkpoint }));
    assert.deepEqual(readEngineV2PreviewState(config), { enabled: true, chatRouting: true, ...checkpoint });
  });
});
