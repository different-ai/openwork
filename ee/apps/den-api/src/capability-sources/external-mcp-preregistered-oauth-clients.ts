/**
 * Deployment-supplied pre-registered OAuth clients for External MCP servers.
 *
 * Some MCP authorization servers accept neither Client ID Metadata Documents
 * nor dynamic client registration, so the provider issues OpenWork a client
 * bound to this deployment's OAuth callback URL. Without this module every
 * organization admin has to paste that client ID by hand. With
 * `DEN_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS` the deployment supplies it
 * once and connections to that server get it automatically.
 *
 * The value is a JSON object keyed by the MCP server URL:
 *
 * ```json
 * { "https://mcp.example.com/mcp": { "clientId": "openwork" } }
 * ```
 *
 * Each entry may also carry `clientSecret` and `tokenEndpointAuthMethod`
 * (`client_secret_basic` | `client_secret_post`) when the provider issued a
 * confidential client. A client is only valid for the callback URL it was
 * registered with, so self-hosted deployments must register their own.
 *
 * This module is pure so it can be unit-tested without the Den environment.
 */
import { z } from "zod"
import type { EnterpriseMcpConnectionRequirements } from "@openwork/enterprise-mcp-client"
import type { ExternalMcpPreset } from "./external-mcp-presets.js"

export const EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS_ENV = "DEN_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS"

const preRegisteredOAuthClientSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().trim().min(1).max(4096).optional(),
  tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]).optional(),
}).strict()

const preRegisteredOAuthClientsSchema = z.record(z.string(), preRegisteredOAuthClientSchema)

export type ExternalMcpPreRegisteredOAuthClient = z.infer<typeof preRegisteredOAuthClientSchema>

export type ExternalMcpPreRegisteredOAuthClients = ReadonlyMap<string, ExternalMcpPreRegisteredOAuthClient>

export const EMPTY_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS: ExternalMcpPreRegisteredOAuthClients = new Map()

/**
 * Canonical form of a remote MCP server URL: origin plus path without a
 * trailing slash. Matches how presets are compared, so the same URL spelled
 * with or without a trailing slash resolves to the same client.
 */
export function normalizeExternalMcpServerUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.username || url.password || url.search || url.hash) return null
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    return `${url.origin}${pathname}`
  } catch {
    return null
  }
}

/**
 * Parse the environment value. Throws a descriptive error on malformed input
 * so a bad deployment config fails at startup instead of silently sending
 * every member to a broken sign-in.
 */
export function parseExternalMcpPreRegisteredOAuthClients(raw: string | undefined): ExternalMcpPreRegisteredOAuthClients {
  const trimmed = raw?.trim()
  if (!trimmed) return EMPTY_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS

  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    throw new Error(`${EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS_ENV} must be a JSON object keyed by MCP server URL.`)
  }
  const parsed = preRegisteredOAuthClientsSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const location = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
    throw new Error(`${EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS_ENV} is invalid${location}: ${issue?.message ?? "unknown error"}.`)
  }

  const clients = new Map<string, ExternalMcpPreRegisteredOAuthClient>()
  for (const [url, client] of Object.entries(parsed.data)) {
    const normalizedUrl = normalizeExternalMcpServerUrl(url)
    if (!normalizedUrl || !normalizedUrl.startsWith("https://")) {
      throw new Error(`${EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS_ENV} key "${url}" must be an absolute https MCP server URL without query or fragment.`)
    }
    if (clients.has(normalizedUrl)) {
      throw new Error(`${EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS_ENV} lists "${normalizedUrl}" more than once.`)
    }
    if (client.tokenEndpointAuthMethod && !client.clientSecret) {
      throw new Error(`${EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS_ENV} entry "${normalizedUrl}" sets tokenEndpointAuthMethod without a clientSecret.`)
    }
    clients.set(normalizedUrl, client)
  }
  return clients
}

export function preRegisteredOAuthClientForUrl(
  url: string,
  clients: ExternalMcpPreRegisteredOAuthClients,
): ExternalMcpPreRegisteredOAuthClient | null {
  if (clients.size === 0) return null
  const normalizedUrl = normalizeExternalMcpServerUrl(url)
  if (normalizedUrl === null) return null
  return clients.get(normalizedUrl) ?? null
}

/**
 * A preset that normally needs an admin-supplied OAuth app stops requiring one
 * when the deployment already supplies the client for that server. The web
 * dashboard reads `requiresOAuthClient` to decide whether to demand client
 * credentials before letting the admin add the connection.
 */
export function applyPreRegisteredOAuthClientDefaults(
  presets: readonly ExternalMcpPreset[],
  clients: ExternalMcpPreRegisteredOAuthClients,
): ExternalMcpPreset[] {
  if (clients.size === 0) return [...presets]
  return presets.map((preset) => {
    if (preset.requiresOAuthClient !== true) return preset
    if (!preRegisteredOAuthClientForUrl(preset.url, clients)) return preset
    const { requiresOAuthClient: _requiresOAuthClient, ...rest } = preset
    return rest
  })
}

export const OAUTH_CLIENT_REGISTRATION_REQUIREMENT_CODE = "oauth_client_registration"

/**
 * Live requirements discovery cannot know that the deployment holds a client
 * for this server, so it reports "Register an OAuth client" as a blocker. When
 * a client is configured, downgrade that requirement to informational and let
 * the discovery read as ready when nothing else blocks it.
 */
export function applyPreRegisteredOAuthClientToRequirements(
  requirements: EnterpriseMcpConnectionRequirements,
  client: ExternalMcpPreRegisteredOAuthClient | null,
): EnterpriseMcpConnectionRequirements {
  if (!client) return requirements
  const registration = requirements.manualRequirements.find((requirement) => (
    requirement.code === OAUTH_CLIENT_REGISTRATION_REQUIREMENT_CODE && requirement.required
  ))
  if (!registration) return requirements

  const manualRequirements = requirements.manualRequirements.map((requirement) => (
    requirement === registration
      ? {
        ...requirement,
        reason: "OpenWork supplies a pre-registered OAuth client for this server, so no admin-provided OAuth app is needed.",
        required: false,
      }
      : requirement
  ))
  const stillBlocked = manualRequirements.some((requirement) => requirement.required)
  const status = requirements.status === "manual_action_required"
    && requirements.authentication.kind === "oauth"
    && !stillBlocked
    ? "ready"
    : requirements.status
  return { ...requirements, status, manualRequirements }
}
