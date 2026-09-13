import { WorkerTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { eq } from "@openwork-ee/den-db/drizzle"
import {
  createKubernetesClient,
  isKubernetesNotFoundError,
  KubernetesApiError,
  type KubernetesClient,
} from "./kubernetes-client.js"

type WorkerId = typeof WorkerTable.$inferSelect.id

type ProvisionInput = {
  workerId: WorkerId
  name: string
  hostToken: string
  clientToken: string
  activityToken: string
}

type ProvisionedInstance = {
  provider: string
  url: string
  status: "provisioning" | "healthy"
  region?: string
  imageVersion?: string | null
}

export class KubernetesWorkerMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KubernetesWorkerMissingError"
  }
}

export function isKubernetesWorkerMissingError(error: unknown) {
  return error instanceof KubernetesWorkerMissingError
    || (error instanceof Error && error.name === "KubernetesWorkerMissingError")
}

export type StopWorkerOnKubernetesResult =
  | { status: "no_sandbox" }
  | { status: "stopped" }

export type KubernetesWorkerRecord = {
  sandbox_id: string
  signed_preview_url: string
  signed_preview_url_expires_at: Date
}

export type KubernetesProvisioningRuntime = {
  client: KubernetesClient
  healthFetch?: typeof fetch
  now?: () => number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const healthRequestTimeoutMs = 5_000
const createConflictLookupMaxAttempts = 6
const createConflictLookupBackoffMs = 2_000
const podLogTailLines = 100
const logger = appLogger.child({ component: "kubernetes_provisioner" })

const podLabels = (workerId: WorkerId) => ({
  "openwork.den.provider": "kubernetes",
  "openwork.den.worker-id": workerId,
})

// TypeID worker ids look like wrk_<26 base32 chars>; swapping the separator
// yields lowercase alphanumeric + hyphen, which is already DNS-1123 safe.
export function kubernetesWorkerName(workerId: WorkerId) {
  return workerId.replace(/_/g, "-")
}

function tokenSecretName(workerId: WorkerId) {
  return `${kubernetesWorkerName(workerId)}-tokens`
}

function workspaceVolumeName(workerId: WorkerId) {
  return `${kubernetesWorkerName(workerId)}-workspace`
}

function dataVolumeName(workerId: WorkerId) {
  return `${kubernetesWorkerName(workerId)}-data`
}

function workerActivityHeartbeatUrl(workerId: WorkerId) {
  const base = env.workerActivityBaseUrl.replace(/\/+$/, "")
  return `${base}/v1/workers/${encodeURIComponent(workerId)}/activity-heartbeat`
}

function assertKubernetesConfig() {
  if (!env.kubernetes.workerImage) {
    throw new Error("KUBERNETES_WORKER_IMAGE is required for kubernetes provisioner")
  }
}

function createRuntime(): KubernetesProvisioningRuntime {
  return {
    client: createKubernetesClient({
      apiUrl: env.kubernetes.apiUrl,
      apiToken: env.kubernetes.apiToken,
      apiCaFile: env.kubernetes.apiCaFile,
      namespace: env.kubernetes.workerNamespace,
    }),
  }
}

function workerServiceUrl(workerId: WorkerId) {
  const port = env.kubernetes.workerPort
  return `http://${kubernetesWorkerName(workerId)}.${env.kubernetes.workerNamespace}.svc.cluster.local:${port}`
}

function provisionedInstanceUrl(workerId: WorkerId) {
  const template = env.workerUrlTemplate?.trim()
  if (template) {
    // The template is a URL host, so the placeholder receives the DNS-safe
    // hyphenated worker name rather than the raw worker id (its underscore is
    // invalid in DNS labels).
    return template.replace("{workerId}", kubernetesWorkerName(workerId))
  }

  return workerServiceUrl(workerId)
}

function provisionedInstance(workerId: WorkerId): ProvisionedInstance {
  return {
    provider: "kubernetes",
    url: provisionedInstanceUrl(workerId),
    status: "healthy",
    region: env.kubernetes.workerNamespace,
    imageVersion: env.kubernetes.workerImage ?? null,
  }
}

function workerRecord(workerId: WorkerId, nowMs: number): KubernetesWorkerRecord {
  return {
    sandbox_id: kubernetesWorkerName(workerId),
    signed_preview_url: provisionedInstanceUrl(workerId),
    signed_preview_url_expires_at: new Date(nowMs + env.kubernetes.workerRecordTtlSeconds * 1000),
  }
}

function tokenSecretManifest(input: ProvisionInput) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: tokenSecretName(input.workerId),
      namespace: env.kubernetes.workerNamespace,
      labels: podLabels(input.workerId),
    },
    type: "Opaque",
    stringData: {
      OPENWORK_TOKEN: input.clientToken,
      OPENWORK_HOST_TOKEN: input.hostToken,
      DEN_ACTIVITY_HEARTBEAT_TOKEN: input.activityToken,
    },
  }
}

