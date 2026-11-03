import { discoverConnectionRequirements } from "@openwork/enterprise-mcp-client"
import type { EnterpriseMcpFetch } from "@openwork/enterprise-mcp-client"

export const CUSTOM_OAUTH_ISSUER_REVIEW_MESSAGE = "The server's published sign-in configuration could not be verified because its issuer does not match. Ask the server owner to fix it, or have an administrator review and save both manual sign-in addresses with their own OAuth app credentials."

/**
 * Called only for a new/changed automatic OAuth identity,.
 * A saved manual pair is a separate, already permission-checked trust boundary.
 * Discovery failures do not become evidence of a mismatch or a claim of verification;
 * strict SDK issuer validation still applies when the person actually signs in.
 */
export async function automaticOAuthSetupDenial(input: { serverUrl: string; fetch: EnterpriseMcpFetch }): Promise<string | null> {
  try {
    const requirements = await discoverConnectionRequirements(input)
    return requirements.warnings.some((warning) => warning.code === "oauth_issuer_mismatch")
      ? CUSTOM_OAUTH_ISSUER_REVIEW_MESSAGE
      : null
  } catch {
    // Do not echo remote documents, URLs, headers or network errors into a save response.
    return null
  }
}

/** Scope order/duplicates do not constitute a new OAuth identity. */
export function oauthScopeSelectionChanged(previous: readonly string[], next: readonly string[]): boolean {
  const left = new Set(previous)
  const right = new Set(next)
  return left.size !== right.size || [...left].some((scope) => !right.has(scope))
}
