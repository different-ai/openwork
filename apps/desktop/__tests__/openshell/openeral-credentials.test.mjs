// Unit tests for apps/desktop/electron/openshell/openeral-credentials.mjs.
//
// Uses OPENWORK_TEST_CREDENTIALS_DIR (the test seam baked into the
// module) to read/write plain files instead of going through Electron's
// safeStorage — which isn't available outside the Electron runtime
// and which a Linux dev box wouldn't have a keyring for anyway.
//
// The encrypted-at-rest behavior is covered by manual testing on each
// platform and the Phase 10 E2E spec on Windows.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir;
let testDir;

test.beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openeral-creds-test-"));
  testDir = join(workDir, "creds");
  process.env.OPENWORK_TEST_CREDENTIALS_DIR = testDir;
  // Belt-and-suspenders: also point the production-file env to a
  // temp path so an accidental fallback doesn't write to the dev's
  // real home directory.
  process.env.OPENWORK_CREDENTIALS_FILE = join(workDir, "production-creds.json");
});

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.OPENWORK_TEST_CREDENTIALS_DIR;
  delete process.env.OPENWORK_CREDENTIALS_FILE;
});

const creds = await import("../../electron/openshell/openeral-credentials.mjs");

// ── setCredential ──────────────────────────────────────────────────────

test("setCredential: rejects unknown keys", async () => {
  await assert.rejects(
    () => creds.setCredential("notARealKey", "value"),
    /Unknown OpenEral credential key/,
  );
});

test("setCredential: rejects empty values", async () => {
  await assert.rejects(
    () => creds.setCredential("databaseUrl", ""),
    /value is empty/i,
  );
  await assert.rejects(
    () => creds.setCredential("databaseUrl", "   "),
    /value is empty/i,
  );
});

test("setCredential: writes plain file in test mode", async () => {
  await creds.setCredential("databaseUrl", "postgresql://test/db");
  const written = readFileSync(join(testDir, "databaseUrl"), "utf8");
  assert.equal(written, "postgresql://test/db");
});

test("setCredential: overwrites an existing value", async () => {
  await creds.setCredential("databaseUrl", "postgresql://first");
  await creds.setCredential("databaseUrl", "postgresql://second");
  const written = readFileSync(join(testDir, "databaseUrl"), "utf8");
  assert.equal(written, "postgresql://second");
});

test("setCredential: each key writes to its own file", async () => {
  await creds.setCredential("databaseUrl", "DB");
  await creds.setCredential("anthropicApiKey", "AK");
  await creds.setCredential("stringcostApiKey", "SK");
  assert.equal(readFileSync(join(testDir, "databaseUrl"), "utf8"), "DB");
  assert.equal(readFileSync(join(testDir, "anthropicApiKey"), "utf8"), "AK");
  assert.equal(readFileSync(join(testDir, "stringcostApiKey"), "utf8"), "SK");
});

// ── getCredential ──────────────────────────────────────────────────────

test("getCredential: returns null when unset", async () => {
  const value = await creds.getCredential("databaseUrl");
  assert.equal(value, null);
});

test("getCredential: round-trips a stored value", async () => {
  await creds.setCredential("anthropicApiKey", "sk-ant-test-xyz");
  const value = await creds.getCredential("anthropicApiKey");
  assert.equal(value, "sk-ant-test-xyz");
});

test("getCredential: rejects unknown keys", async () => {
  await assert.rejects(
    () => creds.getCredential("notARealKey"),
    /Unknown OpenEral credential key/,
  );
});

// ── clearCredential ────────────────────────────────────────────────────

test("clearCredential: removes a stored value", async () => {
  await creds.setCredential("databaseUrl", "DB");
  assert.ok(existsSync(join(testDir, "databaseUrl")));
  await creds.clearCredential("databaseUrl");
  assert.ok(!existsSync(join(testDir, "databaseUrl")));
});

test("clearCredential: is idempotent when the value was never set", async () => {
  // Should not throw.
  await creds.clearCredential("stringcostApiKey");
  await creds.clearCredential("stringcostApiKey");
});

test("clearCredential: only affects the named key", async () => {
  await creds.setCredential("databaseUrl", "DB");
  await creds.setCredential("anthropicApiKey", "AK");
  await creds.clearCredential("databaseUrl");
  const stillThere = await creds.getCredential("anthropicApiKey");
  assert.equal(stillThere, "AK");
});

// ── getCredentialStatus ────────────────────────────────────────────────

test("getCredentialStatus: all unset on a fresh dir", async () => {
  const status = await creds.getCredentialStatus();
  assert.equal(status.databaseUrl, "unset");
  assert.equal(status.anthropicApiKey, "unset");
  assert.equal(status.stringcostApiKey, "unset");
});

test("getCredentialStatus: reflects mixed state", async () => {
  await creds.setCredential("databaseUrl", "DB");
  await creds.setCredential("stringcostApiKey", "SK");
  const status = await creds.getCredentialStatus();
  assert.equal(status.databaseUrl, "set");
  assert.equal(status.anthropicApiKey, "unset");
  assert.equal(status.stringcostApiKey, "set");
});

test("getCredentialStatus: encryptionAvailable is true in test mode", async () => {
  // In test mode (OPENWORK_TEST_CREDENTIALS_DIR set), we bypass
  // safeStorage entirely. The renderer treats encryptionAvailable=true
  // as "fine to save." The real safeStorage check kicks in only when
  // production-file mode is active.
  const status = await creds.getCredentialStatus();
  assert.equal(status.encryptionAvailable, true);
});
