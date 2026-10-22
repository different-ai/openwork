import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { test } from "@openwork/testkit";
import * as managed from "../src/managed-opencode-v2.ts";
import { createEngineV2Preview, readEngineV2PreviewState } from "../src/engine-v2-preview.ts";
import type { ServerConfig } from "../src/types.ts";

test("slow v2 readiness retries with visible status and backoff without disabling a forced fresh profile", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-broker-retry-"));
  for (const [key, value] of Object.entries({
    HOME: root, USERPROFILE: root,
    XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"), OPENCODE_DB: join(root, "unused-v1.db"),
    OPENWORK_OPENCODE2_BIN: join(root, "fixture-engine"), OPENWORK_ENGINE_V2_PREVIEW: "",
    OPENCODE_MODELS_URL: "http://127.0.0.1:1/fixture-models",
  })) vi.stubEnv(key, value);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    freshInstallEngine: "v2", engineAutoUpgrade: true, engineForcePolicy: true,
  };
  const start = vi.spyOn(managed, "createManagedOpencodeV2Server").mockRejectedValue(new managed.EngineV2StartupTimeoutError("Fixture cold health deadline"));
  const fatalErrors: string[] = [];
  const preview = createEngineV2Preview({ config, deferStart: true, autoUpgradeError: error => fatalErrors.push(error) });
  try {
    preview.start();
    await expect.poll(() => preview.status().lastError, { timeout: 2_000, interval: 25 }).toContain("Retrying in 5 seconds");
    assert.equal(start.mock.calls.length, 1);
    assert.equal(preview.status().enabled, true);
    assert.equal(preview.status().chatRouting, true);
    assert.equal(preview.status().engineForced, true);
    assert.notEqual(preview.status().migration.state, "error");
    await expect.poll(() => preview.status().lastError, { timeout: 8_000, interval: 25 }).toContain("Retrying in 10 seconds");
    assert.equal(start.mock.calls.length, 2, "one retry, not a restart storm");
    assert.equal(preview.status().enabled, true);
    assert.equal(preview.status().chatRouting, true);
    assert.equal(preview.status().engineForced, true);
    assert.equal(readEngineV2PreviewState(config).enabled, true);
    assert.deepEqual(fatalErrors, [], "a slow engine is not reported as a fatal forced-upgrade failure");
    evidence.recordAssertionEvidence("Slow v2 startup retries visibly without disabling the fresh profile", "Exactly two attempts, 5 s then 10 s status/backoff, enabled chat routing and forced ownership retained, no fatal callback.", true);
  } finally {
    await preview.stop();
    start.mockRestore();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