function pvcManifest(name: string, workerId: WorkerId, size: string) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name,
      namespace: env.kubernetes.workerNamespace,
      labels: podLabels(workerId),
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: {
        requests: {
          storage: size,
        },
      },
      ...(env.kubernetes.workerStorageClass ? { storageClassName: env.kubernetes.workerStorageClass } : {}),
    },
  }
}

function containerEnv(input: ProvisionInput) {
  const secretName = tokenSecretName(input.workerId)
  const secretKeyRef = (key: string) => ({ valueFrom: { secretKeyRef: { name: secretName, key } } })

  return [
    { name: "OPENWORK_WORKSPACE", value: "/workspace" },
    { name: "OPENWORK_DATA_DIR", value: "/data/openwork-server" },
    { name: "OPENWORK_SIDECAR_DIR", value: "/data/sidecars" },
    { name: "OPENWORK_PORT", value: String(env.kubernetes.workerPort) },
    // The microsandbox entrypoint already starts openwork-server with
    // `--host 0.0.0.0` (CLI beats env), so no bind override is needed here.
    { name: "OPENWORK_APPROVAL_MODE", value: env.kubernetes.workerApprovalMode },
    { name: "OPENWORK_CORS_ORIGINS", value: "*" },
    { name: "OPENWORK_TOKEN", ...secretKeyRef("OPENWORK_TOKEN") },
    { name: "OPENWORK_HOST_TOKEN", ...secretKeyRef("OPENWORK_HOST_TOKEN") },
    { name: "DEN_WORKER_ID", value: input.workerId },
    { name: "DEN_RUNTIME_PROVIDER", value: "kubernetes" },
    { name: "DEN_ACTIVITY_HEARTBEAT_ENABLED", value: "1" },
    { name: "DEN_ACTIVITY_HEARTBEAT_URL", value: workerActivityHeartbeatUrl(input.workerId) },
    { name: "DEN_ACTIVITY_HEARTBEAT_TOKEN", ...secretKeyRef("DEN_ACTIVITY_HEARTBEAT_TOKEN") },
    // opencode stores conversations/sessions in $XDG_DATA_HOME/opencode; point it
    // at the /data PVC so they survive pod recreation (the container FS is
    // ephemeral). The entrypoint creates the dir; the data PVC is RW at /data.
    { name: "XDG_DATA_HOME", value: "/data/opencode-xdg/data" },
  ]
}

// Operator-provided pod overrides (scheduling, security, metadata, networking).
// The provisioner's own selector labels, env, and volumes always win on a
// name collision; operator extras that collide are dropped with a warning.
const RESERVED_VOLUME_NAMES = ["workspace", "data"]

function operatorPodTemplateLabels(workerId: WorkerId) {
  const reserved = Object.keys(podLabels(workerId))
  const operator = env.kubernetes.workerPodLabels
  if (!operator) {
    return podLabels(workerId)
  }
  // Operator labels come first so the provisioner's selector labels override any
  // attempt to clobber openwork.den.worker-id / openwork.den.provider.
  return { ...operator, ...podLabels(workerId), ...Object.fromEntries(reserved.map((k) => [k, (podLabels(workerId) as Record<string, string>)[k]])) }
}

