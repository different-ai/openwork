import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import { BEDROCK_MANTLE_DEFAULT_API_PATH, GATEWAY_FAMILY_DEFAULT_BASE_URLS, gatewaySdkFamily, microsoftFoundryBaseUrl, type ProtocolFamily } from "@openwork-ee/gateway-catalog"
import { bedrockMantleHost, bedrockRuntimeHost, isAwsRegion } from "@openwork-ee/gateway-upstreams/egress"
import type { CatalogProvider } from "@openwork-ee/gateway-catalog"

export type { ProtocolFamily }

export type AuthHeader = { name: string; value: string }

const commonHeaderAllowlist = ["content-type", "accept", "user-agent"]

const familyHeaderAllowlist: Record<ProtocolFamily, string[]> = {
  anthropic: ["anthropic-version", "anthropic-beta"],
  openai: ["openai-beta"],
  mistral: [],
  azure: ["openai-beta"],
  openai_compatible: ["openai-beta"],
  google: [],
  google_vertex: [],
  google_vertex_anthropic: ["anthropic-beta"],
  bedrock: [],
  bedrock_mantle: [],
  microsoft_foundry: ["anthropic-version", "anthropic-beta"],
}

export function classifyProtocolFamily(catalog: CatalogProvider | null): ProtocolFamily | null {
  if (!catalog) return null
  if (catalog.family) return catalog.family
  const family = gatewaySdkFamily(catalog.npm)
  if (family) return family
  return catalog.api ? "openai_compatible" : null
}

export function classifyRequestProtocol(family: ProtocolFamily, restPath: string): GatewayRequestProtocol {
  const pathname = `/${restPath}`.split("?")[0]
  switch (family) {
    case "anthropic":
    case "google_vertex_anthropic":
    case "microsoft_foundry":
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

export function parseBedrockModelPath(pathname: string): { model: string; stream: boolean } | null {
  const match = /\/model\/([^/]+)\/(converse|converse-stream)$/.exec(pathname)
  if (!match) return null
  let model = match[1]
  try {
    model = decodeURIComponent(model)
  } catch {
  }
  return { model, stream: match[2] === "converse-stream" }
}

export function parseGoogleModelPath(pathname: string): { model: string; operation: string } | null {
  const match = /\/models\/([^/:?]+):(generateContent|streamGenerateContent)$/.exec(pathname)
  return match ? { model: match[1], operation: match[2] } : null
}

/** `bearer`: a token the person signed in for (Entra ID on Foundry), not an API key. */
export function buildAuthHeader(family: ProtocolFamily, secret: string, bearer = false): AuthHeader {
  switch (family) {
    case "anthropic":
      return { name: "x-api-key", value: secret }
    case "microsoft_foundry":
      return bearer ? { name: "authorization", value: `Bearer ${secret}` } : { name: "api-key", value: secret }
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

export function isAllowedRequestHeader(family: ProtocolFamily, name: string, providerHeaders: readonly string[] = []) {
  const lower = name.toLowerCase()
  if (lower.startsWith("x-stainless-")) return true
  if (commonHeaderAllowlist.includes(lower)) return true
  if (providerHeaders.includes(lower)) return true
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
  if (family === "microsoft_foundry") return microsoftFoundryBaseUrl(settings.resourceName)
  if (family === "azure") {
    const resourceName = settings.resourceName
    return typeof resourceName === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(resourceName)
      ? `https://${resourceName}.openai.azure.com/openai`
      : null
  }
  if (family === "bedrock") {
    const region = settings.region
    if (region === undefined || region === "") return "https://bedrock-runtime.amazonaws.com"
    return isAwsRegion(region) ? `https://${bedrockRuntimeHost(region)}` : null
  }
  if (family === "bedrock_mantle") {
    const region = settings.region
    if (region === undefined || region === "") return `https://bedrock-mantle.api.aws${BEDROCK_MANTLE_DEFAULT_API_PATH}`
    return isAwsRegion(region) ? `https://${bedrockMantleHost(region)}${BEDROCK_MANTLE_DEFAULT_API_PATH}` : null
  }
  return GATEWAY_FAMILY_DEFAULT_BASE_URLS[family] ?? null
}

export { vertexHost, vertexPublisherBase } from "@openwork-ee/gateway-upstreams/egress"

export function stripApiVersionPrefix(restPath: string) {
  return restPath.replace(/^v1(beta|alpha)?\//, "")
}
