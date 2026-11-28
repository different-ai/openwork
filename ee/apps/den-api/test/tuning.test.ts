import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { DEN_API_ENV_GROUPS } from "../src/env-schema.js"
import { TUNING_ENV_NAMES, readTuning, type Tuning, type TuningEnvName } from "../src/tuning.js"

type Reading = number | undefined
type Reader = (value: string | undefined) => Reading

const plain = (fallback: string): Reader => (value) => Number(value ?? fallback)
const positive = (fallback: number): Reader => (value) => {
  const tuned = Number(value)
  return Number.isSafeInteger(tuned) && tuned > 0 ? tuned : fallback
}

/** How env.ts read each variable before these moved to tuning.ts, expression for expression. */
const BEFORE: Record<TuningEnvName, Reader> = {
  SCIM_MAINTENANCE_INTERVAL_MS: plain("300000"),
  LIFECYCLE_EMAILS_INTERVAL_MS: plain("900000"),
  ADMIN_METRICS_FAST_INTERVAL_MS: (value) => Math.max(60_000, Number(value ?? "300000") || 300_000),
  ADMIN_METRICS_HEAVY_INTERVAL_MS: (value) => Math.max(300_000, Number(value ?? "1800000") || 1_800_000),
  MCP_REGISTRATION_PROBE_INTERVAL_MS: (value) => Math.max(3_600_000, Number(value ?? "86400000") || 86_400_000),
  GITHUB_SYNC_WORKER_INTERVAL_MS: plain("5000"),
  GITHUB_SYNC_RETRY_BASE_MS: plain("30000"),
  GITHUB_SYNC_MAX_ATTEMPTS: plain("5"),
  GITHUB_RECONCILE_BATCH_SIZE: plain("25"),
  GITHUB_RECONCILE_MIN_AGE_MS: plain("21600000"),
  GITHUB_RECONCILE_MAX_BATCHES: plain("20"),
  GITHUB_RECONCILE_RUN_BUDGET_MS: plain("45000"),
  GITHUB_RECONCILE_PROBE_CONCURRENCY: plain("4"),
  WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: plain("60000"),
  WORKER_PROVISIONING_RECONCILE_STALE_MS: plain("180000"),
  WORKER_PROVISIONING_RECONCILE_BATCH_SIZE: plain("10"),
  CLOUD_PROVISION_DEADLINE_MS: plain("900000"),
  CLOUD_MATERIALIZATION_FAILURE_COOLDOWN_MS: plain("120000"),
  CLOUD_IDLE_STOP_MINUTES: (value) => Number(value ?? "30") * 60_000,
  CLOUD_IDLE_LOOP_SECONDS: (value) => Number(value ?? "60") * 1000,
  CLOUD_IDLE_STOP_BATCH_SIZE: plain("10"),
  CLOUD_ACTIVITY_PROBE_TIMEOUT_MS: plain("10000"),
  CLOUD_UNREACHABLE_GRACE_MS: plain("60000"),
  CLOUD_STOP_FLUSH_TIMEOUT_MS: plain("20000"),
  DEN_AUTOMATIONS_POLL_INTERVAL_MS: positive(15_000),
  DEN_AUTOMATIONS_BATCH_SIZE: positive(25),
  DEN_AUTOMATIONS_LEASE_MS: positive(60_000),
  DEN_AUTOMATIONS_RUN_TIMEOUT_MS: positive(900_000),
  DEN_AUTOMATIONS_RUNNER_CLAIM_DEADLINE_MS: positive(900_000),
  RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS: plain("240000"),
  RENDER_PROVISION_TIMEOUT_MS: plain("900000"),
  RENDER_HEALTHCHECK_TIMEOUT_MS: plain("180000"),
  RENDER_POLL_INTERVAL_MS: plain("5000"),
  DAYTONA_CREATE_TIMEOUT_SECONDS: plain("300"),
  DAYTONA_DELETE_TIMEOUT_SECONDS: plain("120"),
  DAYTONA_STOP_TIMEOUT_SECONDS: (value) => value === undefined ? undefined : Number(value),
  DAYTONA_HEALTHCHECK_TIMEOUT_MS: plain("300000"),
  DEN_CKPT_INTERVAL_SECONDS: plain("300"),
  DEN_CKPT_KEEP: plain("3"),
}

