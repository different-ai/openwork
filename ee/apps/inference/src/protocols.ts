// Protocol classification for the org provider gateway (plan §5.3). The
// family comes from the models.dev `npm` package; the per-request protocol
// (which usage parser to run) comes from the forwarded path.
import type { InferenceRequestProtocol } from "@openwork/types/den/inference"
import type { CatalogProvider } from "./provider-catalog.js"

export type ProtocolFamily =
  | "anthropic"
  | "openai"
  | "azure"
  | "openai_compatible"
  | "google"
  | "google_vertex"
  | "google_vertex_anthropic"
  | "bedrock"

export type AuthHeader = { name: string; value: string }

const familyByNpm: Record<string, ProtocolFamily> = {
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/openai": "openai",
  "@ai-sdk/azure": "azure",
  "@ai-sdk/openai-compatible": "openai_compatible",
  "@openrouter/ai-sdk-provider": "openai_compatible",
  "@ai-sdk/google": "google",
  "@ai-sdk/google-vertex": "google_vertex",
  "@ai-sdk/google-vertex/anthropic": "google_vertex_anthropic",
  "@ai-sdk/amazon-bedrock": "bedrock",
}

const commonHeaderAllowlist = ["content-type", "accept", "user-agent"]

const familyHeaderAllowlist: Record<ProtocolFamily, string[]> = {
  anthropic: ["anthropic-version", "anthropic-beta"],
  openai: ["openai-beta", "openai-organization", "openai-project"],
  azure: ["openai-beta", "openai-organization", "openai-project"],
  openai_compatible: ["openai-beta", "openai-organization", "openai-project"],
  google: [],
  google_vertex: [],
  // `anthropic-version` moves into the body (`anthropic_version`) on Vertex.
  google_vertex_anthropic: ["anthropic-beta"],
  bedrock: [],
}

const defaultBaseUrlByFamily: Partial<Record<ProtocolFamily, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
}

export function classifyProtocolFamily(catalog: CatalogProvider | null): ProtocolFamily | null {
  if (!catalog) return null
  const family = catalog.npm ? familyByNpm[catalog.npm] : undefined
  if (family) return family
  // Unknown SDK package but a known API base: best-effort OpenAI-compatible.
  return catalog.api ? "openai_compatible" : null
}

export function classifyRequestProtocol(family: ProtocolFamily, restPath: string): InferenceRequestProtocol {
  const pathname = `/${restPath}`.split("?")[0]
  switch (family) {
    case "anthropic":
    case "google_vertex_anthropic":
      return pathname.endsWith("/messages") ? "anthropic_messages" : "passthrough"
    case "openai":
    case "azure":
    case "openai_compatible":
      if (pathname.endsWith("/chat/completions")) return "openai_chat"
      if (pathname.endsWith("/responses")) return "openai_responses"
      return "passthrough"
    case "google":
    case "google_vertex":
      return parseGoogleModelPath(pathname) ? "google_generate_content" : "passthrough"
    case "bedrock":
      return "bedrock_converse"
  }
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
    case "openai_compatible":
    case "google_vertex":
    case "google_vertex_anthropic":
    case "bedrock":
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
  if (family === "google" || family === "google_vertex") params.delete("key")
  const filtered = params.toString()
  return filtered ? `?${filtered}` : ""
}

export function defaultBaseUrl(family: ProtocolFamily, settings: Record<string, unknown>) {
  if (family === "azure") {
    const resourceName = settings.resourceName
    return typeof resourceName === "string" && resourceName
      ? `https://${resourceName}.openai.azure.com/openai`
      : null
  }
  return defaultBaseUrlByFamily[family] ?? null
}

export function vertexHost(location: string) {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
}

export function vertexPublisherBase(settings: Record<string, unknown>, publisher: "google" | "anthropic") {
  const project = settings.project
  const location = settings.location
  if (typeof project !== "string" || !project || typeof location !== "string" || !location) return null
  return `https://${vertexHost(location)}/v1/projects/${project}/locations/${location}/publishers/${publisher}`
}

// The desktop speaks the public Google/Anthropic API shape; drop its version
// segment so the rest of the path can hang off the Vertex publisher base.
export function stripApiVersionPrefix(restPath: string) {
  return restPath.replace(/^v1(beta|alpha)?\//, "")
}
