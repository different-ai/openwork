import { desc, eq, inArray } from "drizzle-orm"
import { db } from "../db/index.js"
import { WorkerInstanceTable, WorkerStatus, WorkerTable } from "../db/schema.js"
import { env } from "../env.js"
import {
  getLatestRenderDeploy,
  getRenderServiceEnvVar,
  hasRenderConfig,
  listRenderServices,
  type RenderDeploy,
  type RenderService,
} from "./render-api.js"

type WorkerRow = typeof WorkerTable.$inferSelect
type WorkerInstanceRow = typeof WorkerInstanceTable.$inferSelect
type WorkerStatusValue = (typeof WorkerStatus)[number]
type MatchMethod = "env_var" | "instance_url" | "worker_id_prefix"
type RenderState = "missing" | "live" | "provisioning" | "failed" | "unknown"

type RenderWorkerMatch = {
  service: RenderService
  matchedBy: MatchMethod
}

type RenderWorkerDetails = {
  service: RenderService
  latestDeploy: RenderDeploy | null
  state: RenderState
  matchedBy: MatchMethod
}

type RenderSnapshot = {
  enabled: boolean
  note: string | null
  error: string | null
  serviceCount: number
  matchedCloudWorkerCount: number
  missingCloudWorkerCount: number
  stateCounts: Record<RenderState, number>
  latestDeployStatusCounts: Record<string, number>
  matchMethodCounts: Record<MatchMethod, number>
  detailsByWorkerId: Map<string, RenderWorkerDetails>
}

const DAY_MS = 24 * 60 * 60 * 1000
const STALE_PROVISIONING_MS = 15 * 60 * 1000

function normalizeUrl(value: string | null | undefined) {
  return value?.trim().replace(/\/+$/, "") ?? ""
}

function hostFromUrl(value: string | null | undefined) {
  const normalized = normalizeUrl(value)
  if (!normalized) {
    return ""
  }

  try {
    return new URL(normalized).host.toLowerCase()
  } catch {
    return ""
  }
}

function increment(counter: Record<string, number>, key: string) {
  counter[key] = (counter[key] ?? 0) + 1
}

function createWorkerStatusCounts() {
  return Object.fromEntries(WorkerStatus.map((status) => [status, 0])) as Record<WorkerStatusValue, number>
}

function createRenderStateCounts() {
  return {
    missing: 0,
    live: 0,
    provisioning: 0,
    failed: 0,
    unknown: 0,
  } satisfies Record<RenderState, number>
}

function createMatchMethodCounts() {
  return {
    env_var: 0,
    instance_url: 0,
    worker_id_prefix: 0,
  } satisfies Record<MatchMethod, number>
}

function renderStateFromDeploy(deploy: RenderDeploy | null): RenderState {
  if (!deploy) {
    return "unknown"
  }

  if (deploy.status === "live") {
    return "live"
  }

  if (deploy.status.includes("failed") || deploy.status === "canceled") {
    return "failed"
  }

  return "provisioning"
}

function chooseRenderMatch(input: {
  worker: WorkerRow
  instance: WorkerInstanceRow | null
  envMatches: RenderWorkerMatch[]
  candidateServices: RenderService[]
}) {
  const instanceHost = hostFromUrl(input.instance?.url)

  if (input.envMatches.length > 0) {
    const exactHostMatch = input.envMatches.find((entry) => hostFromUrl(entry.service.serviceDetails?.url) === instanceHost)
    return exactHostMatch ?? input.envMatches[0]
  }

  if (instanceHost) {
    const byUrl = input.candidateServices.find((service) => hostFromUrl(service.serviceDetails?.url) === instanceHost)
    if (byUrl) {
      return {
        service: byUrl,
        matchedBy: "instance_url" as const,
      }
    }
  }

  const workerHint = input.worker.id.slice(0, 8).toLowerCase()
  const byName = input.candidateServices.find((service) => {
    const name = service.name?.toLowerCase() ?? ""
    const slug = service.slug?.toLowerCase() ?? ""
    return name.includes(workerHint) || slug.includes(workerHint)
  })

  if (!byName) {
    return null
  }

  return {
    service: byName,
    matchedBy: "worker_id_prefix" as const,
  }
}

