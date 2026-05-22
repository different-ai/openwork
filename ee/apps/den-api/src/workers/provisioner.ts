import { WorkerTable } from "@openwork-ee/den-db/schema"
import { env } from "../env.js"
import {
  deprovisionWorkerOnDaytona,
  provisionWorkerOnDaytona,
} from "./daytona.js"
import {
  customDomainForWorker,
  ensureVercelDnsRecord,
} from "./vanity-domain.js"

type WorkerId = typeof WorkerTable.$inferSelect.id

export type ProvisionInput = {
  workerId: WorkerId
  name: string
  hostToken: string
  clientToken: string
  activityToken: string
  unavailableStaticWorkerUrls?: string[]
}

export type ProvisionedInstance = {
  provider: string
  url: string
  status: "provisioning" | "healthy"
  region?: string
}

export type StaticWorkerConfig = {
  urls: string[]
  healthPath: string
  healthcheckTimeoutMs: number
  healthcheckIntervalMs: number
  reservationTtlMs?: number
  unavailableUrls?: string[]
}

type StaticWorkerReservation = {
  workerId: string
  expiresAt: number
}

type RenderService = {
  id: string
  name?: string
  slug?: string
  serviceDetails?: {
    url?: string
    region?: string
  }
}

type RenderServiceListRow = {
  cursor?: string
  service?: RenderService
}

type RenderDeploy = {
  id: string
  status: string
}

const terminalDeployStates = new Set([
  "live",
  "update_failed",
  "build_failed",
  "canceled",
])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const staticWorkerReservations = new Map<string, StaticWorkerReservation>()

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

const hostFromUrl = (value: string | null | undefined) => {
  if (!value) {
    return ""
  }

  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return ""
  }
}

