export type TuningSource = Readonly<Record<string, string | undefined>>

export const TUNING_ENV_NAMES = [
  "SCIM_MAINTENANCE_INTERVAL_MS",
  "LIFECYCLE_EMAILS_INTERVAL_MS",
  "ADMIN_METRICS_FAST_INTERVAL_MS",
  "ADMIN_METRICS_HEAVY_INTERVAL_MS",
  "MCP_REGISTRATION_PROBE_INTERVAL_MS",
  "GITHUB_SYNC_WORKER_INTERVAL_MS",
  "GITHUB_SYNC_RETRY_BASE_MS",
  "GITHUB_SYNC_MAX_ATTEMPTS",
  "GITHUB_RECONCILE_BATCH_SIZE",
  "GITHUB_RECONCILE_MIN_AGE_MS",
  "GITHUB_RECONCILE_MAX_BATCHES",
  "GITHUB_RECONCILE_RUN_BUDGET_MS",
  "GITHUB_RECONCILE_PROBE_CONCURRENCY",
  "WORKER_PROVISIONING_RECONCILE_INTERVAL_MS",
  "WORKER_PROVISIONING_RECONCILE_STALE_MS",
  "WORKER_PROVISIONING_RECONCILE_BATCH_SIZE",
  "CLOUD_PROVISION_DEADLINE_MS",
  "CLOUD_MATERIALIZATION_FAILURE_COOLDOWN_MS",
  "CLOUD_IDLE_STOP_MINUTES",
  "CLOUD_IDLE_LOOP_SECONDS",
  "CLOUD_IDLE_STOP_BATCH_SIZE",
  "CLOUD_ACTIVITY_PROBE_TIMEOUT_MS",
  "CLOUD_UNREACHABLE_GRACE_MS",
  "CLOUD_STOP_FLUSH_TIMEOUT_MS",
  "DEN_AUTOMATIONS_POLL_INTERVAL_MS",
  "DEN_AUTOMATIONS_BATCH_SIZE",
  "DEN_AUTOMATIONS_LEASE_MS",
  "DEN_AUTOMATIONS_RUN_TIMEOUT_MS",
  "DEN_AUTOMATIONS_RUNNER_CLAIM_DEADLINE_MS",
  "RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS",
  "RENDER_PROVISION_TIMEOUT_MS",
  "RENDER_HEALTHCHECK_TIMEOUT_MS",
  "RENDER_POLL_INTERVAL_MS",
  "DAYTONA_CREATE_TIMEOUT_SECONDS",
  "DAYTONA_DELETE_TIMEOUT_SECONDS",
  "DAYTONA_STOP_TIMEOUT_SECONDS",
  "DAYTONA_HEALTHCHECK_TIMEOUT_MS",
  "DEN_CKPT_INTERVAL_SECONDS",
  "DEN_CKPT_KEEP",
] as const

export type TuningEnvName = (typeof TUNING_ENV_NAMES)[number]

function numberOrDefault(source: TuningSource, name: TuningEnvName, fallback: number): number {
  const value = source[name]
  return value === undefined ? fallback : Number(value)
}

function numberWhenSet(source: TuningSource, name: TuningEnvName): number | undefined {
  const value = source[name]
  return value === undefined ? undefined : Number(value)
}

function positiveIntegerOrDefault(source: TuningSource, name: TuningEnvName, fallback: number): number {
  const tuned = Number(source[name])
  return Number.isSafeInteger(tuned) && tuned > 0 ? tuned : fallback
}

function numberAtLeast(source: TuningSource, name: TuningEnvName, fallback: number, minimum: number): number {
  return Math.max(minimum, numberOrDefault(source, name, fallback) || fallback)
}

