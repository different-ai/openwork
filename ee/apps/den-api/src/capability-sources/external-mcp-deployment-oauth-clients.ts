/**
 * Deployment-bound view of the pure pre-registered OAuth client helpers: the
 * same functions, already bound to this Den instance's configuration.
 */
import { env } from "../env.js"
import { pluginMcpRequiresPreRegisteredOAuthClient } from "./external-mcp-auth-policy.js"
import {
  applyPreRegisteredOAuthClientDefaults,
  applyPreRegisteredOAuthClientToRequirements,
  preRegisteredOAuthClientForUrl,
  type ExternalMcpPreRegisteredOAuthClient,
} from "./external-mcp-preregistered-oauth-clients.js"
import { EXTERNAL_MCP_PRESETS, type ExternalMcpPreset } from "./external-mcp-presets.js"
import type { EnterpriseMcpConnectionRequirements } from "@openwork/enterprise-mcp-client"

const presetsForDeployment = applyPreRegisteredOAuthClientDefaults(
  EXTERNAL_MCP_PRESETS,
  env.externalMcpPreRegisteredOAuthClients,
)

/** Quick-add presets as this deployment should present them. */
export function externalMcpPresetsForDeployment(): readonly ExternalMcpPreset[] {
  return presetsForDeployment
}

/** The OAuth client this deployment holds for an MCP server URL, if any. */
export function deploymentPreRegisteredOAuthClientForUrl(url: string): ExternalMcpPreRegisteredOAuthClient | null {
  return preRegisteredOAuthClientForUrl(url, env.externalMcpPreRegisteredOAuthClients)
}

/**
 * Whether an organization admin still has to supply an OAuth app for this
 * server: the preset demands one and the deployment does not provide it.
 */
export function pluginMcpRequiresAdminOAuthClient(url: string): boolean {
  return pluginMcpRequiresPreRegisteredOAuthClient(url, presetsForDeployment)
}

export function requirementsForDeployment(
  requirements: EnterpriseMcpConnectionRequirements,
): EnterpriseMcpConnectionRequirements {
  return applyPreRegisteredOAuthClientToRequirements(
    requirements,
    deploymentPreRegisteredOAuthClientForUrl(requirements.server.url),
  )
}