function operatorPodAnnotations() {
  return env.kubernetes.workerPodAnnotations ?? {}
}

function operatorImagePullSecrets() {
  const names = env.kubernetes.workerImagePullSecrets
  return names?.length ? names.map((name) => ({ name })) : undefined
}

function mergeExtraEnv(base: ReturnType<typeof containerEnv>, extras: unknown[] | undefined) {
  if (!extras || !extras.length) {
    return base
  }
  const reserved = new Set(base.map((e: { name: string }) => e.name))
  const accepted: Record<string, unknown>[] = []
  for (const entry of extras) {
    if (entry && typeof entry === "object" && "name" in entry && typeof (entry as { name: unknown }).name === "string") {
      if (reserved.has((entry as { name: string }).name)) {
        logger.warn("dropping operator env override that collides with a provisioner env var", { env_var: (entry as { name: string }).name })
        continue
      }
      reserved.add((entry as { name: string }).name)
      accepted.push(entry as Record<string, unknown>)
    }
  }
  return accepted.length ? [...base, ...accepted] : base
}

function mergeExtraVolumes(extras: unknown[] | undefined) {
  if (!extras || !extras.length) {
    return undefined
  }
  const reserved = new Set(RESERVED_VOLUME_NAMES)
  const accepted: Record<string, unknown>[] = []
  for (const vol of extras) {
    if (vol && typeof vol === "object" && "name" in vol && typeof (vol as { name: unknown }).name === "string") {
      if (reserved.has((vol as { name: string }).name)) {
        logger.warn("dropping operator volume that collides with a provisioner volume", { volume: (vol as { name: string }).name })
        continue
      }
      reserved.add((vol as { name: string }).name)
      accepted.push(vol as Record<string, unknown>)
    }
  }
  return accepted.length ? accepted : undefined
}

function mergeExtraVolumeMounts(extras: unknown[] | undefined) {
  if (!extras || !extras.length) {
    return undefined
  }
  const reserved = new Set(RESERVED_VOLUME_NAMES)
  const accepted: Record<string, unknown>[] = []
  for (const mount of extras) {
    if (mount && typeof mount === "object" && "name" in mount && typeof (mount as { name: unknown }).name === "string") {
      if (reserved.has((mount as { name: string }).name)) {
        logger.warn("dropping operator volume mount that collides with a provisioner volume mount", { volume_mount: (mount as { name: string }).name })
        continue
      }
      reserved.add((mount as { name: string }).name)
      accepted.push(mount as Record<string, unknown>)
    }
  }
  return accepted.length ? accepted : undefined
}

