// Unit tests for apps/desktop/electron/openshell/cli.mjs — the CLI
// introspection layer. We do NOT shell out to a real openshell binary
// here; the recording mock-wsl.sh handles `openshell --help`,
// `openshell --version`, and per-subcommand help probes the same way
// it does for the doctor tests.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_WSL = join(__dirname, "mock-wsl.sh");

let workDir;
let wslLog;

test.beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "cli-test-"));
  wslLog = join(workDir, "wsl.log");
  process.env.OPENWORK_WSL_EXE = MOCK_WSL;
  process.env.MOCK_WSL_LOG = wslLog;
  for (const k of ["MOCK_WSL_STDOUT", "MOCK_WSL_STDERR", "MOCK_WSL_EXIT"]) {
    delete process.env[k];
  }
});

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.OPENWORK_WSL_EXE;
  delete process.env.MOCK_WSL_LOG;
});

const cli = await import("../../electron/openshell/cli.mjs");

function readLog() {
  try {
    return readFileSync(wslLog, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

// ── extractSubcommands (pure parser, no IPC) ───────────────────────────

test("extractSubcommands parses a typical clipanion-style help block", () => {
  const text = [
    "USAGE",
    "  openshell <command> [arguments]",
    "",
    "COMMANDS",
    "  init        bootstrap policies and config",
    "  sandbox     manage sandboxes",
    "  gateway     manage the gateway endpoint",
    "  provider    manage providers",
    "",
    "OPTIONS",
    "  --help      show help",
  ].join("\n");
  const subs = cli.__testing.extractSubcommands(text);
  assert.ok(subs.has("init"));
  assert.ok(subs.has("sandbox"));
  assert.ok(subs.has("gateway"));
  assert.ok(subs.has("provider"));
  assert.ok(!subs.has("USAGE"));
  assert.ok(!subs.has("OPTIONS"));
});

test("extractSubcommands handles tab indentation and no COMMANDS header", () => {
  const text = [
    "available verbs:",
    "\tlogin\tauthenticate against a gateway",
    "\tlogout\tclear stored credentials",
    "\tlist\tlist registered gateways",
  ].join("\n");
  const subs = cli.__testing.extractSubcommands(text);
  assert.ok(subs.has("login"));
  assert.ok(subs.has("logout"));
  assert.ok(subs.has("list"));
});

test("extractSubcommands ignores empty input", () => {
  assert.equal(cli.__testing.extractSubcommands("").size, 0);
  assert.equal(cli.__testing.extractSubcommands(null).size, 0);
});

// ── getCliInfo (the main probe path) ───────────────────────────────────

test("getCliInfo: binary present, JSON version available", async () => {
  cli.__testing.clearMockCliInfo();
  cli.__testing.resetAll();
  // The first wslRun in probe() is `openshell --help`; we need its
  // stdout to look like help. Subsequent calls all reuse the same env,
  // so we use STDOUT for help and let --version fall back to plain.
  // Trick: extractSubcommands is permissive, so a single canned help
  // block doubles as both the help body and the version fallback.
  process.env.MOCK_WSL_STDOUT = [
    "COMMANDS",
    "  init     bootstrap",
    "  sandbox  manage sandboxes",
    "  gateway  manage gateways",
  ].join("\n");
  const info = await cli.getCliInfo();
  assert.equal(info.available, true);
  assert.ok(info.subcommands.has("init"));
  assert.ok(info.subcommands.has("gateway"));
  // Version probe returns the same stdout; the helper extracts a x.y.z
  // match, which our canned help doesn't contain, so version is null.
  assert.equal(info.version, null);
  assert.equal(info.error, null);
});

test("getCliInfo: non-zero exit reports available=false and surfaces stderr", async () => {
  cli.__testing.resetAll();
  process.env.MOCK_WSL_EXIT = "127";
  process.env.MOCK_WSL_STDERR = "openshell: command not found";
  const info = await cli.getCliInfo();
  assert.equal(info.available, false);
  assert.equal(info.subcommands.size, 0);
  assert.match(info.error, /command not found/);
});

test("getCliInfo caches across calls within a process", async () => {
  cli.__testing.resetAll();
  process.env.MOCK_WSL_STDOUT = "COMMANDS\n  init  bootstrap";
  await cli.getCliInfo();
  const before = readLog().length;
  await cli.getCliInfo();
  const after = readLog().length;
  assert.equal(before, after, "second getCliInfo call should not re-probe");
});

test("resetCache forces a fresh probe", async () => {
  cli.__testing.resetAll();
  process.env.MOCK_WSL_STDOUT = "COMMANDS\n  init  bootstrap";
  await cli.getCliInfo();
  const before = readLog().length;
  cli.resetCache();
  await cli.getCliInfo();
  const after = readLog().length;
  assert.ok(after > before, "resetCache should trigger another wsl call");
});

// ── hasSubcommand ──────────────────────────────────────────────────────

test("hasSubcommand: top-level lookup matches the cached help block", async () => {
  cli.__testing.resetAll();
  process.env.MOCK_WSL_STDOUT = [
    "COMMANDS",
    "  sandbox  manage sandboxes",
    "  gateway  manage gateways",
  ].join("\n");
  assert.equal(await cli.hasSubcommand(null, "sandbox"), true);
  assert.equal(await cli.hasSubcommand(null, "gateway"), true);
  assert.equal(await cli.hasSubcommand(null, "nonsense"), false);
});

test("hasSubcommand: per-parent lookup probes `openshell <parent> --help`", async () => {
  cli.__testing.resetAll();
  // We rely on the mock returning the SAME stdout for every wsl call;
  // the test seam is to assert on the call-args log instead of trying
  // to vary the stdout per call.
  process.env.MOCK_WSL_STDOUT = [
    "COMMANDS",
    "  add     register a gateway",
    "  select  pick an active gateway",
  ].join("\n");
  const yes = await cli.hasSubcommand("gateway", "add");
  const no = await cli.hasSubcommand("gateway", "start");
  assert.equal(yes, true, "add should be detected in gateway help");
  assert.equal(no, false, "start should be absent from this help block");
  // The probe must have invoked `openshell gateway --help` at least once.
  assert.ok(
    readLog().some((line) => /-d openwork-openshell -- openshell gateway --help/.test(line)),
    "expected a `gateway --help` probe in the wsl log",
  );
});

// ── mock seam (used by installer/main tests downstream) ────────────────

test("setMockCliInfo lets downstream tests skip the WSL probe entirely", async () => {
  cli.__testing.resetAll();
  cli.__testing.setMockCliInfo({
    available: true,
    version: "9.9.9",
    rawHelp: "MOCKED",
    subcommands: new Set(["init", "sandbox"]),
    parentSubcommands: { gateway: ["add", "select"] },
    error: null,
  });
  const info = await cli.getCliInfo();
  assert.equal(info.version, "9.9.9");
  assert.equal(await cli.hasSubcommand(null, "init"), true);
  assert.equal(await cli.hasSubcommand("gateway", "add"), true);
  assert.equal(await cli.hasSubcommand("gateway", "start"), false);
  // No real wsl calls should have happened.
  assert.equal(readLog().length, 0, "mocked cli info should bypass wsl entirely");
  cli.__testing.clearMockCliInfo();
});
