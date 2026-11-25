import {
  createCloudRuntimeOrchestrator,
  type CloudRuntimeOrchestrator,
  type CloudRuntimeOrchestratorConfig,
  type RuntimeInstanceStore,
} from "@openwork-ee/cloud-runtime/orchestrator"
import type { ProviderEndpointKind, SandboxProvider } from "@openwork/sandbox"
import { createDaytonaProvider, DAYTONA_PROVIDER_ID } from "@openwork/sandbox-daytona"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { createDatabaseRuntimeInstanceStore } from "./cloud-runtime-store.js"

export type CloudRuntimeProviderId = typeof env.provisionerMode

const providers: Record<string, {
  credentialConfigured: () => boolean
  imageVersion: () => string | null
  endpointKind: ProviderEndpointKind
  create: () => SandboxProvider
}> = {
  [DAYTONA_PROVIDER_ID]: {
    credentialConfigured: () => Boolean(env.daytona.apiKey?.trim()),
    imageVersion: () => env.daytona.snapshot ?? null,
    endpointKind: "signed-expiring",
    create: () => createDaytonaProvider({
      apiKey: env.daytona.apiKey ?? "",
      apiUrl: env.daytona.apiUrl,
      target: env.daytona.target,
      snapshot: env.daytona.snapshot ?? null,
      ...(env.daytona.sandboxClass === "linux-vm" ? { platform: { os: "linux", isolation: "microvm" }, supportsPause: true } : {}),
      ...(env.daytona.sandboxClass === "linux-vm" && env.daytona.autoDeleteInterval > 0 ? { idleRetentionMinutes: env.daytona.autoDeleteInterval } : {}),
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
  daytonaApiKey?: string
}

export function cloudRuntimeConfigured(options: CloudRuntimeAvailabilityOptions = {}) {
  return (options.provisionerMode ?? env.provisionerMode) in providers
}

export function isCloudRuntimeProviderId(providerId: string) {
  return providerId in providers
}

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
      ...(runtime.sandboxClass === "linux-vm"
        ? { autoStopMinutes: 0, autoPauseMinutes: runtime.autoPauseInterval }
        : { autoStopMinutes: runtime.autoStopInterval, autoArchiveMinutes: runtime.autoArchiveInterval }),
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
      ...(runtime.sandboxClass === "linux-vm" ? { cloudComputerDisplay: ":99" } : {}),
      imageDescription: "Daytona runtime image",
      rebuildHint: "rebuild and republish the Daytona snapshot",
    },
  }
}

let cachedStore: RuntimeInstanceStore | null = null
let cachedRuntime: CloudRuntimeOrchestrator | null = null

export function cloudRuntimeStore(): RuntimeInstanceStore {
  cachedStore ??= createDatabaseRuntimeInstanceStore({ endpointKind: cloudRuntimeEndpointKind() })
  return cachedStore
}

export function cloudRuntimeEndpointKind(): ProviderEndpointKind {
  return endpointKindForProvider(env.provisionerMode)
}

export function endpointKindForProvider(providerId: string): ProviderEndpointKind {
  const entry = providers[providerId]
  return entry ? entry.endpointKind : "stable"
}

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

export function currentCloudImageVersion(options: CloudRuntimeAvailabilityOptions = {}) {
  const entry = providers[options.provisionerMode ?? env.provisionerMode]
  return entry ? entry.imageVersion() : null
}
