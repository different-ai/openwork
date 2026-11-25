import { matchExternalMcpPresetForUrl } from "./external-mcp-auth-policy.js"

export type NativeConnectorProviderId = "google-workspace" | "microsoft-365"

export type ImportedConnectorTarget =
  | {
    kind: "native"
    providerId: NativeConnectorProviderId
    displayName: string
    whenMissing: "keep_declared" | "skip"
  }
  | {
    kind: "preset"
    providerId: string
    displayName: string
    url: string
  }

type ClaudeConnectorAlias = {
  blankUrlNames?: readonly string[]
  hosts?: readonly string[]
  target: Extract<ImportedConnectorTarget, { kind: "native" }>
}

type NativeProvider = Omit<Extract<ImportedConnectorTarget, { kind: "native" }>, "whenMissing">
const GOOGLE_WORKSPACE: NativeProvider = { kind: "native", providerId: "google-workspace", displayName: "Google Workspace" }
const MICROSOFT_365: NativeProvider = { kind: "native", providerId: "microsoft-365", displayName: "Microsoft 365" }

export const CLAUDE_CONNECTOR_ALIASES: readonly ClaudeConnectorAlias[] = [
  { hosts: ["microsoft365.mcp.claude.com"], target: { ...MICROSOFT_365, whenMissing: "skip" } },
  { blankUrlNames: ["gmail", "google calendar", "google drive"], target: { ...GOOGLE_WORKSPACE, whenMissing: "skip" } },
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
