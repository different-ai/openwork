// Unit tests for apps/desktop/electron/openshell/doctor.mjs.
// Each public component check is tested in isolation through the
// __testing export, plus the pure-JS aggregation matrix. End-to-end
// flow against a real distro lives in Phase 10's openshell.spec.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_WSL = join(__dirname, "mock-wsl.sh");
const MOCK_PWSH = join(__dirname, "mock-pwsh.sh");

let workDir;
let wslLog;
let pwshLog;

test.beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "doctor-test-"));
  wslLog = join(workDir, "wsl.log");
  pwshLog = join(workDir, "pwsh.log");
  process.env.OPENWORK_WSL_EXE = MOCK_WSL;
  process.env.OPENWORK_POWERSHELL_EXE = MOCK_PWSH;
  process.env.MOCK_WSL_LOG = wslLog;
  process.env.MOCK_PWSH_LOG = pwshLog;
  for (const key of [
    "MOCK_WSL_STDOUT",
    "MOCK_WSL_STDOUT_FILE",
    "MOCK_WSL_STDERR",
    "MOCK_WSL_EXIT",
    "MOCK_WSL_DELAY_MS",
    "MOCK_PWSH_STDOUT",
    "MOCK_PWSH_STDOUT_FILE",
    "MOCK_PWSH_STDERR",
    "MOCK_PWSH_EXIT",
  ]) {
    delete process.env[key];
  }
});

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.OPENWORK_WSL_EXE;
  delete process.env.OPENWORK_POWERSHELL_EXE;
  delete process.env.MOCK_WSL_LOG;
  delete process.env.MOCK_PWSH_LOG;
});

function readLog(path) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

const doctor = await import("../../electron/openshell/doctor.mjs");
const { __testing } = doctor;

// ── checkWindows ───────────────────────────────────────────────────────

test("checkWindows: non-win32 platform reports missing", async () => {
  // On this Linux dev box, os.platform() === 'linux', so this exercises
  // the real non-Windows path without any mocking.
  const c = await __testing.checkWindows();
  assert.equal(c.id, "windows");
  if (process.platform === "win32") {
    assert.ok(c.state === "ok" || c.state === "missing");
  } else {
    assert.equal(c.state, "missing");
    assert.match(c.detail, /OpenShell requires Windows 11/);
  }
});

// ── checkHyperV ────────────────────────────────────────────────────────

test("checkHyperV: Enabled → ok", async () => {
  process.env.MOCK_PWSH_STDOUT = "Enabled\n";
  const c = await __testing.checkHyperV();
  assert.equal(c.id, "hyperv");
  assert.equal(c.state, "ok");
  assert.equal(c.actionable, null);
});

test("checkHyperV: Disabled → missing with remediation", async () => {
  process.env.MOCK_PWSH_STDOUT = "Disabled\n";
  const c = await __testing.checkHyperV();
  assert.equal(c.state, "missing");
  assert.match(c.detail, /Disabled/);
  assert.match(c.actionable, /dism|VirtualMachinePlatform|Virtual Machine Platform/);
});

test("checkHyperV: missing feature (empty stdout) → missing", async () => {
  process.env.MOCK_PWSH_STDOUT = "";
  const c = await __testing.checkHyperV();
  assert.equal(c.state, "missing");
});

test("checkHyperV: invokes powershell with Get-WindowsOptionalFeature query", async () => {
  process.env.MOCK_PWSH_STDOUT = "Enabled";
  await __testing.checkHyperV();
  const lines = readLog(pwshLog);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /-NoProfile -NonInteractive -Command/);
  assert.match(lines[0], /Get-WindowsOptionalFeature.*VirtualMachinePlatform/);
});

// ── checkWsl ───────────────────────────────────────────────────────────

test("checkWsl: default version 2 → ok", async () => {
  process.env.MOCK_WSL_STDOUT =
    "WSL version: 2.0.0\nKernel version: 5.15\nDefault Version: 2\n";
  const c = await __testing.checkWsl();
  assert.equal(c.state, "ok");
  assert.equal(c.version, "2");
});

