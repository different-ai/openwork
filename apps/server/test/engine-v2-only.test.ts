import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createEngineV2Preview } from "../src/engine-v2-preview.js";
import type { ServerConfig } from "../src/types.js";
import { openHistoryDatabase } from "../src/opencode-v2-history-store.js";
import { nativeSession } from "../src/opencode-v2-session-home.js";

async function profile(run: (config: ServerConfig, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "openwork-v2-only-"));
  const previous = { OPENWORK_RUNTIME_DB: process.env.OPENWORK_RUNTIME_DB, OPENCODE_DB: process.env.OPENCODE_DB };
  process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  process.env.OPENCODE_DB = join(dir, "v1.db");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    engineV2Only: true, engineForcePolicy: true,
  };
  try { await run(config, dir); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("v2-only mode rejects an unadopted or interrupted profile without touching history", async () => {
  await profile(async (config, dir) => {
    const source = join(dir, "v1.db");
    await writeFile(source, "retained v1 bytes");
    const stateFile = join(dir, "engine-v2-preview.json");
    for (const state of [
      { enabled: false, chatRouting: false },
      { enabled: true, chatRouting: true, automaticHistoryCopy: true },
      { enabled: true, chatRouting: true, v1HistoryCopyStartedAt: 1 },
    ]) {
      const saved = JSON.stringify(state);
      await writeFile(stateFile, saved);
      assert.throws(() => createEngineV2Preview({ config, deferStart: true }), /requires completed adoption/);
      assert.equal(await readFile(source, "utf8"), "retained v1 bytes");
      assert.equal(await readFile(stateFile, "utf8"), saved);
    }
  });
});

test("adopted v2-only mode cannot be routed back by manual or force-off requests", async () => {
  await profile(async (config, dir) => {
    await writeFile(join(dir, "v1.db"), "retained v1 bytes");
    await writeFile(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true, engineForced: true }));
    const engine = createEngineV2Preview({ config, deferStart: true });
    try {
      assert.equal(engine.setForcePolicy({ upgrade: false }).chatRouting, true);
      await assert.rejects(engine.setChatRouting(false), /no longer supported/);
      await assert.rejects(engine.setChatRouting(false, "reverted"), /no longer supported/);
      await assert.rejects(engine.setEnabled(false), /no longer supported/);
      assert.throws(() => engine.migrateHistory(), /Restore the dual-engine image/);
      assert.equal(engine.status().chatRouting, true);
      assert.equal(await readFile(join(dir, "v1.db"), "utf8"), "retained v1 bytes");
    } finally { await engine.stop(); }
  });
});

test("fresh v2-only mode selects v2 without an organization rollout or legacy override", async () => {
  await profile(async config => {
    const engine = createEngineV2Preview({ config, deferStart: true });
    try { assert.equal(engine.status().chatRouting, true); assert.equal(engine.status().enabled, true); }
    finally { await engine.stop(); }
  });
});

test("v2-only startup refuses uncopied or unreadable v1 history even with a saved v2 route", async () => {
  for (const unreadable of [false, true]) {
    await profile(async (config, dir) => {
      const source = join(dir, "v1.db");
      if (unreadable) await writeFile(source, "unreadable history");
      else {
        const db = await openHistoryDatabase(source);
        db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER); INSERT INTO session VALUES ('retained-chat', 10)");
        db.close();
      }
      const before = await readFile(source);
      await writeFile(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true, v1HistoryCopiedAt: 1 }));
      const engine = createEngineV2Preview({ config, deferStart: true });
      try {
        engine.start();
        for (let check = 0; check < 100 && !engine.status().lastError; check++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(engine.status().lastError);
        assert.equal(engine.status().running, false);
        assert.equal(engine.status().chatRouting, true, "never falls back to an absent v1 executable");
        assert.deepEqual(await readFile(source), before);
      } finally { await engine.stop(); }
    });
  }
});

test("missing v2 in a retired forced-fresh installation fails without a v1 fallback", async () => {
  await profile(async (config, dir) => {
    const previous = process.env.OPENWORK_OPENCODE2_BIN;
    process.env.OPENWORK_OPENCODE2_BIN = join(dir, "missing-opencode2");
    await writeFile(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true, engineOrigin: "fresh", engineForced: true }));
    const engine = createEngineV2Preview({ config, deferStart: true });
    try {
      engine.start();
      for (let check = 0; check < 100 && !engine.status().lastError; check++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(engine.status().lastError);
      assert.equal(engine.status().running, false);
      assert.equal(engine.status().chatRouting, true);
    } finally {
      await engine.stop();
      if (previous === undefined) delete process.env.OPENWORK_OPENCODE2_BIN; else process.env.OPENWORK_OPENCODE2_BIN = previous;
    }
  });
});

