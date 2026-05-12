// Unit tests for apps/desktop/electron/openshell/client.mjs.
// Mock wsl.exe is the same recording script as wsl.test.mjs; behavior
// for `openshell sandbox create` is simulated by emitting the
// "sandbox ready: <name>" line and then keeping the child alive via
// MOCK_WSL_DELAY_MS so the readiness detection can be observed.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_WSL = join(__dirname, "mock-wsl.sh");

let workDir;
let logPath;

test.beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "client-test-"));
  logPath = join(workDir, "args.log");
  process.env.OPENWORK_WSL_EXE = MOCK_WSL;
  process.env.MOCK_WSL_LOG = logPath;
  for (const key of [
    "MOCK_WSL_STDOUT",
    "MOCK_WSL_STDOUT_FILE",
    "MOCK_WSL_STDERR",
    "MOCK_WSL_EXIT",
    "MOCK_WSL_DELAY_MS",
    "MOCK_WSL_DELAY_BEFORE_MS",
  ]) {
    delete process.env[key];
  }
});

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.OPENWORK_WSL_EXE;
  delete process.env.MOCK_WSL_LOG;
});

function readArgsLog() {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

const client = await import("../../electron/openshell/client.mjs");

// ── createSandbox ──────────────────────────────────────────────────────

test("createSandbox: builds expected argv and resolves on ready line", async () => {
  process.env.MOCK_WSL_STDOUT =
    "preparing pod...\nsandbox ready: openwork-abc123\n";
  process.env.MOCK_WSL_DELAY_MS = "2000"; // stay alive while test asserts

  const logs = [];
  const handle = await client.createSandbox({
    name: "openwork-abc123",
    policyPath: "/mnt/c/policies/banking-strict.yaml",
    workspaceTarPath: "/mnt/c/runs/abc123/workspace.tar",
    hostPort: 51234,
    internalPort: 8080,
    command: ["sh", "/entrypoint.sh"],
    onLog: (evt) => logs.push(evt),
  });

  assert.equal(handle.name, "openwork-abc123");
  assert.ok(handle.process, "handle.process should be the spawned child");
  assert.equal(typeof handle.cleanup, "function");

  // Argv recorded by the mock during the create call.
  const lines = readArgsLog();
  assert.ok(lines[0], "create call should be logged");
  assert.match(lines[0], /-d openwork-openshell --/);
  assert.match(lines[0], /openshell sandbox create/);
  assert.match(lines[0], /--name openwork-abc123/);
  assert.match(
    lines[0],
    /--policy \/mnt\/c\/policies\/banking-strict\.yaml/,
  );
  assert.match(
    lines[0],
    /--workspace-tarball \/mnt\/c\/runs\/abc123\/workspace\.tar/,
  );
  assert.match(lines[0], /--port-forward 127\.0\.0\.1:51234:8080/);
  assert.match(lines[0], /-- sh \/entrypoint\.sh$/);

  // onLog should have captured both progress and the readiness line.
  assert.ok(
    logs.some(
      (e) => e.stream === "stdout" && e.line === "preparing pod...",
    ),
    "stdout log should include progress",
  );
  assert.ok(
    logs.some(
      (e) =>
        e.stream === "stdout" && e.line === "sandbox ready: openwork-abc123",
    ),
    "stdout log should include the ready line",
  );

  // Reset the delay so cleanup's deleteSandbox returns quickly.
  delete process.env.MOCK_WSL_DELAY_MS;
  await handle.cleanup();
});

test("createSandbox: omits --workspace-tarball when not provided", async () => {
  process.env.MOCK_WSL_STDOUT = "sandbox ready: foo\n";
  const handle = await client.createSandbox({
    name: "foo",
    policyPath: "/p.yaml",
    hostPort: 9000,
    internalPort: 80,
    command: ["true"],
  });
  assert.equal(handle.name, "foo");
  const lines = readArgsLog();
  assert.doesNotMatch(lines[0], /--workspace-tarball/);
  await handle.cleanup();
});

test("createSandbox: rejects on ready timeout", async () => {
  // No MOCK_WSL_STDOUT → mock emits nothing; readyTimeoutMs fires.
  process.env.MOCK_WSL_DELAY_MS = "5000"; // stay alive past the timeout
  await assert.rejects(
    client.createSandbox({
      name: "slow",
      policyPath: "/p.yaml",
      hostPort: 9000,
      internalPort: 80,
      command: ["sleep", "10"],
      readyTimeoutMs: 100,
    }),
    /did not report ready within 100ms/,
  );
});

test("createSandbox: rejects when the process exits before ready", async () => {
  process.env.MOCK_WSL_STDOUT = "starting...\n";
  process.env.MOCK_WSL_EXIT = "1";
  // No delay → mock emits "starting..." then immediately exits non-zero,
  // never producing the ready line.
  await assert.rejects(
    client.createSandbox({
      name: "boom",
      policyPath: "/p.yaml",
      hostPort: 9000,
      internalPort: 80,
      command: ["true"],
      readyTimeoutMs: 5000,
    }),
    /exited with code 1 before reporting ready/,
  );
});

test("createSandbox: validates required inputs", async () => {
  await assert.rejects(
    () =>
      client.createSandbox({
        policyPath: "/p.yaml",
        hostPort: 9000,
        internalPort: 80,
        command: ["true"],
      }),
    /name is required/,
  );
  await assert.rejects(
    () =>
      client.createSandbox({
        name: "x",
        hostPort: 9000,
        internalPort: 80,
        command: ["true"],
      }),
    /policyPath is required/,
  );
  await assert.rejects(
    () =>
      client.createSandbox({
        name: "x",
        policyPath: "/p.yaml",
        hostPort: 9000,
        internalPort: 80,
        command: [],
      }),
    /command must be a non-empty array/,
  );
  await assert.rejects(
    () =>
      client.createSandbox({
        name: "x",
        policyPath: "/p.yaml",
        hostPort: "nope",
        internalPort: 80,
        command: ["true"],
      }),
    /hostPort and internalPort must be numbers/,
  );
});

// ── deleteSandbox ──────────────────────────────────────────────────────

test("deleteSandbox: passes --force and the name through", async () => {
  process.env.MOCK_WSL_STDOUT = "";
  const r = await client.deleteSandbox("openwork-abc123");
  assert.equal(r.exitCode, 0);
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /-d openwork-openshell -- openshell sandbox delete openwork-abc123 --force/,
  );
});

