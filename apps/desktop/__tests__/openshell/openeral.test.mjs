// Unit tests for apps/desktop/electron/openshell/openeral.mjs.
//
// Uses the same mock-wsl.sh as wsl.test.mjs / doctor.test.mjs to record
// argv and emit canned stdout. Credentials are stubbed via the
// OPENWORK_TEST_CREDENTIALS_DIR env seam baked into
// openeral-credentials.mjs (plain-file storage; no Electron required).
//
// The actual docker pull + openshell sandbox create round-trip lives in
// the Phase 10 E2E spec — these unit tests verify only the argv shape,
// the validation logic, and the orchestration between sub-steps.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_WSL = join(__dirname, "mock-wsl.sh");

let workDir;
let logPath;
let credsDir;

test.beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openeral-test-"));
  logPath = join(workDir, "wsl-args.log");
  credsDir = join(workDir, "creds");
  process.env.OPENWORK_WSL_EXE = MOCK_WSL;
  process.env.MOCK_WSL_LOG = logPath;
  process.env.OPENWORK_TEST_CREDENTIALS_DIR = credsDir;
  process.env.OPENWORK_CREDENTIALS_FILE = join(workDir, "creds-prod-fallback.json");
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
  delete process.env.OPENWORK_TEST_CREDENTIALS_DIR;
  delete process.env.OPENWORK_CREDENTIALS_FILE;
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

const openeral = await import("../../electron/openshell/openeral.mjs");
const credentials = await import("../../electron/openshell/openeral-credentials.mjs");

// ── Pure helpers ───────────────────────────────────────────────────────

test("imageForProfile: maps claude profile to sandys image", () => {
  assert.equal(
    openeral.imageForProfile("openeral-claude"),
    "ghcr.io/sandys/openeral/sandbox:just-bash",
  );
});

test("imageForProfile: maps openclaw profile to sandys image (same as claude)", () => {
  // openeral README: same image, only --provider differs.
  assert.equal(
    openeral.imageForProfile("openeral-openclaw"),
    "ghcr.io/sandys/openeral/sandbox:just-bash",
  );
});

test("imageForProfile: throws on unknown profile", () => {
  assert.throws(() => openeral.imageForProfile("openeral-unknown"), /Unknown OpenEral profile/);
});

test("providerForProfile: maps claude → 'claude', openclaw → 'openclaw'", () => {
  assert.equal(openeral.providerForProfile("openeral-claude"), "claude");
  assert.equal(openeral.providerForProfile("openeral-openclaw"), "openclaw");
});

// ── ensureOpenClawProvider ─────────────────────────────────────────────

test("ensureOpenClawProvider: returns {created:true} when create succeeds", async () => {
  // Mock wsl emits 0 exit; first invocation is the create.
  process.env.MOCK_WSL_STDOUT = "ok";
  const r = await openeral.ensureOpenClawProvider();
  assert.equal(r.created, true);
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /openshell provider create --name openclaw/);
  assert.match(lines[0], /OPENERAL_AGENT=openclaw/);
});

test("ensureOpenClawProvider: falls back to update when create fails", async () => {
  // We can't make the mock fail one call and succeed the next without a
  // stateful mock. Approach: set exit=1 — both create AND update fail,
  // and we assert the error message mentions both. Then in a second
  // test below (success), we cover the happy path.
  process.env.MOCK_WSL_EXIT = "1";
  process.env.MOCK_WSL_STDERR = "boom";
  await assert.rejects(
    () => openeral.ensureOpenClawProvider(),
    /Could not ensure openclaw provider/,
  );
  const lines = readArgsLog();
  assert.equal(lines.length, 2);
  assert.match(lines[0], /provider create --name openclaw/);
  assert.match(lines[1], /provider update openclaw/);
});

// ── sandboxExists ──────────────────────────────────────────────────────

test("sandboxExists: returns true when the sandbox is in the list", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify([
    { name: "openeral-foo" },
    { name: "openeral-bar" },
  ]);
  assert.equal(await openeral.sandboxExists("openeral-foo"), true);
});

test("sandboxExists: returns false when not present", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify([{ name: "something-else" }]);
  assert.equal(await openeral.sandboxExists("openeral-foo"), false);
});

test("sandboxExists: accepts plain-string list entries", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify(["openeral-foo"]);
  assert.equal(await openeral.sandboxExists("openeral-foo"), true);
});

test("sandboxExists: returns false when list command fails", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  assert.equal(await openeral.sandboxExists("openeral-foo"), false);
});

test("sandboxExists: returns false on empty input", async () => {
  assert.equal(await openeral.sandboxExists(""), false);
});

// ── createOpenEralSandbox ──────────────────────────────────────────────

test("createOpenEralSandbox: throws when DATABASE_URL is unconfigured", async () => {
  await assert.rejects(
    () =>
      openeral.createOpenEralSandbox({
        name: "openeral-test",
        profile: "openeral-claude",
        skipImagePull: true,
      }),
    /DATABASE_URL is not configured/,
  );
});

test("createOpenEralSandbox: throws when openclaw missing ANTHROPIC_API_KEY", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  await assert.rejects(
    () =>
      openeral.createOpenEralSandbox({
        name: "openeral-test",
        profile: "openeral-openclaw",
        skipImagePull: true,
      }),
    /ANTHROPIC_API_KEY is required for OpenClaw/,
  );
});

test("createOpenEralSandbox: short-circuits when sandbox already exists", async () => {
  // listSandboxes returns our target name → existed=true, no create call.
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  process.env.MOCK_WSL_STDOUT = JSON.stringify([{ name: "openeral-resume" }]);
  const result = await openeral.createOpenEralSandbox({
    name: "openeral-resume",
    profile: "openeral-claude",
    skipImagePull: true,
  });
  assert.equal(result.existed, true);
  // Only one wsl call: the list probe.
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /openshell sandbox list --json/);
});

