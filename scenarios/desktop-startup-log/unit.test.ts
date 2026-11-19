import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "@openwork/testkit";
import { createStartupLog, startupPhase, withStartupPhase } from "../../apps/desktop/electron/startup-log.mjs";
import { startupPhase as serverStartupPhase, startupPhaseSync } from "../../apps/server/src/startup-phase.js";
import { extractArchive } from "../../apps/server/src/selfhost-web.js";
import { composeDiagnosticsBundleJson } from "../../apps/app/src/app/lib/diagnostics-bundle";

function lab() { return mkdtempSync(join(tmpdir(), "exp-spl-unit-")); }
function records(file: string) { return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)); }

test("persists paired monotonic timings for overlapping phases, including error without error data", async () => {
  const directory = lab();
  let clock = 10;
  const log = createStartupLog({ directory, now: () => clock });
  try {
    const first = startupPhase("server.start");
    clock += 50;
    const second = startupPhase("server.start");
    clock += 25;
    first(); first();
    clock += 10;
    second();
    await assert.rejects(withStartupPhase("bootstrap.apply", async () => { throw new Error("private-home/token"); }));
    startupPhase("server.restart.requested", "startup-recovery")();
    startupPhase("server.restart.requested", "https://example.invalid/?token=private")();
    const rows = records(log.filePath);
    assert.deepEqual(rows.filter((row) => row.phase === "server.restart.requested" && row.event === "start").map((row) => row.cause), ["startup-recovery", undefined]);
    assert.deepEqual(rows.filter((row) => row.event === "end" && row.phase !== "server.restart.requested").map((row) => [row.phase, row.durationMs, row.status]), [
      ["server.start", 75, "ok"], ["server.start", 35, "ok"], ["bootstrap.apply", 0, "error"],
    ]);
    assert.equal(rows.filter((row) => row.event === "stall").length, 0);
    assert.equal(readFileSync(log.filePath, "utf8").includes("private-home"), false);
  } finally { log.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an artificial three-second main-thread block retains phase attribution before the timer resumes", async () => {
  const directory = lab();
  const log = createStartupLog({ directory });
  try {
    await withStartupPhase("plugin-deps.seed", async () => {
      startupPhaseSync("plugin-deps.extract", () => {
        const until = performance.now() + 3000;
        while (performance.now() < until) { /* deliberately block the event loop */ }
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
    const rows = records(log.filePath);
    const stall = rows.find((row) => row.event === "stall");
    assert.ok(stall);
    assert.ok(stall.elapsedMs >= 3000);
    assert.ok(stall.lateMs > 2000);
    assert.deepEqual(stall.open.map((entry: { phase: string }) => entry.phase), ["plugin-deps.seed", "plugin-deps.extract"]);
    assert.ok(rows.indexOf(stall) < rows.findIndex((row) => row.event === "end" && row.phase === "plugin-deps.extract"));
    assert.equal(rows.filter((row) => row.event === "stall").length, 1);
  } finally { log.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("async extraction lasting over three seconds keeps its phase open without reporting a main-thread stall", async () => {
  const directory = lab();
  const log = createStartupLog({ directory });
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks += 1; }, 25);
  try {
    await serverStartupPhase("plugin-deps.extract", () => extractArchive("fixture.tgz", "fixture.tgz", directory, {
      // Exercise the real Promise/close-event extractor with a real child;
      // its slow work belongs off-thread, not in the artificial busy-wait above.
      spawnImpl: (_command, _args, options) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 3100)"], options),
    }));
    const rows = records(log.filePath);
    const start = rows.find((row) => row.event === "start" && row.phase === "plugin-deps.extract");
    const end = rows.find((row) => row.event === "end" && row.id === start?.id);
    assert.ok(start && end);
    assert.ok(end.durationMs >= 3000);
    assert.equal(end.status, "ok");
    assert.ok(ticks > 5, "main timers keep running while the child is pending");
    assert.equal(rows.filter((row) => row.event === "stall").length, 0);
  } finally { clearInterval(heartbeat); log.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("heartbeat detects an unattributed stall on resume and records last completed phase", async () => {
  const directory = lab();
  let clock = 0;
  const log = createStartupLog({ directory, now: () => clock, heartbeatMs: 1 });
  try {
    startupPhase("app.ready")();
    clock = 3100;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stall = records(log.filePath).find((row) => row.event === "stall");
    assert.equal(stall.lastCompleted, "app.ready");
    assert.deepEqual(stall.open, []);
    log.close();
    const before = readFileSync(log.filePath, "utf8");
    startupPhase("server.start")();
    assert.equal(readFileSync(log.filePath, "utf8"), before);
  } finally { log.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("caps both files, rotates across launches, exports only bounded logs and excludes arbitrary input", () => {
  const directory = lab();
  const log = createStartupLog({ directory, maxBytes: 1024 });
  try {
    const secret = "https://example.invalid/?token=private-grant /Users/private-person";
    channel("openwork.desktop.startup-phase").publish({ type: "start", name: secret, id: {} });
    channel("openwork.desktop.startup-phase").publish({ type: "start", name: "not-a-phase", id: {} });
    for (let index = 0; index < 60; index++) startupPhase("app.ready")();
    assert.deepEqual(readdirSync(directory).sort(), ["desktop-startup.log", "desktop-startup.log.1"]);
    for (const file of readdirSync(directory)) {
      assert.ok(statSync(join(directory, file)).size <= 1024);
      assert.equal(readFileSync(join(directory, file), "utf8").includes("private"), false);
      assert.equal(readFileSync(join(directory, file), "utf8").includes("https://"), false);
    }
    const exported = log.read();
    assert.equal(exported.filePath, "<userData>/logs/desktop-startup.log");
    assert.ok(exported.previous.length > 0 && exported.current.length > 0);
    const bundle = JSON.parse(composeDiagnosticsBundleJson({
      capturedAt: new Date().toISOString(), desktopRuntime: true, appInfo: null,
      engineInfo: null, openworkServerSettings: {}, hostInfo: null,
      developerLogs: [], perfLogs: [], desktopStartupLog: exported,
    }));
    assert.deepEqual(bundle.desktopStartupLog, exported);
    log.close();
    const previous = readFileSync(log.filePath, "utf8");
    const next = createStartupLog({ directory, maxBytes: 1024 });
    next.close();
    assert.ok(readFileSync(log.filePath, "utf8").includes(previous) || readFileSync(`${log.filePath}.1`, "utf8") === previous);
  } finally { log.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unwritable sink is best effort and leaves operation results unchanged", async () => {
  const directory = lab();
  const blocked = join(directory, "not-a-directory");
  writeFileSync(blocked, "occupied");
  const log = createStartupLog({ directory: blocked });
  try {
    assert.equal(await withStartupPhase("server.start", async () => 42), 42);
    assert.equal(log.read().current, "");
  } finally { log.close(); rmSync(directory, { recursive: true, force: true }); }
});
