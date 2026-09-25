import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { runAuditPilot } from "../scripts/audit-pilot.js"
import { AUDIT_PILOT_HELP, AuditPilotError, PILOT_DEFAULT_CATEGORIES, PILOT_SYSTEM_ACTOR, parsePilotArgs, pilotConfigSummary, validatePilotConfig } from "../src/audit/pilot-policy.js"

const organizationId = createDenTypeId("organization")
const config = { organizationId, source: "operator", allowance: 100, attachmentWindowSeconds: 300, excessMode: "keep_all" }
const args = ["--org-id", organizationId, "--source", "operator", "--allowance", "100", "--attachment-window-seconds", "300", "--excess-mode", "keep_all"]
const invalid = (error: unknown) => error instanceof AuditPilotError && error.code === "audit_pilot_invalid_arguments"

test("default dry-run requires explicit org, source, operation allowance, attachment window and excess mode", () => {
  assert.equal(parsePilotArgs(args).mode, "dry-run")
  assert.equal(parsePilotArgs([...args, "--dry-run"]).mode, "dry-run")
  assert.equal(parsePilotArgs([...args, "--apply"]).mode, "apply")
  for (let index = 0; index < args.length; index += 2) assert.throws(() => parsePilotArgs(args.filter((_, position) => position !== index && position !== index + 1)), invalid)
  for (const more of [["--apply", "--dry-run"], ["--source", "cloud"], ["--currency", "USD"], ["--retention-days", "30"], ["--force"], ["--apply=true"], ["unexpected"], ["--help"]]) assert.throws(() => parsePilotArgs([...args, ...more]), invalid)
})

test("only implemented pilot modes are accepted, without implicit financial or downgrade configuration", () => {
  assert.equal(validatePilotConfig({ ...config, source: "cloud", excessMode: "delete_oldest" }).source, "cloud")
  assert.equal(validatePilotConfig({ ...config, excessMode: "delete_oldest" }).excessMode, "delete_oldest")
  for (const next of [
    { source: "cloud" }, { source: "unknown" }, { excessMode: "paid_overage" }, { currency: "USD" }, { rate: 1 },
    { enabled: false }, { revision: 2 }, { effectiveAt: "2026-01-01T00:00:00.000Z" }, { graceDays: 7 },
    { organizationId: "org_not-a-type-id" }, { allowance: -1 }, { allowance: 1.5 }, { allowance: Number.MAX_SAFE_INTEGER + 1 },
    { attachmentWindowSeconds: 0 }, { attachmentWindowSeconds: 86401 }, { categories: ["not-implemented"] }, { categories: ["change", "change"] },
  ]) assert.throws(() => validatePilotConfig({ ...config, ...next }), invalid)
  for (const value of ["1e3", "Infinity", "0x10", "-1", "1.5", " 100", "01", "9007199254740992"]) assert.throws(() => parsePilotArgs(args.map((arg, index) => index === 5 ? value : arg)), invalid)
  assert.equal(validatePilotConfig({ ...config, allowance: 0, attachmentWindowSeconds: 86400 }).allowance, 0)
})

test("implemented defaults are independent, configurable and lifecycle is forced even for empty selection", () => {
  assert.deepEqual(new Set(validatePilotConfig(config).categories), new Set(PILOT_DEFAULT_CATEGORIES))
  assert.deepEqual(validatePilotConfig({ ...config, categories: ["read"] }).categories, ["read", "lifecycle"])
  assert.deepEqual(validatePilotConfig({ ...config, categories: [] }).categories, ["lifecycle"])
  const parsed = parsePilotArgs([...args, "--categories", "change,request"])
  assert.ok("config" in parsed)
  assert.deepEqual(parsed.config.categories, ["change", "request", "lifecycle"])
  parsed.config.categories.pop()
  assert.ok(validatePilotConfig(config).categories.includes("lifecycle"))
})