test("createOpenEralSandbox: claude profile builds correct argv", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  // Sandbox NOT in list, but list itself succeeds (returns [])
  process.env.MOCK_WSL_STDOUT = "[]";
  const result = await openeral.createOpenEralSandbox({
    name: "openeral-new",
    profile: "openeral-claude",
    skipImagePull: true,
  });
  assert.equal(result.existed, false);
  assert.equal(result.imageRef, "ghcr.io/sandys/openeral/sandbox:just-bash");
  assert.equal(result.provider, "claude");
  const lines = readArgsLog();
  // Expected calls: 1) sandbox list (exists check), 2) sandbox create.
  // No provider create (claude is built-in). No image pull (skipped).
  const createLine = lines.find((l) => /openshell sandbox create/.test(l));
  assert.ok(createLine, `no create line. lines=${JSON.stringify(lines)}`);
  assert.match(createLine, /--name openeral-new/);
  assert.match(createLine, /--from ghcr\.io\/sandys\/openeral\/sandbox:just-bash/);
  assert.match(createLine, /--upload .*:\/sandbox\/openeral-input/);
  assert.match(createLine, /sandbox create --tty --name openeral-new/);
  assert.match(createLine, /--provider claude --auto-providers/);
  assert.match(createLine, /--auto-providers -- openeral$/);
});

test("createOpenEralSandbox: openclaw profile ensures provider + builds argv", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  await credentials.setCredential("anthropicApiKey", "sk-ant-xxx");
  process.env.MOCK_WSL_STDOUT = "[]";
  const result = await openeral.createOpenEralSandbox({
    name: "openeral-claws",
    profile: "openeral-openclaw",
    skipImagePull: true,
  });
  assert.equal(result.provider, "openclaw");
  const lines = readArgsLog();
  // Expected calls: list, provider create (OR update), sandbox create.
  assert.ok(
    lines.some((l) => /openshell provider create --name openclaw/.test(l)),
    "provider create call expected",
  );
  const createLine = lines.find((l) => /openshell sandbox create/.test(l));
  assert.ok(createLine);
  assert.match(createLine, /--name openeral-claws/);
  assert.match(createLine, /--from ghcr\.io\/sandys\/openeral\/sandbox:just-bash/);
  assert.match(createLine, /--provider openclaw --auto-providers/);
});

test("createOpenEralSandbox: cleans up temp credential bundle after success", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  process.env.MOCK_WSL_STDOUT = "[]";
  await openeral.createOpenEralSandbox({
    name: "openeral-cleanup",
    profile: "openeral-claude",
    skipImagePull: true,
  });
  // The bundle dir was a randomly-named subdir of os.tmpdir(); the
  // staged path is in the recorded argv. After cleanup it should not
  // exist on disk.
  const lines = readArgsLog();
  const createLine = lines.find((l) => /sandbox create/.test(l));
  const uploadMatch = createLine.match(/--upload (\S+):\/sandbox\/openeral-input/);
  assert.ok(uploadMatch, "expected --upload path in argv");
  const uploadPath = uploadMatch[1];
  // Convert WSL path back to a check: toWslPath outputs /mnt/<drive>/...
  // On Linux, the input was the host path; toWslPath passes POSIX paths
  // unchanged. So the dir is the host path.
  const { existsSync } = await import("node:fs");
  assert.equal(
    existsSync(uploadPath),
    false,
    `temp credential dir ${uploadPath} should have been cleaned up`,
  );
});

test("createOpenEralSandbox: requires name and profile", async () => {
  await assert.rejects(
    () => openeral.createOpenEralSandbox({ profile: "openeral-claude" }),
    /name is required/,
  );
  await assert.rejects(
    () => openeral.createOpenEralSandbox({ name: "x" }),
    /profile is required/,
  );
});

// ── deleteOpenEralSandbox ──────────────────────────────────────────────

test("deleteOpenEralSandbox: passes --force and name through", async () => {
  process.env.MOCK_WSL_STDOUT = "";
  await openeral.deleteOpenEralSandbox("openeral-foo");
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /openshell sandbox delete openeral-foo --force/);
});

test("deleteOpenEralSandbox: rejects empty name", async () => {
  await assert.rejects(() => openeral.deleteOpenEralSandbox(""), /name is required/);
});

// ── probeDatabaseUrl ───────────────────────────────────────────────────

test("probeDatabaseUrl: throws when DATABASE_URL unset", async () => {
  await assert.rejects(() => openeral.probeDatabaseUrl(), /not configured/);
});

test("probeDatabaseUrl: runs psql in postgres:16-alpine and returns reachable", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  process.env.MOCK_WSL_STDOUT = "1";
  const r = await openeral.probeDatabaseUrl();
  assert.equal(r.ok, true);
  assert.equal(r.reachable, true);
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /docker run --rm -i -e PGCONNECT_TIMEOUT=10 postgres:16-alpine psql/);
  assert.match(lines[0], /postgresql:\/\/test\/db/);
  assert.match(lines[0], /-tAc select 1/);
});

test("probeDatabaseUrl: surfaces psql error stderr", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://bad/host");
  process.env.MOCK_WSL_EXIT = "2";
  process.env.MOCK_WSL_STDERR = "psql: connection refused";
  await assert.rejects(
    () => openeral.probeDatabaseUrl(),
    /Could not reach PostgreSQL.*connection refused/s,
  );
});