/** Where each variable ends up in what tuning.ts returns. */
const NOW: Record<TuningEnvName, (tuning: Tuning) => Reading> = {
  SCIM_MAINTENANCE_INTERVAL_MS: (tuning) => tuning.scimMaintenanceIntervalMs,
  LIFECYCLE_EMAILS_INTERVAL_MS: (tuning) => tuning.lifecycleEmailsIntervalMs,
  ADMIN_METRICS_FAST_INTERVAL_MS: (tuning) => tuning.adminMetrics.fastIntervalMs,
  ADMIN_METRICS_HEAVY_INTERVAL_MS: (tuning) => tuning.adminMetrics.heavyIntervalMs,
  MCP_REGISTRATION_PROBE_INTERVAL_MS: (tuning) => tuning.mcpRegistrationProbeIntervalMs,
  GITHUB_SYNC_WORKER_INTERVAL_MS: (tuning) => tuning.githubSync.workerIntervalMs,
  GITHUB_SYNC_RETRY_BASE_MS: (tuning) => tuning.githubSync.retryBaseMs,
  GITHUB_SYNC_MAX_ATTEMPTS: (tuning) => tuning.githubSync.maxAttempts,
  GITHUB_RECONCILE_BATCH_SIZE: (tuning) => tuning.githubSync.reconcileBatchSize,
  GITHUB_RECONCILE_MIN_AGE_MS: (tuning) => tuning.githubSync.reconcileMinAgeMs,
  GITHUB_RECONCILE_MAX_BATCHES: (tuning) => tuning.githubSync.reconcileMaxBatches,
  GITHUB_RECONCILE_RUN_BUDGET_MS: (tuning) => tuning.githubSync.reconcileRunBudgetMs,
  GITHUB_RECONCILE_PROBE_CONCURRENCY: (tuning) => tuning.githubSync.reconcileProbeConcurrency,
  WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: (tuning) => tuning.workerProvisioning.reconcileIntervalMs,
  WORKER_PROVISIONING_RECONCILE_STALE_MS: (tuning) => tuning.workerProvisioning.reconcileStaleMs,
  WORKER_PROVISIONING_RECONCILE_BATCH_SIZE: (tuning) => tuning.workerProvisioning.reconcileBatchSize,
  CLOUD_PROVISION_DEADLINE_MS: (tuning) => tuning.cloud.provisionDeadlineMs,
  CLOUD_MATERIALIZATION_FAILURE_COOLDOWN_MS: (tuning) => tuning.cloud.materializationFailureCooldownMs,
  CLOUD_IDLE_STOP_MINUTES: (tuning) => tuning.cloud.idleStopMs,
  CLOUD_IDLE_LOOP_SECONDS: (tuning) => tuning.cloud.idleLoopIntervalMs,
  CLOUD_IDLE_STOP_BATCH_SIZE: (tuning) => tuning.cloud.idleStopBatchSize,
  CLOUD_ACTIVITY_PROBE_TIMEOUT_MS: (tuning) => tuning.cloud.activityProbeTimeoutMs,
  CLOUD_UNREACHABLE_GRACE_MS: (tuning) => tuning.cloud.unreachableGraceMs,
  CLOUD_STOP_FLUSH_TIMEOUT_MS: (tuning) => tuning.cloud.stopFlushTimeoutMs,
  DEN_AUTOMATIONS_POLL_INTERVAL_MS: (tuning) => tuning.automations.pollIntervalMs,
  DEN_AUTOMATIONS_BATCH_SIZE: (tuning) => tuning.automations.batchSize,
  DEN_AUTOMATIONS_LEASE_MS: (tuning) => tuning.automations.leaseMs,
  DEN_AUTOMATIONS_RUN_TIMEOUT_MS: (tuning) => tuning.automations.runTimeoutMs,
  DEN_AUTOMATIONS_RUNNER_CLAIM_DEADLINE_MS: (tuning) => tuning.automations.runnerClaimDeadlineMs,
  RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS: (tuning) => tuning.render.customDomainReadyTimeoutMs,
  RENDER_PROVISION_TIMEOUT_MS: (tuning) => tuning.render.provisionTimeoutMs,
  RENDER_HEALTHCHECK_TIMEOUT_MS: (tuning) => tuning.render.healthcheckTimeoutMs,
  RENDER_POLL_INTERVAL_MS: (tuning) => tuning.render.pollIntervalMs,
  DAYTONA_CREATE_TIMEOUT_SECONDS: (tuning) => tuning.daytona.createTimeoutSeconds,
  DAYTONA_DELETE_TIMEOUT_SECONDS: (tuning) => tuning.daytona.deleteTimeoutSeconds,
  DAYTONA_STOP_TIMEOUT_SECONDS: (tuning) => tuning.daytona.stopTimeoutSeconds,
  DAYTONA_HEALTHCHECK_TIMEOUT_MS: (tuning) => tuning.daytona.healthcheckTimeoutMs,
  DEN_CKPT_INTERVAL_SECONDS: (tuning) => tuning.daytona.checkpointIntervalSeconds,
  DEN_CKPT_KEEP: (tuning) => tuning.daytona.checkpointKeep,
}

