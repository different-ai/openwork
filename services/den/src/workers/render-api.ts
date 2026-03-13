import { env } from "../env.js"

export type RenderService = {
  id: string
  name?: string
  slug?: string
  suspended?: string | boolean | null
  serviceDetails?: {
    url?: string
    region?: string
  }
}

export type RenderDeploy = {
  id: string
  status: string
  createdAt?: string
  updatedAt?: string
  finishedAt?: string
}

type RenderServiceListRow = {
  cursor?: string
  service?: RenderService
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function parseEnvVarValue(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null
  }

  const envVar = isRecord(payload.envVar) ? payload.envVar : null
  return firstString([
    payload.value,
    payload.previewValue,
    envVar?.value,
    envVar?.previewValue,
  ])
}

export function hasRenderConfig() {
  return Boolean(env.render.apiKey && env.render.ownerId)
}

export function assertRenderConfig() {
  if (!env.render.apiKey) {
    throw new Error("RENDER_API_KEY is required for render provisioner")
  }

  if (!env.render.ownerId) {
    throw new Error("RENDER_OWNER_ID is required for render provisioner")
  }
}

export async function renderRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  assertRenderConfig()

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
    throw new Error(`Render API ${path} failed (${response.status}): ${text.slice(0, 400)}`)
  }

  if (!text) {
    return null as T
  }

  return JSON.parse(text) as T
}

export async function listRenderServices(limit = 200) {
  const rows: RenderService[] = []
  let cursor: string | undefined

  while (rows.length < limit) {
    const query = new URLSearchParams({ limit: "100" })
    if (cursor) {
      query.set("cursor", cursor)
    }

    const page = await renderRequest<RenderServiceListRow[]>(`/services?${query.toString()}`)
    if (page.length === 0) {
      break
    }

    rows.push(...page.map((entry) => entry.service).filter((entry): entry is RenderService => Boolean(entry?.id)))

    const nextCursor = page[page.length - 1]?.cursor
    if (!nextCursor || nextCursor === cursor) {
      break
    }

    cursor = nextCursor
  }

  return rows.slice(0, limit)
}

export async function getLatestRenderDeploy(serviceId: string) {
  const rows = await renderRequest<Array<{ deploy?: RenderDeploy }>>(`/services/${serviceId}/deploys?limit=1`)
  return rows[0]?.deploy ?? null
}

export async function getRenderServiceEnvVar(serviceId: string, envVarKey: string) {
  assertRenderConfig()

  const response = await fetch(
    `${env.render.apiBase}/services/${serviceId}/env-vars/${encodeURIComponent(envVarKey)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${env.render.apiKey}`,
      },
    },
  )

  if (response.status === 404) {
    return null
  }

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Render API /services/${serviceId}/env-vars/${envVarKey} failed (${response.status}): ${text.slice(0, 400)}`)
  }

  if (!text) {
    return { key: envVarKey, value: null }
  }

  let payload: unknown = null
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    return { key: envVarKey, value: null }
  }

  return {
    key: envVarKey,
    value: parseEnvVarValue(payload),
  }
}