test("operator attribution is explicitly system/self-reported, never an authenticated human or credential", () => {
  const flags = { auditCaptureEnabled: false, auditVisibilityEnabled: false, databaseUrl: "synthetic-sensitive-do-not-print" }
  const summary = pilotConfigSummary(validatePilotConfig(config), flags, "dry-run")
  assert.deepEqual(summary.actor, { type: "system", id: PILOT_SYSTEM_ACTOR, operatorReferenceIsSelfReported: false })
  assert.equal(JSON.stringify(summary).includes("synthetic-sensitive"), false)
  assert.equal(summary.auditCaptureEnabled, false)
  assert.equal(summary.auditVisibilityEnabled, false)
  assert.equal(summary.policyEventBypassesTrafficFlag, true)
  assert.equal(summary.billing, "disabled")
  assert.equal(summary.deletionEnabled, false)
  assert.equal(summary.scheduledWork, false)
  assert.equal(summary.guaranteedRetentionDays, null)
  assert.equal(summary.capacityUnit, "retained_operation")
  const identified = pilotConfigSummary(validatePilotConfig({ ...config, operatorReference: "internal-123" }), flags, "apply")
  assert.deepEqual(identified.actor, { type: "system", id: `${PILOT_SYSTEM_ACTOR}:internal-123`, operatorReferenceIsSelfReported: true })
  for (const operatorReference of ["", "a".repeat(65), "Bearer xyz", "sk-abcdefghijklmnop", "https://name:pass@example.test", "secret-reference", "line\nbreak"]) assert.throws(() => validatePilotConfig({ ...config, operatorReference }), invalid)
})

test("preview is separate read-only stored-policy mode and rejects changes or apply confirmation", () => {
  assert.deepEqual(parsePilotArgs(["--preview-retention", "--org-id", organizationId]), { mode: "preview-retention", organizationId })
  for (const extra of [["--apply"], ["--allowance", "1"], ["--operator-reference", "internal-123"], ["--dry-run"], ["--confirmation", "digest"]]) assert.throws(() => parsePilotArgs(["--preview-retention", "--org-id", organizationId, ...extra]), invalid)
  assert.throws(() => parsePilotArgs(["--preview-retention"]), invalid)
})

test("help and malformed commands never load configured credentials or a database", async () => {
  let loaded = false
  const output: string[] = []
  const errors: string[] = []
  const load = async (): Promise<never> => { loaded = true; throw new Error("must not load") }
  assert.equal(await runAuditPilot(["--help"], { out: (text) => output.push(text), error: (text) => errors.push(text) }, load), 0)
  assert.equal(await runAuditPilot(["--org-id", "synthetic-sensitive"], { out: (text) => output.push(text), error: (text) => errors.push(text) }, load), 1)
  assert.equal(loaded, false)
  assert.deepEqual(output, [AUDIT_PILOT_HELP])
  assert.deepEqual(errors, ["audit_pilot_invalid_arguments"])
  for (const text of ["NEW enabled policy", "revision 1", "PREVIEW ONLY", "one operation", "No retention days", "nonsecret", "10000", "selectionComplete", "default false", "No updates"]) assert.ok(AUDIT_PILOT_HELP.includes(text), text)
})

test("installation entitlement env is a strict default-false boolean independent of single-org and legacy gating", () => {
  for (const value of [undefined, "false", "true", "TRUE", "1", "yes", ""]) {
    const childEnv = { ...process.env, DATABASE_URL: "mysql://root:synthetic@127.0.0.1:1/audit_logs_test", DEN_DB_ENCRYPTION_KEY: "synthetic-disposable-key-1234567890123456", BETTER_AUTH_SECRET: "synthetic-disposable-auth-1234567890123456", BETTER_AUTH_URL: "http://127.0.0.1:8790", DEN_ORG_MODE: "single_org", DEN_PLAN_GATING_ENABLED: "false", DEN_AUDIT_SELF_HOSTED_ENABLED: value }
    const child = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "--eval", "const {env}=await import('./src/env.ts'); process.stdout.write(JSON.stringify(env.auditSelfHostedEnabled))"], { cwd: new URL("..", import.meta.url), env: childEnv, encoding: "utf8" })
    if (value === undefined || value === "false" || value === "true") {
      assert.equal(child.status, 0)
      assert.equal(child.stdout, String(value === "true"))
    } else assert.notEqual(child.status, 0)
  }
})

test("configuration/database failures are withheld, not serialized or blindly retried", async () => {
  const output: string[] = []
  const errors: string[] = []
  let calls = 0
  const exit = await runAuditPilot(args, { out: (text) => output.push(text), error: (text) => errors.push(text) }, async () => {
    calls++
    throw new Error("synthetic-sensitive-database-url-or-query")
  })
  assert.equal(exit, 1)
  assert.equal(calls, 1)
  assert.deepEqual(output, [])
  assert.equal(errors.length, 1)
  assert.ok(errors[0].includes("outcome_unverified"))
  assert.equal(errors[0].includes("synthetic-sensitive"), false)
})