function deploymentManifest(input: ProvisionInput) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: kubernetesWorkerName(input.workerId),
      namespace: env.kubernetes.workerNamespace,
      labels: podLabels(input.workerId),
    },
    spec: {
      replicas: 1,
      // Recreate instead of RollingUpdate: the workspace/data PVCs are
      // ReadWriteOnce, so a surge pod during a rolling image patch would
      // MultiAttach-stall behind the terminating pod.
      strategy: {
        type: "Recreate",
      },
      selector: {
        matchLabels: podLabels(input.workerId),
      },
      template: {
        metadata: {
          labels: operatorPodTemplateLabels(input.workerId),
          ...(Object.keys(operatorPodAnnotations()).length ? { annotations: operatorPodAnnotations() } : {}),
        },
        spec: {
          automountServiceAccountToken: false,
          ...(operatorImagePullSecrets() ? { imagePullSecrets: operatorImagePullSecrets() } : {}),
          ...(env.kubernetes.workerNodeSelector ? { nodeSelector: env.kubernetes.workerNodeSelector } : {}),
          ...(env.kubernetes.workerTolerations ? { tolerations: env.kubernetes.workerTolerations } : {}),
          ...(env.kubernetes.workerAffinity ? { affinity: env.kubernetes.workerAffinity } : {}),
          ...(env.kubernetes.workerTopologySpreadConstraints ? { topologySpreadConstraints: env.kubernetes.workerTopologySpreadConstraints } : {}),
          ...(env.kubernetes.workerPriorityClassName ? { priorityClassName: env.kubernetes.workerPriorityClassName } : {}),
          ...(env.kubernetes.workerDnsPolicy ? { dnsPolicy: env.kubernetes.workerDnsPolicy } : {}),
          ...(env.kubernetes.workerDnsConfig ? { dnsConfig: env.kubernetes.workerDnsConfig } : {}),
          ...(env.kubernetes.workerPodSecurityContext ? { securityContext: env.kubernetes.workerPodSecurityContext } : {}),
          ...(env.kubernetes.workerShareProcessNamespace !== undefined ? { shareProcessNamespace: env.kubernetes.workerShareProcessNamespace } : {}),
          ...(env.kubernetes.workerHostNetwork !== undefined ? { hostNetwork: env.kubernetes.workerHostNetwork } : {}),
          ...(env.kubernetes.workerInitContainers ? { initContainers: env.kubernetes.workerInitContainers } : {}),
          containers: [
            {
              name: "openwork-server",
              image: env.kubernetes.workerImage,
              imagePullPolicy: env.kubernetes.workerImagePullPolicy,
              ports: [
                { containerPort: env.kubernetes.workerPort },
              ],
              env: mergeExtraEnv(containerEnv(input), env.kubernetes.workerExtraEnv),
              readinessProbe: {
                httpGet: { path: "/health", port: env.kubernetes.workerPort },
              },
              livenessProbe: {
                httpGet: { path: "/health", port: env.kubernetes.workerPort },
              },
              resources: {
                requests: {
                  cpu: env.kubernetes.workerResources.cpuRequest,
                  memory: env.kubernetes.workerResources.memoryRequest,
                },
                limits: {
                  cpu: env.kubernetes.workerResources.cpuLimit,
                  memory: env.kubernetes.workerResources.memoryLimit,
                },
              },
              ...(env.kubernetes.workerContainerSecurityContext ? { securityContext: env.kubernetes.workerContainerSecurityContext } : {}),
              ...(env.kubernetes.workerLifecycleHooks ? { lifecycle: env.kubernetes.workerLifecycleHooks } : {}),
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "data", mountPath: "/data" },
                ...(mergeExtraVolumeMounts(env.kubernetes.workerExtraVolumeMounts) ?? []),
              ],
            },
          ],
          volumes: [
            {
              name: "workspace",
              persistentVolumeClaim: { claimName: workspaceVolumeName(input.workerId) },
            },
            {
              name: "data",
              persistentVolumeClaim: { claimName: dataVolumeName(input.workerId) },
            },
            ...(mergeExtraVolumes(env.kubernetes.workerExtraVolumes) ?? []),
          ],
        },
      },
    },
  }
}

function serviceManifest(input: ProvisionInput) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: kubernetesWorkerName(input.workerId),
      namespace: env.kubernetes.workerNamespace,
      labels: podLabels(input.workerId),
    },
    spec: {
      type: "ClusterIP",
      selector: podLabels(input.workerId),
      ports: [
        {
          port: env.kubernetes.workerPort,
          targetPort: env.kubernetes.workerPort,
        },
      ],
    },
  }
}

async function upsertTokenSecret(client: KubernetesClient, input: ProvisionInput) {
  try {
    await client.createSecret(tokenSecretManifest(input))
    return
  } catch (error) {
    if (!(error instanceof KubernetesApiError && error.status === 409)) {
      throw error
    }
  }

  await client.deleteSecret(tokenSecretName(input.workerId)).catch((error) => {
    logger.warn("failed to delete stale Kubernetes worker token secret", { worker_id: input.workerId, error })
  })
  await client.createSecret(tokenSecretManifest(input))
}

