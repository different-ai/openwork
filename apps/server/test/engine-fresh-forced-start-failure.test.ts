import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState, seedFreshInstallEngineState } from "../src/engine-v2-preview.js";
import type { ServerConfig } from "../src/types.js";

const nativeBinary = process.env.OPENWORK_OPENCODE2_BIN;

async function profile(run: (config: ServerConfig) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "openwork-fresh-forced-failure-"));
  const overrides = {
    HOME: directory, USERPROFILE: directory,
    XDG_DATA_HOME: join(directory, "data"), XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"), OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENWORK_RUNTIME_DB: join(directory, "runtime.sqlite"), OPENCODE_DB: join(directory, "v1.db"),
    OPENWORK_OPENCODE2_BIN: join(directory, "nonexistent-opencode2"), OPENWORK_ENGINE_V2_PREVIEW: "",
  };
  const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    freshInstallEngine: "v2",
  };
  try { await run(config); }
  finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForError(engine: ReturnType<typeof createEngineV2Preview>) {
  const deadline = Date.now() + 10_000;
  while (!engine.status().lastError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(engine.status().lastError ?? "", /nonexistent-opencode2/);
}

for (const preseeded of [false, true]) test(`forced fresh start failure never falls back after original-store adoption (saved selection: ${preseeded})`, { timeout: 20_000 }, async () => {
  await profile(async config => {
    if (preseeded) assert.equal(seedFreshInstallEngineState(config), true);
    const engine = createEngineV2Preview({ config, waits: { engineRestartMs: 60_000 } });
    try {
      await waitForError(engine);
      assert.equal(engine.status().running, false);
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().enabled, true);
      assert.equal(engine.status().engineForced, true);
      assert.ok(engine.status().v1UnavailableReason);
    } finally { await engine.stop(); }
    const saved = readEngineV2PreviewState(config);
    assert.equal(saved.chatRouting, true);
    assert.equal(saved.historyDatabase, process.env.OPENCODE_DB);
    const later = createEngineV2Preview({ config, waits: { engineRestartMs: 60_000 } });
    try {
      await waitForError(later);
      assert.equal(later.status().chatRouting, true);
      assert.equal(later.status().running, false);
    } finally { await later.stop(); }
  });
});

test("a later healthy fresh start uses the adopted original store without falling back", { skip: !nativeBinary, timeout: 90_000 }, async () => {
  if (!nativeBinary) return;
  await profile(async config => {
    const first = createEngineV2Preview({ config, waits: { engineRestartMs: 60_000 } });
    try { await waitForError(first); assert.equal(first.status().chatRouting, true); }
    finally { await first.stop(); }
    const selected = readEngineV2PreviewState(config).historyDatabase;
    process.env.OPENWORK_OPENCODE2_BIN = nativeBinary;
    const retried = createEngineV2Preview({ config });
    try {
      const deadline = Date.now() + 60_000;
      while (!retried.status().running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(retried.status().running, true, JSON.stringify(retried.status()));
      assert.equal(retried.status().chatRouting, true);
      assert.equal(retried.status().engineForced, true);
      assert.equal(retried.status().lastError, undefined);
      assert.equal(readEngineV2PreviewState(config).historyDatabase, selected);
    } finally { await retried.stop(); }
  });
});

test("a failed manually selected fresh engine is not silently changed by the force controller", async () => {
  await profile(async config => {
    assert.equal(seedFreshInstallEngineState({ ...config, engineAutoUpgrade: false }), true);
    const engine = createEngineV2Preview({ config });
    try {
      await waitForError(engine);
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().engineForced, false);
      assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry, undefined);
    } finally { await engine.stop(); }
  });
});
