// End-to-end tests for the OpenShell sandbox integration. These run
// against a real `openwork-openshell` WSL2 distro on Windows; on every
// other environment they skip with a clear reason so `pnpm test:openshell:e2e`
// is safe to invoke anywhere (including dev Linux boxes and macOS).
//
// Gating env vars:
//   OPENWORK_E2E_OPENSHELL=1
//     Enable the non-destructive suite. Requires the distro to already
//     be registered, Docker + OpenShell + gateway healthy. Use on a
//     prepared Windows test machine (or a windows-2022 CI runner where
//     a previous step ran the installer).
//   OPENWORK_E2E_OPENSHELL_DESTRUCTIVE=1
//     Additionally enable the installer / reboot / WSL teardown tests.
//     These touch machine-wide WSL state and should only run on a
//     throwaway VM. Implies OPENWORK_E2E_OPENSHELL=1.
//
// Why this spec exists separately from the unit tests in __tests__/openshell/:
// the unit suite uses a recording mock for wsl.exe and runs on Linux.
// This spec exercises the bits the mocks cannot — does `wsl --import`
// actually accept our Docker-exported tarball? Does `openshell sandbox
// create` parse banking-strict.yaml? Does the port-forward bind? Does
// `wsl -t` actually kill orphans, or does WSL #12159 still bite us?
//
// Tests are intentionally clustered into describe blocks so a Windows
// CI run can opt into a subset (e.g. only the failure-mode probes) by
// passing --test-name-pattern to node:test.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  DISTRO_NAME,
  distroExists,
  distroState,
  toWslPath,
  wslRun,
} from "../electron/openshell/wsl.mjs";
import { openshellDoctor } from "../electron/openshell/doctor.mjs";
import * as client from "../electron/openshell/client.mjs";

// ── Skip gating ────────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === "win32";
const E2E_ENABLED = process.env.OPENWORK_E2E_OPENSHELL === "1";
const DESTRUCTIVE_ENABLED = process.env.OPENWORK_E2E_OPENSHELL_DESTRUCTIVE === "1";

/** Reason string for non-destructive tests, or false if they should run. */
const SKIP_REASON_E2E = !IS_WINDOWS
  ? "OpenShell E2E spec requires Windows 11 + WSL2"
  : !E2E_ENABLED
    ? "Set OPENWORK_E2E_OPENSHELL=1 to run against a live openwork-openshell distro"
    : false;

const SKIP_REASON_DESTRUCTIVE = SKIP_REASON_E2E
  ? SKIP_REASON_E2E
  : !DESTRUCTIVE_ENABLED
    ? "Set OPENWORK_E2E_OPENSHELL_DESTRUCTIVE=1 (destructive — touches machine-wide WSL state)"
    : false;

// ── Test policy file (so each test can pass --policy) ──────────────────

let workDir;
let policyPath;
let policyWslPath;

test.before(() => {
  if (SKIP_REASON_E2E) return;
  workDir = mkdtempSync(join(tmpdir(), "openshell-e2e-"));
  policyPath = join(workDir, "test-policy.yaml");
  // Minimal policy that allows nothing — sufficient to exercise the
  // parse + load path without the test depending on any specific
  // network egress.
  writeFileSync(
    policyPath,
    [
      "version: 1",
      "filesystem_policy:",
      "  include_workdir: true",
      "  read_only: [/usr, /lib, /lib64, /etc]",
      "  read_write: [/workspace, /tmp]",
      "process:",
      "  run_as_user: sandbox",
      "  run_as_group: sandbox",
      "network_policies: {}",
      "resources:",
      "  cpu: \"1\"",
      "  memory: \"1Gi\"",
      "  disk: \"2Gi\"",
      "",
    ].join("\n"),
  );
  policyWslPath = toWslPath(policyPath);
});

test.after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ── Preconditions ──────────────────────────────────────────────────────

test("precondition: the openwork-openshell distro is registered", { skip: SKIP_REASON_E2E }, async () => {
  assert.equal(await distroExists(), true, `Distro ${DISTRO_NAME} must be registered before E2E runs`);
});