test("checkWsl: default version 1 → warn", async () => {
  process.env.MOCK_WSL_STDOUT = "Default Version: 1\n";
  const c = await __testing.checkWsl();
  assert.equal(c.state, "warn");
  assert.equal(c.version, "1");
  assert.match(c.actionable, /set-default-version 2/);
});

test("checkWsl: non-zero exit → missing", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  process.env.MOCK_WSL_STDERR = "WSL is not installed";
  const c = await __testing.checkWsl();
  assert.equal(c.state, "missing");
  assert.match(c.detail, /not installed/);
});

// ── checkDistro ────────────────────────────────────────────────────────

test("checkDistro: present → ok", async () => {
  process.env.MOCK_WSL_STDOUT = "Ubuntu\nopenwork-openshell\n";
  const c = await __testing.checkDistro();
  assert.equal(c.state, "ok");
});

test("checkDistro: absent → missing", async () => {
  process.env.MOCK_WSL_STDOUT = "Ubuntu\nfedora\n";
  const c = await __testing.checkDistro();
  assert.equal(c.state, "missing");
  assert.match(c.actionable, /installer/);
});

// ── checkDockerInDistro ────────────────────────────────────────────────

test("checkDockerInDistro: JSON success → ok with ServerVersion", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify({ ServerVersion: "24.0.7" });
  const c = await __testing.checkDockerInDistro();
  assert.equal(c.state, "ok");
  assert.equal(c.version, "24.0.7");
});

test("checkDockerInDistro: non-zero exit → missing", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  process.env.MOCK_WSL_STDERR = "Cannot connect to the Docker daemon";
  const c = await __testing.checkDockerInDistro();
  assert.equal(c.state, "missing");
  assert.match(c.actionable, /docker start|installer/);
});

test("checkDockerInDistro: passes docker info with --format json", async () => {
  process.env.MOCK_WSL_STDOUT = "{}";
  await __testing.checkDockerInDistro();
  const lines = readLog(wslLog);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /-d openwork-openshell -- docker info --format/);
});

// ── checkOpenShellCli ──────────────────────────────────────────────────

test("checkOpenShellCli: JSON version → ok", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify({ version: "1.2.3" });
  const c = await __testing.checkOpenShellCli();
  assert.equal(c.state, "ok");
  assert.equal(c.version, "1.2.3");
});

test("checkOpenShellCli: non-zero exit → missing", async () => {
  process.env.MOCK_WSL_EXIT = "127";
  process.env.MOCK_WSL_STDERR = "openshell: command not found";
  const c = await __testing.checkOpenShellCli();
  assert.equal(c.state, "missing");
});

// ── checkOpenShellGateway ──────────────────────────────────────────────

test("checkOpenShellGateway: gateway Ready → ok", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify({
    gateway: { state: "Ready" },
    version: "1.2.3",
  });
  const c = await __testing.checkOpenShellGateway();
  assert.equal(c.state, "ok");
});

test("checkOpenShellGateway: state-level ok shorthand → ok", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify({ state: "ok" });
  const c = await __testing.checkOpenShellGateway();
  assert.equal(c.state, "ok");
});

test("checkOpenShellGateway: gateway Crashed → warn with restart hint", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify({
    gateway: { state: "Crashed" },
  });
  const c = await __testing.checkOpenShellGateway();
  assert.equal(c.state, "warn");
  assert.match(c.actionable, /[Rr]estart/);
});

test("checkOpenShellGateway: non-zero exit → missing", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  const c = await __testing.checkOpenShellGateway();
  assert.equal(c.state, "missing");
});

// ── checkDiskUsage ─────────────────────────────────────────────────────