async function getWorkerDeployment(client: KubernetesClient, workerId: WorkerId) {
  try {
    return await client.getDeployment(kubernetesWorkerName(workerId))
  } catch (error) {
    if (isKubernetesNotFoundError(error)) {
      return null
    }

    throw error
  }
}

function deploymentReplicas(deployment: Record<string, unknown>) {
  const spec = deployment.spec as { replicas?: number } | undefined
  return spec?.replicas ?? null
}

async function patchWorkerDeployment(client: KubernetesClient, workerId: WorkerId, patch: Record<string, unknown>) {
  await client.patchDeployment(kubernetesWorkerName(workerId), patch)
}

async function ensureWorkspaceReady(client: KubernetesClient, workerId: WorkerId) {
  await client.getPvc(workspaceVolumeName(workerId))
  await client.getPvc(dataVolumeName(workerId))
}

// The worker entrypoint prints the client/host tokens at startup, so the log
// tail embedded in health-timeout errors must never carry them.
function redactPodLogs(logs: string, input: ProvisionInput) {
  return logs
    .split("\n")
    .map((line) => {
      let redacted = line
      for (const token of [input.clientToken, input.hostToken, input.activityToken]) {
        if (token) {
          redacted = redacted.split(token).join("[REDACTED]")
        }
      }
      if (redacted.toLowerCase().includes("token:")) {
        redacted = "[REDACTED]"
      }
      return redacted
    })
    .join("\n")
}

async function diagnosticSnapshot(client: KubernetesClient, workerId: WorkerId, input: ProvisionInput) {
  try {
    const pods = await client.listPods(`openwork.den.worker-id=${workerId}`)
    const items = Array.isArray(pods.items) ? pods.items : []
    if (items.length === 0) {
      return "no worker pods found"
    }

    const lines: string[] = []
    for (const pod of items) {
      const metadata = pod.metadata as { name?: string } | undefined
      const status = pod.status as { phase?: string } | undefined
      const name = metadata?.name ?? "unknown"
      lines.push(`pod ${name} phase=${status?.phase ?? "unknown"}`)

      if (lines.length > 1) {
        continue
      }

      const logs = await client.getPodLogs(name, { tailLines: podLogTailLines }).catch(() => null)
      if (logs?.trim()) {
        lines.push(`logs:\n${redactPodLogs(logs.trim(), input).slice(-4000)}`)
      }
    }

    return lines.join("\n")
  } catch (error) {
    logger.warn("failed to collect Kubernetes worker diagnostics", { worker_id: workerId, error })
    return null
  }
}

