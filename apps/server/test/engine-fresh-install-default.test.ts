import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { freshInstallEngineState, readEngineV2PreviewState, seedFreshInstallEngineState } from "../src/engine-v2-preview.js";

const fresh = { requested: "v2" as const, env: {}, stateFileExists: false, v1HistoryExists: false };

test("a brand-new install starts on OpenCode v2", () => {
  assert.deepEqual(freshInstallEngineState(fresh), { enabled: true, chatRouting: true });
});

test("updates, saved choices, v1 history and explicit overrides keep today's engine", () => {
  assert.equal(freshInstallEngineState({ ...fresh, requested: undefined }), undefined);
  assert.equal(freshInstallEngineState({ ...fresh, stateFileExists: true }), undefined);
  assert.equal(freshInstallEngineState({ ...fresh, v1HistoryExists: true }), undefined);
  assert.equal(freshInstallEngineState({ ...fresh, env: { OPENWORK_ENGINE_V2_PREVIEW: "0" } }), undefined);
});

type Profile = { configPath: string; freshInstallEngine: "v2" };

function withProfile(run: (config: Profile, env: NodeJS.ProcessEnv, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "openwork-fresh-engine-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(dir, "openwork", "runtime.sqlite");
  try {
    const config: Profile = { configPath: join(dir, "openwork", "server.json"), freshInstallEngine: "v2" };
    run(config, { OPENCODE_DB: join(dir, "opencode", "opencode.db") }, dir);
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the fresh-install choice is saved once and a later switch back to v1 sticks", () => {
  withProfile((config, env, dir) => {
    assert.equal(seedFreshInstallEngineState(config, env), true);
    const { engineChangedAt, ...state } = readEngineV2PreviewState(config);
    assert.ok(engineChangedAt && Number.isFinite(Date.parse(engineChangedAt)));
    assert.deepEqual(state, { enabled: true, chatRouting: true, engineOrigin: "fresh" });

    writeFileSync(join(dir, "openwork", "engine-v2-preview.json"), JSON.stringify({ enabled: false, chatRouting: false }));
    assert.equal(seedFreshInstallEngineState(config, env), false);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "openwork", "engine-v2-preview.json"), "utf8")), { enabled: false, chatRouting: false });
  });
});

test("a force-upgraded fresh profile records its selected engine ownership", () => {
  withProfile((config, env) => {
    assert.equal(seedFreshInstallEngineState({ ...config, engineAutoUpgrade: true }, env), true);
    const { engineChangedAt, ...state } = readEngineV2PreviewState(config);
    assert.ok(engineChangedAt && Number.isFinite(Date.parse(engineChangedAt)));
    assert.deepEqual(state, { enabled: true, chatRouting: true, engineOrigin: "fresh", engineForced: true });
  });
});

test("a profile with OpenCode v1 history stays on v1", () => {
  withProfile((config, env, dir) => {
    mkdirSync(join(dir, "opencode"), { recursive: true });
    writeFileSync(join(dir, "opencode", "opencode.db"), "");
    assert.equal(seedFreshInstallEngineState(config, env), false);
    assert.deepEqual(readEngineV2PreviewState(config), { enabled: false, chatRouting: false });
  });
});
