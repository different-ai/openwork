// Protocol classification for the org provider gateway (plan §5.3). The
// family comes from the models.dev `npm` package; the per-request protocol
// (which usage parser to run) comes from the forwarded path.
import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import { BEDROCK_MANTLE_DEFAULT_API_PATH } from "@openwork-ee/utils/bedrock-mantle-catalog"
import { bedrockMantleHost, bedrockRuntimeHost, isAwsRegion } from "@openwork-ee/utils/inference-egress"
import type { CatalogProvider } from "./provider-catalog.js"

export type ProtocolFamily =
  | "anthropic"
  | "openai"
  | "mistral"
  | "azure"
  | "openai_compatible"
  | "google"
  | "google_vertex"
  | "google_vertex_anthropic"
  | "bedrock"
  | "bedrock_mantle"

export type AuthHeader = { name: string; value: string }

const familyByNpm: Record<string, ProtocolFamily> = {
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/openai": "openai",
  "@ai-sdk/mistral": "mistral",
  "@ai-sdk/azure": "azure",
  "@ai-sdk/openai-compatible": "openai_compatible",
  "@openrouter/ai-sdk-provider": "openai_compatible",
  "@ai-sdk/google": "google",
  "@ai-sdk/google-vertex": "google_vertex",
  "@ai-sdk/google-vertex/anthropic": "google_vertex_anthropic",
  "@ai-sdk/amazon-bedrock": "bedrock",
  "@ai-sdk/amazon-bedrock/mantle": "bedrock_mantle",
}

const commonHeaderAllowlist = ["content-type", "accept", "user-agent"]

const familyHeaderAllowlist: Record<ProtocolFamily, string[]> = {
  anthropic: ["anthropic-version", "anthropic-beta"],
  openai: ["openai-beta"],
  mistral: [],
  azure: ["openai-beta"],
  openai_compatible: ["openai-beta"],
  google: [],
  google_vertex: [],
  // `anthropic-version` moves into the body (`anthropic_version`) on Vertex.
  google_vertex_anthropic: ["anthropic-beta"],
  bedrock: [],
  bedrock_mantle: [],
}

const defaultBaseUrlByFamily: Partial<Record<ProtocolFamily, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  mistral: "https://api.mistral.ai/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
}

export function classifyProtocolFamily(catalog: CatalogProvider | null): ProtocolFamily | null {
  if (!catalog) return null
  const family = catalog.npm ? familyByNpm[catalog.npm] : undefined
  if (family) return family
  // Unknown SDK package but a known API base: best-effort OpenAI-compatible.
  return catalog.api ? "openai_compatible" : null
}

export function classifyRequestProtocol(family: ProtocolFamily, restPath: string): GatewayRequestProtocol {
  const pathname = `/${restPath}`.split("?")[0]
  switch (family) {
    case "anthropic":
    case "google_vertex_anthropic":
      return /^\/(?:v1\/)?messages$/.test(pathname) ? "anthropic_messages" : "passthrough"
    case "mistral":
      return /^\/(?:v1\/)?chat\/completions$/.test(pathname) ? "openai_chat" : "passthrough"
    case "openai":
    case "azure":
    case "openai_compatible":
      if (/^\/(?:v1\/)?(?:deployments\/[^/]+\/)?chat\/completions$/.test(pathname)) return "openai_chat"
      if (/^\/(?:v1\/)?(?:deployments\/[^/]+\/)?responses$/.test(pathname)) return "openai_responses"
      return "passthrough"
    case "google":
    case "google_vertex":
      return /^\/(?:v1(?:beta|alpha)?\/)?models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(pathname) ? "google_generate_content" : "passthrough"
    case "bedrock":
      return parseBedrockModelPath(pathname) ? "bedrock_converse" : "passthrough"
    case "bedrock_mantle":
      if (/^\/(?:v1\/)?chat\/completions$/.test(pathname)) return "openai_chat"
      if (/^\/(?:v1\/)?responses$/.test(pathname)) return "openai_responses"
      return "passthrough"
  }
}

