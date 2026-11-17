import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopBootstrapConfigSchema } from "../../../packages/install-config/src/index.ts";
import { operationalDiagnosticSnapshotSchema } from "@openwork/types/operational-diagnostics";
import { startDesktopOperationalDiagnostics } from "../electron/operational-diagnostics.mjs";
import { createWorkspaceStore } from "../electron/workspace-store.mjs";

const config = { enabled: true, output: "file", intervalMinutes: 5 };
const bootstrap = { baseUrl: "https://example.invalid", requireSignin: false, writtenAt: "2026-11-16T12:00:00.000Z" };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("both bootstrap parsers preserve an absent block, validate enabled blocks and reject invalid ones", async () => {
  const directory = await mkdtemp(fileURLToPath(new URL("./.diagnostics-test-", import.meta.url)));
  const previous = process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = path.join(directory, "desktop-bootstrap.json");
  const store = createWorkspaceStore({ app: { getPath: () => directory }, defaultDenBaseUrl: bootstrap.baseUrl, defaultRequireSignin: false, forceRequireSignin: false });
  try {
    assert.equal(desktopBootstrapConfigSchema.parse(bootstrap).diagnostics, undefined);
    assert.equal((await store.setDesktopBootstrapConfig(bootstrap)).diagnostics, undefined);
    for (const diagnostics of [{}, config]) {
      const parsed = desktopBootstrapConfigSchema.parse({ ...bootstrap, diagnostics });
      const normalized = await store.setDesktopBootstrapConfig({ ...bootstrap, diagnostics });
      assert.deepEqual(normalized.diagnostics, parsed.diagnostics);
      assert.deepEqual((await store.getDesktopBootstrapConfig()).diagnostics, parsed.diagnostics);
      assert.equal(parsed.diagnostics.output, "file");
    }
    for (const diagnostics of [{ enabled: "true" }, { output: true }, { intervalMinutes: 4 }, { intervalMinutes: 1441 }, { intervalMinutes: 5.5 }, { destination: "remote" }, null]) {
      assert.equal(desktopBootstrapConfigSchema.safeParse({ ...bootstrap, diagnostics }).success, false);
      await assert.rejects(() => store.setDesktopBootstrapConfig({ ...bootstrap, diagnostics }));
    }
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
    else process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop requires both config and resolved flag and never starts a timer by default", () => {
  let schedules = 0;
  let writes = 0;
  const options = { directory: "unused", version: "1.2.3", runtimeStatus: async () => ({}), schedule: () => { schedules++; throw new Error("timer"); }, write: async () => { writes++; } };
  for (const gates of [{}, { config, featureEnabled: false }, { featureEnabled: true }, { config: { ...config, enabled: false }, featureEnabled: true }, { config: { ...config, output: "stdout" }, featureEnabled: true }]) {
    startDesktopOperationalDiagnostics({ ...options, ...gates })();
  }
  assert.equal(schedules, 0);
  assert.equal(writes, 0);
});

test("desktop writes one overwritten schema-valid file with current runtime states", async () => {
  const directory = await mkdtemp(fileURLToPath(new URL("./.diagnostics-test-", import.meta.url)));
  let tick;
  let timer;
  let completed;
  const firstWrite = new Promise((resolve) => { completed = resolve; });
  const stop = startDesktopOperationalDiagnostics({
    directory, version: "1.2.3", config, featureEnabled: true,
    write: async (...args) => { await writeFile(...args); completed(); },
    runtimeStatus: async () => ({ engine: { running: true }, openworkServer: { running: false } }),
    now: () => new Date("2026-11-16T12:34:56.000Z"),
    schedule: (fn, ms) => { tick = fn; timer = setInterval(fn, ms); return timer; },
  });
  try {
    assert.equal(timer.hasRef(), false);
    await firstWrite;
    await settle();
    const snapshot = operationalDiagnosticSnapshotSchema.parse(JSON.parse(await readFile(path.join(directory, "operational-diagnostic.json"), "utf8")));
    assert.equal(snapshot.components.engine, "ok");
    assert.equal(snapshot.components.localServer, "down");
    assert.equal(snapshot.components.database, "unknown");
    assert.equal(snapshot.snapshotTime, "2026-11-16T12:34:00.000Z");
    const secondWrite = new Promise((resolve) => { completed = resolve; });
    tick();
    await secondWrite;
    await settle();
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "operational-diagnostic.json"), "utf8")), snapshot);
    assert.deepEqual(await readdir(directory), ["operational-diagnostic.json"]);
  } finally {
    stop();
    await settle();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop producer failure yields unknown, invalid snapshots and write failures do not escape", async () => {
  const written = [];
  const deps = { directory: "unused", config, featureEnabled: true, version: "1.2.3", runtimeStatus: async () => { throw new Error("private"); }, makeDirectory: async () => {}, write: async (_file, body) => { written.push(JSON.parse(body)); } };
  let stop = startDesktopOperationalDiagnostics(deps);
  await settle();
  stop();
  assert.equal(written.length, 1);
  assert.ok(Object.values(written[0].components).every((value) => value === "unknown"));
  stop = startDesktopOperationalDiagnostics({ ...deps, version: "invalid" });
  await settle();
  stop();
  assert.equal(written.length, 1);
  stop = startDesktopOperationalDiagnostics({ ...deps, write: async () => { throw new Error("disk"); } });
  await settle();
  stop();
});
