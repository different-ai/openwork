function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function splitHostname(hostname: string, domain: string): string | null {
  const normalizedHost = hostname.trim().toLowerCase()
  const normalizedDomain = domain.trim().toLowerCase()
  if (!normalizedHost || !normalizedDomain) {
    return null
  }

  if (normalizedHost === normalizedDomain) {
    return ""
  }

  if (!normalizedHost.endsWith(`.${normalizedDomain}`)) {
    return null
  }

  return normalizedHost.slice(0, -(normalizedDomain.length + 1))
}

function hostFromUrl(value: string): string | null {
  try {
    return new URL(normalizeUrl(value)).host.toLowerCase()
  } catch {
    return null
  }
}

function withVercelScope(url: URL, teamId?: string, teamSlug?: string) {
  if (teamId?.trim()) {
    url.searchParams.set("teamId", teamId.trim())
  } else if (teamSlug?.trim()) {
    url.searchParams.set("slug", teamSlug.trim())
  }
  return url
}

type VercelDnsRecord = {
  id: string
  type?: string
  name?: string
  value?: string
}

async function vercelRequest<T>(input: {
  apiBase: string
  token: string
  path: string
  teamId?: string
  teamSlug?: string
  method?: "GET" | "POST" | "PATCH"
  body?: unknown
}): Promise<T> {
  const base = normalizeUrl(input.apiBase || "https://api.vercel.com")
  const url = withVercelScope(new URL(`${base}${input.path}`), input.teamId, input.teamSlug)
  const headers = new Headers({
    Authorization: `Bearer ${input.token}`,
    Accept: "application/json",
  })

  const init: RequestInit = {
    method: input.method ?? "GET",
    headers,
  }

  if (typeof input.body !== "undefined") {
    headers.set("Content-Type", "application/json")
    init.body = JSON.stringify(input.body)
  }

  const response = await fetch(url, init)
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`Vercel API ${input.path} failed (${response.status}): ${text.slice(0, 300)}`)
  }

  if (!text) {
    return null as T
  }

  return JSON.parse(text) as T
}

export function customDomainForWorker(workerId: string, suffix: string | null | undefined): string | null {
  const normalizedSuffix = suffix?.trim().toLowerCase()
  if (!normalizedSuffix) {
    return null
  }

  const label = slug(workerId).slice(0, 32)
  if (!label) {
    return null
  }

  return `${label}.${normalizedSuffix}`
}

export async function ensureVercelDnsRecord(input: {
  hostname: string
  targetUrl: string
  domain: string | null | undefined
  apiBase?: string
  token?: string
  teamId?: string
  teamSlug?: string
}): Promise<boolean> {
  const domain = input.domain?.trim().toLowerCase()
  const token = input.token?.trim()
  if (!domain || !token) {
    return false
  }

  const name = splitHostname(input.hostname, domain)
  const targetHost = hostFromUrl(input.targetUrl)
  if (name === null || !targetHost) {
    return false
  }

  const list = await vercelRequest<{ records?: VercelDnsRecord[] }>({
    apiBase: input.apiBase ?? "https://api.vercel.com",
    token,
    teamId: input.teamId,
    teamSlug: input.teamSlug,
    path: `/v4/domains/${encodeURIComponent(domain)}/records`,
  })

  const records = Array.isArray(list.records) ? list.records : []
  const current = records.find((record) => {
    if (!record?.id) {
      return false
    }
    if ((record.type ?? "").toUpperCase() !== "CNAME") {
      return false
    }
    return (record.name ?? "") === name
  })

  if (current && (current.value ?? "").toLowerCase() === targetHost.toLowerCase()) {
    return true
  }

  const payload = {
    name,
    type: "CNAME",
    value: targetHost,
  }

  if (current?.id) {
    await vercelRequest({
      apiBase: input.apiBase ?? "https://api.vercel.com",
      token,
      teamId: input.teamId,
      teamSlug: input.teamSlug,
      method: "PATCH",
      path: `/v4/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(current.id)}`,
      body: payload,
    })
    return true
  }

  await vercelRequest({
    apiBase: input.apiBase ?? "https://api.vercel.com",
    token,
    teamId: input.teamId,
    teamSlug: input.teamSlug,
    method: "POST",
    path: `/v4/domains/${encodeURIComponent(domain)}/records`,
    body: payload,
  })

  return true
}