// @ai-sdk/amazon-bedrock: `/model/{encodeURIComponent(modelId)}/converse[-stream]`.
export function parseBedrockModelPath(pathname: string): { model: string; stream: boolean } | null {
  const match = /\/model\/([^/]+)\/(converse|converse-stream)$/.exec(pathname)
  if (!match) return null
  let model = match[1]
  try {
    model = decodeURIComponent(model)
  } catch {
    // keep the raw segment
  }
  return { model, stream: match[2] === "converse-stream" }
}

export function parseGoogleModelPath(pathname: string): { model: string; operation: string } | null {
  const match = /\/models\/([^/:?]+):(generateContent|streamGenerateContent)$/.exec(pathname)
  return match ? { model: match[1], operation: match[2] } : null
}

export function buildAuthHeader(family: ProtocolFamily, secret: string): AuthHeader {
  switch (family) {
    case "anthropic":
      return { name: "x-api-key", value: secret }
    case "azure":
      return { name: "api-key", value: secret }
    case "google":
      return { name: "x-goog-api-key", value: secret }
    case "openai":
    case "mistral":
    case "openai_compatible":
    case "google_vertex":
    case "google_vertex_anthropic":
    case "bedrock":
    case "bedrock_mantle":
      return { name: "authorization", value: `Bearer ${secret}` }
  }
}

export function isAllowedRequestHeader(family: ProtocolFamily, name: string) {
  const lower = name.toLowerCase()
  if (lower.startsWith("x-stainless-")) return true
  if (commonHeaderAllowlist.includes(lower)) return true
  return familyHeaderAllowlist[family].includes(lower)
}

export function filterQuery(family: ProtocolFamily, search: string) {
  const params = new URLSearchParams(search)
  if (family === "google_vertex" || family === "google_vertex_anthropic") return params.get("alt") === "sse" ? "?alt=sse" : ""
  for (const name of [...params.keys()]) {
    if (["key", "api_key", "api-key", "apikey", "access_token", "token", "authorization"].includes(name.toLowerCase())) params.delete(name)
  }
  const filtered = params.toString()
  return filtered ? `?${filtered}` : ""
}

export function defaultBaseUrl(family: ProtocolFamily, settings: Record<string, unknown>) {
  if (family === "azure") {
    const resourceName = settings.resourceName
    return typeof resourceName === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(resourceName)
      ? `https://${resourceName}.openai.azure.com/openai`
      : null
  }
  if (family === "bedrock") {
    // The gateway re-derives the host once the credential is known (its region
    // wins over settings.region, plan §5.3), so a missing region here must not
    // fail URL resolution: the region-less host is replaced before use.
    const region = settings.region
    if (region === undefined || region === "") return "https://bedrock-runtime.amazonaws.com"
    return isAwsRegion(region) ? `https://${bedrockRuntimeHost(region)}` : null
  }
  if (family === "bedrock_mantle") {
    // As for Bedrock; the model's API path (/v1 or /openai/v1) is applied once
    // the grant has chosen the upstream model.
    const region = settings.region
    if (region === undefined || region === "") return `https://bedrock-mantle.api.aws${BEDROCK_MANTLE_DEFAULT_API_PATH}`
    return isAwsRegion(region) ? `https://${bedrockMantleHost(region)}${BEDROCK_MANTLE_DEFAULT_API_PATH}` : null
  }
  return defaultBaseUrlByFamily[family] ?? null
}

export function vertexHost(location: string) {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
}

export function vertexPublisherBase(settings: Record<string, unknown>, publisher: "google" | "anthropic") {
  const project = settings.project
  const location = settings.location
  if (typeof project !== "string" || !/^(?:[a-z][a-z0-9-]{4,61}[a-z0-9]|[0-9]{6,20})$/.test(project)
    || typeof location !== "string" || !/^(?:global|[a-z]+(?:-[a-z]+)*[0-9]+)$/.test(location)) return null
  return `https://${vertexHost(location)}/v1/projects/${project}/locations/${location}/publishers/${publisher}`
}

// The desktop speaks the public Google/Anthropic API shape; drop its version
// segment so the rest of the path can hang off the Vertex publisher base.
export function stripApiVersionPrefix(restPath: string) {
  return restPath.replace(/^v1(beta|alpha)?\//, "")
}