async function renderRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${env.render.apiKey}`)
  headers.set("Accept", "application/json")

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  const response = await fetch(`${env.render.apiBase}${path}`, {
    ...init,
    headers,
  })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(
      `Render API ${path} failed (${response.status}): ${text.slice(0, 400)}`,
    )
  }

  if (!text) {
    return null as T
  }

  return JSON.parse(text) as T
}

async function waitForDeployLive(serviceId: string) {
  const startedAt = Date.now()
  let latest: RenderDeploy | null = null

  while (Date.now() - startedAt < env.render.provisionTimeoutMs) {
    const rows = await renderRequest<Array<{ deploy: RenderDeploy }>>(
      `/services/${serviceId}/deploys?limit=1`,
    )
    latest = rows[0]?.deploy ?? null

    if (latest && terminalDeployStates.has(latest.status)) {
      if (latest.status !== "live") {
        throw new Error(
          `Render deploy ${latest.id} ended with ${latest.status}`,
        )
      }
      return latest
    }

    await sleep(env.render.pollIntervalMs)
  }

  throw new Error(
    `Timed out waiting for Render deploy for service ${serviceId}`,
  )
}

async function waitForHealth(
  url: string,
  timeoutMs = env.render.healthcheckTimeoutMs,
  intervalMs = env.render.pollIntervalMs,
  healthPath = "/health",
) {
  const normalizedPath = healthPath.startsWith("/") ? healthPath : `/${healthPath}`
  const healthUrl = `${url.replace(/\/$/, "")}${normalizedPath}`
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), remainingMs)

    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: controller.signal,
      })
      if (response.ok) {
        return
      }
    } catch {
      // ignore transient network failures while the instance boots
    } finally {
      clearTimeout(timeout)
    }

    const elapsedMs = Date.now() - startedAt
    const sleepMs = Math.min(intervalMs, Math.max(timeoutMs - elapsedMs, 0))
    if (sleepMs > 0) {
      await sleep(sleepMs)
    }
  }

  throw new Error(`Timed out waiting for worker health endpoint ${healthUrl}`)
}

export function normalizeStaticWorkerUrl(value: string) {
  const parsedUrl = new URL(value.trim())
  parsedUrl.hash = ""
  parsedUrl.search = ""
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "")
  return parsedUrl.toString().replace(/\/+$/, "")
}

function safeNormalizeWorkerUrl(value: string) {
  try {
    return normalizeStaticWorkerUrl(value)
  } catch {
    return ""
  }
}

function pruneExpiredStaticWorkerReservations(now = Date.now()) {
  for (const [url, reservation] of staticWorkerReservations) {
    if (reservation.expiresAt <= now) {
      staticWorkerReservations.delete(url)
    }
  }
}

function selectStaticWorkerUrl(workerId: string, config: StaticWorkerConfig) {
  pruneExpiredStaticWorkerReservations()

  return selectStaticWorkerUrlFromPool(workerId, config, true)
}

export function selectStaticWorkerUrlFromPool(
  workerId: string,
  config: StaticWorkerConfig,
  includeInProcessReservations = false,
) {
  if (includeInProcessReservations) {
    pruneExpiredStaticWorkerReservations()
  }

  const urls = config.urls.map(safeNormalizeWorkerUrl).filter(Boolean)
  if (urls.length === 0) {
    throw new Error("STATIC_WORKER_URLS is required when PROVISIONER_MODE=static")
  }

  const unavailableUrls = new Set(
    (config.unavailableUrls ?? []).map(safeNormalizeWorkerUrl).filter(Boolean),
  )
  if (includeInProcessReservations) {
    for (const [url, reservation] of staticWorkerReservations) {
      if (reservation.workerId !== workerId) {
        unavailableUrls.add(url)
      }
    }
  }

  const availableUrls = urls.filter((url) => !unavailableUrls.has(url))

  if (availableUrls.length === 0) {
    throw new Error(
      "No available static worker URL remains; all configured STATIC_WORKER_URLS are already assigned to active workers",
    )
  }

  let hash = 0
  for (const char of workerId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }

  return availableUrls[hash % availableUrls.length]!
}

function reserveStaticWorkerUrl(workerId: string, url: string, ttlMs: number) {
  if (ttlMs <= 0) {
    return
  }
  staticWorkerReservations.set(url, {
    workerId,
    expiresAt: Date.now() + ttlMs,
  })
}

function releaseStaticWorkerUrl(workerId: string, url: string) {
  const reservation = staticWorkerReservations.get(url)
  if (reservation?.workerId === workerId) {
    staticWorkerReservations.delete(url)
  }
}

export async function provisionStaticWorker(
  input: ProvisionInput,
  config: StaticWorkerConfig = env.staticWorkers,
): Promise<ProvisionedInstance> {
  const reservationTtlMs = config.reservationTtlMs ?? 300000
  const url = selectStaticWorkerUrl(input.workerId, {
    ...config,
    unavailableUrls: config.unavailableUrls ?? input.unavailableStaticWorkerUrls,
  })
  reserveStaticWorkerUrl(input.workerId, url, reservationTtlMs)

  try {
    await waitForHealth(
      url,
      config.healthcheckTimeoutMs,
      config.healthcheckIntervalMs,
      config.healthPath,
    )
  } catch (error) {
    releaseStaticWorkerUrl(input.workerId, url)
    throw error
  }

  if (reservationTtlMs <= 0) {
    releaseStaticWorkerUrl(input.workerId, url)
  }

  return {
    provider: "static",
    url,
    status: "healthy",
    region: "on-prem",
  }
}

export async function checkStaticWorkerHealth(url: string, config: StaticWorkerConfig) {
  await waitForHealth(
    url,
    config.healthcheckTimeoutMs,
    config.healthcheckIntervalMs,
    config.healthPath,
  )
}

async function listRenderServices(limit = 200) {
  const rows: RenderService[] = []
  let cursor: string | undefined

  while (rows.length < limit) {
    const query = new URLSearchParams({ limit: "100" })
    if (cursor) {
      query.set("cursor", cursor)
    }

    const page = await renderRequest<RenderServiceListRow[]>(
      `/services?${query.toString()}`,
    )
    if (page.length === 0) {
      break
    }

    rows.push(
      ...page
        .map((entry) => entry.service)
        .filter((entry): entry is RenderService => Boolean(entry?.id)),
    )

    const nextCursor = page[page.length - 1]?.cursor
    if (!nextCursor || nextCursor === cursor) {
      break
    }

    cursor = nextCursor
  }

  return rows.slice(0, limit)
}

async function attachRenderCustomDomain(
  serviceId: string,
  workerId: string,
  renderUrl: string,
) {
  const hostname = customDomainForWorker(
    workerId,
    env.render.workerPublicDomainSuffix,
  )
  if (!hostname) {
    return null
  }

  try {
    await renderRequest(`/services/${serviceId}/custom-domains`, {
      method: "POST",
      body: JSON.stringify({
        name: hostname,
      }),
    })

    const dnsReady = await ensureVercelDnsRecord({
      hostname,
      targetUrl: renderUrl,
      domain: env.vercel.dnsDomain ?? env.render.workerPublicDomainSuffix,
      apiBase: env.vercel.apiBase,
      token: env.vercel.token,
      teamId: env.vercel.teamId,
      teamSlug: env.vercel.teamSlug,
    })

    if (!dnsReady) {
      console.warn(
        `[provisioner] vanity dns upsert skipped or failed for ${hostname}; using Render URL fallback`,
      )
      return null
    }

    return `https://${hostname}`
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(
      `[provisioner] custom domain attach failed for ${serviceId}: ${message}`,
    )
    return null
  }
}

function assertRenderConfig() {
  if (!env.render.apiKey) {
    throw new Error("RENDER_API_KEY is required for render provisioner")
  }
  if (!env.render.ownerId) {
    throw new Error("RENDER_OWNER_ID is required for render provisioner")
  }
}

