// Unit tests for apps/desktop/electron/openshell/installer.mjs.
// The orchestrator is tested in isolation: phases are injected as
// in-memory stubs so the suite never touches wsl.exe or PowerShell and
// runs on Linux. Real-Windows end-to-end coverage lives in Phase 10's
// openshell.spec.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = await import("../../electron/openshell/installer.mjs");

let workDir;
let stateFile;

test.beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "installer-test-"));
  stateFile = join(workDir, "openshell-install.json");
});

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── state load/save ────────────────────────────────────────────────────

test("loadInstallerState returns default state when file is missing", async () => {
  const state = await installer.loadInstallerState(stateFile);
  assert.deepEqual(state.completed, []);
  assert.equal(state.rebootRequired, false);
  assert.equal(state.lastError, null);
  assert.equal(state.startedAt, null);
});

test("saveInstallerState writes to disk and stamps updatedAt", async () => {
  const before = Date.now() - 1;
  const written = await installer.saveInstallerState(
    { ...installer.__testing.defaultState(), completed: ["preflight"], startedAt: 12345 },
    stateFile,
  );
  assert.ok(written.updatedAt >= before, "updatedAt should be set");
  const onDisk = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.deepEqual(onDisk.completed, ["preflight"]);
  assert.equal(onDisk.startedAt, 12345);
});

test("loadInstallerState round-trips a saved state", async () => {
  await installer.saveInstallerState(
    { completed: ["preflight", "wsl"], rebootRequired: true, lastError: "x", startedAt: 99, updatedAt: 100 },
    stateFile,
  );
  const loaded = await installer.loadInstallerState(stateFile);
  assert.deepEqual(loaded.completed, ["preflight", "wsl"]);
  assert.equal(loaded.rebootRequired, true);
  assert.equal(loaded.lastError, "x");
});

test("normalizeState rejects malformed input and dedupes completed", () => {
  const { normalizeState } = installer.__testing;
  const result = normalizeState({
    completed: ["preflight", "wsl", "wsl", null, 42, "preflight"],
    rebootRequired: "yes",
    lastError: 7,
    startedAt: "abc",
    updatedAt: 12,
  });
  assert.deepEqual(result.completed, ["preflight", "wsl"]);
  assert.equal(result.rebootRequired, true); // truthy → true
  assert.equal(result.lastError, null); // non-string → null
  assert.equal(result.startedAt, null); // non-finite → null
  assert.equal(result.updatedAt, 12);
});

test("loadInstallerState falls back to default when file is corrupt", async () => {
  writeFileSync(stateFile, "{not json");
  const loaded = await installer.loadInstallerState(stateFile);
  assert.deepEqual(loaded.completed, []);
});

// ── orchestrator: happy path ───────────────────────────────────────────

function makeStubPhase(id, behavior = {}) {
  return {
    id,
    run: async (ctx) => {
      ctx.onProgress?.({ phase: id, message: `running ${id}`, percent: 50 });
      if (behavior.throw) {
        const err = new Error(`forced failure in ${id}`);
        if (behavior.code) err.code = behavior.code;
        throw err;
      }
      if (behavior.checkSignal && ctx.signal?.aborted) {
        const err = new Error("aborted");
        err.code = "ABORT_ERR";
        throw err;
      }
      behavior.calls?.push(id);
    },
  };
}

