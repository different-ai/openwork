import { WorkerTable } from "@openwork-ee/den-db/schema"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import {
  deprovisionWorkerOnDaytona,
  provisionWorkerOnDaytona,
} from "./daytona.js"
import {
  customDomainForWorker,
  ensureVercelDnsRecord,
} from "./vanity-domain.js"

type WorkerId = typeof WorkerTable.$inferSelect.id
const logger = appLogger.child({ component: "worker_provisioner" })

export type ProvisionInput = {
  workerId: WorkerId
  name: string
  hostToken: string
  clientToken: string
  activityToken: string
}

export type ProvisionedInstance = {
  provider: string
  url: string
  status: "provisioning" | "healthy"
  region?: string
  imageVersion?: string | null
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

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

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
) {
  const healthUrl = `${url.replace(/\/$/, "")}/health`
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { method: "GET" })
      if (response.ok) {
        return
      }
    } catch {
      // ignore transient network failures while the instance boots
    }
    await sleep(env.render.pollIntervalMs)
  }

  throw new Error(`Timed out waiting for worker health endpoint ${healthUrl}`)
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
      logger.warn("vanity dns upsert skipped or failed", { hostname })
      return null
    }

    return `https://${hostname}`
  } catch (error) {
    logger.warn("custom domain attach failed", { service_id: serviceId, worker_id: workerId, error })
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
  const openworkServerPackage = env.render.workerOpenworkVersion?.trim()
    ? `openwork-server@${env.render.workerOpenworkVersion.trim()}`
    : "openwork-server"
  const buildCommand = [
    `npm install -g ${shellQuote(openworkServerPackage)}`,
    "node ./scripts/install-opencode.mjs",
  ].join(" && ")
  const startScript = `
set -u
mkdir -p /tmp/workspace
plugin_dir="$(npm root -g)/openwork-server/dist/opencode-plugins"
if [ ! -d "$plugin_dir" ]; then
  echo "openwork-server extension plugins missing at $plugin_dir" >&2
  exit 1
fi
attempt=0
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  if OPENWORK_MANAGE_OPENCODE=1 OPENWORK_OPENCODE_BIN=./bin/opencode OPENWORK_EXTENSIONS_PLUGIN_DIR="$plugin_dir" openwork-server --workspace /tmp/workspace --host 0.0.0.0 --port "\${PORT:-10000}" --cors '*' --approval manual --verbose; then
    exit 0
  fi
  status=$?
  echo "openwork-server failed (attempt $attempt, exit $status); retrying in 3s"
  sleep 3
done
exit 1
`.trim()
  const startCommand = `sh -lc ${shellQuote(startScript)}`

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
      logger.warn("vanity domain not ready yet", { worker_id: input.workerId })
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
    logger.warn("failed to suspend Render service", { worker_id: input.workerId, service_id: target.id, error })
  }
}
