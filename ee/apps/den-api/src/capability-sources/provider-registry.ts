/**
 * Registry of native OAuth providers — capability sources Den implements
 * itself against a classic OAuth2 authorization-code flow (as opposed to
 * external MCP connections, which are discovered dynamically at connect
 * time and never need a registry entry — see ../external-mcp/ ).
 *
 * Adding a new native provider is: one entry here, plus whatever capability
 * routes call `getValidAccessToken(providerId, ...)`. No new tables, no new
 * OAuth plumbing — `generic-oauth.ts` drives every provider the same way.
 */

export type NativeOAuthProviderConfig = {
  providerId: string
  displayName: string
  authorizeUrl: string
  tokenUrl: string
  defaultScopes: string[]
  /** Google (and most modern providers) support PKCE even for confidential clients; harmless to always send. */
  usesPkce: boolean
  /** Extra fixed authorize-url params beyond client_id/redirect_uri/response_type/scope/state/PKCE. */
  extraAuthorizeParams?: Record<string, string>
}

export const NATIVE_OAUTH_PROVIDERS: Record<string, NativeOAuthProviderConfig> = {
  "google-workspace": {
    providerId: "google-workspace",
    displayName: "Google Workspace",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
    usesPkce: true,
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
  },
}

export function getNativeOAuthProvider(providerId: string): NativeOAuthProviderConfig | null {
  return NATIVE_OAUTH_PROVIDERS[providerId] ?? null
}
