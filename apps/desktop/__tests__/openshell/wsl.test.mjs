// Unit tests for apps/desktop/electron/openshell/wsl.mjs.
// Uses node:test against a recording mock wsl.exe (mock-wsl.sh) so the
// suite runs on Linux/macOS dev boxes as well as Windows CI.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_WSL = join(__dirname, "mock-wsl.sh");

let workDir;
let logPath;

test.beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "wsl-test-"));
  logPath = join(workDir, "args.log");
  process.env.OPENWORK_WSL_EXE = MOCK_WSL;
  process.env.MOCK_WSL_LOG = logPath;
  delete process.env.MOCK_WSL_STDOUT;
  delete process.env.MOCK_WSL_STDOUT_FILE;
  delete process.env.MOCK_WSL_STDERR;
  delete process.env.MOCK_WSL_EXIT;
  delete process.env.MOCK_WSL_DELAY_MS;
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

// Fresh import per test would be cleaner, but the module is stateless
// modulo env vars (which we reset). One import is fine.
const wsl = await import("../../electron/openshell/wsl.mjs");

test("DISTRO_NAME is the openshell distro", () => {
  assert.equal(wsl.DISTRO_NAME, "openwork-openshell");
});

test("wslRun forwards argv to wsl.exe and decodes UTF-8 stdout", async () => {
  process.env.MOCK_WSL_STDOUT = "hello world";
  const r = await wsl.wslRun(["-d", "openwork-openshell", "--", "echo", "hi"]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "hello world");
  assert.equal(r.stderr, "");
  assert.deepEqual(readArgsLog(), ["-d openwork-openshell -- echo hi"]);
});

test("wslRun decodes UTF-16 LE output with BOM", async () => {
  const sentinel = "Default Version: 2";
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(sentinel, "utf16le"),
  ]);
  const stdoutFile = join(workDir, "out.bin");
  writeFileSync(stdoutFile, utf16);
  process.env.MOCK_WSL_STDOUT_FILE = stdoutFile;
  const r = await wsl.wslRun(["--status"]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, sentinel);
});

test("wslRun decodes UTF-16 LE output without BOM via NUL-byte heuristic", async () => {
  const sentinel = "openwork-openshell    Running         2";
  const utf16 = Buffer.from(sentinel, "utf16le");
  const stdoutFile = join(workDir, "out.bin");
  writeFileSync(stdoutFile, utf16);
  process.env.MOCK_WSL_STDOUT_FILE = stdoutFile;
  const r = await wsl.wslRun(["--list", "--verbose"]);
  assert.equal(r.stdout, sentinel);
});

test("wslRun honors a non-zero exit code", async () => {
  process.env.MOCK_WSL_EXIT = "7";
  process.env.MOCK_WSL_STDERR = "boom";
  const r = await wsl.wslRun(["whatever"]);
  assert.equal(r.exitCode, 7);
  assert.equal(r.stderr, "boom");
});

test("wslRun rejects when the command exceeds the timeout", async () => {
  process.env.MOCK_WSL_DELAY_MS = "500";
  await assert.rejects(
    wsl.wslRun(["slow"], { timeout: 50 }),
    /timed out after 50ms/,
  );
});

test("wslRun --user is injected after -d <distro>", async () => {
  process.env.MOCK_WSL_STDOUT = "";
  await wsl.wslRun(["-d", "openwork-openshell", "--", "id"], { user: "root" });
  assert.deepEqual(readArgsLog(), [
    "-d openwork-openshell --user root -- id",
  ]);
});

test("wslRun --user is prepended when no -d flag is present", async () => {
  await wsl.wslRun(["--list"], { user: "root" });
  assert.deepEqual(readArgsLog(), ["--user root --list"]);
});

test("distroExists returns true when the distro is listed", async () => {
  process.env.MOCK_WSL_STDOUT = "Ubuntu-22.04\nopenwork-openshell\n";
  assert.equal(await wsl.distroExists(), true);
  assert.deepEqual(readArgsLog(), ["--list --quiet"]);
});