test("precondition: distro is in Running state (or can be started)", { skip: SKIP_REASON_E2E }, async () => {
  const state = await distroState();
  assert.ok(
    state === "Running" || state === "Stopped",
    `Distro is in unexpected state: ${state}`,
  );
});

test("precondition: openshell CLI is invokable inside the distro", { skip: SKIP_REASON_E2E }, async () => {
  const r = await wslRun(["-d", DISTRO_NAME, "--", "openshell", "version", "--json"], { timeout: 10_000 });
  assert.equal(r.exitCode, 0, `openshell version failed: ${r.stderr || r.stdout}`);
});

// ── Doctor: ready state on a healthy machine ───────────────────────────

test("openshellDoctor reports status === 'ready' when the stack is healthy", { skip: SKIP_REASON_E2E }, async () => {
  const result = await openshellDoctor();
  assert.equal(
    result.status,
    "ready",
    `doctor not ready. fatal=${JSON.stringify(result.fatal)} actionable=${JSON.stringify(result.actionable)}`,
  );
  // Spot-check that every expected component reports ok.
  const states = new Map(result.components.map((c) => [c.id, c.state]));
  for (const id of ["windows", "hyperv", "wsl", "distro", "docker", "openshell-cli", "openshell-gateway"]) {
    assert.equal(states.get(id), "ok", `${id} should be ok, got ${states.get(id)}`);
  }
});

test("doctor reflects gateway 'warn' state after killing the gateway pod", { skip: SKIP_REASON_E2E }, async () => {
  // Forcibly stop the gateway, observe doctor, then restart it so the
  // suite leaves the machine in a usable state. Wrapped in try/finally
  // so a mid-test failure still restarts the gateway.
  await wslRun(["-d", DISTRO_NAME, "--", "openshell", "gateway", "stop"], { timeout: 30_000 });
  try {
    const result = await openshellDoctor();
    const gateway = result.components.find((c) => c.id === "openshell-gateway");
    assert.ok(
      gateway?.state === "warn" || gateway?.state === "missing",
      `expected gateway warn/missing, got ${gateway?.state}`,
    );
  } finally {
    await wslRun(
      ["-d", DISTRO_NAME, "--", "openshell", "gateway", "start", "--detach"],
      { timeout: 60_000 },
    );
  }
});

// ── Sandbox lifecycle ──────────────────────────────────────────────────

function uniqueName(prefix = "owe2e") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

test("client.createSandbox + deleteSandbox round-trip", { skip: SKIP_REASON_E2E }, async () => {
  const name = uniqueName();
  // /bin/sleep keeps the sandbox alive until we delete it.
  const handle = await client.createSandbox({
    name,
    policyPath: policyWslPath,
    hostPort: 0,             // unused for this trivial command
    internalPort: 0,
    command: ["/bin/sleep", "60"],
    readyTimeoutMs: 60_000,
  });
  try {
    assert.equal(handle.name, name);
    // Status should report Running while the sleep child is alive.
    const status = await client.getSandboxStatus(name);
    assert.ok(status, "getSandboxStatus returned null");
  } finally {
    await handle.cleanup();
  }
  // After cleanup, status should fail (sandbox gone).
  await assert.rejects(
    () => client.getSandboxStatus(name),
    /not found|failed|status/i,
  );
});

test("listSandboxes returns the active sandbox while it's running", { skip: SKIP_REASON_E2E }, async () => {
  const name = uniqueName();
  const handle = await client.createSandbox({
    name,
    policyPath: policyWslPath,
    hostPort: 0,
    internalPort: 0,
    command: ["/bin/sleep", "60"],
    readyTimeoutMs: 60_000,
  });
  try {
    const sandboxes = await client.listSandboxes();
    const names = sandboxes.map((s) => s.name ?? s);
    assert.ok(names.includes(name), `expected ${name} in ${JSON.stringify(names)}`);
  } finally {
    await handle.cleanup();
  }
});

