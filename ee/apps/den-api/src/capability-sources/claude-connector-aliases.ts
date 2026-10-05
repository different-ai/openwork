/**
 * Claude Cowork plugins (for example Anthropic's knowledge-work-plugins) list
 * suggested connectors in `.mcp.json`. Some of those entries point at
 * Anthropic-hosted endpoints, or leave the URL blank because Claude provides
 * the connector itself. Imported as-is they become new, often unusable,
 * connections next to the ones the organization already has.
 *
 * This table maps those declarations to the provider OpenWork already knows,
 * so a GitHub plugin import can use the organization's existing connection.
 * Only providers Den itself implements (native connectors in
 * provider-registry.ts) or offers as presets (external-mcp-presets.ts) are
 * valid targets. Any declared URL that already equals a preset URL (Slack,
 * Notion, Linear, GitHub, ...) maps to that preset without an entry here.
 *
 * Deliberately not mapped, because Den has no preset or native connector to
 * send them to: HubSpot (mcp.hubspot.com/anthropic), Lusha
 * (mcp.lusha.com/mcp/claude), Gusto (mcp.api.gusto.com/anthropic), Mailchimp,
 * Zoho, and Anthropic's research servers (hcls.mcp.claude.com,
 * pubmed.mcp.claude.com). Those keep the existing import behaviour.
 */
import { matchExternalMcpPresetForUrl } from "./external-mcp-auth-policy.js"

export type NativeConnectorProviderId = "google-workspace" | "microsoft-365"

export type ImportedConnectorTarget =
  | {
    kind: "native"
    providerId: NativeConnectorProviderId
    displayName: string
    /**
     * What to do when the organization has no such native connection yet.
     * "skip": the declared endpoint only works inside Claude, so never create
     * a connection for it; the person connects the native provider instead.
     * "keep_declared": the declared endpoint is the vendor's own server, so
     * import it as before.
     */
    whenMissing: "keep_declared" | "skip"
  }
  | {
    kind: "preset"
    providerId: string
    displayName: string
    /** The preset's URL; imports use it instead of the declared one. */
    url: string
  }

type ClaudeConnectorAlias = {
  /** Server names (case-insensitive; "-" and "_" read as spaces) declared with a blank URL. */
  blankUrlNames?: readonly string[]
  /** Hostnames whose declared URL (any path) maps to the target. */
  hosts?: readonly string[]
  target: Extract<ImportedConnectorTarget, { kind: "native" }>
}

type NativeProvider = Omit<Extract<ImportedConnectorTarget, { kind: "native" }>, "whenMissing">
const GOOGLE_WORKSPACE: NativeProvider = { kind: "native", providerId: "google-workspace", displayName: "Google Workspace" }
const MICROSOFT_365: NativeProvider = { kind: "native", providerId: "microsoft-365", displayName: "Microsoft 365" }

export const CLAUDE_CONNECTOR_ALIASES: readonly ClaudeConnectorAlias[] = [
  // Anthropic's hosted Microsoft 365 connector; it signs people in through
  // Anthropic's own app registration.
  { hosts: ["microsoft365.mcp.claude.com"], target: { ...MICROSOFT_365, whenMissing: "skip" } },
  // Claude supplies Gmail, Calendar and Drive itself, so plugins leave the URL blank.
  { blankUrlNames: ["gmail", "google calendar", "google drive"], target: { ...GOOGLE_WORKSPACE, whenMissing: "skip" } },
  // Google's own Workspace MCP servers. Real endpoints, but an organization
  // with Google Workspace connected should not get a second Google connection.
  {
    hosts: ["gmailmcp.googleapis.com", "calendarmcp.googleapis.com", "drivemcp.googleapis.com"],
    target: { ...GOOGLE_WORKSPACE, whenMissing: "keep_declared" },
  },
]

function normalizedServerName(name: string) {
  return name.trim().toLowerCase().replace(/[-_\s]+/g, " ")
}

function urlHostname(url: string) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** The provider OpenWork already knows for one declared plugin connector, if any. */
export function resolveImportedConnectorTarget(input: { name: string; url: string | null }): ImportedConnectorTarget | null {
  const url = input.url?.trim() ?? ""
  if (!url) {
    const name = normalizedServerName(input.name)
    const alias = CLAUDE_CONNECTOR_ALIASES.find((entry) => entry.blankUrlNames?.includes(name))
    return alias ? alias.target : null
  }
  const hostname = urlHostname(url)
  const alias = hostname ? CLAUDE_CONNECTOR_ALIASES.find((entry) => entry.hosts?.includes(hostname)) : undefined
  if (alias) return alias.target
  const preset = matchExternalMcpPresetForUrl(url)
  return preset ? { kind: "preset", providerId: preset.presetId, displayName: preset.displayName, url: preset.url } : null
}