test("checkDiskUsage: plenty of free space → ok", async () => {
  // df -B1 --output=avail,size emits header line then data line.
  // 80 GB free of 100 GB → 80% free.
  process.env.MOCK_WSL_STDOUT =
    "    Avail      1B-blocks\n" +
    "85899345920  107374182400\n";
  const c = await __testing.checkDiskUsage();
  assert.equal(c.state, "ok");
  assert.match(c.version, /80 GB free of 100 GB|free/i);
});

test("checkDiskUsage: < 10% free → warn", async () => {
  // 8 GB free of 100 GB → 8% free.
  process.env.MOCK_WSL_STDOUT =
    "    Avail      1B-blocks\n" +
    "8589934592   107374182400\n";
  const c = await __testing.checkDiskUsage();
  assert.equal(c.state, "warn");
  assert.match(c.actionable, /docker image prune/i);
});

test("checkDiskUsage: < 5% free → missing", async () => {
  // 2 GB free of 100 GB → 2% free.
  process.env.MOCK_WSL_STDOUT =
    "    Avail      1B-blocks\n" +
    "2147483648   107374182400\n";
  const c = await __testing.checkDiskUsage();
  assert.equal(c.state, "missing");
  assert.match(c.actionable, /wsl --shrink|prune/i);
});

test("checkDiskUsage: df failure → unknown", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  process.env.MOCK_WSL_STDERR = "df: /: No such file";
  const c = await __testing.checkDiskUsage();
  assert.equal(c.state, "unknown");
});

test("checkDiskUsage: unparseable output → unknown", async () => {
  process.env.MOCK_WSL_STDOUT = "not a df table";
  const c = await __testing.checkDiskUsage();
  assert.equal(c.state, "unknown");
});

// ── checkOrphans ───────────────────────────────────────────────────────

test("checkOrphans: zero orphans → ok", async () => {
  process.env.MOCK_WSL_STDOUT = "0\n";
  const c = await __testing.checkOrphans();
  assert.equal(c.state, "ok");
  assert.equal(c.version, "0");
});

test("checkOrphans: handful (≤5) → still ok", async () => {
  process.env.MOCK_WSL_STDOUT = "3\n";
  const c = await __testing.checkOrphans();
  assert.equal(c.state, "ok");
});

test("checkOrphans: > 5 orphans → warn with restart hint", async () => {
  process.env.MOCK_WSL_STDOUT = "12\n";
  const c = await __testing.checkOrphans();
  assert.equal(c.state, "warn");
  assert.match(c.actionable, /wsl --terminate/i);
  assert.equal(c.version, "12");
});

test("checkOrphans: non-zero exit → unknown", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  const c = await __testing.checkOrphans();
  assert.equal(c.state, "unknown");
});

test("checkOrphans: non-numeric output → unknown", async () => {
  process.env.MOCK_WSL_STDOUT = "not a number";
  const c = await __testing.checkOrphans();
  assert.equal(c.state, "unknown");
});

// ── aggregateStatus matrix ─────────────────────────────────────────────

function mkComp(id, state) {
  return { id, label: id, state, version: null, detail: null };
}

test("aggregateStatus: all ok → ready", () => {
  const cs = ["windows", "hyperv", "wsl", "distro", "docker", "openshell-cli", "openshell-gateway"]
    .map((id) => mkComp(id, "ok"));
  assert.equal(__testing.aggregateStatus(cs), "ready");
});

test("aggregateStatus: any warn but no missing → degraded", () => {
  const cs = [
    mkComp("windows", "ok"),
    mkComp("hyperv", "ok"),
    mkComp("wsl", "warn"),
    mkComp("distro", "ok"),
    mkComp("docker", "ok"),
    mkComp("openshell-cli", "ok"),
    mkComp("openshell-gateway", "ok"),
  ];
  assert.equal(__testing.aggregateStatus(cs), "degraded");
});

