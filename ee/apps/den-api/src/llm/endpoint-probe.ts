/**
 * Endpoint probing for custom LLM providers ("test connection").
 *
 * Given a base URL and credential, discover what the endpoint actually
 * serves: normalize common URL mistakes (trailing `/responses`, Azure host
 * twins), call the OpenAI-compatible `GET /models`, and return the model
 * ids — on Azure these are the deployment names, which is exactly what the
 * provider config needs. Pure logic is separated from I/O so it can be
 * unit-tested with an injected fetch.
 */

type JsonRecord = Record<string, unknown>

export type ProbeVendor = "azure" | "openai-compatible"

export type EndpointProbeResult = {
  ok: boolean
  vendor: ProbeVendor
  /** The candidate base URL that answered /models, when ok. */
  normalizedApi: string | null
  /** Every candidate URL that was attempted, in order. */
  attempted: string[]
  models: Array<{ id: string }>
  /** Human guidance when not ok. */
  hint: string | null
  /** Upstream HTTP status of the last failed attempt, when relevant. */
  status: number | null
}

const AZURE_HOST_PATTERN = /\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/i

const STRIP_SUFFIXES = [
  "/chat/completions",
  "/completions",
  "/responses",
  "/models",
]

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function detectVendor(url: string): ProbeVendor {
  try {
    const { hostname } = new URL(url)
    if (AZURE_HOST_PATTERN.test(hostname)) return "azure"
  } catch {
    // fall through
  }
  return "openai-compatible"
}

function normalizeBase(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.hash = ""
    url.search = ""
    let pathname = url.pathname.replace(/\/+$/, "")
    for (const suffix of STRIP_SUFFIXES) {
      if (pathname.toLowerCase().endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length)
        break
      }
    }
    url.pathname = pathname
    return url.toString().replace(/\/+$/, "")
  } catch {
    return null
  }
}

function azureHostTwin(base: string): string | null {
  try {
    const url = new URL(base)
    if (/\.openai\.azure\.com$/i.test(url.hostname)) {
      url.hostname = url.hostname.replace(/\.openai\.azure\.com$/i, ".services.ai.azure.com")
      return url.toString().replace(/\/+$/, "")
    }
    if (/\.services\.ai\.azure\.com$/i.test(url.hostname)) {
      url.hostname = url.hostname.replace(/\.services\.ai\.azure\.com$/i, ".openai.azure.com")
      return url.toString().replace(/\/+$/, "")
    }
  } catch {
    // ignore
  }
  return null
}

function withAzureV1Path(base: string): string | null {
  try {
    const url = new URL(base)
    if (!AZURE_HOST_PATTERN.test(url.hostname)) return null
    if (url.pathname === "" || url.pathname === "/") {
      url.pathname = "/openai/v1"
      return url.toString().replace(/\/+$/, "")
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Ordered, deduplicated list of base URLs to try. The user's (normalized)
 * input always comes first; Azure-specific rewrites follow — the host twin
 * (`openai.azure.com` <-> `services.ai.azure.com`) and the bare-origin
 * `/openai/v1` path, both mistakes we have watched real users make.
 */
export function buildCandidateBaseUrls(raw: string): string[] {
  const first = normalizeBase(raw)
  if (!first) return []
  const candidates: string[] = [first]

  const v1 = withAzureV1Path(first)
  if (v1) candidates.push(v1)

  const twin = azureHostTwin(first)
  if (twin) {
    candidates.push(twin)
    const twinV1 = withAzureV1Path(twin)
    if (twinV1) candidates.push(twinV1)
  }

  return [...new Set(candidates)].slice(0, 6)
}

function isBlockedHostname(hostname: string, allowLoopback: boolean): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "metadata.google.internal") return true
  if (normalized === "169.254.169.254" || normalized.startsWith("169.254.")) return true
  if (normalized === "fd00:ec2::254") return true
  const loopback =
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127\./.test(normalized)
  if (loopback) return !allowLoopback
  // Private ranges: allowed for self-hosted installs reaching internal
  // gateways; the metadata/link-local blocks above are the hard rule.
  return false
}

export function assertProbeUrlAllowed(url: string, options?: { allowLoopback?: boolean }) {
  const allowLoopback = options?.allowLoopback ?? process.env.OPENWORK_DEV_MODE === "1"
  const parsed = new URL(url)
  if (isBlockedHostname(parsed.hostname, allowLoopback)) {
    throw new EndpointProbeBlockedError(`Probing ${parsed.hostname} is not allowed.`)
  }
}

export class EndpointProbeBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EndpointProbeBlockedError"
  }
}