test("distroExists returns false when our distro is absent", async () => {
  process.env.MOCK_WSL_STDOUT = "Ubuntu-22.04\nfedora\n";
  assert.equal(await wsl.distroExists(), false);
});

test("distroExists returns false on non-zero exit", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  assert.equal(await wsl.distroExists(), false);
});

test("distroState parses Running from --list --verbose", async () => {
  process.env.MOCK_WSL_STDOUT =
    "  NAME                  STATE           VERSION\n" +
    "* openwork-openshell    Running         2\n" +
    "  Ubuntu-22.04          Stopped         2\n";
  assert.equal(await wsl.distroState(), "Running");
});

test("distroState parses Stopped", async () => {
  process.env.MOCK_WSL_STDOUT =
    "  NAME                  STATE           VERSION\n" +
    "  openwork-openshell    Stopped         2\n";
  assert.equal(await wsl.distroState(), "Stopped");
});

test("distroState returns NotFound when the distro is absent", async () => {
  process.env.MOCK_WSL_STDOUT =
    "  NAME                  STATE           VERSION\n" +
    "  Ubuntu-22.04          Running         2\n";
  assert.equal(await wsl.distroState(), "NotFound");
});

test("ensureDistroRunning throws when the distro is not registered", async () => {
  process.env.MOCK_WSL_STDOUT = "  NAME    STATE    VERSION\n";
  await assert.rejects(
    wsl.ensureDistroRunning(),
    /is not registered/,
  );
});

test("ensureDistroRunning returns immediately when already Running", async () => {
  process.env.MOCK_WSL_STDOUT =
    "  NAME                  STATE           VERSION\n" +
    "  openwork-openshell    Running         2\n";
  await wsl.ensureDistroRunning();
  // Only the state probe should have run; no boot call.
  assert.deepEqual(readArgsLog(), ["--list --verbose"]);
});

test("toWslPath converts a Windows drive path", () => {
  assert.equal(
    wsl.toWslPath("C:\\Users\\j\\workspace"),
    "/mnt/c/Users/j/workspace",
  );
});

test("toWslPath handles forward slashes and quotes", () => {
  assert.equal(wsl.toWslPath('"D:/data/x"'), "/mnt/d/data/x");
});

test("toWslPath passes through POSIX paths unchanged", () => {
  assert.equal(wsl.toWslPath("/mnt/c/already"), "/mnt/c/already");
});

test("toWindowsPath converts a WSL mount path", () => {
  assert.equal(
    wsl.toWindowsPath("/mnt/c/Users/j/workspace"),
    "C:\\Users\\j\\workspace",
  );
});

test("toWindowsPath is the inverse of toWslPath for drive paths", () => {
  const win = "C:\\Users\\j\\workspace";
  assert.equal(wsl.toWindowsPath(wsl.toWslPath(win)), win);
});

test("toWindowsPath passes through non-mount WSL paths unchanged", () => {
  assert.equal(wsl.toWindowsPath("/etc/hostname"), "/etc/hostname");
});

test("wslSpawn.kill() runs `wsl -t openwork-openshell` to reap orphans", async () => {
  // Long-running mock so we have a child to kill.
  process.env.MOCK_WSL_DELAY_MS = "5000";
  const child = wsl.wslSpawn(["-d", "openwork-openshell", "--", "sleep", "5"]);

  const exited = new Promise((resolve) => child.on("exit", resolve));
  child.kill("SIGTERM");
  await exited;

  // Wait a tick for the reaper child's log line to flush. The reaper is
  // also a mock-wsl.sh invocation, so its args show up in the log.
  await new Promise((r) => setTimeout(r, 100));

  const lines = readArgsLog();
  assert.ok(
    lines.some((l) => l === "-t openwork-openshell"),
    `expected '-t openwork-openshell' invocation, got: ${JSON.stringify(lines)}`,
  );
});
