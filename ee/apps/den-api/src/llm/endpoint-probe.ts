type JsonRecord = Record<string, unknown>

export type ProbeVendor = "azure" | "openai-compatible"

export type EndpointProbeResult = {
  ok: boolean
  vendor: ProbeVendor
  normalizedApi: string | null
  attempted: string[]
  models: Array<{ id: string }>
  hint: string | null
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
  }
  return null
}

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

const AZURE_DEPLOYMENTS_API_VERSION = "2023-03-15-preview"

async function listAzureDeployments(
  fetchImpl: FetchLike,
  base: string,
  apiKey: string,
): Promise<string[] | null> {
  let origin: string
  try {
    origin = new URL(base).origin
  } catch {
    return null
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetchImpl(
      `${origin}/openai/deployments?api-version=${AZURE_DEPLOYMENTS_API_VERSION}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "api-key": apiKey,
        },
        signal: controller.signal,
        redirect: "error",
      },
    )
    if (!response.ok) return null
    const payload = await readBoundedJson(response)
    const ids = parseModelIds(payload)
    return ids && ids.length > 0 ? ids : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
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

      const deployments =
        vendor === "azure" ? await listAzureDeployments(fetchImpl, base, input.apiKey) : null

      return {
        ok: true,
        vendor,
        normalizedApi: base,
        attempted,
        models: (deployments ?? ids).map((id) => ({ id })),
        hint: null,
        status: response.status,
      }
    } catch {
      continue
    }
  }

  if (vendor === "azure") {
    const origins = [...new Set(candidates.map((base) => new URL(base).origin))]
    for (const origin of origins) {
      const deployments = await listAzureDeployments(fetchImpl, `${origin}/openai/v1`, input.apiKey)
      if (deployments) {
        return {
          ok: true,
          vendor,
          normalizedApi: `${origin}/openai/v1`,
          attempted,
          models: deployments.map((id) => ({ id })),
          hint: null,
          status: 200,
        }
      }
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

export type ModelVerification = {
  id: string
  status: "ok" | "adjusted" | "failed"
  npm: "@ai-sdk/openai-compatible" | "@ai-sdk/openai"
  message: string | null
}

const VERIFY_TIMEOUT_MS = 20_000
const MAX_VERIFY_MODELS = 8

function truncate(value: string, max = 300): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}

function readErrorMessage(payload: unknown): { message: string; param: string | null } {
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = typeof payload.error.message === "string" ? payload.error.message : ""
    const param = typeof payload.error.param === "string" ? payload.error.param : null
    return { message, param }
  }
  return { message: "", param: null }
}

async function completionAttempt(
  fetchImpl: FetchLike,
  base: string,
  apiKey: string,
  modelId: string,
  tokenParam: "max_tokens" | "max_completion_tokens",
): Promise<{ ok: boolean; needsCompletionTokens: boolean; message: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        [tokenParam]: 16,
      }),
      signal: controller.signal,
      redirect: "error",
    })
    if (response.ok) {
      return { ok: true, needsCompletionTokens: false, message: null }
    }
    const payload = await readBoundedJson(response)
    const { message, param } = readErrorMessage(payload)
    const needsCompletionTokens =
      response.status === 400 &&
      (param === "max_tokens" || /max_completion_tokens/i.test(message))
    return {
      ok: false,
      needsCompletionTokens,
      message: truncate(message || `HTTP ${response.status}`),
    }
  } catch (error) {
    return {
      ok: false,
      needsCompletionTokens: false,
      message: truncate(error instanceof Error ? error.message : "Request failed."),
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function verifyModels(input: {
  api: string
  apiKey: string
  modelIds: string[]
  fetchImpl?: FetchLike
  allowLoopback?: boolean
}): Promise<ModelVerification[]> {
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init))
  const base = normalizeBase(input.api)
  const ids = [...new Set(input.modelIds.map((id) => id.trim()).filter(Boolean))].slice(
    0,
    MAX_VERIFY_MODELS,
  )
  if (!base || ids.length === 0) return []
  assertProbeUrlAllowed(base, { allowLoopback: input.allowLoopback })

  const results: ModelVerification[] = []
  for (const id of ids) {
    const first = await completionAttempt(fetchImpl, base, input.apiKey, id, "max_tokens")
    if (first.ok) {
      results.push({ id, status: "ok", npm: "@ai-sdk/openai-compatible", message: null })
      continue
    }
    if (first.needsCompletionTokens) {
      const second = await completionAttempt(
        fetchImpl,
        base,
        input.apiKey,
        id,
        "max_completion_tokens",
      )
      if (second.ok) {
        results.push({
          id,
          status: "adjusted",
          npm: "@ai-sdk/openai",
          message: "Model requires max_completion_tokens; using the OpenAI request shape.",
        })
        continue
      }
      results.push({ id, status: "failed", npm: "@ai-sdk/openai", message: second.message })
      continue
    }
    results.push({ id, status: "failed", npm: "@ai-sdk/openai-compatible", message: first.message })
  }
  return results
}