const MAX_RESPONSE_BYTES = 512 * 1024
const PROBE_TIMEOUT_MS = 8_000

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error("Response too large.")
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseModelIds(payload: unknown): string[] | null {
  if (!isRecord(payload)) return null
  const data = payload.data
  if (!Array.isArray(data)) return null
  const ids = data.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const id = typeof entry.id === "string" ? entry.id.trim() : ""
    return id ? [id] : []
  })
  return [...new Set(ids)].sort()
}

function hintFor(vendor: ProbeVendor, status: number | null): string {
  if (status === 401 || status === 403) {
    return vendor === "azure"
      ? "The endpoint rejected the key. Check Keys & Endpoint on the Azure resource — the key must belong to the same resource as the base URL."
      : "The endpoint rejected the key. Double-check the credential for this endpoint."
  }
  if (status === 404) {
    return vendor === "azure"
      ? "No OpenAI-compatible /models endpoint found. Azure base URLs usually end in /openai/v1 — copy the endpoint from the Azure portal and check the resource name."
      : "No /models endpoint found at this base URL. Most OpenAI-compatible endpoints end in /v1."
  }
  if (status !== null) {
    return `The endpoint answered /models with HTTP ${status}.`
  }
  return "Could not reach the endpoint. Check the URL, network access, and that the endpoint allows requests from OpenWork Cloud."
}

/**
 * Try each candidate base URL until one serves /models. Sends both
 * `Authorization: Bearer` and `api-key` headers — Azure accepts either,
 * OpenAI-compatible servers ignore the extra header.
 */
export async function probeEndpoint(input: {
  api: string
  apiKey: string
  fetchImpl?: FetchLike
  allowLoopback?: boolean
}): Promise<EndpointProbeResult> {
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init))
  const vendor = detectVendor(input.api)
  const candidates = buildCandidateBaseUrls(input.api)
  const attempted: string[] = []

  if (candidates.length === 0) {
    return {
      ok: false,
      vendor,
      normalizedApi: null,
      attempted,
      models: [],
      hint: "Enter a valid http(s) base URL.",
      status: null,
    }
  }

  let lastStatus: number | null = null

  for (const base of candidates) {
    attempted.push(base)
    try {
      assertProbeUrlAllowed(base, { allowLoopback: input.allowLoopback })
    } catch (error) {
      if (error instanceof EndpointProbeBlockedError) {
        return { ok: false, vendor, normalizedApi: null, attempted, models: [], hint: error.message, status: null }
      }
      throw error
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetchImpl(`${base}/models`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${input.apiKey}`,
            "api-key": input.apiKey,
          },
          signal: controller.signal,
          redirect: "error",
        })
      } finally {
        clearTimeout(timer)
      }

      lastStatus = response.status
      if (!response.ok) continue

      const payload = await readBoundedJson(response)
      const ids = parseModelIds(payload)
      if (!ids) continue

      return {
        ok: true,
        vendor,
        normalizedApi: base,
        attempted,
        models: ids.map((id) => ({ id })),
        hint: null,
        status: response.status,
      }
    } catch {
      // Network error or abort — try the next candidate.
      continue
    }
  }

  return {
    ok: false,
    vendor,
    normalizedApi: null,
    attempted,
    models: [],
    hint: hintFor(vendor, lastStatus),
    status: lastStatus,
  }
}