async function waitForHealth(url: string, timeoutMs: number, runtime: KubernetesProvisioningRuntime, workerId: WorkerId, input: ProvisionInput) {
  const fetchImpl = runtime.healthFetch ?? fetch
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const remainingMs = timeoutMs - (Date.now() - startedAt)
      const response = await fetchImpl(`${url.replace(/\/$/, "")}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.max(1, Math.min(remainingMs, healthRequestTimeoutMs))),
      })
      if (response.ok) {
        return
      }
    } catch {
      // ignore transient startup failures
    }

    const remainingAfterProbeMs = timeoutMs - (Date.now() - startedAt)
    if (remainingAfterProbeMs > 0) {
      await sleep(Math.min(env.kubernetes.pollIntervalMs, remainingAfterProbeMs))
    }
  }

  const diagnostics = await diagnosticSnapshot(runtime.client, workerId, input)
  throw new Error(
    [
      `Timed out waiting for Kubernetes worker health at ${url.replace(/\/$/, "")}/health`,
      diagnostics ?? "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  )
}

function deploymentContainerImage(deployment: Record<string, unknown>) {
  const containers = (deployment.spec as { template?: { spec?: { containers?: Array<{ image?: string }> } } } | undefined)
    ?.template?.spec?.containers
  return containers?.[0]?.image ?? null
}

async function adoptExistingWorker(input: {
  provisionInput: ProvisionInput
  runtime: KubernetesProvisioningRuntime
  deployment: Record<string, unknown>
}): Promise<ProvisionedInstance> {
  await upsertTokenSecret(input.runtime.client, input.provisionInput)
  await ensureWorkspaceReady(input.runtime.client, input.provisionInput.workerId)

  const replicas = deploymentReplicas(input.deployment)
  const runningImage = deploymentContainerImage(input.deployment)
  if (runningImage && runningImage !== env.kubernetes.workerImage) {
    // The deployment was adopted with an older image; reconcile it before
    // reporting healthy so the DB imageVersion and the running pod agree.
    await patchWorkerDeployment(input.runtime.client, input.provisionInput.workerId, {
      spec: {
        replicas: 1,
        template: {
          spec: {
            containers: [
              {
                name: "openwork-server",
                image: env.kubernetes.workerImage,
              },
            ],
          },
        },
      },
    })
  } else if (replicas === null || replicas < 1) {
    await patchWorkerDeployment(input.runtime.client, input.provisionInput.workerId, { spec: { replicas: 1 } })
  }

  await waitForHealth(workerServiceUrl(input.provisionInput.workerId), env.kubernetes.healthcheckTimeoutMs, input.runtime, input.provisionInput.workerId, input.provisionInput)
  return provisionedInstance(input.provisionInput.workerId)
}

// A 409 on a supporting-object create means a concurrent replica (or a
// half-completed deprovision) already created it; verify the object exists
// and continue instead of dead-ending the provision attempt.
async function createOrAdoptObject(
  client: KubernetesClient,
  create: () => Promise<unknown>,
  verify: () => Promise<unknown>,
  label: string,
  workerId: WorkerId,
) {
  try {
    await create()
  } catch (error) {
    if (!(error instanceof KubernetesApiError && error.status === 409)) {
      throw error
    }
    await verify()
    logger.info("adopted existing Kubernetes worker object after create conflict", { object: label, worker_id: workerId })
  }
}

async function provisionFreshWorker(input: {
  provisionInput: ProvisionInput
  runtime: KubernetesProvisioningRuntime
}): Promise<ProvisionedInstance> {
  const { client } = input.runtime
  const workerId = input.provisionInput.workerId

  await createOrAdoptObject(
    client,
    () => client.createPvc(pvcManifest(workspaceVolumeName(workerId), workerId, env.kubernetes.workspaceVolumeSize)),
    () => client.getPvc(workspaceVolumeName(workerId)),
    "workspace-pvc",
    workerId,
  )
  await createOrAdoptObject(
    client,
    () => client.createPvc(pvcManifest(dataVolumeName(workerId), workerId, env.kubernetes.dataVolumeSize)),
    () => client.getPvc(dataVolumeName(workerId)),
    "data-pvc",
    workerId,
  )
  await createOrAdoptObject(
    client,
    () => client.createSecret(tokenSecretManifest(input.provisionInput)),
    () => client.getSecret(tokenSecretName(workerId)),
    "token-secret",
    workerId,
  )
  await client.createDeployment(deploymentManifest(input.provisionInput))
  await createOrAdoptObject(
    client,
    () => client.createService(serviceManifest(input.provisionInput)),
    () => client.getService(kubernetesWorkerName(workerId)),
    "service",
    workerId,
  )

  await waitForHealth(workerServiceUrl(workerId), env.kubernetes.healthcheckTimeoutMs, input.runtime, workerId, input.provisionInput)
  return provisionedInstance(workerId)
}

export async function provisionWorkerOnKubernetesWithRuntime(
  input: ProvisionInput,
  runtime: KubernetesProvisioningRuntime,
  options: { sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<ProvisionedInstance> {
  const existing = await getWorkerDeployment(runtime.client, input.workerId)
  if (existing) {
    return adoptExistingWorker({ provisionInput: input, runtime, deployment: existing })
  }

  try {
    return await provisionFreshWorker({ provisionInput: input, runtime })
  } catch (error) {
    if (!(error instanceof KubernetesApiError && error.status === 409)) {
      throw error
    }

    // Another replica provisioned the same worker concurrently; adopt its
    // objects instead of failing the request.
    for (let attempt = 1; attempt <= createConflictLookupMaxAttempts; attempt += 1) {
      const deployment = await getWorkerDeployment(runtime.client, input.workerId)
      if (deployment) {
        return adoptExistingWorker({ provisionInput: input, runtime, deployment })
      }

      if (attempt < createConflictLookupMaxAttempts) {
        await (options.sleep ?? sleep)(createConflictLookupBackoffMs)
      }
    }

    throw error
  }
}

export async function provisionWorkerOnKubernetes(
  input: ProvisionInput,
): Promise<ProvisionedInstance> {
  assertKubernetesConfig()

  return provisionWorkerOnKubernetesWithRuntime(input, createRuntime())
}

async function getWorkerImageVersion(workerId: WorkerId) {
  const rows = await db
    .select({ image_version: WorkerTable.image_version })
    .from(WorkerTable)
    .where(eq(WorkerTable.id, workerId))
    .limit(1)

  return rows[0]?.image_version ?? null
}

async function wakeExistingWorker(input: {
  provisionInput: ProvisionInput
  runtime: KubernetesProvisioningRuntime
  deployment: Record<string, unknown>
  workerImageVersion: string | null
}): Promise<ProvisionedInstance> {
  const imageVersion = env.kubernetes.workerImage
  if (imageVersion && input.workerImageVersion !== imageVersion) {
    // Stale-image recycle: the PVCs survive the rollout, so the workspace and
    // data persist across the image update the same way Daytona snapshot
    // recycling preserves the shared volume.
    await patchWorkerDeployment(input.runtime.client, input.provisionInput.workerId, {
      spec: {
        replicas: 1,
        template: {
          spec: {
            containers: [
              {
                name: "openwork-server",
                image: imageVersion,
              },
            ],
          },
        },
      },
    })
  } else if (deploymentReplicas(input.deployment) === null || deploymentReplicas(input.deployment)! < 1) {
    await patchWorkerDeployment(input.runtime.client, input.provisionInput.workerId, { spec: { replicas: 1 } })
  }

  await waitForHealth(workerServiceUrl(input.provisionInput.workerId), env.kubernetes.healthcheckTimeoutMs, input.runtime, input.provisionInput.workerId, input.provisionInput)
  return provisionedInstance(input.provisionInput.workerId)
}

export async function wakeWorkerOnKubernetesWithRuntime(
  input: ProvisionInput,
  runtime: KubernetesProvisioningRuntime,
  workerImageVersion: string | null,
): Promise<ProvisionedInstance> {
  const deployment = await getWorkerDeployment(runtime.client, input.workerId)
  if (!deployment) {
    throw new KubernetesWorkerMissingError(`Kubernetes worker deployment missing for worker ${input.workerId}`)
  }

  return wakeExistingWorker({ provisionInput: input, runtime, deployment, workerImageVersion })
}

export async function wakeWorkerOnKubernetes(
  input: ProvisionInput,
): Promise<ProvisionedInstance> {
  assertKubernetesConfig()

  const runtime = createRuntime()
  const workerImageVersion = await getWorkerImageVersion(input.workerId)
  return wakeWorkerOnKubernetesWithRuntime(input, runtime, workerImageVersion)
}

export async function stopWorkerOnKubernetesWithRuntime(workerId: WorkerId, runtime: KubernetesProvisioningRuntime): Promise<StopWorkerOnKubernetesResult> {
  const client = runtime.client
  const deployment = await getWorkerDeployment(client, workerId)
  if (!deployment) {
    return { status: "no_sandbox" }
  }

  const replicas = deploymentReplicas(deployment)
  if (replicas !== null && replicas < 1) {
    return { status: "stopped" }
  }

  // Scale to zero instead of deleting: the PVCs and secret survive so the
  // next wake reuses the workspace, mirroring a stopped Daytona sandbox.
  await patchWorkerDeployment(client, workerId, { spec: { replicas: 0 } })

  return { status: "stopped" }
}

export async function stopWorkerOnKubernetes(workerId: WorkerId): Promise<StopWorkerOnKubernetesResult> {
  assertKubernetesConfig()

  return stopWorkerOnKubernetesWithRuntime(workerId, createRuntime())
}

export async function deprovisionWorkerOnKubernetesWithRuntime(workerId: WorkerId, runtime: KubernetesProvisioningRuntime) {
  const client = runtime.client
  await client.deleteDeployment(kubernetesWorkerName(workerId)).catch((error) => {
    if (!isKubernetesNotFoundError(error)) {
      logger.warn("failed to delete Kubernetes worker deployment", { worker_id: workerId, error })
    }
  })
  await client.deleteService(kubernetesWorkerName(workerId)).catch((error) => {
    if (!isKubernetesNotFoundError(error)) {
      logger.warn("failed to delete Kubernetes worker service", { worker_id: workerId, error })
    }
  })
  await client.deleteSecret(tokenSecretName(workerId)).catch((error) => {
    if (!isKubernetesNotFoundError(error)) {
      logger.warn("failed to delete Kubernetes worker token secret", { worker_id: workerId, error })
    }
  })
  await client.deletePvc(workspaceVolumeName(workerId)).catch((error) => {
    if (!isKubernetesNotFoundError(error)) {
      logger.warn("failed to delete Kubernetes worker workspace PVC", { worker_id: workerId, error })
    }
  })
  await client.deletePvc(dataVolumeName(workerId)).catch((error) => {
    if (!isKubernetesNotFoundError(error)) {
      logger.warn("failed to delete Kubernetes worker data PVC", { worker_id: workerId, error })
    }
  })
}

export async function deprovisionWorkerOnKubernetes(workerId: WorkerId) {
  assertKubernetesConfig()

  return deprovisionWorkerOnKubernetesWithRuntime(workerId, createRuntime())
}

export async function inspectKubernetesWorkerWithRuntime(workerId: WorkerId, runtime: KubernetesProvisioningRuntime) {
  const deployment = await getWorkerDeployment(runtime.client, workerId)
  if (!deployment) {
    return null
  }

  const replicas = deploymentReplicas(deployment)
  return { state: replicas !== null && replicas < 1 ? "stopped" : "started" }
}

export async function inspectKubernetesWorker(workerId: WorkerId) {
  assertKubernetesConfig()

  return inspectKubernetesWorkerWithRuntime(workerId, createRuntime())
}

export async function getKubernetesWorkerRecordWithRuntime(workerId: WorkerId, runtime: KubernetesProvisioningRuntime): Promise<KubernetesWorkerRecord | null> {
  const deployment = await getWorkerDeployment(runtime.client, workerId)
  if (!deployment) {
    return null
  }

  return workerRecord(workerId, (runtime.now ?? Date.now)())
}

export async function getKubernetesWorkerRecord(workerId: WorkerId): Promise<KubernetesWorkerRecord | null> {
  assertKubernetesConfig()

  return getKubernetesWorkerRecordWithRuntime(workerId, createRuntime())
}

export async function refreshKubernetesSignedPreviewWithRuntime(workerId: WorkerId, runtime: KubernetesProvisioningRuntime): Promise<KubernetesWorkerRecord | null> {
  return getKubernetesWorkerRecordWithRuntime(workerId, runtime)
}

export async function refreshKubernetesSignedPreview(workerId: WorkerId): Promise<KubernetesWorkerRecord | null> {
  assertKubernetesConfig()

  return refreshKubernetesSignedPreviewWithRuntime(workerId, createRuntime())
}