export function readTuning(source: TuningSource) {
  return {
    scimMaintenanceIntervalMs: numberOrDefault(source, "SCIM_MAINTENANCE_INTERVAL_MS", 300_000),
    lifecycleEmailsIntervalMs: numberOrDefault(source, "LIFECYCLE_EMAILS_INTERVAL_MS", 900_000),
    adminMetrics: {
      fastIntervalMs: numberAtLeast(source, "ADMIN_METRICS_FAST_INTERVAL_MS", 300_000, 60_000),
      heavyIntervalMs: numberAtLeast(source, "ADMIN_METRICS_HEAVY_INTERVAL_MS", 1_800_000, 300_000),
    },
    mcpRegistrationProbeIntervalMs: numberAtLeast(source, "MCP_REGISTRATION_PROBE_INTERVAL_MS", 86_400_000, 3_600_000),
    githubSync: {
      workerIntervalMs: numberOrDefault(source, "GITHUB_SYNC_WORKER_INTERVAL_MS", 5_000),
      retryBaseMs: numberOrDefault(source, "GITHUB_SYNC_RETRY_BASE_MS", 30_000),
      maxAttempts: numberOrDefault(source, "GITHUB_SYNC_MAX_ATTEMPTS", 5),
      reconcileBatchSize: numberOrDefault(source, "GITHUB_RECONCILE_BATCH_SIZE", 25),
      reconcileMinAgeMs: numberOrDefault(source, "GITHUB_RECONCILE_MIN_AGE_MS", 21_600_000),
      reconcileMaxBatches: numberOrDefault(source, "GITHUB_RECONCILE_MAX_BATCHES", 20),
      reconcileRunBudgetMs: numberOrDefault(source, "GITHUB_RECONCILE_RUN_BUDGET_MS", 45_000),
      reconcileProbeConcurrency: numberOrDefault(source, "GITHUB_RECONCILE_PROBE_CONCURRENCY", 4),
    },
    workerProvisioning: {
      reconcileIntervalMs: numberOrDefault(source, "WORKER_PROVISIONING_RECONCILE_INTERVAL_MS", 60_000),
      reconcileStaleMs: numberOrDefault(source, "WORKER_PROVISIONING_RECONCILE_STALE_MS", 180_000),
      reconcileBatchSize: numberOrDefault(source, "WORKER_PROVISIONING_RECONCILE_BATCH_SIZE", 10),
    },
    cloud: {
      provisionDeadlineMs: numberOrDefault(source, "CLOUD_PROVISION_DEADLINE_MS", 900_000),
      materializationFailureCooldownMs: numberOrDefault(source, "CLOUD_MATERIALIZATION_FAILURE_COOLDOWN_MS", 120_000),
      idleStopMs: numberOrDefault(source, "CLOUD_IDLE_STOP_MINUTES", 30) * 60_000,
      idleLoopIntervalMs: numberOrDefault(source, "CLOUD_IDLE_LOOP_SECONDS", 60) * 1000,
      idleStopBatchSize: numberOrDefault(source, "CLOUD_IDLE_STOP_BATCH_SIZE", 10),
      activityProbeTimeoutMs: numberOrDefault(source, "CLOUD_ACTIVITY_PROBE_TIMEOUT_MS", 10_000),
      unreachableGraceMs: numberOrDefault(source, "CLOUD_UNREACHABLE_GRACE_MS", 60_000),
      stopFlushTimeoutMs: numberOrDefault(source, "CLOUD_STOP_FLUSH_TIMEOUT_MS", 20_000),
    },
    automations: {
      pollIntervalMs: positiveIntegerOrDefault(source, "DEN_AUTOMATIONS_POLL_INTERVAL_MS", 15_000),
      batchSize: positiveIntegerOrDefault(source, "DEN_AUTOMATIONS_BATCH_SIZE", 25),
      leaseMs: positiveIntegerOrDefault(source, "DEN_AUTOMATIONS_LEASE_MS", 60_000),
      runTimeoutMs: positiveIntegerOrDefault(source, "DEN_AUTOMATIONS_RUN_TIMEOUT_MS", 900_000),
      runnerClaimDeadlineMs: positiveIntegerOrDefault(source, "DEN_AUTOMATIONS_RUNNER_CLAIM_DEADLINE_MS", 900_000),
    },
    render: {
      customDomainReadyTimeoutMs: numberOrDefault(source, "RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS", 240_000),
      provisionTimeoutMs: numberOrDefault(source, "RENDER_PROVISION_TIMEOUT_MS", 900_000),
      healthcheckTimeoutMs: numberOrDefault(source, "RENDER_HEALTHCHECK_TIMEOUT_MS", 180_000),
      pollIntervalMs: numberOrDefault(source, "RENDER_POLL_INTERVAL_MS", 5_000),
    },
    daytona: {
      createTimeoutSeconds: numberOrDefault(source, "DAYTONA_CREATE_TIMEOUT_SECONDS", 300),
      deleteTimeoutSeconds: numberOrDefault(source, "DAYTONA_DELETE_TIMEOUT_SECONDS", 120),
      stopTimeoutSeconds: numberWhenSet(source, "DAYTONA_STOP_TIMEOUT_SECONDS"),
      healthcheckTimeoutMs: numberOrDefault(source, "DAYTONA_HEALTHCHECK_TIMEOUT_MS", 300_000),
      checkpointIntervalSeconds: numberOrDefault(source, "DEN_CKPT_INTERVAL_SECONDS", 300),
      checkpointKeep: numberOrDefault(source, "DEN_CKPT_KEEP", 3),
    },
  }
}

export type Tuning = ReturnType<typeof readTuning>

export const tuning: Tuning = readTuning(process.env)
