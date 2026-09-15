import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { needs, test } from "@openwork/testkit";
import { sanitizedLiveProofEnvironment } from "./eng105-live-environment.ts";

// Explicitly authorized, opt-in boundary proof. No UI, DB, seed, or duplicate PUTs.
// Credentials stay in the child environment; only the setup script emits receipts.
const script = fileURLToPath(new URL("../../scripts/demo/setup-eng105-den.sh", import.meta.url));

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}

test("ENG105 authorized live setup verifies API configuration and removes only owned resources", async ({ evidence }) => {
  needs({ placement: "local", commands: ["bash", "curl", "jq"], optIn: ["ENG105_LIVE_PROOF"], env: ["DEN_API_URL", "DEN_API_KEY", "DEMO_EXPECTED_ORG_ID", "DEMO_KEY_PREFIX", "DEMO_STATE_DIR", "ENG105_RECEIPT_DIR"] });
  const output = process.env.ENG105_RECEIPT_DIR;
  const state = process.env.DEMO_STATE_DIR;
  const prefix = process.env.DEMO_KEY_PREFIX;
  assert.ok(output && state && prefix);
  // The caller pins the authorized org explicitly; no private org IDs in public code.
  assert.ok(prefix.startsWith("rsproof-") || prefix.startsWith("exp-"));
  assert.equal(process.env.DEMO_TEAMMATE_EMAIL, undefined, "This proof does not send invitations");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const run = async (phase: string, args: string[]) => {
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile("bash", [script, ...args], { env: sanitizedLiveProofEnvironment(process.env), timeout: 600_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
        if (!error) resolve({ exitCode: 0, stdout, stderr });
        else if (!error.killed && typeof error.code === "number") resolve({ exitCode: error.code, stdout, stderr });
        else reject(new Error(`Live setup ${phase} did not return; inspect owned resources before any retry`));
      });
    });
    const secret = process.env.DEN_API_KEY;
    assert.ok(secret);
    assert.equal(result.stdout.includes(secret), false, "Script stdout must not expose admin credential");
    assert.equal(result.stderr.includes(secret), false, "Script stderr must not expose admin credential");
    const parsed: unknown = JSON.parse(result.stdout);
    const receipts = rows(parsed);
    await writeFile(join(output, `${phase}.json`), JSON.stringify({ phase, exitCode: result.exitCode, receipts }, null, 2), { mode: 0o600 });
    await writeFile(join(output, `${phase}.txt`), result.stderr, { mode: 0o600 });
    return { exitCode: result.exitCode, receipts };
  };
  const connectionsOnly = process.env.ENG105_LIVE_CONNECTIONS_ONLY === "1";
  const configArgs = connectionsOnly ? ["--connections-only"] : [];
  const results: Record<string, Awaited<ReturnType<typeof run>>> = {};
  try {
    results.apply = await run("apply", configArgs);
    results.verify = await run("verify", ["--verify", ...configArgs]);
    if (results.apply.exitCode === 0 && process.env.ENG105_LIVE_REAPPLY === "1") results.reapply = await run("reapply", configArgs);
  } finally {
    results.teardown = await run("teardown", ["--teardown"]);
    results.afterTeardown = await run("after-teardown", ["--verify", "--connections-only"]);
  }
  const manifest = object(JSON.parse(await readFile(join(state, "owner.json"), "utf8")));
  const remaining = rows(manifest.resources);
  evidence.recordAssertionEvidence("Cleanup is confirmed independently of setup readiness", `Teardown exit ${results.teardown.exitCode}; unresolved owned resources ${remaining.length}. Created MCP identities were checked through independent post-teardown GETs.`, results.teardown.exitCode === 0 && remaining.length === 0);
  assert.equal(results.teardown.exitCode, 0, "All owned cleanup operations must succeed");
  assert.deepEqual(remaining, [], "Owner manifest must have no unresolved resources");
  assert.equal(manifest.org, process.env.DEMO_EXPECTED_ORG_ID);
  assert.equal(manifest.prefix, prefix);
  assert.ok(results.afterTeardown.receipts.every((row) => row.ok === true || (row.phase === "lookup-by-key" && row.status === 404)), "Post-cleanup reads must not be ambiguous HTTP errors");
  assert.ok(results.afterTeardown.receipts.filter((row) => row.phase === "lookup-list" || row.phase === "lookup-by-key").length >= 3, "Every key needs a post-cleanup lookup");
  assert.equal(results.apply.exitCode, 0, "Live apply must succeed; inspect redacted apply receipts");
  const applied = results.apply.receipts.filter((row) => row.phase === "apply");
  assert.equal(applied.length, 3);
  assert.ok(applied.every((row) => row.ok === true && (row.status === 201 || row.status === 200)));
  const createdIds = applied.filter((row) => row.status === 201).map((row) => row.connectionId);
  assert.ok(results.afterTeardown.receipts.filter((row) => row.phase === "verified-state").every((row) => !createdIds.includes(row.connectionId)));
  const verified = results.verify.receipts.filter((row) => row.phase === "verified-state");
  assert.deepEqual(verified.map((row) => [row.authType, row.credentialMode, row.orgWide]), [["none", "shared", true], ["none", "shared", true], ["oauth", "per_member", true]]);
  assert.equal(results.verify.exitCode, 0);
  evidence.recordAssertionEvidence("Live MCP configuration and cleanup", `Three MCP configurations were read back with correct auth, credential mode and org-wide access. Created count: ${createdIds.length}; teardown and post-delete reads confirmed cleanup. Calendar OAuth readiness is not claimed.`, true);
  if (results.reapply) {
    assert.equal(results.reapply.exitCode, 0);
    const reapplied = results.reapply.receipts.filter((row) => row.phase === "apply");
    assert.deepEqual(reapplied.map((row) => row.connectionId), applied.map((row) => row.connectionId));
    assert.deepEqual(reapplied.map((row) => [row.status, row.changedFields]), [[200, []], [200, []], [200, []]]);
    assert.equal(results.reapply.receipts.some((row) => row.phase === "dashboard-create" || row.phase === "dashboard-grant" || row.phase === "invite"), false);
    evidence.recordAssertionEvidence("Live MCP idempotence", "The second apply returned three HTTP200 responses with identical connection IDs and empty changedFields; no duplicate dashboard, grant or invitation writes.", true);
  }
  if (connectionsOnly) {
    evidence.recordAssertionEvidence("Explicit connections-only scope", "This run proves registration, idempotence when enabled, and cleanup only. It does not claim Calendar consent or full dashboard readiness.", true);
    return;
  }
  const manual = results.apply.receipts.filter((row) => row.phase === "manual-step");
  evidence.recordAssertionEvidence("Full three-App dashboard readiness requires member consent", `Manual prerequisites: ${manual.length}. An expected connection_not_ready response is consent enforcement, not a product bug.`, manual.length === 0);
  assert.deepEqual(manual, [], "Full three-App readiness is incomplete until the calling member connects");
  assert.ok(results.apply.receipts.some((row) => row.phase === "dashboard-verify" && row.ok === true));
  assert.ok(results.apply.receipts.some((row) => row.phase === "dashboard-access-verify" && row.ok === true));
}, 1_800_000);