test("installOpenShellStack runs all phases and writes ready state", async () => {
  const calls = [];
  const phases = ["preflight", "wsl", "distro", "docker", "openshell", "verify"].map(
    (id) => makeStubPhase(id, { calls }),
  );
  const phaseEvents = [];
  const progress = [];
  const result = await installer.installOpenShellStack({
    phases,
    stateFile,
    onPhase: (id, status) => phaseEvents.push([id, status]),
    onProgress: (evt) => progress.push(evt),
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(calls, ["preflight", "wsl", "distro", "docker", "openshell", "verify"]);
  assert.deepEqual(result.state.completed, ["preflight", "wsl", "distro", "docker", "openshell", "verify"]);
  // Each phase emits a starting + done event.
  assert.equal(phaseEvents.filter(([, s]) => s === "starting").length, 6);
  assert.equal(phaseEvents.filter(([, s]) => s === "done").length, 6);
  // Progress hook was called.
  assert.equal(progress.length, 6);
});

// ── orchestrator: resume from partial state ────────────────────────────

test("installOpenShellStack skips phases already in completed[]", async () => {
  // Pre-seed state: preflight + wsl done.
  await installer.saveInstallerState(
    { ...installer.__testing.defaultState(), completed: ["preflight", "wsl"], startedAt: 1 },
    stateFile,
  );
  const calls = [];
  const phases = ["preflight", "wsl", "distro", "docker", "openshell", "verify"].map(
    (id) => makeStubPhase(id, { calls }),
  );
  const result = await installer.installOpenShellStack({ phases, stateFile });
  assert.equal(result.status, "ready");
  assert.deepEqual(calls, ["distro", "docker", "openshell", "verify"]);
});

// ── orchestrator: reboot-required ──────────────────────────────────────

test("REBOOT_REQUIRED from phaseWsl pauses install and persists state", async () => {
  const phases = [
    makeStubPhase("preflight"),
    makeStubPhase("wsl", { throw: true, code: "REBOOT_REQUIRED" }),
    makeStubPhase("distro"),
  ];
  const phaseEvents = [];
  const result = await installer.installOpenShellStack({
    phases,
    stateFile,
    onPhase: (id, status) => phaseEvents.push([id, status]),
  });
  assert.equal(result.status, "reboot_required");
  assert.equal(result.state.rebootRequired, true);
  assert.deepEqual(result.state.completed, ["preflight"]);
  // wsl phase reports reboot_required, distro never runs.
  assert.ok(phaseEvents.some(([id, s]) => id === "wsl" && s === "reboot_required"));
  assert.ok(!phaseEvents.some(([id]) => id === "distro"));

  // On next launch, the state file remembers the reboot.
  const persisted = await installer.loadInstallerState(stateFile);
  assert.equal(persisted.rebootRequired, true);
  assert.deepEqual(persisted.completed, ["preflight"]);
});

test("after a reboot, the next install run picks up where wsl left off", async () => {
  // Simulate the state left behind by the previous test.
  await installer.saveInstallerState(
    {
      ...installer.__testing.defaultState(),
      completed: ["preflight"],
      rebootRequired: true,
      lastError: "wsl: WSL2 installed. Please reboot...",
      startedAt: 1,
    },
    stateFile,
  );
  const calls = [];
  const phases = [
    makeStubPhase("preflight", { calls }),
    makeStubPhase("wsl", { calls }), // succeeds this time
    makeStubPhase("distro", { calls }),
    makeStubPhase("docker", { calls }),
    makeStubPhase("openshell", { calls }),
    makeStubPhase("verify", { calls }),
  ];
  const result = await installer.installOpenShellStack({ phases, stateFile });
  assert.equal(result.status, "ready");
  // Preflight is skipped; wsl re-runs and succeeds.
  assert.deepEqual(calls, ["wsl", "distro", "docker", "openshell", "verify"]);
  assert.equal(result.state.rebootRequired, false);
  assert.equal(result.state.lastError, null);
});

// ── orchestrator: failure propagation ──────────────────────────────────

test("phase failure persists lastError and rethrows", async () => {
  const phases = [
    makeStubPhase("preflight"),
    makeStubPhase("wsl", { throw: true }),
    makeStubPhase("distro"),
  ];
  const phaseEvents = [];
  await assert.rejects(
    installer.installOpenShellStack({
      phases,
      stateFile,
      onPhase: (id, status, err) => phaseEvents.push([id, status, err?.message]),
    }),
    /forced failure in wsl/,
  );
  const persisted = await installer.loadInstallerState(stateFile);
  assert.ok(persisted.lastError?.startsWith("wsl:"));
  assert.deepEqual(persisted.completed, ["preflight"]);
  assert.ok(phaseEvents.some(([id, s]) => id === "wsl" && s === "failed"));
});

// ── orchestrator: cancellation ─────────────────────────────────────────

test("AbortSignal stops the install between phases", async () => {
  const calls = [];
  const ac = new AbortController();
  const phases = [
    {
      id: "preflight",
      run: async (ctx) => {
        calls.push("preflight");
        ac.abort(); // abort during preflight; orchestrator should stop after
        ctx.onProgress?.({ phase: "preflight", message: "x" });
      },
    },
    makeStubPhase("wsl", { calls }),
    makeStubPhase("distro", { calls }),
  ];
  const result = await installer.installOpenShellStack({
    phases,
    stateFile,
    signal: ac.signal,
  });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, ["preflight"]); // wsl/distro never ran
  // preflight DID complete (abort happened inside the phase body but
  // after `await` returned), so it's marked done.
  assert.deepEqual(result.state.completed, ["preflight"]);
});

test("AbortSignal aborted before start returns cancelled immediately", async () => {
  const ac = new AbortController();
  ac.abort();
  const calls = [];
  const phases = [makeStubPhase("preflight", { calls }), makeStubPhase("wsl", { calls })];
  const result = await installer.installOpenShellStack({
    phases,
    stateFile,
    signal: ac.signal,
  });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, []);
});

// ── orchestrator: startedAt timestamp ──────────────────────────────────

test("startedAt is set once on first run and preserved across resumes", async () => {
  const phases = [makeStubPhase("preflight"), makeStubPhase("wsl", { throw: true })];
  await assert.rejects(installer.installOpenShellStack({ phases, stateFile }));
  const after1 = await installer.loadInstallerState(stateFile);
  assert.ok(after1.startedAt, "startedAt should be set on first run");
  const firstStart = after1.startedAt;
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(installer.installOpenShellStack({ phases, stateFile }));
  const after2 = await installer.loadInstallerState(stateFile);
  assert.equal(after2.startedAt, firstStart, "startedAt should be preserved on retry");
});
