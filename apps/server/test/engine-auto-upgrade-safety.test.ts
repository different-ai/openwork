import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState } from "../src/engine-v2-preview.js";
import type { ServerConfig } from "../src/types.js";

test("legacy off policy preserves forced routing and never rewrites existing database or backup files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-upgrade-safety-"));
  const previous = { OPENWORK_RUNTIME_DB: process.env.OPENWORK_RUNTIME_DB, OPENCODE_DB: process.env.OPENCODE_DB,
    OPENWORK_ENGINE_V2_PREVIEW: process.env.OPENWORK_ENGINE_V2_PREVIEW };
  process.env.OPENWORK_RUNTIME_DB = join(directory, "runtime.db");
  process.env.OPENCODE_DB = join(directory, "v1.db");
  delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    engineForcePolicy: true, engineAutoUpgrade: false,
  };
  try {
    const target = join(directory, "opencode-v2", "state", "opencode.db");
    const backup = join(directory, "opencode-v2", "backups", "baseline.db");
    await mkdir(join(directory, "opencode-v2", "state"), { recursive: true });
    await mkdir(join(directory, "opencode-v2", "backups"), { recursive: true });
    const files = [join(directory, "v1.db"), target, backup];
    for (const file of files) await writeFile(file, `Preserve original bytes: ${file}`);
    const before = await Promise.all(files.map(file => readFile(file)));
    await writeFile(join(directory, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true,
      engineOrigin: "forced", engineForced: true }));
    const engine = createEngineV2Preview({ config, deferStart: true });
    try {
      engine.setForcePolicy({ upgrade: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().engineOrigin, "forced");
      assert.equal(engine.status().engineForced, true);
    } finally { await engine.stop(); }
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
    assert.equal(readEngineV2PreviewState(config).engineOrigin, "forced");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
