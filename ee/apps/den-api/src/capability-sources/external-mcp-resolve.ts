/**
 * Smart resolution for the "add a connection" flow: an admin types a free-form
 * query — a full URL, a bare host, or just a product name like "vercel" — and
 * the resolver turns it into concrete MCP endpoint candidates. Candidates are
 * probed with the same side-effect-free requirements discovery (and the same
 * SSRF-guarded fetch) as POST /v1/mcp-connections/discover; nothing here
 * registers clients, writes credentials, or creates connections.
 */
import type { EnterpriseMcpConnectionRequirements } from "@openwork/enterprise-mcp-client"
import type { ExternalMcpPreset } from "./external-mcp-presets.js"

export const MAX_RESOLVE_QUERY_LENGTH = 200

/** Bare names probe well-known hosts; keep the fan-out small and bounded. */
export const RESOLVE_CANDIDATE_LIMIT = 5

export type ResolveQueryClassification =
  | { kind: "url"; url: string }
  | { kind: "domain"; url: string }
  | { kind: "name"; slug: string }
  | { kind: "invalid"; reason: string }

// Dots are excluded: a dotted query without spaces is classified as a domain,
// and a dotted phrase with spaces is ambiguous rather than a product name.
const NAME_QUERY_PATTERN = /^[a-z0-9][a-z0-9 &_'-]{0,63}$/i
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

function validateEndpointUrl(parsed: URL): string | null {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "An MCP server URL must use HTTP or HTTPS."
  }
  if (parsed.username || parsed.password || parsed.hash) {
    return "An MCP server URL cannot contain credentials or a fragment."
  }
  return null
}

export function classifyResolveQuery(rawQuery: string): ResolveQueryClassification {
  const query = rawQuery.trim()
  if (!query) return { kind: "invalid", reason: "Type a server URL or a product name." }
  if (query.length > MAX_RESOLVE_QUERY_LENGTH) {
    return { kind: "invalid", reason: `Queries are limited to ${MAX_RESOLVE_QUERY_LENGTH} characters.` }
  }

  if (/^https?:\/\//i.test(query)) {
    let parsed: URL
    try {
      parsed = new URL(query)
    } catch {
      return { kind: "invalid", reason: "That URL could not be parsed." }
    }
    const problem = validateEndpointUrl(parsed)
    if (problem) return { kind: "invalid", reason: problem }
    return { kind: "url", url: parsed.toString() }
  }

  if (query.includes(".") && !/\s/.test(query)) {
    let parsed: URL
    try {
      parsed = new URL(`https://${query}`)
    } catch {
      return { kind: "invalid", reason: "That host could not be parsed." }
    }
    const problem = validateEndpointUrl(parsed)
    if (problem) return { kind: "invalid", reason: problem }
    if (!HOSTNAME_PATTERN.test(parsed.hostname)) {
      return { kind: "invalid", reason: "That host could not be parsed." }
    }
    return { kind: "domain", url: parsed.toString() }
  }

  if (NAME_QUERY_PATTERN.test(query)) {
    const slug = normalizeQueryText(query)
    if (slug) return { kind: "name", slug }
  }
  return { kind: "invalid", reason: "Type a server URL or a product name." }
}

/** Lowercased letters and digits only — the comparison form for names. */
export function normalizeQueryText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function withMcpPathVariant(url: string): string[] {
  const parsed = new URL(url)
  const candidates = [parsed.toString()]
  if (parsed.pathname === "/" && !parsed.search) {
    candidates.push(new URL("/mcp", parsed).toString())
  }
  return candidates
}

/**
 * Ordered, deduplicated endpoint candidates for a classified query. The order
 * is the preference order: an exact URL always outranks a guessed variant.
 */
export function resolveCandidateUrls(classification: ResolveQueryClassification): string[] {
  const candidates: string[] = []
  if (classification.kind === "url") {
    candidates.push(...withMcpPathVariant(classification.url))
  } else if (classification.kind === "domain") {
    candidates.push(...withMcpPathVariant(classification.url))
    const parsed = new URL(classification.url)
    if (!parsed.hostname.startsWith("mcp.") && parsed.pathname === "/" && !parsed.search) {
      candidates.push(`https://mcp.${parsed.hostname}/mcp`)
    }
  } else if (classification.kind === "name") {
    // Some providers only answer on the host root (Stripe), others only on
    // /mcp — probe both for the most common host before trying other TLDs.
    candidates.push(`https://mcp.${classification.slug}.com/mcp`)
    candidates.push(`https://mcp.${classification.slug}.com/`)
    for (const tld of ["dev", "io", "ai"]) {
      candidates.push(`https://mcp.${classification.slug}.${tld}/mcp`)
    }
  }
  return [...new Set(candidates)].slice(0, RESOLVE_CANDIDATE_LIMIT)
}

/**
 * A curated preset always beats probing: it carries a verified URL plus auth
 * expectations (for example Slack's pre-registered OAuth client requirement).
 */
export function matchPresetForQuery(
  rawQuery: string,
  presets: readonly ExternalMcpPreset[],
): ExternalMcpPreset | null {
  const query = rawQuery.trim()
  if (!query) return null
  const normalized = normalizeQueryText(query)
  const queryHost = hostnameOf(query) ?? hostnameOf(`https://${query}`)
  for (const preset of presets) {
    if (normalized && (normalizeQueryText(preset.presetId) === normalized || normalizeQueryText(preset.displayName) === normalized)) {
      return preset
    }
    const presetHost = hostnameOf(preset.url)
    if (queryHost && presetHost && queryHost === presetHost) {
      return preset
    }
  }
  return null
}

function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** "https://mcp.vercel.com/mcp" -> "Vercel"; used to prefill the name field. */
export function suggestConnectionName(url: string): string {
  const hostname = hostnameOf(url)
  if (!hostname) return ""
  const labels = hostname.split(".").filter(Boolean)
  while (labels.length > 1 && (labels[0] === "mcp" || labels[0] === "www" || labels[0] === "api")) {
    labels.shift()
  }
  const label = labels[0] ?? ""
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : ""
}

/**
 * Whether a discovery result is evidence of a real MCP endpoint. Guessed
 * candidates (from a bare name) demand strong evidence — a successful
 * initialize or advertised OAuth metadata — so an unrelated site that merely
 * answers 401 never resolves as a match.
 */
export function discoveryQualifiesAsMcp(
  discovery: EnterpriseMcpConnectionRequirements,
  options: { guessed: boolean },
): boolean {
  if (discovery.server.initialize === "succeeded") return true
  // Advertised RFC 9728 OAuth metadata is strong evidence of an MCP-style
  // protected resource even when unauthenticated initialize is rejected with
  // something other than 401 (Vercel does this).
  if (discovery.status === "ready" && discovery.authentication.kind === "oauth") return true
  if (discovery.server.initialize !== "authentication_required") return false
  if (discovery.authentication.kind === "oauth") return true
  return !options.guessed && discovery.authentication.kind === "manual_bearer"
}