function buildWorkerIssues(input: {
  worker: WorkerRow
  instance: WorkerInstanceRow | null
  render: RenderWorkerDetails | null
  now: number
}) {
  const issues: string[] = []

  if (input.worker.destination === "cloud" && !input.instance) {
    issues.push("cloud_worker_missing_instance")
  }

  if (input.worker.destination !== "cloud") {
    return issues
  }

  if (!input.render) {
    issues.push("render_service_missing")
  } else {
    if (input.worker.status === "healthy" && input.render.state !== "live") {
      issues.push("db_healthy_render_not_live")
    }

    if (input.worker.status === "failed" && input.render.state === "live") {
      issues.push("db_failed_render_live")
    }

    if (input.worker.status === "provisioning" && input.render.state === "live") {
      issues.push("db_provisioning_render_live")
    }
  }

  if (
    input.worker.status === "provisioning"
    && input.now - input.worker.updated_at.getTime() >= STALE_PROVISIONING_MS
  ) {
    issues.push("provisioning_stale")
  }

  return issues
}

async function getLatestInstancesByWorkerId(workerIds: string[]) {
  const byWorkerId = new Map<string, WorkerInstanceRow>()
  if (workerIds.length === 0) {
    return byWorkerId
  }

  const rows = await db
    .select()
    .from(WorkerInstanceTable)
    .where(inArray(WorkerInstanceTable.worker_id, workerIds))
    .orderBy(desc(WorkerInstanceTable.created_at))

  for (const row of rows) {
    if (!byWorkerId.has(row.worker_id)) {
      byWorkerId.set(row.worker_id, row)
    }
  }

  return byWorkerId
}

async function buildRenderSnapshot(workers: WorkerRow[], latestInstancesByWorkerId: Map<string, WorkerInstanceRow>) {
  const emptySummary: RenderSnapshot = {
    enabled: false,
    note: null,
    error: null,
    serviceCount: 0,
    matchedCloudWorkerCount: 0,
    missingCloudWorkerCount: 0,
    stateCounts: createRenderStateCounts(),
    latestDeployStatusCounts: {},
    matchMethodCounts: createMatchMethodCounts(),
    detailsByWorkerId: new Map<string, RenderWorkerDetails>(),
  }

  const cloudWorkers = workers.filter((worker) => worker.destination === "cloud")
  if (cloudWorkers.length === 0) {
    return {
      ...emptySummary,
      note: "No cloud workers in this org yet.",
    }
  }

  if (env.provisionerMode !== "render") {
    return {
      ...emptySummary,
      note: "Render analytics are unavailable because Den is not using the render provisioner in this environment.",
    }
  }

  if (!hasRenderConfig()) {
    return {
      ...emptySummary,
      note: "Render analytics are unavailable because Render API credentials are not configured in this environment.",
    }
  }

  try {
    const prefix = env.render.workerNamePrefix.toLowerCase()
    const allServices = await listRenderServices()
    const candidateServices = allServices.filter((service) => {
      const name = service.name?.toLowerCase() ?? ""
      const slug = service.slug?.toLowerCase() ?? ""
      return name.startsWith(prefix) || slug.startsWith(prefix)
    })

    const envVarMatchesByWorkerId = new Map<string, RenderWorkerMatch[]>()
    const envVarFetches = await Promise.all(
      candidateServices.map(async (service) => {
        try {
          const envVar = await getRenderServiceEnvVar(service.id, "DEN_WORKER_ID")
          return {
            service,
            workerId: envVar?.value ?? null,
          }
        } catch {
          return {
            service,
            workerId: null,
          }
        }
      }),
    )

    for (const entry of envVarFetches) {
      if (!entry.workerId) {
        continue
      }

      const matches = envVarMatchesByWorkerId.get(entry.workerId) ?? []
      matches.push({
        service: entry.service,
        matchedBy: "env_var",
      })
      envVarMatchesByWorkerId.set(entry.workerId, matches)
    }

    const matchedByWorkerId = new Map<string, RenderWorkerMatch>()
    for (const worker of cloudWorkers) {
      const match = chooseRenderMatch({
        worker,
        instance: latestInstancesByWorkerId.get(worker.id) ?? null,
        envMatches: envVarMatchesByWorkerId.get(worker.id) ?? [],
        candidateServices,
      })

      if (match) {
        matchedByWorkerId.set(worker.id, match)
      }
    }

    const uniqueServices = Array.from(
      new Map(Array.from(matchedByWorkerId.values()).map((entry) => [entry.service.id, entry.service])).values(),
    )

    const latestDeployByServiceId = new Map(
      await Promise.all(
        uniqueServices.map(async (service) => {
          try {
            return [service.id, await getLatestRenderDeploy(service.id)] as const
          } catch {
            return [service.id, null] as const
          }
        }),
      ),
    )

    const detailsByWorkerId = new Map<string, RenderWorkerDetails>()
    const stateCounts = createRenderStateCounts()
    const latestDeployStatusCounts: Record<string, number> = {}
    const matchMethodCounts = createMatchMethodCounts()

    for (const worker of cloudWorkers) {
      const match = matchedByWorkerId.get(worker.id)
      if (!match) {
        increment(stateCounts, "missing")
        continue
      }

      increment(matchMethodCounts, match.matchedBy)
      const latestDeploy = latestDeployByServiceId.get(match.service.id) ?? null
      if (latestDeploy?.status) {
        increment(latestDeployStatusCounts, latestDeploy.status)
      }

      const state = renderStateFromDeploy(latestDeploy)
      increment(stateCounts, state)
      detailsByWorkerId.set(worker.id, {
        service: match.service,
        latestDeploy,
        state,
        matchedBy: match.matchedBy,
      })
    }

    return {
      enabled: true,
      note: "Render worker matching prefers DEN_WORKER_ID and falls back to instance URL or worker-id prefix when older services do not expose that env var.",
      error: null,
      serviceCount: uniqueServices.length,
      matchedCloudWorkerCount: detailsByWorkerId.size,
      missingCloudWorkerCount: cloudWorkers.length - detailsByWorkerId.size,
      stateCounts,
      latestDeployStatusCounts,
      matchMethodCounts,
      detailsByWorkerId,
    }
  } catch (error) {
    return {
      ...emptySummary,
      enabled: true,
      error: error instanceof Error ? error.message : "render_analytics_failed",
      note: "DB analytics are still available, but Render API lookups failed in this environment.",
    }
  }
}

