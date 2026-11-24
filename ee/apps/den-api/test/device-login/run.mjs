import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { withContractDatabase } from "../../../../../scripts/den-contract-database.mjs";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const realClock = process.argv.includes("--real-clock");
const caseFlag = process.argv.find((arg) => arg.startsWith("--case="));
const caseIndex = process.argv.indexOf("--case");
const caseName = caseFlag?.slice("--case=".length) ?? (caseIndex >= 0 ? process.argv[caseIndex + 1] : "delayed");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const started = performance.now();
let stage = "database setup";

// The scenario runs in a clean child. It cannot inherit provider credentials.
const hostEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap((key) =>
  process.env[key] ? [[key, process.env[key]]] : []));

try {
  assert.ok(["delayed", "denial", "expiry", "abuse-isolation"].includes(caseName), "Use --case delayed, denial, expiry, or abuse-isolation.");
  assert.ok(!realClock || caseName === "delayed", "The real-clock mode supports only the delayed case.");
  await withContractDatabase(async (databaseUrl) => {
    const env = {
      ...hostEnv,
      DATABASE_URL: databaseUrl,
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "device-login-local-encryption-key-not-production",
      BETTER_AUTH_SECRET: "device-login-local-auth-secret-not-production",
      OPENWORK_DEV_MODE: "0",
      DEN_REQUIRE_EMAIL_VERIFICATION: "false",
      DEN_PASSWORD_BREACH_SCREENING_ENABLED: "false",
      DEN_BOTID_PROTECTION_ENABLED: "false",
      DEN_AUDIT_CAPTURE_ENABLED: "false",
      DEN_ORG_MODE: "multi_org",
      LOOPS_MARKETING_ENABLED: "false",
      DEVICE_LOGIN_TEST_CLOCK: realClock ? "real" : "virtual",
      DEVICE_LOGIN_TEST_CASE: caseName,
      RENDER_GIT_COMMIT: sha,
    };
    const schema = spawnSync("pnpm", ["--filter", "@openwork-ee/den-db", "exec", "node",
      "--conditions=development", "--import", "tsx", "./node_modules/drizzle-kit/bin.cjs", "push", "--force"],
    { cwd: root, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(schema.status, 0, "Disposable schema setup must exit 0.");
    console.log("[device-login] Disposable schema ready. Database rate limiting must stay enabled.");
    stage = `${caseName} regression`;
    const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx",
      fileURLToPath(new URL("scenario.mjs", import.meta.url))], { cwd: join(root, "ee/apps/den-api"), env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    // Never print raw auth output. It can contain device codes or session tokens.
    child.stdout.resume();
    let diagnostics = "";
    child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-16_384); });
    let report;
    child.on("message", (message) => {
      if (message?.type === "device-login-result") report = message;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), realClock ? 240_000 : 60_000);
    let exitCode;
    let signal;
    try {
      [exitCode, signal] = await once(child, "exit");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    if (report) console.log(JSON.stringify({ ...report, sha, runnerSeconds: Number(((performance.now() - started) / 1000).toFixed(3)) }));
    if (!report) {
      const code = diagnostics.match(/code: '(ERR_[A-Z_]+)'/)?.[1];
      const missing = diagnostics.match(/Cannot find (?:package|module) '([^']+)'/)?.[1];
      console.error(JSON.stringify({ startupErrorCode: code ?? null, missingImport: missing ?? null }));
    }
    assert.ok(report, `The scenario must send a safe result. Child exit=${exitCode}; signal=${signal ?? "none"}.`);
    assert.equal(exitCode, 0, report.failure ?? "The selected case must succeed.");
  });
  console.log("[device-login] Passed: 1. Failed: 0. Skipped: 0.");
} catch (error) {
  console.error(`[device-login] Failed: ${stage}. SHA=${sha}. Passed: 0. Failed: 1. Skipped: 0.`);
  // Assertion messages are authored by this runner. Do not expose SQL errors.
  if (error instanceof assert.AssertionError) console.error(error.message);
  else console.error("Local setup failed. Check local MySQL and installed workspace dependencies.");
  process.exitCode = 1;
}