const binary = process.env.OPENWORK_OPENCODE2_BIN;
for (const web of [false, true]) {
test(`CLI${web ? " --web" : ""} starts and serves sessions with v2 only, no v1 executable or download`, { skip: !binary, timeout: 90_000 }, async () => {
  if (!binary) return;
  const dir = await mkdtemp(join(tmpdir(), "openwork-v2-only-cli-"));
  await mkdir(join(dir, "web"));
  await writeFile(join(dir, "web", "index.html"), "<!doctype html><title>V2 runtime test</title>");
  let output = "";
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), ...(web ? ["--web"] : []),
    "--workspace", dir, "--host", "127.0.0.1", "--port", "0", "--approval", "auto"], {
    env: { ...process.env, PATH: "/usr/bin:/bin", HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config"),
      XDG_CACHE_HOME: join(dir, "cache"), OPENWORK_DATA_DIR: join(dir, "openwork"),
      OPENWORK_SERVER_CONFIG: join(dir, "openwork", "server.json"), OPENWORK_RUNTIME_DB: join(dir, "runtime.sqlite"),
      OPENCODE_DB: join(dir, "v1-does-not-exist.db"), OPENWORK_TOKEN: "test-token", OPENWORK_HOST_TOKEN: "test-host",
      OPENWORK_ENGINE_V2_ONLY: "1", OPENWORK_MANAGE_OPENCODE: "1", OPENWORK_OPENCODE2_BIN: binary,
      OPENWORK_OPENCODE_BIN: join(dir, "absent-v1-executable"), OPENWORK_ENGINE_AUTO_UPGRADE: "0",
      OPENWORK_ENGINE_FORCE_POLICY: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENWORK_ENGINE_V2_PREVIEW: "sidecar",
      OPENWORK_WEB_ROOT: join(dir, "web"), OPENWORK_WEB_BOOTSTRAP_TOKEN: "0", OPENWORK_NO_UPDATE_CHECK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    let url: string | undefined;
    for (let check = 0; check < 800; check++) {
      assert.equal(child.exitCode, null, output);
      url = output.match(/OpenWork server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (url) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(url, output);
    const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
    for (let check = 0; check < 600; check++) {
      const status = await (await fetch(`${url}/experimental/engine-v2-preview/status`, { headers })).json();
      assert.equal(status.chatRouting, true);
      assert.equal(status.lastError, undefined, JSON.stringify(status));
      if (status.running) break;
      await new Promise(resolve => setTimeout(resolve, 50));
      if (check === 599) assert.fail(output);
    }
    const workspaces = await (await fetch(`${url}/workspaces`, { headers })).json();
    const workspaceId = workspaces.items[0]?.id;
    assert.equal(typeof workspaceId, "string");
    const sessionUrl = `${url}/workspace/${workspaceId}/opencode2/api/session`;
    const created = await fetch(sessionUrl, { method: "POST", headers, body: JSON.stringify({ title: "Retained v2 conversation", location: { directory: dir } }) });
    assert.equal(created.status, 200, await created.clone().text());
    const session = nativeSession(await created.json());
    assert.ok(session);
    assert.equal(typeof session.id, "string");
    const reopened = await fetch(`${sessionUrl}/${session.id}`, { headers });
    assert.equal(reopened.status, 200, await reopened.clone().text());
    assert.equal(nativeSession(await reopened.json())?.title, "Retained v2 conversation");
    const refused = await fetch(`${url}/experimental/engine-v2-preview`, { method: "PUT", headers, body: JSON.stringify({ chatRouting: false }) });
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /engine_v1_retired/);
    const policy = await fetch(`${url}/experimental/engine-v2-preview/force`, { method: "POST", headers: { ...headers, "X-OpenWork-Host-Token": "test-host" }, body: JSON.stringify({ upgrade: false }) });
    assert.equal(policy.status, 200, await policy.clone().text());
    assert.equal((await policy.json()).chatRouting, true);
  } finally {
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(kill);
    await rm(dir, { recursive: true, force: true });
  }
});
}