export async function buildOrgWorkerAnalytics(orgId: string) {
  const workers = await db
    .select()
    .from(WorkerTable)
    .where(eq(WorkerTable.org_id, orgId))
    .orderBy(desc(WorkerTable.created_at))

  const latestInstancesByWorkerId = await getLatestInstancesByWorkerId(workers.map((worker) => worker.id))
  const render = await buildRenderSnapshot(workers, latestInstancesByWorkerId)
  const workerStatusCounts = createWorkerStatusCounts()
  const now = Date.now()

  let createdLast24h = 0
  let staleProvisioningCount = 0

  const workerItems = workers.map((worker) => {
    increment(workerStatusCounts, worker.status)

    if (now - worker.created_at.getTime() < DAY_MS) {
      createdLast24h += 1
    }

    if (worker.status === "provisioning" && now - worker.updated_at.getTime() >= STALE_PROVISIONING_MS) {
      staleProvisioningCount += 1
    }

    const instance = latestInstancesByWorkerId.get(worker.id) ?? null
    const renderDetails = render.detailsByWorkerId.get(worker.id) ?? null
    const issues = buildWorkerIssues({
      worker,
      instance,
      render: renderDetails,
      now,
    })

    return {
      workerId: worker.id,
      name: worker.name,
      destination: worker.destination,
      db: {
        status: worker.status,
        createdAt: worker.created_at,
        updatedAt: worker.updated_at,
        description: worker.description,
        imageVersion: worker.image_version,
        workspacePath: worker.workspace_path,
        sandboxBackend: worker.sandbox_backend,
      },
      instance: instance
        ? {
            provider: instance.provider,
            region: instance.region,
            url: instance.url,
            status: instance.status,
            createdAt: instance.created_at,
            updatedAt: instance.updated_at,
          }
        : null,
      render: renderDetails
        ? {
            serviceId: renderDetails.service.id,
            serviceName: renderDetails.service.name ?? null,
            serviceUrl: renderDetails.service.serviceDetails?.url ?? null,
            region: renderDetails.service.serviceDetails?.region ?? null,
            latestDeployId: renderDetails.latestDeploy?.id ?? null,
            latestDeployStatus: renderDetails.latestDeploy?.status ?? null,
            state: renderDetails.state,
            matchedBy: renderDetails.matchedBy,
          }
        : null,
      issues,
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    orgId,
    summary: {
      workers: {
        total: workers.length,
        local: workers.filter((worker) => worker.destination === "local").length,
        cloud: workers.filter((worker) => worker.destination === "cloud").length,
        byStatus: workerStatusCounts,
        createdLast24h,
        staleProvisioningCount,
        cloudWithoutInstanceCount: workers.filter((worker) => worker.destination === "cloud" && !latestInstancesByWorkerId.has(worker.id)).length,
      },
      render: {
        enabled: render.enabled,
        note: render.note,
        error: render.error,
        serviceCount: render.serviceCount,
        matchedCloudWorkerCount: render.matchedCloudWorkerCount,
        missingCloudWorkerCount: render.missingCloudWorkerCount,
        stateCounts: render.stateCounts,
        latestDeployStatusCounts: render.latestDeployStatusCounts,
        matchMethodCounts: render.matchMethodCounts,
      },
    },
    workers: workerItems,
  }
}
