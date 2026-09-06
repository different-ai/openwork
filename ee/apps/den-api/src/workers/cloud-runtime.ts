import {
  createCloudRuntimeOrchestrator,
  type CloudRuntimeOrchestrator,
  type CloudRuntimeOrchestratorConfig,
  type RuntimeInstanceStore,
} from "@openwork-ee/cloud-runtime/orchestrator"
import type { SandboxProvider } from "@openwork-ee/cloud-runtime/contract"
import { createDaytonaProvider, DAYTONA_PROVIDER_ID } from "@openwork-ee/cloud-runtime-daytona"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { createDatabaseRuntimeInstanceStore } from "./cloud-runtime-store.js"

export type CloudRuntimeProviderId = typeof env.provisionerMode

/**
 * Providers that run OpenWork Cloud instances through the runtime contract.
 * `render` and `stub` predate the contract and keep their legacy paths in
 * `provisioner.ts`.
 * The member Cloud API already required hasDaytonaProvisioner before this
 * registry: leaving those legacy modes unregistered preserves its 404 boundary.
 * Generic Render/stub worker provisioning is separate and remains supported.
 */
const providers: Record<string, {
  credentialConfigured: () => boolean
  /** The pinned image version new instances boot; configuration, not a credential. */
  imageVersion: () => string | null
  create: () => SandboxProvider
}> = {
  [DAYTONA_PROVIDER_ID]: {
    credentialConfigured: () => Boolean(env.daytona.apiKey?.trim()),
    imageVersion: () => env.daytona.snapshot ?? null,
    create: () => createDaytonaProvider({
      apiKey: env.daytona.apiKey ?? "",
      apiUrl: env.daytona.apiUrl,
      target: env.daytona.target,
      snapshot: env.daytona.snapshot ?? null,
      image: env.daytona.image,
      resources: {
        cpu: env.daytona.resources.cpu,
        memoryGb: env.daytona.resources.memory,
        diskGb: env.daytona.resources.disk,
      },
      pollIntervalMs: env.daytona.pollIntervalMs,
      helperCreateTimeoutMs: env.daytona.createTimeoutSeconds * 1000,
    }),
  },
}

export type CloudRuntimeAvailabilityOptions = {
  provisionerMode?: CloudRuntimeProviderId
  /** Test seam: overrides the configured provider credential presence. */
  daytonaApiKey?: string
}

/** A contract provider is selected, regardless of credentials. */
export function cloudRuntimeConfigured(options: CloudRuntimeAvailabilityOptions = {}) {
  return (options.provisionerMode ?? env.provisionerMode) in providers
}

export function isCloudRuntimeProviderId(providerId: string) {
  return providerId in providers
}

/** A contract provider is selected and its credentials are present. */
export function cloudRuntimeAvailable(options: CloudRuntimeAvailabilityOptions = {}) {
  const providerId = options.provisionerMode ?? env.provisionerMode
  const entry = providers[providerId]
  if (!entry) return false
  if (options.daytonaApiKey !== undefined && providerId === DAYTONA_PROVIDER_ID) {
    return Boolean(options.daytonaApiKey.trim())
  }
  return entry.credentialConfigured()
}

function workerActivityHeartbeatUrl(workerId: string) {
  const base = env.workerActivityBaseUrl.replace(/\/+$/, "")
  return `${base}/v1/workers/${encodeURIComponent(workerId)}/activity-heartbeat`
}

export function cloudRuntimeOrchestratorConfig(): CloudRuntimeOrchestratorConfig {
  const runtime = env.daytona
  return {
    instanceNamePrefix: runtime.sandboxNamePrefix,
    sharedVolumeName: runtime.sharedVolumeName,
    workspaceMountPath: runtime.workspaceMountPath,
    dataMountPath: runtime.dataMountPath,
    runtimeWorkspacePath: runtime.runtimeWorkspacePath,
    runtimeDataPath: runtime.runtimeDataPath,
    sidecarDir: runtime.sidecarDir,
    checkpointIntervalSeconds: runtime.checkpointIntervalSeconds,
    checkpointKeep: runtime.checkpointKeep,
    port: runtime.openworkPort,
    publicEndpoint: runtime.public,
    lifecycle: {
      autoStopMinutes: runtime.autoStopInterval,
      autoArchiveMinutes: runtime.autoArchiveInterval,
      autoDeleteMinutes: runtime.autoDeleteInterval,
    },
    resources: {
      cpu: runtime.resources.cpu,
      memoryGb: runtime.resources.memory,
      diskGb: runtime.resources.disk,
    },
    endpointTtlSeconds: runtime.signedPreviewExpiresSeconds,
    endpointRefreshLeadMs: 5 * 60 * 1000,
    createTimeoutMs: runtime.createTimeoutSeconds * 1000,
    stopTimeoutMs: (runtime.stopTimeoutSeconds ?? runtime.deleteTimeoutSeconds) * 1000,
    destroyTimeoutMs: runtime.deleteTimeoutSeconds * 1000,
    healthcheckTimeoutMs: runtime.healthcheckTimeoutMs,
    pollIntervalMs: runtime.pollIntervalMs,
    activityHeartbeatUrl: workerActivityHeartbeatUrl,
    bootstrap: {
      imageDescription: "Daytona runtime image",
      rebuildHint: "rebuild and republish the Daytona snapshot",
    },
  }
}

let cachedStore: RuntimeInstanceStore | null = null
let cachedRuntime: CloudRuntimeOrchestrator | null = null

/** Instance records are readable even before a provider is selected. */
export function cloudRuntimeStore(): RuntimeInstanceStore {
  cachedStore ??= createDatabaseRuntimeInstanceStore({ providerId: env.provisionerMode })
  return cachedStore
}

/** The selected provider behind Den's lifecycle policy. Throws when no contract provider is configured. */
export function getCloudRuntime(): CloudRuntimeOrchestrator {
  if (cachedRuntime) return cachedRuntime
  const entry = providers[env.provisionerMode]
  if (!entry) {
    throw new Error(`No Cloud runtime provider is configured (CLOUD_RUNTIME_PROVIDER=${env.provisionerMode})`)
  }
  if (!entry.credentialConfigured()) {
    throw new Error(`Cloud runtime provider ${env.provisionerMode} is missing its credentials`)
  }
  cachedRuntime = createCloudRuntimeOrchestrator({
    provider: entry.create(),
    store: cloudRuntimeStore(),
    config: cloudRuntimeOrchestratorConfig(),
    logger: appLogger.child({ component: "cloud_runtime" }),
  })
  return cachedRuntime
}

/** The image version new instances boot, or `null` without a configured provider or pin. */
export function currentCloudImageVersion(options: CloudRuntimeAvailabilityOptions = {}) {
  const entry = providers[options.provisionerMode ?? env.provisionerMode]
  return entry ? entry.imageVersion() : null
}
