import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineSpawnTimeoutMs } from "../src/engine-spawn-timeout.js";
import { createManagedOpencodeServer } from "../src/managed-opencode.js";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";

// OPENWORK_ENGINE_SPAWN_TIMEOUT_MS tunes how long a managed engine may take to
// start. An explicit option wins, then the env, then each engine's own default.

const roots: string[] = [];
const previous = process.env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS;
afterEach(async () => {
  if (previous === undefined) delete process.env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS;
  else process.env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS = previous;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Both engines spawn `<bin> serve --hostname <h> --port <p> ...`, so pointing
// bin at this runtime executes the "serve" script below, on every platform and
// without a shebang. After listenAfterMs it serves a v2 health payload and
// prints the listening line both engines wait for; when omitted it never does.
async function slowEngine(listenAfterMs?: number) {
  const cwd = await mkdtemp(join(tmpdir(), "openwork-spawn-timeout-"));
  roots.push(cwd);
  const listen = listenAfterMs === undefined ? "" : `
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
setTimeout(() => {
  const server = require("node:http").createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ version: "test", pid: process.pid }));
  });
  server.listen(Number(arg("--port")), arg("--hostname"), () => {
    process.stdout.write("opencode server listening on http://" + arg("--hostname") + ":" + server.address().port + "\\n");
  });
}, ${listenAfterMs});`;
  await writeFile(join(cwd, "serve"), `setInterval(() => {}, 1 << 30);${listen}\n`, "utf8");
  return { bin: process.execPath, cwd };
}

// Engine v2 spawns in the current directory, where the "serve" script must be.
async function startV2(engine: { bin: string; cwd: string }, bootTimeoutMs?: number) {
  const previousCwd = process.cwd();
  process.chdir(engine.cwd);
  try {
    return await createManagedOpencodeV2Server({
      bin: engine.bin,
      rootDir: join(engine.cwd, "v2"),
      ...(bootTimeoutMs === undefined ? {} : { bootTimeoutMs }),
    });
  } finally {
    process.chdir(previousCwd);
  }
}

test("keeps each engine's default when unset", () => {
  expect(engineSpawnTimeoutMs(15_000, {})).toBe(15_000);
  expect(engineSpawnTimeoutMs(60_000, {})).toBe(60_000);
});

test("reads a positive override", () => {
  expect(engineSpawnTimeoutMs(15_000, { OPENWORK_ENGINE_SPAWN_TIMEOUT_MS: "90000" })).toBe(90_000);
});

test("falls back to the default for zero, negative, empty, or garbage values", () => {
  for (const value of ["0", "-1", "", "  ", "abc", "Infinity"]) {
    expect(engineSpawnTimeoutMs(15_000, { OPENWORK_ENGINE_SPAWN_TIMEOUT_MS: value })).toBe(15_000);
  }
});

test("caps values that setTimeout would treat as zero", () => {
  expect(engineSpawnTimeoutMs(15_000, { OPENWORK_ENGINE_SPAWN_TIMEOUT_MS: "99999999999" })).toBe(2_147_483_647);
});

test("v1 waits as long as the env override allows", async () => {
  process.env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS = "300";
  await expect(createManagedOpencodeServer(await slowEngine())).rejects.toThrow("Timeout waiting for OpenCode server after 300ms");
});

test("v1 lets an explicit timeoutMs win over the env override", async () => {
  process.env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS = "60000";
  const engine = await slowEngine();
  await expect(createManagedOpencodeServer({ ...engine, timeoutMs: 200 })).rejects.toThrow("Timeout waiting for OpenCode server after 200ms");
});

test("v1 times out a slow engine under a tight budget and starts it once the budget allows", async () => {
  const engine = await slowEngine(400);
  process.env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS = "100";
  await expect(createManagedOpencodeServer(engine)).rejects.toThrow("Timeout waiting for OpenCode server after 100ms");

  process.env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS = "3000";
  const server = await createManagedOpencodeServer(engine);
  try {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.isAlive()).toBe(true);
  } finally {
    await server.close();
  }
});

test("v2 waits as long as the env override allows", async () => {
  process.env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS = "300";
  await expect(startV2(await slowEngine())).rejects.toThrow("Timed out waiting 300ms for OpenCode v2 health");
});

test("v2 lets an explicit bootTimeoutMs win over the env override", async () => {
  process.env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS = "60000";
  await expect(startV2(await slowEngine(), 200)).rejects.toThrow("Timed out waiting 200ms for OpenCode v2 health");
});

test("v2 times out a slow engine under a tight budget and starts it once the budget allows", async () => {
  const engine = await slowEngine(400);
  process.env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS = "100";
  await expect(startV2(engine)).rejects.toThrow("Timed out waiting 100ms for OpenCode v2 health");

  process.env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS = "3000";
  const server = await startV2(engine);
  try {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await server.health()).healthy).toBe(true);
  } finally {
    await server.close();
  }
});