/** Unset, a normal override, and every malformed value an environment can carry. */
const VALUES: readonly (string | undefined)[] = [
  undefined, "", " ", "0", "1", "7", "42", "60000", "1200000", "-5", "1.5", "1e3", " 250 ", "0x10",
  "abc", "12abc", "true", "Infinity", "-Infinity", "NaN", "9007199254740993", "00012",
]

test("each internal setting reads unset, overridden and malformed values exactly as env.ts did", () => {
  for (const name of TUNING_ENV_NAMES) {
    for (const value of VALUES) {
      const source = value === undefined ? {} : { [name]: value }
      assert.deepStrictEqual(NOW[name](readTuning(source)), BEFORE[name](value), `${name}=${JSON.stringify(value)}`)
    }
  }
})

test("an override of one internal setting changes that setting only", () => {
  const defaults = readTuning({})
  for (const name of TUNING_ENV_NAMES) {
    const overridden = readTuning({ [name]: "7" })
    assert.notDeepStrictEqual(NOW[name](overridden), NOW[name](defaults), `${name} is not read`)
    for (const other of TUNING_ENV_NAMES) {
      if (other !== name) assert.deepStrictEqual(NOW[other](overridden), NOW[other](defaults), `${name} changed ${other}`)
    }
  }
})

test("the defaults are the ones den-api has always run with", () => {
  assert.deepStrictEqual(readTuning({}), {
    scimMaintenanceIntervalMs: 300_000,
    lifecycleEmailsIntervalMs: 900_000,
    adminMetrics: { fastIntervalMs: 300_000, heavyIntervalMs: 1_800_000 },
    mcpRegistrationProbeIntervalMs: 86_400_000,
    githubSync: {
      workerIntervalMs: 5_000,
      retryBaseMs: 30_000,
      maxAttempts: 5,
      reconcileBatchSize: 25,
      reconcileMinAgeMs: 21_600_000,
      reconcileMaxBatches: 20,
      reconcileRunBudgetMs: 45_000,
      reconcileProbeConcurrency: 4,
    },
    workerProvisioning: { reconcileIntervalMs: 60_000, reconcileStaleMs: 180_000, reconcileBatchSize: 10 },
    cloud: {
      provisionDeadlineMs: 900_000,
      materializationFailureCooldownMs: 120_000,
      idleStopMs: 1_800_000,
      idleLoopIntervalMs: 60_000,
      idleStopBatchSize: 10,
      activityProbeTimeoutMs: 10_000,
      unreachableGraceMs: 60_000,
      stopFlushTimeoutMs: 20_000,
    },
    automations: { pollIntervalMs: 15_000, batchSize: 25, leaseMs: 60_000, runTimeoutMs: 900_000, runnerClaimDeadlineMs: 900_000 },
    render: { customDomainReadyTimeoutMs: 240_000, provisionTimeoutMs: 900_000, healthcheckTimeoutMs: 180_000, pollIntervalMs: 5_000 },
    daytona: {
      createTimeoutSeconds: 300,
      deleteTimeoutSeconds: 120,
      stopTimeoutSeconds: undefined,
      healthcheckTimeoutMs: 300_000,
      checkpointIntervalSeconds: 300,
      checkpointKeep: 3,
    },
  })
})

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const envExample = readFileSync(path.join(serviceDir, ".env.example"), "utf8")

/** Variables a line of .env.example sets or offers commented out, in file order. */
function documentedNames(text: string): string[] {
  return [...text.matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].flatMap((match) => match[1] === undefined ? [] : [match[1]])
}

test("internal settings are not installation settings: absent from the schema groups and from .env.example", () => {
  const grouped = new Set(Object.values(DEN_API_ENV_GROUPS).flat())
  const documented = new Set(documentedNames(envExample))
  for (const name of TUNING_ENV_NAMES) {
    assert.equal(grouped.has(name), false, `${name} is back in env-schema.ts`)
    assert.equal(documented.has(name), false, `${name} is back in .env.example`)
  }
})

test(".env.example opens with exactly the core settings, before anything optional", () => {
  const optionalStart = envExample.indexOf("==== Optional capabilities ====")
  assert.ok(optionalStart > 0, "the Optional capabilities heading is missing")
  assert.deepEqual(documentedNames(envExample.slice(0, optionalStart)).sort(), [...DEN_API_ENV_GROUPS.core].sort())
  assert.equal(DEN_API_ENV_GROUPS.core.length, 12)
})

test("no variable belongs to two groups", () => {
  const all = Object.values(DEN_API_ENV_GROUPS).flat()
  assert.equal(new Set(all).size, all.length)
})
