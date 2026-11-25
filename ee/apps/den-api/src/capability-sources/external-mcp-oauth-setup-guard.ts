import { discoverConnectionRequirements } from "@openwork/mcp-enterprise-client"
import type { EnterpriseMcpFetch } from "@openwork/mcp-enterprise-client"

export const CUSTOM_OAUTH_ISSUER_REVIEW_MESSAGE = "The server's published sign-in configuration could not be verified because its issuer does not match. Ask the server owner to fix it, or have an administrator review and save both manual sign-in addresses with their own OAuth app credentials."

export async function automaticOAuthSetupDenial(input: { serverUrl: string; fetch: EnterpriseMcpFetch }): Promise<string | null> {
  try {
    const requirements = await discoverConnectionRequirements(input)
    return requirements.warnings.some((warning) => warning.code === "oauth_issuer_mismatch")
      ? CUSTOM_OAUTH_ISSUER_REVIEW_MESSAGE
      : null
  } catch {
    return null
  }
}

export function oauthScopeSelectionChanged(previous: readonly string[], next: readonly string[]): boolean {
  const left = new Set(previous)
  const right = new Set(next)
  return left.size !== right.size || [...left].some((scope) => !right.has(scope))
}