test("aggregateStatus: missing distro → missing (not unsupported)", () => {
  const cs = [
    mkComp("windows", "ok"),
    mkComp("hyperv", "ok"),
    mkComp("wsl", "ok"),
    mkComp("distro", "missing"),
    mkComp("docker", "missing"),
    mkComp("openshell-cli", "missing"),
    mkComp("openshell-gateway", "missing"),
  ];
  assert.equal(__testing.aggregateStatus(cs), "missing");
});

test("aggregateStatus: missing Windows → unsupported", () => {
  const cs = [
    mkComp("windows", "missing"),
    mkComp("hyperv", "ok"),
    mkComp("wsl", "ok"),
    mkComp("distro", "ok"),
    mkComp("docker", "ok"),
    mkComp("openshell-cli", "ok"),
    mkComp("openshell-gateway", "ok"),
  ];
  assert.equal(__testing.aggregateStatus(cs), "unsupported");
});

test("aggregateStatus: missing Hyper-V → unsupported", () => {
  const cs = [
    mkComp("windows", "ok"),
    mkComp("hyperv", "missing"),
    mkComp("wsl", "ok"),
    mkComp("distro", "ok"),
    mkComp("docker", "ok"),
    mkComp("openshell-cli", "ok"),
    mkComp("openshell-gateway", "ok"),
  ];
  assert.equal(__testing.aggregateStatus(cs), "unsupported");
});

test("aggregateStatus: unknown without missing → degraded", () => {
  const cs = [
    mkComp("windows", "ok"),
    mkComp("hyperv", "ok"),
    mkComp("wsl", "ok"),
    mkComp("distro", "ok"),
    mkComp("docker", "unknown"),
    mkComp("openshell-cli", "ok"),
    mkComp("openshell-gateway", "ok"),
  ];
  assert.equal(__testing.aggregateStatus(cs), "degraded");
});

// ── deriveActionable / deriveFatal ─────────────────────────────────────

test("deriveActionable picks up component actionables with labels prefixed", () => {
  const cs = [
    { id: "wsl", label: "WSL2", state: "warn", version: null, detail: null, actionable: "Run X" },
    { id: "docker", label: "Docker", state: "ok", version: null, detail: null, actionable: null },
  ];
  assert.deepEqual(__testing.deriveActionable(cs), ["WSL2: Run X"]);
});

test("deriveFatal only reports missing components with a detail", () => {
  const cs = [
    { id: "wsl", label: "WSL2", state: "missing", version: null, detail: "WSL not installed", actionable: null },
    { id: "distro", label: "Distro", state: "missing", version: null, detail: null, actionable: null },
    { id: "docker", label: "Docker", state: "ok", version: null, detail: null, actionable: null },
  ];
  assert.deepEqual(__testing.deriveFatal(cs), ["WSL2: WSL not installed"]);
});

// ── openshellDoctor() integration shape ────────────────────────────────

test("openshellDoctor returns a well-formed result on non-Windows host", async () => {
  // No env mocking needed: on Linux, checkWindows returns missing
  // synchronously and the rest of the calls go through our mocks but
  // with no canned stdout (so they'll mostly report missing/unknown).
  // We just verify the result shape is sane and aggregation runs.
  process.env.MOCK_PWSH_STDOUT = "Disabled";
  process.env.MOCK_WSL_EXIT = "1";
  const result = await doctor.openshellDoctor();
  assert.ok(["ready", "degraded", "missing", "unsupported"].includes(result.status));
  assert.equal(result.components.length, 9);
  assert.deepEqual(
    result.components.map((c) => c.id),
    [
      "windows",
      "hyperv",
      "wsl",
      "distro",
      "docker",
      "openshell-cli",
      "openshell-gateway",
      "disk",
      "orphans",
    ],
  );
  assert.ok(Array.isArray(result.actionable));
  assert.ok(Array.isArray(result.fatal));
  // On Linux, "windows" is missing → unsupported.
  if (process.platform !== "win32") {
    assert.equal(result.status, "unsupported");
  }
});