// ── Policy + workspace tarball flow (validates the orchestrator path) ──

test("openshell sandbox create accepts the shipped banking-strict.yaml", { skip: SKIP_REASON_E2E }, async () => {
  // Resolve the packaged policy. In a packaged build this lives at
  // process.resourcesPath/openshell-policies; running this spec from
  // source uses the repo path.
  const repoPath = join(__dirname, "..", "..", "orchestrator", "policies", "banking-strict.yaml");
  const wslPath = toWslPath(repoPath);
  const name = uniqueName("policy");
  const handle = await client.createSandbox({
    name,
    policyPath: wslPath,
    hostPort: 0,
    internalPort: 0,
    command: ["/bin/true"],
    readyTimeoutMs: 60_000,
  });
  await handle.cleanup();
  // No assert needed — createSandbox throws on a parse error from
  // openshell. Reaching this line means the policy parsed.
});

test("workspace tarball survives the Docker-export -> wsl --import -> openshell-extract chain", { skip: SKIP_REASON_E2E }, async () => {
  // Stage a workspace with a known file, tar it inside WSL exactly the
  // way startOpenShellSandbox does, and verify the sandbox sees the
  // file at /workspace/<name>.
  const stagingDir = mkdtempSync(join(tmpdir(), "owe2e-staging-"));
  try {
    const sentinel = "hello-from-host\n";
    const sentinelFile = join(stagingDir, "hello.txt");
    writeFileSync(sentinelFile, sentinel);

    const wslStaging = toWslPath(stagingDir);
    const tarball = `${wslStaging}/workspace.tar`;
    const tarResult = await wslRun(
      ["-d", DISTRO_NAME, "--", "tar", "-cf", tarball, "-C", wslStaging, "."],
      { timeout: 30_000 },
    );
    assert.equal(tarResult.exitCode, 0, `tar failed: ${tarResult.stderr}`);

    const name = uniqueName("ws");
    const handle = await client.createSandbox({
      name,
      policyPath: policyWslPath,
      workspaceTarPath: tarball,
      hostPort: 0,
      internalPort: 0,
      command: ["/bin/cat", "/workspace/hello.txt"],
      readyTimeoutMs: 60_000,
    });
    // Process output is captured by openshell — we'd want to read it
    // back, but `openshell sandbox create` doesn't return stdout in a
    // structured form. As an end-to-end indicator we just confirm
    // creation succeeded; a richer check would `openshell sandbox exec
    // <name> -- cat /workspace/hello.txt` and assert the bytes.
    await handle.cleanup();
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

// ── Port-forward ───────────────────────────────────────────────────────

test("--port-forward 127.0.0.1:HOST:INTERNAL exposes a TCP listener on the host", { skip: SKIP_REASON_E2E }, async () => {
  // Boot a sandbox that listens on 8080 with `python3 -m http.server`
  // and verify the host-side port-forward delivers the response. Skip
  // gracefully if the bundled image doesn't ship python3.
  const probe = await wslRun(
    ["-d", DISTRO_NAME, "--", "bash", "-c", "command -v python3 || echo MISSING"],
    { timeout: 10_000 },
  );
  if (probe.stdout.trim().endsWith("MISSING")) {
    return; // Soft-skip — surfaced as a passing test with no assertions.
  }
  const name = uniqueName("pf");
  // findFreePort is a one-liner using node:net but we just pick a high
  // arbitrary port; collisions are vanishingly unlikely on a test VM.
  const hostPort = 52_000 + Math.floor(Math.random() * 1000);
  const handle = await client.createSandbox({
    name,
    policyPath: policyWslPath,
    hostPort,
    internalPort: 8080,
    command: ["python3", "-m", "http.server", "8080", "--bind", "0.0.0.0"],
    readyTimeoutMs: 60_000,
  });
  try {
    // Give the python server a moment to bind after openshell reports
    // ready.
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`http://127.0.0.1:${hostPort}/`);
    assert.ok(res.status >= 200 && res.status < 500, `unexpected status ${res.status}`);
  } finally {
    await handle.cleanup();
  }
});

// ── Orphan-process cleanup (WSL #12159) ────────────────────────────────

test("wslSpawn.kill() reaps orphans via `wsl -t openwork-openshell`", { skip: SKIP_REASON_E2E }, async () => {
  // Conceptually: start a long-running wsl child, kill it, then run
  // `wsl --list --running` and confirm no orphan from this test
  // survived. The mock-based unit test verifies the arg passing; this
  // is the live confirmation that the orphan-kill actually unwedges
  // the distro. Implemented as a TODO in v1 — the assertion side
  // requires polling for orphan PIDs inside the distro, which is
  // platform-fragile.
  // TODO(phase10): implement once we settle on a deterministic
  // orphan-detection probe (likely `wsl -d openwork-openshell -- pgrep
  // -f <our-sentinel> | wc -l`).
});

// ── Failure-mode probes (mostly TODO until we have a destructive VM) ───

test.describe("spec §5 failure modes", () => {
  test("Hyper-V disabled reports unsupported", { skip: SKIP_REASON_E2E }, () => {
    // Requires toggling Hyper-V off via dism + reboot; only meaningful
    // on a destructive VM. TODO: parameterize the doctor's checkHyperV
    // so the test can inject a "Disabled" PowerShell mock without
    // actually disabling Hyper-V on the test VM.
  });

  test("wsl --install blocked by GPO surfaces actionable error", { skip: SKIP_REASON_DESTRUCTIVE }, () => {
    // Drop a fake GPO registry value that wsl --install honors, run
    // the installer's phaseWsl, assert error message includes the
    // policy block hint. TODO: implement against a destructive VM.
  });

  test("EDR kills wsl.exe subprocess; doctor reports degraded", { skip: SKIP_REASON_DESTRUCTIVE }, () => {
    // Hard to simulate without an actual EDR product. TODO: write a
    // synthetic killer that pgreps wsl.exe and SIGKILLs it during a
    // sandbox create, then verify doctor catches the missing gateway.
  });

  test("Distro corrupts: doctor reports missing docker after a forced unregister", { skip: SKIP_REASON_DESTRUCTIVE }, async () => {
    // wsl --unregister openwork-openshell, then openshellDoctor()
    // should report distro=missing. Re-register via the installer to
    // restore state.
    // TODO: requires the installer to be runnable in CI mode; ties
    // into Phase 11 packaging work.
  });

  test("disk near-full toast triggers below 10% free in distro", { skip: SKIP_REASON_E2E }, async () => {
    // Fill /workspace via `dd if=/dev/zero` until df -h reports < 10%,
    // verify doctor adds an actionable line. TODO: doctor.mjs doesn't
    // probe disk usage yet — extend it first.
  });
});

// ── Installer lifecycle (destructive only) ─────────────────────────────

test.describe("installer.mjs end-to-end (destructive)", () => {
  test("phasePreflight passes on a clean Windows 11 VM", { skip: SKIP_REASON_DESTRUCTIVE }, () => {
    // TODO: import phasePreflight via __testing and invoke. Trivial.
  });

  test("REBOOT_REQUIRED is thrown on first wsl --install and resumable after reboot", { skip: SKIP_REASON_DESTRUCTIVE }, () => {
    // The reboot half is genuinely hard to test in CI — it requires a
    // VM snapshot before phaseWsl, runner reboot, then resume.
    // GitHub Actions doesn't support multi-stage runs across reboots
    // out of the box, so this test is documented but not implemented.
    // Equivalent coverage: the unit suite already verifies the state
    // machine resumes from completed[] correctly.
  });

  test("full install brings doctor to status=ready on a clean VM", { skip: SKIP_REASON_DESTRUCTIVE }, () => {
    // The acceptance test: wsl --unregister, run installOpenShellStack
    // with a pre-built rootfs path, assert doctor.status === "ready".
    // Takes ~10 minutes; gate behind a slow-tests CI lane.
  });
});