test("deleteSandbox: rejects when name is missing", async () => {
  await assert.rejects(() => client.deleteSandbox(""), /name is required/);
});

// ── getSandboxStatus ───────────────────────────────────────────────────

test("getSandboxStatus: parses JSON from openshell sandbox status", async () => {
  const payload = { name: "foo", state: "Running", podName: "sandbox-foo" };
  process.env.MOCK_WSL_STDOUT = JSON.stringify(payload);
  const result = await client.getSandboxStatus("foo");
  assert.deepEqual(result, payload);
  const lines = readArgsLog();
  assert.match(
    lines[0],
    /openshell sandbox status foo --json/,
  );
});

test("getSandboxStatus: throws on non-zero exit", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  process.env.MOCK_WSL_STDERR = "sandbox not found";
  await assert.rejects(
    () => client.getSandboxStatus("missing"),
    /sandbox not found/,
  );
});

test("getSandboxStatus: throws on invalid JSON", async () => {
  process.env.MOCK_WSL_STDOUT = "not json at all";
  await assert.rejects(
    () => client.getSandboxStatus("foo"),
    /invalid JSON response/,
  );
});

// ── listSandboxes ──────────────────────────────────────────────────────

test("listSandboxes: parses JSON array", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify([
    { name: "a", state: "Running" },
    { name: "b", state: "Stopped" },
  ]);
  const result = await client.listSandboxes();
  assert.equal(result.length, 2);
  assert.equal(result[0].name, "a");
  const lines = readArgsLog();
  assert.match(lines[0], /openshell sandbox list --json/);
});

test("listSandboxes: throws on non-zero exit", async () => {
  process.env.MOCK_WSL_EXIT = "2";
  process.env.MOCK_WSL_STDERR = "gateway down";
  await assert.rejects(() => client.listSandboxes(), /gateway down/);
});

// ── getGatewayStatus ───────────────────────────────────────────────────

test("getGatewayStatus: parses JSON", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify({
    state: "Ready",
    podName: "openshell-gateway",
  });
  const result = await client.getGatewayStatus();
  assert.equal(result.state, "Ready");
  const lines = readArgsLog();
  assert.match(lines[0], /openshell gateway status --json/);
});

test("getGatewayStatus: throws on non-zero exit", async () => {
  process.env.MOCK_WSL_EXIT = "3";
  process.env.MOCK_WSL_STDERR = "gateway pod not found";
  await assert.rejects(
    () => client.getGatewayStatus(),
    /gateway pod not found/,
  );
});
