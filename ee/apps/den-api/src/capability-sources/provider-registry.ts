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

import { MICROSOFT_365_DEFAULT_FEATURES } from "@openwork/types/den/microsoft-365"
import { env } from "../env.js"

export type NativeOAuthProviderConfig = {
  providerId: string
  displayName: string
  authorizeUrl: string
  tokenUrl: string
  /** Display-only endpoint shown on connection cards. */
  websiteUrl: string
  defaultScopes: string[]
  defaultFeatures?: string[]
  optionalFeatures?: Record<string, string[]>
  /** Google (and most modern providers) support PKCE even for confidential clients; harmless to always send. */
  usesPkce: boolean
  /** Extra fixed authorize-url params beyond client_id/redirect_uri/response_type/scope/state/PKCE. */
  extraAuthorizeParams?: Record<string, string>
  /** OrgOAuthClient.extra key used to bind authorize and token endpoints to one tenant. */
  tenantIdExtraKey?: string
  /** Higher provider scopes that satisfy a narrower required scope. */
  scopeImplications?: Record<string, string[]>
}

export const NATIVE_OAUTH_PROVIDERS: Record<string, NativeOAuthProviderConfig> = {
  "google-workspace": {
    providerId: "google-workspace",
    displayName: "Google Workspace",
    authorizeUrl: env.googleOAuthAuthorizeUrl ?? "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: env.googleOAuthTokenUrl ?? "https://oauth2.googleapis.com/token",
    websiteUrl: "https://workspace.google.com",
    defaultScopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    defaultFeatures: ["calendarRead", "gmailDraft", "driveFile"],
    optionalFeatures: {
      calendarRead: ["https://www.googleapis.com/auth/calendar.readonly"],
      calendarWrite: ["https://www.googleapis.com/auth/calendar.events"],
      gmailDraft: ["https://www.googleapis.com/auth/gmail.compose"],
      gmailRead: ["https://www.googleapis.com/auth/gmail.readonly"],
      driveFile: ["https://www.googleapis.com/auth/drive.file"],
      driveRead: ["https://www.googleapis.com/auth/drive.readonly"],
      driveFull: ["https://www.googleapis.com/auth/drive"],
      chat: [
        "https://www.googleapis.com/auth/chat.spaces.readonly",
        "https://www.googleapis.com/auth/chat.messages.readonly",
        "https://www.googleapis.com/auth/chat.messages.create",
      ],
    },
    usesPkce: true,
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
  },
  "microsoft-365": {
    providerId: "microsoft-365",
    displayName: "Microsoft 365",
    authorizeUrl: env.microsoftOAuthAuthorizeUrl ?? "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize",
    tokenUrl: env.microsoftOAuthTokenUrl ?? "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token",
    websiteUrl: "https://www.microsoft.com/microsoft-365",
    defaultScopes: ["openid", "profile", "email", "offline_access", "User.Read"],
    defaultFeatures: [...MICROSOFT_365_DEFAULT_FEATURES],
    optionalFeatures: {
      mailRead: ["Mail.Read"],
      mailDraft: ["Mail.ReadWrite"],
      calendarRead: ["Calendars.Read"],
      calendarWrite: ["Calendars.ReadWrite"],
      filesRead: ["Files.Read"],
      filesWrite: ["Files.ReadWrite"],
      filesReadAll: ["Files.Read.All"],
      filesFull: ["Files.ReadWrite.All"],
      teamsChatRead: ["Chat.Read"],
      teamsChatSend: ["Chat.Read", "ChatMessage.Send"],
    },
    scopeImplications: {
      "Mail.ReadWrite": ["Mail.Read"],
      "Calendars.ReadWrite": ["Calendars.Read"],
      "Files.ReadWrite": ["Files.Read"],
      "Files.Read.All": ["Files.Read"],
      "Files.ReadWrite.All": ["Files.Read", "Files.ReadWrite", "Files.Read.All"],
      "Chat.ReadWrite": ["Chat.Read", "ChatMessage.Send"],
    },
    usesPkce: true,
    tenantIdExtraKey: "tenantId",
  },
}

export function getNativeOAuthProvider(providerId: string): NativeOAuthProviderConfig | null {
  return NATIVE_OAUTH_PROVIDERS[providerId] ?? null
}

export function resolveProviderScopes(provider: NativeOAuthProviderConfig, features: string[]): string[] {
  const scopes: string[] = []
  for (const scope of provider.defaultScopes) {
    if (!scopes.includes(scope)) scopes.push(scope)
  }

  const optionalFeatures = provider.optionalFeatures
  if (!optionalFeatures) return scopes

  for (const feature of features) {
    const featureScopes = optionalFeatures[feature]
    if (!featureScopes) continue
    for (const scope of featureScopes) {
      if (!scopes.includes(scope)) scopes.push(scope)
    }
  }

  return scopes
}

export function providerScopesSatisfy(
  provider: NativeOAuthProviderConfig,
  grantedScopes: readonly string[] | null,
  requiredScope: string,
): boolean {
  if (!grantedScopes || grantedScopes.length === 0) return false
  const normalizedRequired = requiredScope.toLowerCase()
  for (const grantedScope of grantedScopes) {
    if (grantedScope.toLowerCase() === normalizedRequired) return true
    const implicationEntry = Object.entries(provider.scopeImplications ?? {})
      .find(([scope]) => scope.toLowerCase() === grantedScope.toLowerCase())
    const impliedScopes = implicationEntry?.[1] ?? []
    if (impliedScopes.some((scope) => scope.toLowerCase() === normalizedRequired)) return true
  }
  return false
}

function providerDefaultFeatures(provider: NativeOAuthProviderConfig): string[] {
  const optionalFeatures = provider.optionalFeatures
  if (!optionalFeatures) return []
  return (provider.defaultFeatures ?? []).filter((feature) => Object.hasOwn(optionalFeatures, feature))
}

export function clientSelectedFeatures(provider: NativeOAuthProviderConfig, extra: Record<string, unknown> | null): string[] {
  const optionalFeatures = provider.optionalFeatures
  if (!optionalFeatures) return []
  if (!extra || !Object.hasOwn(extra, "features") || !Array.isArray(extra.features)) return providerDefaultFeatures(provider)

  const features: string[] = []
  for (const feature of extra.features) {
    if (typeof feature !== "string") continue
    if (!Object.hasOwn(optionalFeatures, feature)) continue
    if (!features.includes(feature)) features.push(feature)
  }
  return features
}