async function provisionWorkerOnRender(
  input: ProvisionInput,
): Promise<ProvisionedInstance> {
  assertRenderConfig()

  const serviceName = slug(
    `${env.render.workerNamePrefix}-${input.name}-${input.workerId.slice(0, 8)}`,
  ).slice(0, 62)
  const orchestratorPackage = env.render.workerOpenworkVersion?.trim()
    ? `openwork-orchestrator@${env.render.workerOpenworkVersion.trim()}`
    : "openwork-orchestrator"
  const buildCommand = [
    `npm install -g ${orchestratorPackage}`,
    "node ./scripts/install-opencode.mjs",
  ].join(" && ")
  const startCommand = [
    "mkdir -p /tmp/workspace",
    "attempt=0; while [ $attempt -lt 3 ]; do attempt=$((attempt + 1)); openwork serve --workspace /tmp/workspace --remote-access --openwork-port ${PORT:-10000} --opencode-host 127.0.0.1 --opencode-port 4096 --connect-host 127.0.0.1 --cors '*' --approval manual --allow-external --opencode-source external --opencode-bin ./bin/opencode --no-opencode-router --verbose && exit 0; echo \"openwork serve failed (attempt $attempt); retrying in 3s\"; sleep 3; done; exit 1",
  ].join(" && ")

  const payload = {
    type: "web_service",
    name: serviceName,
    ownerId: env.render.ownerId,
    repo: env.render.workerRepo,
    branch: env.render.workerBranch,
    autoDeploy: "no",
    rootDir: env.render.workerRootDir,
    envVars: [
      { key: "OPENWORK_TOKEN", value: input.clientToken },
      { key: "OPENWORK_HOST_TOKEN", value: input.hostToken },
      { key: "DEN_WORKER_ID", value: input.workerId },
    ],
    serviceDetails: {
      runtime: "node",
      plan: env.render.workerPlan,
      region: env.render.workerRegion,
      healthCheckPath: "/health",
      envSpecificDetails: {
        buildCommand,
        startCommand,
      },
    },
  }

  const created = await renderRequest<{ service: RenderService }>("/services", {
    method: "POST",
    body: JSON.stringify(payload),
  })

  const serviceId = created.service.id
  await waitForDeployLive(serviceId)
  const service = await renderRequest<RenderService>(`/services/${serviceId}`)
  const renderUrl = service.serviceDetails?.url

  if (!renderUrl) {
    throw new Error(`Render service ${serviceId} has no public URL`)
  }

  await waitForHealth(renderUrl)

  const customUrl = await attachRenderCustomDomain(
    serviceId,
    input.workerId,
    renderUrl,
  )
  let url = renderUrl

  if (customUrl) {
    try {
      await waitForHealth(customUrl, env.render.customDomainReadyTimeoutMs)
      url = customUrl
    } catch {
      console.warn(
        `[provisioner] vanity domain not ready yet for ${input.workerId}; returning Render URL fallback`,
      )
    }
  }

  return {
    provider: "render",
    url,
    status: "healthy",
    region: service.serviceDetails?.region ?? env.render.workerRegion,
  }
}

export async function provisionWorker(
  input: ProvisionInput,
): Promise<ProvisionedInstance> {
  if (env.provisionerMode === "render") {
    return provisionWorkerOnRender(input)
  }

  if (env.provisionerMode === "daytona") {
    return provisionWorkerOnDaytona(input)
  }

  if (env.provisionerMode === "static") {
    return provisionStaticWorker(input)
  }

  const template = env.workerUrlTemplate ?? "https://workers.local/{workerId}"
  const url = template.replace("{workerId}", input.workerId)
  return {
    provider: "stub",
    url,
    status: "provisioning",
  }
}

export async function deprovisionWorker(input: {
  workerId: WorkerId
  instanceUrl: string | null
}) {
  if (env.provisionerMode === "static") {
    if (input.instanceUrl) {
      releaseStaticWorkerUrl(input.workerId, safeNormalizeWorkerUrl(input.instanceUrl))
    }
    return
  }

  if (env.provisionerMode === "daytona") {
    await deprovisionWorkerOnDaytona(input.workerId)
    return
  }

  if (env.provisionerMode !== "render") {
    return
  }

  assertRenderConfig()

  const targetHost = hostFromUrl(input.instanceUrl)
  const workerHint = input.workerId.slice(0, 8).toLowerCase()

  const services = await listRenderServices()

  const target =
    services.find((service) => {
      if (service.name?.toLowerCase().includes(workerHint)) {
        return true
      }

      if (
        targetHost &&
        hostFromUrl(service.serviceDetails?.url) === targetHost
      ) {
        return true
      }

      return false
    }) ?? null

  if (!target) {
    return
  }

  try {
    await renderRequest(`/services/${target.id}/suspend`, {
      method: "POST",
      body: JSON.stringify({}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(
      `[provisioner] failed to suspend Render service ${target.id}: ${message}`,
    )
  }
}
