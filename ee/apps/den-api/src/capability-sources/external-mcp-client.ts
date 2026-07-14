import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { env } from "../env.js"
import { appendPublicApiPath } from "../request-url.js"
import { createGuardedFetch, createRealmSafeFetch } from "./url-guard.js"
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type {
  ExternalMcpConnectionRow,
  ExternalMcpOAuthClientRevision,
  ExternalMcpTokenRevision,
} from "./external-mcp-connections.js"
import {
  clearLegacyExternalMcpPendingCodeVerifierIfMatches,
  clearExternalMcpMemberTokens,
  clearExternalMcpTokens,
  compareAndSetExternalMcpOAuthClient,
  consumeExternalMcpOAuthTransaction,
  consumeLegacyExternalMcpPendingCodeVerifier,
  deleteExternalMcpOAuthTransaction,
  externalMcpIdentityBinding,
  externalMcpOAuthClientRevision,
  externalMcpOAuthClientValue,
  externalMcpMemberTokenRevision,
  externalMcpSharedTokenRevision,
  ExternalMcpOAuthAuthorizationRevokedError,
  getExternalMcpConnection,
  persistExternalMcpDcrOAuthClientWithLease,
  readConnectedAccountForExternalMcpIdentity,
  readOrgOAuthClientForExternalMcpIdentity,
  releaseExternalMcpOAuthRegistrationLease,
  saveExternalMcpAuthorizationCodeTokens,
  saveExternalMcpOAuthTransaction,
  saveExternalMcpRefreshTokens,
  tryAcquireExternalMcpOAuthRegistrationLease,
} from "./external-mcp-connections.js"
import {
  ExternalMcpDiagnosticError,
  ExternalMcpDiagnosticTracker,
  catalogDiagnosticError,
  createExternalMcpDiagnosticFetch,
  type ExternalMcpDiagnosticPhase,
  lifecycleDeadlineDiagnosticError,
  providerToolDiagnosticError,
} from "./external-mcp-diagnostics.js"

/**
 * Real MCP client for "add any MCP server" (External MCP Connections) —
 * as opposed to generic-oauth.ts, which only fits native providers with a
 * FIXED, admin-configured OAuth app (Google Workspace). Third-party MCP
 * servers (Notion, Linear, ...) don't have a pre-shared client_id: they
 * need RFC 9728 discovery + RFC 7591 dynamic client registration, which is
 * exactly what the MCP SDK's own OAuthClientProvider/auth() machinery
 * implements. This file is the one OAuthClientProvider implementation,
 * backed by our own tables, that every external connection uses.
 *
 * Dynamically-registered client info is stored in OrgOAuthClientTable
 * (providerId = the connection's own row id) — the same table used for
 * admin-configured native-provider clients, since the shape (client id +
 * optional secret + free-form extras) is identical either way.
 */

const CLIENT_NAME = "OpenWork"
const EXTERNAL_MCP_CALL_TIMEOUT_MS = 30_000
const EXTERNAL_MCP_LIFECYCLE_TIMEOUT_MS = 45_000
const EXTERNAL_MCP_TOOL_PAGE_LIMIT = 20
const EXTERNAL_MCP_TOOL_ITEM_LIMIT = 2_000
const EXTERNAL_MCP_TOOL_NAME_LIMIT_BYTES = 512
const EXTERNAL_MCP_TOOL_TITLE_LIMIT_BYTES = 4 * 1024
const EXTERNAL_MCP_TOOL_DESCRIPTION_LIMIT_BYTES = 64 * 1024
const EXTERNAL_MCP_TOOL_SCHEMA_LIMIT_BYTES = 512 * 1024
const EXTERNAL_MCP_TOOL_SCHEMA_DEPTH_LIMIT = 64
const EXTERNAL_MCP_CURSOR_LIMIT_BYTES = 16 * 1024
const EXTERNAL_MCP_CATALOG_LIMIT_BYTES = 8 * 1024 * 1024
// A crashed owner becomes replaceable as soon as its maximum lifecycle could
// have ended; a retry should not have to fail once merely to outwait the lease.
const EXTERNAL_MCP_DCR_LEASE_STALE_MS = EXTERNAL_MCP_LIFECYCLE_TIMEOUT_MS
const EXTERNAL_MCP_DCR_LEASE_POLL_MS = 100

export type ExternalMcpLifecycleDeadline = {
  expiresAt: number
  signal: AbortSignal
  abort: (reason?: unknown) => void
}

export function createExternalMcpLifecycleDeadline(
  timeoutMs = EXTERNAL_MCP_LIFECYCLE_TIMEOUT_MS,
): ExternalMcpLifecycleDeadline {
  const controller = new AbortController()
  return {
    expiresAt: Date.now() + Math.max(1, timeoutMs),
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
  }
}

function assertExternalMcpLifecycleActive(input: {
  deadline: ExternalMcpLifecycleDeadline
  diagnostic: ExternalMcpDiagnosticTracker
  phase: ExternalMcpDiagnosticPhase
}): void {
  if (!input.deadline.signal.aborted && Date.now() < input.deadline.expiresAt) return
  const reason = input.deadline.signal.reason
  if (reason instanceof ExternalMcpDiagnosticError) throw reason
  const error = lifecycleDeadlineDiagnosticError({ tracker: input.diagnostic, phase: input.phase })
  if (!input.deadline.signal.aborted) input.deadline.abort(error)
  throw error
}

/**
 * The MCP SDK owns OAuth discovery, registration, refresh, and finishAuth
 * fetches. finishAuth accepts no RequestOptions, so bind the transport fetch
 * itself to the lifecycle signal instead of relying on the outer promise race.
 */
export function bindExternalMcpFetchToLifecycle(
  baseFetch: (url: string | URL, init?: RequestInit) => Promise<Response>,
  deadline: ExternalMcpLifecycleDeadline,
  diagnostic: ExternalMcpDiagnosticTracker,
) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    assertExternalMcpLifecycleActive({ deadline, diagnostic, phase: diagnostic.activePhase })
    const signal = init?.signal
      ? AbortSignal.any([init.signal, deadline.signal])
      : deadline.signal
    return baseFetch(url, { ...init, signal })
  }
}

export async function runExternalMcpRequestWithinDeadline<T>(input: {
  deadline: ExternalMcpLifecycleDeadline
  diagnostic: ExternalMcpDiagnosticTracker
  phase: ExternalMcpDiagnosticPhase
  operation: (options: RequestOptions) => Promise<T>
}): Promise<T> {
  input.diagnostic.begin(input.phase)
  const remaining = Math.floor(input.deadline.expiresAt - Date.now())
  assertExternalMcpLifecycleActive({ deadline: input.deadline, diagnostic: input.diagnostic, phase: input.phase })

  const controller = new AbortController()
  const options: RequestOptions = {
    signal: AbortSignal.any([controller.signal, input.deadline.signal]),
    timeout: Math.max(1, Math.min(EXTERNAL_MCP_CALL_TIMEOUT_MS, remaining)),
    maxTotalTimeout: remaining,
    resetTimeoutOnProgress: false,
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const error = lifecycleDeadlineDiagnosticError({
        tracker: input.diagnostic,
        phase: input.diagnostic.activePhase,
      })
      input.deadline.abort(error)
      controller.abort(error)
      reject(error)
    }, remaining)
    void Promise.resolve().then(() => input.operation(options)).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Which member's credential this session should use, for connections with
 * credentialMode "per_member". Absent for "shared" connections (tokens live
 * on the connection row itself).
 */
export type ExternalMcpMemberContext = {
  orgMembershipId: DenTypeId<"member">
}

export type ExternalMcpOAuthRegistrationProvenance = "pre_registered" | "dcr" | "cimd"
export type ExternalMcpTokenEndpointAuthMethod = "client_secret_basic" | "client_secret_post" | "none"

type ExternalMcpOAuthRegistrationPolicy = {
  provenance: "dcr" | "cimd"
  tokenEndpointAuthMethod: ExternalMcpTokenEndpointAuthMethod
}

const EXTERNAL_MCP_OAUTH_REGISTRATION_PROVENANCE_KEY = "registrationProvenance"
const EXTERNAL_MCP_TOKEN_ENDPOINT_AUTH_METHODS = [
  "client_secret_basic",
  "client_secret_post",
  "none",
] satisfies ExternalMcpTokenEndpointAuthMethod[]

function isExternalMcpTokenEndpointAuthMethod(value: unknown): value is ExternalMcpTokenEndpointAuthMethod {
  return value === "client_secret_basic" || value === "client_secret_post" || value === "none"
}

function externalMcpTokenEndpointAuthMethods(state: OAuthDiscoveryState): string[] {
  const advertised = state.authorizationServerMetadata?.token_endpoint_auth_methods_supported
  // RFC 8414 section 2 defines client_secret_basic as the default when the
  // authorization-server metadata omits this field. Apply the same default
  // when discovery falls back to conventional endpoints without metadata.
  return advertised?.length ? [...new Set(advertised)] : ["client_secret_basic"]
}

export function externalMcpOAuthRegistrationPolicy(
  state: OAuthDiscoveryState,
): ExternalMcpOAuthRegistrationPolicy {
  const supported = externalMcpTokenEndpointAuthMethods(state)
  if (
    state.authorizationServerMetadata?.client_id_metadata_document_supported === true
    && supported.includes("none")
  ) {
    return { provenance: "cimd", tokenEndpointAuthMethod: "none" }
  }

  const tokenEndpointAuthMethod = EXTERNAL_MCP_TOKEN_ENDPOINT_AUTH_METHODS.find((method) => supported.includes(method))
  if (!tokenEndpointAuthMethod) {
    throw new Error("The MCP authorization server does not advertise a supported token endpoint client authentication method.")
  }
  return { provenance: "dcr", tokenEndpointAuthMethod }
}

export function externalMcpClientTokenEndpointAuthMethod(input: {
  clientInformation: OAuthClientInformationMixed
  discoveryState: OAuthDiscoveryState
}): ExternalMcpTokenEndpointAuthMethod {
  const supported = externalMcpTokenEndpointAuthMethods(input.discoveryState)
  const candidate = "token_endpoint_auth_method" in input.clientInformation
    ? input.clientInformation.token_endpoint_auth_method
    : undefined
  const hasClientSecret = typeof input.clientInformation.client_secret === "string"
    && input.clientInformation.client_secret.length > 0

  if (candidate !== undefined) {
    if (!isExternalMcpTokenEndpointAuthMethod(candidate) || !supported.includes(candidate)) {
      throw new Error("The saved OAuth client uses a token endpoint client authentication method this authorization server does not support.")
    }
    if (candidate === "none" && hasClientSecret) {
      throw new Error("OAuth token endpoint authentication method none is only valid for a public client without a client secret.")
    }
    if (candidate !== "none" && !hasClientSecret) {
      throw new Error(`OAuth token endpoint authentication method ${candidate} requires a client secret.`)
    }
    return candidate
  }

  if (hasClientSecret) {
    if (supported.includes("client_secret_basic")) return "client_secret_basic"
    if (supported.includes("client_secret_post")) return "client_secret_post"
    throw new Error("The MCP authorization server does not accept a supported confidential OAuth client authentication method.")
  }
  if (supported.includes("none")) return "none"
  throw new Error("This MCP authorization server requires a confidential OAuth client, but no client secret is configured.")
}

export function externalMcpPreRegisteredClientExtra(): Record<string, unknown> {
  return { [EXTERNAL_MCP_OAUTH_REGISTRATION_PROVENANCE_KEY]: "pre_registered" }
}

export function externalMcpOAuthClientRegistrationProvenance(input: {
  clientId: string
  clientSecret: string | null
  expectedClientMetadataUrl?: string
  extra: Record<string, unknown> | null
}): ExternalMcpOAuthRegistrationProvenance {
  const explicit = input.extra?.[EXTERNAL_MCP_OAUTH_REGISTRATION_PROVENANCE_KEY]
  if (explicit === "pre_registered" || explicit === "dcr" || explicit === "cimd") return explicit

  // Rows saved before provenance was introduced can be classified without
  // exposing credentials: SDK-created rows contain clientInformation, while
  // admin-entered clients historically did not.
  if (isRecord(input.extra?.clientInformation)) {
    if (
      !input.clientSecret
      && input.expectedClientMetadataUrl
      && input.clientId === input.expectedClientMetadataUrl
    ) return "cimd"
    return "dcr"
  }
  return "pre_registered"
}

export function shouldRotateExternalMcpOAuthClient(
  provenance: ExternalMcpOAuthRegistrationProvenance,
): boolean {
  return provenance === "dcr"
}

export function safeExternalMcpClientInformation(
  clientInformation: OAuthClientInformationMixed,
): Record<string, unknown> {
  const full = OAuthClientInformationFullSchema.safeParse(clientInformation)
  const parsed = full.success ? full.data : OAuthClientInformationSchema.parse(clientInformation)
  const safe: Record<string, unknown> = { ...parsed }
  const tokenEndpointAuthMethod = "token_endpoint_auth_method" in clientInformation
    ? clientInformation.token_endpoint_auth_method
    : undefined
  delete safe.token_endpoint_auth_method
  if (isExternalMcpTokenEndpointAuthMethod(tokenEndpointAuthMethod)) {
    safe.token_endpoint_auth_method = tokenEndpointAuthMethod
  }
  delete safe.client_secret
  delete safe.registration_access_token
  return safe
}

export function restoreExternalMcpClientInformation(input: {
  clientId: string
  clientSecret: string | null
  extra: Record<string, unknown> | null
}): OAuthClientInformationMixed {
  const candidate = input.extra?.clientInformation
  const full = OAuthClientInformationFullSchema.safeParse({
    ...(isRecord(candidate) ? candidate : {}),
    client_id: input.clientId,
    client_secret: input.clientSecret ?? undefined,
  })
  if (full.success) return full.data
  const base = OAuthClientInformationSchema.parse({
    client_id: input.clientId,
    client_secret: input.clientSecret ?? undefined,
  })
  const storedTokenEndpointAuthMethod = isRecord(candidate)
    ? candidate.token_endpoint_auth_method
    : undefined
  if (typeof storedTokenEndpointAuthMethod !== "string") return base
  return { ...base, token_endpoint_auth_method: storedTokenEndpointAuthMethod }
}

export function assertExternalMcpPkceDiscovery(state: OAuthDiscoveryState): void {
  if (state.authorizationServerMetadata?.code_challenge_methods_supported?.includes("S256")) return
  throw new Error("The MCP authorization server must advertise PKCE code_challenge_methods_supported including S256.")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function externalMcpClientMetadataUrl(input: {
  connectionId: string
  redirectUri: string
}): string | undefined {
  const redirectUrl = new URL(input.redirectUri)
  if (redirectUrl.protocol !== "https:") return undefined
  const connectionPath = `/v1/mcp-connections/${encodeURIComponent(input.connectionId)}`
  const callbackPath = `${connectionPath}/connect/callback`
  if (!redirectUrl.pathname.endsWith(callbackPath)) return undefined

  const publicBase = new URL(redirectUrl)
  publicBase.pathname = redirectUrl.pathname.slice(0, -callbackPath.length) || "/"
  publicBase.search = ""
  publicBase.hash = ""
  return appendPublicApiPath(publicBase.toString(), `${connectionPath}/oauth-client-metadata`)
}

export class ExternalMcpOAuthProvider implements OAuthClientProvider {
  private connection: ExternalMcpConnectionRow
  private readonly identityBinding: string
  private readonly redirectUri: string
  private readonly signedState?: string
  private readonly member?: ExternalMcpMemberContext
  private readonly diagnostic: ExternalMcpDiagnosticTracker
  private readonly lifecycleDeadline?: ExternalMcpLifecycleDeadline
  private readonly authorizationActor?: ExternalMcpMemberContext
  private readonly allowDynamicClientRegistration: boolean
  private savedDiscoveryState?: OAuthDiscoveryState
  private registrationPolicy?: ExternalMcpOAuthRegistrationPolicy
  private authorizationState?: string
  private authorizationCodeEpoch?: number
  private registrationLeaseToken?: string
  private loadedClientRevision?: ExternalMcpOAuthClientRevision
  private loadedClientProvenance?: ExternalMcpOAuthRegistrationProvenance
  private loadedTokenRevision?: ExternalMcpTokenRevision
  /** Captured by redirectToAuthorization so the HTTP route can hand it back to the admin's browser instead of actually redirecting anything server-side. */
  lastAuthorizeUrl: string | null = null

  constructor(
    connection: ExternalMcpConnectionRow,
    redirectUri: string,
    signedState: string | undefined,
    member: ExternalMcpMemberContext | undefined,
    diagnostic: ExternalMcpDiagnosticTracker,
    lifecycleDeadline?: ExternalMcpLifecycleDeadline,
    authorizationActor?: ExternalMcpMemberContext,
    allowDynamicClientRegistration = false,
  ) {
    this.connection = connection
    this.identityBinding = externalMcpIdentityBinding(connection)
    this.redirectUri = redirectUri
    this.signedState = signedState
    this.member = member
    this.diagnostic = diagnostic
    this.lifecycleDeadline = lifecycleDeadline
    this.authorizationActor = authorizationActor
    this.allowDynamicClientRegistration = allowDynamicClientRegistration
    if (connection.credentialMode === "per_member" && connection.authType === "oauth" && !member) {
      throw new Error(`Connection "${connection.id}" uses per-member credentials; a member context is required.`)
    }
  }

  private get isPerMember(): boolean {
    return this.connection.credentialMode === "per_member"
  }

  private async memberAccount() {
    if (!this.member) return null
    const result = await readConnectedAccountForExternalMcpIdentity({
      connection: this.connection,
      orgMembershipId: this.member.orgMembershipId,
    })
    if (!result.current) throw new Error("The external MCP connection identity changed during authorization.")
    return result.value
  }

  private async orgOAuthClient() {
    const result = await readOrgOAuthClientForExternalMcpIdentity(this.connection)
    if (!result.current) throw new Error("The external MCP connection identity changed during authorization.")
    return result.value
  }

  private assertCurrentIdentity(connection: ExternalMcpConnectionRow): void {
    if (externalMcpIdentityBinding(connection) !== this.identityBinding) {
      throw new Error("The external MCP connection identity changed during authorization.")
    }
  }

  private async refreshConnection(): Promise<ExternalMcpConnectionRow> {
    const refreshed = await getExternalMcpConnection({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
    })
    if (!refreshed) throw new Error("The external MCP connection no longer exists.")
    this.assertCurrentIdentity(refreshed)
    this.connection = refreshed
    return refreshed
  }

  private assertLifecycleActive(phase: ExternalMcpDiagnosticPhase): void {
    if (!this.lifecycleDeadline) return
    assertExternalMcpLifecycleActive({ deadline: this.lifecycleDeadline, diagnostic: this.diagnostic, phase })
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  /**
   * Prefer the MCP 2025-11-25 Client ID Metadata Document flow when an
   * authorization server advertises it. The public document is scoped to one
   * connection because OAuth redirect URIs must match exactly. Local HTTP
   * development deliberately falls back to DCR/pre-registration: CIMD client
   * identifiers are required to be HTTPS URLs.
   */
  get clientMetadataUrl(): string | undefined {
    if (this.registrationPolicy?.provenance !== "cimd") return undefined
    return externalMcpClientMetadataUrl({
      connectionId: this.connection.id,
      redirectUri: this.redirectUri,
    })
  }

  /**
   * The SDK includes whatever this returns as the standard OAuth `state`
   * param, and — critically — every spec-compliant authorization server
   * (real or our stand-in) echoes `state` back verbatim on redirect. Our
   * own signed state token (which encodes which connection this is for)
   * MUST travel as this standard param, not a custom one: a custom param
   * would simply be dropped by any real server, since only `state` is
   * required to be preserved.
   */
  state(): string {
    // Only reached when a fresh authorize URL is actually being built (i.e.
    // connect/start, which always supplies signedState); this fallback only
    // exists to satisfy the type when connect() is attempted opportunistically
    // with an existing valid token and no authorization step is needed.
    this.authorizationState ??= this.signedState ?? randomUUID()
    return this.authorizationState
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUri],
      client_name: CLIENT_NAME,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.registrationPolicy?.tokenEndpointAuthMethod ?? "none",
      ...(this.connection.requestedOAuthScopes?.length
        ? { scope: this.connection.requestedOAuthScopes.join(" ") }
        : {}),
    }
  }

  private get oauthTransactionState(): string | undefined {
    return this.authorizationState ?? this.signedState
  }

  private get oauthTransactionMemberId(): DenTypeId<"member"> {
    return this.authorizationActor?.orgMembershipId
      ?? this.member?.orgMembershipId
      ?? this.connection.createdByOrgMembershipId
  }

  /**
   * Wait for the replica currently performing DCR, or atomically take a stale
   * lease. The client is re-read after lease acquisition so a registration
   * committed between the optimistic read and the claim is never duplicated.
   */
  private async waitForRegisteredClientOrAcquireLease() {
    const leaseToken = this.registrationLeaseToken ?? randomUUID()
    while (true) {
      this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
      const now = new Date()
      const lease = await tryAcquireExternalMcpOAuthRegistrationLease({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        expectedIdentityBinding: this.identityBinding,
        leaseToken,
        startedAt: now,
        staleBefore: new Date(now.getTime() - EXTERNAL_MCP_DCR_LEASE_STALE_MS),
      })
      if (lease === "connection_missing") {
        throw new Error("The external MCP connection no longer exists.")
      }
      if (lease === "acquired") {
        this.registrationLeaseToken = leaseToken
        const registered = await this.orgOAuthClient()
        if (!registered) return null
        await this.releaseOAuthRegistrationLease()
        return registered
      }

      const registered = await this.orgOAuthClient()
      if (registered) return registered
      this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_MCP_DCR_LEASE_POLL_MS))
    }
  }

  async releaseOAuthRegistrationLease(): Promise<void> {
    const leaseToken = this.registrationLeaseToken
    if (!leaseToken) return
    await releaseExternalMcpOAuthRegistrationLease({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
      expectedIdentityBinding: this.identityBinding,
      leaseToken,
    })
    this.registrationLeaseToken = undefined
  }

  private async clearMatchingLegacyCodeVerifier(codeVerifier: string): Promise<void> {
    try {
      await clearLegacyExternalMcpPendingCodeVerifierIfMatches({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        expectedIdentityBinding: this.identityBinding,
        orgMembershipId: this.oauthTransactionMemberId,
        expectedCodeVerifier: codeVerifier,
      })
    } catch {
      // Expand-release compatibility only. The exact state transaction has
      // already been consumed, so a transient legacy cleanup failure must not
      // discard the valid verifier before the token exchange can run.
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
      let client = await this.orgOAuthClient()
      this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
      if (!client) {
        if (this.registrationPolicy?.provenance !== "dcr") {
          this.loadedClientRevision = undefined
          this.loadedClientProvenance = undefined
          return undefined
        }
        if (!this.allowDynamicClientRegistration) {
          throw new Error("A saved OAuth client is required before this MCP operation can continue.")
        }
        client = await this.waitForRegisteredClientOrAcquireLease()
        this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
        if (!client) {
          this.loadedClientRevision = undefined
          this.loadedClientProvenance = undefined
          return undefined
        }
      }
      const restored = restoreExternalMcpClientInformation({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        extra: client.extra,
      })
      if (!this.savedDiscoveryState) {
        throw new Error("OAuth discovery must complete before loading client credentials.")
      }
      const tokenEndpointAuthMethod = externalMcpClientTokenEndpointAuthMethod({
        clientInformation: restored,
        discoveryState: this.savedDiscoveryState,
      })
      const clientInformation = { ...restored, token_endpoint_auth_method: tokenEndpointAuthMethod }
      const expectedClientMetadataUrl = externalMcpClientMetadataUrl({
        connectionId: this.connection.id,
        redirectUri: this.redirectUri,
      })
      const registrationProvenance = externalMcpOAuthClientRegistrationProvenance({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        expectedClientMetadataUrl,
        extra: client.extra,
      })
      const storedProvenance = client.extra?.[EXTERNAL_MCP_OAUTH_REGISTRATION_PROVENANCE_KEY]
      const storedMethod = isRecord(client.extra?.clientInformation)
        ? client.extra.clientInformation.token_endpoint_auth_method
        : undefined
      if (storedProvenance === registrationProvenance && storedMethod === tokenEndpointAuthMethod) {
        this.loadedClientRevision = externalMcpOAuthClientRevision(client)
        this.loadedClientProvenance = registrationProvenance
        this.diagnostic.passed("AUTH_CLIENT_REGISTRATION", "reachable")
        return clientInformation
      }

      const persisted = await compareAndSetExternalMcpOAuthClient({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        expectedIdentityBinding: this.identityBinding,
        expectedAuthorizationEpoch: this.connection.oauthAuthorizationEpoch,
        expected: externalMcpOAuthClientRevision(client),
        next: {
          ...externalMcpOAuthClientValue(client),
          extra: {
            clientInformation: safeExternalMcpClientInformation(clientInformation),
            [EXTERNAL_MCP_OAUTH_REGISTRATION_PROVENANCE_KEY]: registrationProvenance,
          },
        },
      })
      if (persisted.status === "applied") {
        this.loadedClientRevision = persisted.revision ?? undefined
        this.loadedClientProvenance = registrationProvenance
        this.diagnostic.passed("AUTH_CLIENT_REGISTRATION", "reachable")
        return clientInformation
      }
      if (persisted.status === "connection_missing") {
        throw new Error("The external MCP connection no longer exists.")
      }
      if (persisted.status === "connection_changed") {
        throw new Error("The external MCP connection was disconnected while OAuth client configuration was in progress. Start authorization again.")
      }
      // A concurrent administrator or OAuth flow changed the client. Re-read
      // it and validate that exact revision rather than returning stale data.
    }
    throw new Error("The saved OAuth client changed repeatedly while authorization was starting. Start authorization again with the latest client configuration.")
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
    if (!this.savedDiscoveryState || !this.registrationPolicy) {
      throw new Error("OAuth discovery must complete before saving client credentials.")
    }
    const tokenEndpointAuthMethod = externalMcpClientTokenEndpointAuthMethod({
      clientInformation,
      discoveryState: this.savedDiscoveryState,
    })
    if (tokenEndpointAuthMethod !== this.registrationPolicy.tokenEndpointAuthMethod) {
      throw new Error("The OAuth registration response changed the requested token endpoint client authentication method.")
    }
    const expectedClientMetadataUrl = externalMcpClientMetadataUrl({
      connectionId: this.connection.id,
      redirectUri: this.redirectUri,
    })
    const registrationProvenance: ExternalMcpOAuthRegistrationProvenance = this.registrationPolicy.provenance === "cimd"
      && expectedClientMetadataUrl === clientInformation.client_id
      ? "cimd"
      : "dcr"
    const normalizedClientInformation = { ...clientInformation, token_endpoint_auth_method: tokenEndpointAuthMethod }
    const extra = {
      clientInformation: safeExternalMcpClientInformation(normalizedClientInformation),
      [EXTERNAL_MCP_OAUTH_REGISTRATION_PROVENANCE_KEY]: registrationProvenance,
    }
    const authorizationActor = this.authorizationActor
    if (!authorizationActor) {
      throw new Error("An authorization actor is required before persisting an OAuth client registration.")
    }
    if (
      this.isPerMember
      && authorizationActor.orgMembershipId !== this.member?.orgMembershipId
    ) throw new ExternalMcpOAuthAuthorizationRevokedError()
    if (registrationProvenance === "dcr") {
      const leaseToken = this.registrationLeaseToken
      if (!leaseToken) {
        throw new Error("Dynamic OAuth client registration cannot be persisted without owning its connection lease.")
      }
      this.loadedClientRevision = await persistExternalMcpDcrOAuthClientWithLease({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        expectedIdentityBinding: this.identityBinding,
        leaseToken,
        expectedAuthorizationEpoch: this.connection.oauthAuthorizationEpoch,
        authorizationActor,
        clientId: clientInformation.client_id,
        clientSecret: clientInformation.client_secret ?? null,
        extra,
      })
      this.loadedClientProvenance = "dcr"
      this.registrationLeaseToken = undefined
    } else {
      // CIMD uses a deterministic public URL as its client identifier and has
      // no remote registration side effect to single-flight. It still uses an
      // insert-only CAS so a late SDK callback cannot overwrite a client an
      // administrator configured after discovery or recreate one after the
      // owning connection was deleted/disconnected.
      const persisted = await compareAndSetExternalMcpOAuthClient({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        expectedIdentityBinding: this.identityBinding,
        expectedAuthorizationEpoch: this.connection.oauthAuthorizationEpoch,
        authorizationActor,
        expected: null,
        next: {
          clientId: clientInformation.client_id,
          clientSecret: null,
          extra,
          createdByOrgMembershipId: authorizationActor.orgMembershipId,
        },
      })
      if (persisted.status === "connection_missing") {
        throw new Error("The external MCP connection no longer exists.")
      }
      if (persisted.status === "connection_changed") {
        throw new Error("The external MCP connection was disconnected while OAuth client configuration was in progress. Start authorization again.")
      }
      if (persisted.status === "client_changed") {
        const concurrent = await this.orgOAuthClient()
        let compatible = false
        if (
          concurrent
          && concurrent.clientId === clientInformation.client_id
          && !concurrent.clientSecret
        ) {
          try {
            compatible = externalMcpClientTokenEndpointAuthMethod({
              clientInformation: restoreExternalMcpClientInformation({
                clientId: concurrent.clientId,
                clientSecret: concurrent.clientSecret,
                extra: concurrent.extra,
              }),
              discoveryState: this.savedDiscoveryState,
            }) === "none"
          } catch {
            compatible = false
          }
        }
        if (!concurrent || !compatible) {
          throw new Error("An OAuth client was configured while Client ID Metadata persistence was in progress. Start authorization again with the saved client.")
        }

        // Verify the compatible row and connection fence together. This is a
        // no-content-change CAS: it preserves the concurrent row's manual/DCR
        // provenance instead of relabeling it as CIMD.
        const verified = await compareAndSetExternalMcpOAuthClient({
          organizationId: this.connection.organizationId,
          connectionId: this.connection.id,
          expectedIdentityBinding: this.identityBinding,
          expectedAuthorizationEpoch: this.connection.oauthAuthorizationEpoch,
          authorizationActor,
          expected: externalMcpOAuthClientRevision(concurrent),
          next: externalMcpOAuthClientValue(concurrent),
        })
        if (verified.status === "connection_missing") {
          throw new Error("The external MCP connection no longer exists.")
        }
        if (verified.status === "connection_changed") {
          throw new Error("The external MCP connection was disconnected while OAuth client configuration was in progress. Start authorization again.")
        }
        if (verified.status === "client_changed") {
          throw new Error("The saved OAuth client changed again while Client ID Metadata persistence was in progress. Start authorization again with the latest client.")
        }
        if (verified.status !== "applied") {
          throw new Error("The OAuth client could not be verified while Client ID Metadata persistence was in progress.")
        }
        this.loadedClientRevision = verified.revision ?? undefined
        this.loadedClientProvenance = externalMcpOAuthClientRegistrationProvenance({
          clientId: concurrent.clientId,
          clientSecret: concurrent.clientSecret,
          expectedClientMetadataUrl,
          extra: concurrent.extra,
        })
      } else if (persisted.status === "applied") {
        this.loadedClientRevision = persisted.revision ?? undefined
        this.loadedClientProvenance = "cimd"
      } else {
        throw new Error("The OAuth client could not be persisted through Client ID Metadata.")
      }
    }
    this.diagnostic.passed("AUTH_CLIENT_REGISTRATION", "reachable")
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
    assertExternalMcpPkceDiscovery(state)
    // Enforce the same supported intersection used by preview discovery at
    // the credential boundary, immediately before CIMD/DCR can run.
    this.registrationPolicy = externalMcpOAuthRegistrationPolicy(state)
    this.savedDiscoveryState = state
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    this.assertLifecycleActive("CONTINUITY_REFRESH")
    if (this.isPerMember) {
      const account = await this.memberAccount()
      this.assertLifecycleActive("CONTINUITY_REFRESH")
      if (!account?.accessToken) {
        this.loadedTokenRevision = undefined
        return undefined
      }
      this.loadedTokenRevision = externalMcpMemberTokenRevision(account)
      return {
        access_token: account.accessToken,
        token_type: account.tokenType ?? "Bearer",
        refresh_token: account.refreshToken ?? undefined,
        scope: account.scopes?.join(" ") ?? undefined,
      }
    }
    const refreshed = await this.refreshConnection()
    if (!refreshed.accessToken) {
      this.loadedTokenRevision = undefined
      return undefined
    }
    this.loadedTokenRevision = externalMcpSharedTokenRevision(refreshed)
    return {
      access_token: refreshed.accessToken,
      token_type: refreshed.tokenType ?? "Bearer",
      refresh_token: refreshed.refreshToken ?? undefined,
      scope: refreshed.scope ?? undefined,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null
    const isAuthorizationCodeCommit = this.authorizationActor !== undefined
      && this.authorizationCodeEpoch !== undefined
    const phase = this.diagnostic.activePhase === "CONTINUITY_REFRESH"
      ? "CONTINUITY_REFRESH"
      : "AUTH_TOKEN_ACQUISITION"
    this.assertLifecycleActive(phase)
    const tokenCommit = {
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
      expectedIdentityBinding: this.identityBinding,
      orgMembershipId: this.member?.orgMembershipId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type ?? null,
      scope: tokens.scope,
      expiresAt,
    }
    const committedTokenRevision = isAuthorizationCodeCommit
      ? await saveExternalMcpAuthorizationCodeTokens({
        ...tokenCommit,
        authorizationActor: this.authorizationActor!,
        expectedAuthorizationEpoch: this.authorizationCodeEpoch!,
      })
      : await saveExternalMcpRefreshTokens({
        ...tokenCommit,
        expectedAuthorizationEpoch: this.connection.oauthAuthorizationEpoch,
      })
    if (isAuthorizationCodeCommit) this.authorizationCodeEpoch = undefined
    this.loadedTokenRevision = committedTokenRevision
    // Refresh the in-memory row so a subsequent tokens()/refresh in the same
    // connection attempt sees the just-saved values.
    await this.refreshConnection()
    this.diagnostic.passed(phase)
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") {
      const expected = this.loadedClientRevision
      const provenance = this.loadedClientProvenance
      if (expected && provenance) {
        // invalid_client is recoverable only for a client OpenWork registered
        // dynamically. Never erase credentials an admin must rotate with the
        // provider, and never "rotate" a deterministic CIMD URL client.
        if (shouldRotateExternalMcpOAuthClient(provenance)) {
          // The provider can report invalid_client after an administrator has
          // already rotated the row. Delete only the exact DCR revision that
          // produced this failure, while sharing the connection fence with
          // disconnect/delete and every other OAuth-client writer.
          const invalidated = await compareAndSetExternalMcpOAuthClient({
            organizationId: this.connection.organizationId,
            connectionId: this.connection.id,
            expectedIdentityBinding: this.identityBinding,
            expectedAuthorizationEpoch: this.connection.oauthAuthorizationEpoch,
            expected,
            next: null,
          })
          if (invalidated.status === "connection_missing") {
            throw new Error("The external MCP connection no longer exists.")
          }
          if (invalidated.status === "connection_changed") {
            throw new Error("The external MCP connection identity changed during credential invalidation.")
          }
        }
      }
      this.loadedClientRevision = undefined
      this.loadedClientProvenance = undefined
    }
    if (scope === "all" || scope === "tokens") {
      const expectedRevision = this.loadedTokenRevision
      if (expectedRevision && this.isPerMember && this.member) {
        await clearExternalMcpMemberTokens({
          organizationId: this.connection.organizationId,
          orgMembershipId: this.member.orgMembershipId,
          connectionId: this.connection.id,
          expectedIdentityBinding: this.identityBinding,
          expectedRevision,
        })
      } else if (expectedRevision && !this.isPerMember) {
        await clearExternalMcpTokens({
          organizationId: this.connection.organizationId,
          connectionId: this.connection.id,
          expectedIdentityBinding: this.identityBinding,
          expectedRevision,
        })
        await this.refreshConnection()
      }
      this.loadedTokenRevision = undefined
    }
    if (scope === "all" || scope === "verifier") {
      const signedState = this.oauthTransactionState
      if (signedState) {
        const codeVerifier = await deleteExternalMcpOAuthTransaction({
          organizationId: this.connection.organizationId,
          connectionId: this.connection.id,
          expectedIdentityBinding: this.identityBinding,
          orgMembershipId: this.oauthTransactionMemberId,
          signedState,
        })
        if (codeVerifier) await this.clearMatchingLegacyCodeVerifier(codeVerifier)
      }
    }
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizeUrl = authorizationUrl.toString()
    this.diagnostic.begin("AUTH_USER_OR_WORKLOAD")
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.assertLifecycleActive("AUTH_USER_OR_WORKLOAD")
    const signedState = this.oauthTransactionState
    if (!signedState) throw new Error("A signed OAuth state is required before saving a PKCE verifier.")
    const authorizationActor = this.authorizationActor
    if (!authorizationActor) throw new Error("An authorization actor is required before starting MCP OAuth.")
    await saveExternalMcpOAuthTransaction({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
      expectedIdentityBinding: this.identityBinding,
      orgMembershipId: this.oauthTransactionMemberId,
      authorizationActor,
      expectedAuthorizationEpoch: this.connection.oauthAuthorizationEpoch,
      signedState,
      codeVerifier,
    })
  }

  async codeVerifier(): Promise<string> {
    this.assertLifecycleActive("AUTH_TOKEN_ACQUISITION")
    const signedState = this.oauthTransactionState
    if (!signedState) throw new Error("The OAuth callback is missing its signed state transaction.")
    const transactionInput = {
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
      expectedIdentityBinding: this.identityBinding,
      orgMembershipId: this.oauthTransactionMemberId,
    }
    const exactTransaction = await consumeExternalMcpOAuthTransaction({
      ...transactionInput,
      signedState,
    })
    if (exactTransaction) {
      this.authorizationCodeEpoch = exactTransaction.authorizationEpoch
      await this.clearMatchingLegacyCodeVerifier(exactTransaction.codeVerifier)
      this.assertLifecycleActive("AUTH_TOKEN_ACQUISITION")
      return exactTransaction.codeVerifier
    }
    const codeVerifier = await consumeLegacyExternalMcpPendingCodeVerifier(transactionInput)
    this.assertLifecycleActive("AUTH_TOKEN_ACQUISITION")
    if (!codeVerifier) {
      throw new Error("The OAuth authorization transaction is missing, expired, or already consumed.")
    }
    this.authorizationCodeEpoch = this.connection.oauthAuthorizationEpoch
    return codeVerifier
  }
}

function buildTransport(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  signedState?: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
  lifecycleDeadline?: ExternalMcpLifecycleDeadline,
  authorizationActor?: ExternalMcpMemberContext,
  allowDynamicClientRegistration = false,
) {
  const diagnostic = new ExternalMcpDiagnosticTracker(diagnosticReferenceId ?? randomUUID(), {
    authType: connection.authType,
    credentialMode: connection.credentialMode,
  })
  const provider = connection.authType === "oauth"
    ? new ExternalMcpOAuthProvider(
        connection,
        redirectUri,
        signedState,
        member,
        diagnostic,
        lifecycleDeadline,
        authorizationActor,
        allowDynamicClientRegistration,
      )
    : undefined
  const guardedFetch = env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch()
  const lifecycleFetch = lifecycleDeadline
    ? bindExternalMcpFetchToLifecycle(guardedFetch, lifecycleDeadline, diagnostic)
    : guardedFetch
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    authProvider: provider,
    // SSRF guard: every outbound request (the MCP endpoint itself, but also
    // discovery documents and token endpoints the SDK follows to OTHER
    // hosts) is checked against private/reserved address ranges at request
    // time. Hosted-deployment protection; self-hosted/dev opt out via env.
    fetch: createExternalMcpDiagnosticFetch({ fetch: lifecycleFetch, endpoint: connection.url, tracker: diagnostic }),
    requestInit: connection.authType === "apikey" && connection.apiKey
      ? { headers: { authorization: `Bearer ${connection.apiKey}` } }
      : undefined,
  })
  return { transport, provider, diagnostic }
}

function buildClient() {
  return new Client({ name: "openwork-den", version: "1.0.0" }, { capabilities: {} })
}

type ExternalMcpToolPage = Awaited<ReturnType<Client["listTools"]>>

type SerializedMeasurement =
  | { ok: true; bytes: number }
  | { ok: false; reason: "size" | "depth" | "cycle" }

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function serializedStringBytes(value: string): number {
  return utf8Bytes(JSON.stringify(value))
}

function measureSerializedJson(
  value: unknown,
  byteLimit: number,
  depthLimit: number,
): SerializedMeasurement {
  type Frame =
    | { kind: "value"; value: unknown; depth: number }
    | { kind: "leave"; value: object }
  const stack: Frame[] = [{ kind: "value", value, depth: 0 }]
  const active = new WeakSet<object>()
  let bytes = 0
  const add = (amount: number): boolean => {
    bytes += amount
    return bytes <= byteLimit
  }

  while (stack.length > 0) {
    const frame = stack.pop()
    if (!frame) break
    if (frame.kind === "leave") {
      active.delete(frame.value)
      continue
    }
    if (frame.depth > depthLimit) return { ok: false, reason: "depth" }
    const current = frame.value
    if (current === null) {
      if (!add(4)) return { ok: false, reason: "size" }
      continue
    }
    if (typeof current === "string") {
      // Two quote bytes plus the UTF-8 payload. Escaping can only make the
      // serialized value larger, so account for the exact JSON string when
      // it contains characters that need escaping.
      const serialized = JSON.stringify(current)
      if (!add(utf8Bytes(serialized))) return { ok: false, reason: "size" }
      continue
    }
    if (typeof current === "number" || typeof current === "boolean") {
      if (!add(utf8Bytes(JSON.stringify(current)))) return { ok: false, reason: "size" }
      continue
    }
    if (typeof current !== "object") {
      if (!add(4)) return { ok: false, reason: "size" }
      continue
    }
    if (active.has(current)) return { ok: false, reason: "cycle" }
    active.add(current)
    stack.push({ kind: "leave", value: current })

    if (Array.isArray(current)) {
      if (!add(2 + Math.max(0, current.length - 1))) return { ok: false, reason: "size" }
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "value", value: current[index], depth: frame.depth + 1 })
      }
      continue
    }

    const entries = Object.entries(current)
    if (!add(2 + Math.max(0, entries.length - 1))) return { ok: false, reason: "size" }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!
      if (!add(utf8Bytes(JSON.stringify(key)) + 1)) return { ok: false, reason: "size" }
      stack.push({ kind: "value", value: child, depth: frame.depth + 1 })
    }
  }
  return { ok: true, bytes }
}

function fieldLimitError(input: {
  diagnostic: ExternalMcpDiagnosticTracker
  code: "MCP_CATALOG_TOOL_NAME_LIMIT" | "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT" | "MCP_CATALOG_TOOL_TITLE_LIMIT"
  field: string
  limit: number
}): ExternalMcpDiagnosticError {
  return catalogDiagnosticError({
    tracker: input.diagnostic,
    code: input.code,
    operatorAction: `Reduce each serialized tool ${input.field} below ${input.limit} UTF-8 bytes.`,
  })
}

function validateToolCatalogField(input: {
  diagnostic: ExternalMcpDiagnosticTracker
  value: string | undefined
  limit: number
  field: string
  code: "MCP_CATALOG_TOOL_NAME_LIMIT" | "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT" | "MCP_CATALOG_TOOL_TITLE_LIMIT"
}): void {
  if (input.value !== undefined && serializedStringBytes(input.value) > input.limit) {
    throw fieldLimitError(input)
  }
}

function validateToolSchema(input: {
  diagnostic: ExternalMcpDiagnosticTracker
  schema: unknown
}): void {
  const measurement = measureSerializedJson(
    input.schema,
    EXTERNAL_MCP_TOOL_SCHEMA_LIMIT_BYTES,
    EXTERNAL_MCP_TOOL_SCHEMA_DEPTH_LIMIT,
  )
  if (measurement.ok) return
  const code = measurement.reason === "depth"
    ? "MCP_CATALOG_SCHEMA_DEPTH_LIMIT"
    : measurement.reason === "cycle"
      ? "MCP_CATALOG_SCHEMA_CYCLE"
      : "MCP_CATALOG_SCHEMA_SIZE_LIMIT"
  const operatorAction = measurement.reason === "depth"
    ? `Flatten each tool schema below ${EXTERNAL_MCP_TOOL_SCHEMA_DEPTH_LIMIT} nested levels.`
    : measurement.reason === "cycle"
      ? "Return JSON-serializable, acyclic tool schemas."
      : `Reduce each serialized tool schema below ${EXTERNAL_MCP_TOOL_SCHEMA_LIMIT_BYTES} bytes.`
  throw catalogDiagnosticError({ tracker: input.diagnostic, code, operatorAction })
}

function measureCatalogTool(input: {
  diagnostic: ExternalMcpDiagnosticTracker
  tool: ExternalMcpToolPage["tools"][number]
  remainingBytes: number
}): number {
  validateToolCatalogField({
    diagnostic: input.diagnostic,
    value: input.tool.name,
    field: "name",
    limit: EXTERNAL_MCP_TOOL_NAME_LIMIT_BYTES,
    code: "MCP_CATALOG_TOOL_NAME_LIMIT",
  })
  validateToolCatalogField({
    diagnostic: input.diagnostic,
    value: input.tool.title,
    field: "title",
    limit: EXTERNAL_MCP_TOOL_TITLE_LIMIT_BYTES,
    code: "MCP_CATALOG_TOOL_TITLE_LIMIT",
  })
  validateToolCatalogField({
    diagnostic: input.diagnostic,
    value: input.tool.description,
    field: "description",
    limit: EXTERNAL_MCP_TOOL_DESCRIPTION_LIMIT_BYTES,
    code: "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT",
  })
  validateToolSchema({ diagnostic: input.diagnostic, schema: input.tool.inputSchema })
  if (input.tool.outputSchema !== undefined) {
    validateToolSchema({ diagnostic: input.diagnostic, schema: input.tool.outputSchema })
  }

  const measurement = measureSerializedJson(
    input.tool,
    Math.max(0, input.remainingBytes),
    EXTERNAL_MCP_TOOL_SCHEMA_DEPTH_LIMIT + 4,
  )
  if (!measurement.ok) {
    throw catalogDiagnosticError({
      tracker: input.diagnostic,
      code: "MCP_CATALOG_BYTE_LIMIT",
      operatorAction: `Reduce the complete serialized tool catalog below ${EXTERNAL_MCP_CATALOG_LIMIT_BYTES} bytes.`,
    })
  }
  return measurement.bytes
}

export async function collectExternalMcpToolPages(input: {
  listPage: (cursor: string | undefined, options: RequestOptions) => Promise<ExternalMcpToolPage>
  diagnostic: ExternalMcpDiagnosticTracker
  pageLimit?: number
  itemLimit?: number
  deadline?: ExternalMcpLifecycleDeadline
}): Promise<ExternalMcpToolPage["tools"]> {
  const pageLimit = input.pageLimit ?? EXTERNAL_MCP_TOOL_PAGE_LIMIT
  const itemLimit = input.itemLimit ?? EXTERNAL_MCP_TOOL_ITEM_LIMIT
  const deadline = input.deadline ?? createExternalMcpLifecycleDeadline()
  const tools: ExternalMcpToolPage["tools"] = []
  const seenCursors = new Set<string>()
  const seenToolNames = new Set<string>()
  let catalogBytes = 0
  let cursor: string | undefined
  for (let page = 0; page < pageLimit; page += 1) {
    input.diagnostic.begin("MCP_TOOL_DISCOVERY")
    const result = await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic: input.diagnostic,
      phase: "MCP_TOOL_DISCOVERY",
      operation: (options) => input.listPage(cursor, options),
    })
    if (tools.length + result.tools.length > itemLimit) {
      throw catalogDiagnosticError({
        tracker: input.diagnostic,
        code: "MCP_CATALOG_ITEM_LIMIT",
        operatorAction: `Reduce the provider catalog below ${itemLimit} tools or use a scoped MCP server.`,
      })
    }
    for (const tool of result.tools) {
      catalogBytes += measureCatalogTool({
        diagnostic: input.diagnostic,
        tool,
        remainingBytes: EXTERNAL_MCP_CATALOG_LIMIT_BYTES - catalogBytes,
      })
      if (seenToolNames.has(tool.name)) {
        throw catalogDiagnosticError({
          tracker: input.diagnostic,
          code: "MCP_CATALOG_DUPLICATE_TOOL",
          operatorAction: "Ensure every tools/list page uses a unique, stable tool name.",
        })
      }
      seenToolNames.add(tool.name)
      tools.push(tool)
    }
    if (!result.nextCursor) {
      input.diagnostic.passed("MCP_TOOL_DISCOVERY", "catalog_ready")
      return tools
    }
    if (serializedStringBytes(result.nextCursor) > EXTERNAL_MCP_CURSOR_LIMIT_BYTES) {
      throw catalogDiagnosticError({
        tracker: input.diagnostic,
        code: "MCP_CATALOG_CURSOR_SIZE_LIMIT",
        operatorAction: `Reduce each serialized tools/list cursor below ${EXTERNAL_MCP_CURSOR_LIMIT_BYTES} UTF-8 bytes.`,
      })
    }
    const cursorMeasurement = measureSerializedJson(
      result.nextCursor,
      EXTERNAL_MCP_CATALOG_LIMIT_BYTES - catalogBytes,
      1,
    )
    if (!cursorMeasurement.ok) {
      throw catalogDiagnosticError({
        tracker: input.diagnostic,
        code: "MCP_CATALOG_BYTE_LIMIT",
        operatorAction: `Reduce the complete serialized tool catalog below ${EXTERNAL_MCP_CATALOG_LIMIT_BYTES} bytes.`,
      })
    }
    catalogBytes += cursorMeasurement.bytes
    if (seenCursors.has(result.nextCursor)) {
      throw catalogDiagnosticError({
        tracker: input.diagnostic,
        code: "MCP_CATALOG_CURSOR_LOOP",
        operatorAction: "Fix the provider's tools/list pagination so each nextCursor advances.",
      })
    }
    seenCursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw catalogDiagnosticError({
    tracker: input.diagnostic,
    code: "MCP_CATALOG_PAGE_LIMIT",
    operatorAction: `Reduce the provider catalog to at most ${pageLimit} pages or use a scoped MCP server.`,
  })
}

export type ExternalMcpConnectResult =
  | { status: "connected" }
  | { status: "needs_auth"; authorizeUrl: string }

/**
 * Attempts to connect. For authType "none"/"apikey" this either succeeds or
 * throws. For "oauth", if there's no valid token yet, the SDK's transport
 * drives discovery (+ dynamic client registration if needed) and returns the
 * authorize URL to send the admin's browser to — no token exchange happens
 * yet, that's connect/callback's job. `signedState` (our own signed token
 * identifying which connection this is for) is passed through as the
 * standard OAuth `state` param, since that's the only param guaranteed to
 * round-trip back to connect/callback on any spec-compliant server.
 */
export async function connectExternalMcp(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  signedState?: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
  authorizationActor?: ExternalMcpMemberContext,
  lifecycleDeadline?: ExternalMcpLifecycleDeadline,
): Promise<ExternalMcpConnectResult> {
  const client = buildClient()
  const deadline = lifecycleDeadline ?? createExternalMcpLifecycleDeadline()
  const { transport, provider, diagnostic } = buildTransport(
    connection,
    redirectUri,
    signedState,
    member,
    diagnosticReferenceId,
    deadline,
    authorizationActor,
    true,
  )
  let result: ExternalMcpConnectResult | undefined
  let primaryError: unknown
  try {
    await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic,
      phase: "MCP_INITIALIZE",
      operation: (options) => client.connect(transport, options),
    })
    diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
    result = { status: "connected" }
  } catch (error) {
    if (error instanceof UnauthorizedError && provider?.lastAuthorizeUrl) {
      diagnostic.begin("AUTH_USER_OR_WORKLOAD")
      result = { status: "needs_auth", authorizeUrl: provider.lastAuthorizeUrl }
    } else {
      // Freeze the causal phase before close() can perform any additional
      // transport work and move the tracker to another lifecycle phase.
      primaryError = diagnostic.error(error)
    }
  } finally {
    try {
      await client.close()
    } catch (error) {
      // Never replace the causal handshake error. A close failure after a
      // successful connection is its own lifecycle diagnostic; closing an
      // unauthenticated transport is best-effort but still always attempted.
      if (!primaryError && result?.status === "connected") {
        primaryError = diagnostic.error(error, "SHUTDOWN")
      }
    }
    try {
      await provider?.releaseOAuthRegistrationLease()
    } catch (error) {
      // Preserve an earlier handshake error, but never report a successful
      // start while this request may still own a distributed DCR lease.
      if (!primaryError) primaryError = diagnostic.error(error, "AUTH_CLIENT_REGISTRATION")
    }
  }
  if (primaryError) throw diagnostic.error(primaryError)
  if (!result) throw diagnostic.error(new Error("MCP connection ended without a result."), "MCP_INITIALIZE")
  return result
}

/** Completes the OAuth code exchange after the browser is redirected back with `code`. For per-member connections, `member` (from the signed state token) decides whose account the tokens are saved against. */
export async function runExternalMcpAuthCompletionLifecycle(input: {
  diagnostic: ExternalMcpDiagnosticTracker
  finishAuth: () => Promise<void>
  validateMcp: (options?: RequestOptions) => Promise<void>
  invalidateTokens: () => Promise<void>
  close: () => Promise<void>
  deadline?: ExternalMcpLifecycleDeadline
}): Promise<void> {
  const deadline = input.deadline ?? createExternalMcpLifecycleDeadline()
  input.diagnostic.begin("AUTH_TOKEN_ACQUISITION")
  let exchangedTokens = false
  let primaryError: ExternalMcpDiagnosticError | null = null
  try {
    await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic: input.diagnostic,
      phase: "AUTH_TOKEN_ACQUISITION",
      operation: () => input.finishAuth(),
    })
    exchangedTokens = true
    input.diagnostic.passed("AUTH_TOKEN_ACQUISITION")
    await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic: input.diagnostic,
      phase: "MCP_INITIALIZE",
      operation: (options) => input.validateMcp(options),
    })
    input.diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
  } catch (error) {
    primaryError = input.diagnostic.error(error, exchangedTokens ? "MCP_INITIALIZE" : "AUTH_TOKEN_ACQUISITION")
    if (exchangedTokens) {
      try {
        await input.invalidateTokens()
      } catch {
        // Cleanup must not replace the causal validation diagnostic.
      }
    }
  } finally {
    try {
      await input.close()
    } catch (error) {
      if (!primaryError) primaryError = input.diagnostic.error(error, "SHUTDOWN")
    }
  }
  if (primaryError) throw primaryError
}

export async function completeExternalMcpAuth(
  connection: ExternalMcpConnectionRow,
  code: string,
  redirectUri: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
  signedState?: string,
  authorizationActor?: ExternalMcpMemberContext,
): Promise<void> {
  const client = buildClient()
  const deadline = createExternalMcpLifecycleDeadline()
  const { transport, provider, diagnostic } = buildTransport(
    connection,
    redirectUri,
    signedState,
    member,
    diagnosticReferenceId,
    deadline,
    authorizationActor,
  )
  await runExternalMcpAuthCompletionLifecycle({
    diagnostic,
    finishAuth: () => transport.finishAuth(code),
    // A token response alone does not prove audience, tenant, scopes, or MCP
    // readiness. Initialize with the newly stored credential before success.
    validateMcp: (options) => client.connect(transport, options),
    invalidateTokens: () => provider?.invalidateCredentials?.("tokens") ?? Promise.resolve(),
    close: () => client.close(),
    deadline,
  })
}

/** Remove only the verifier associated with the denied/abandoned browser tab. */
export async function abandonExternalMcpAuth(
  connection: ExternalMcpConnectionRow,
  signedState: string,
  member?: ExternalMcpMemberContext,
  _diagnosticReferenceId?: string,
  authorizationActor?: ExternalMcpMemberContext,
): Promise<void> {
  const expectedIdentityBinding = externalMcpIdentityBinding(connection)
  const orgMembershipId = authorizationActor?.orgMembershipId
    ?? member?.orgMembershipId
    ?? connection.createdByOrgMembershipId
  const codeVerifier = await deleteExternalMcpOAuthTransaction({
    organizationId: connection.organizationId,
    connectionId: connection.id,
    expectedIdentityBinding,
    orgMembershipId,
    signedState,
  })
  if (!codeVerifier) return
  try {
    await clearLegacyExternalMcpPendingCodeVerifierIfMatches({
      organizationId: connection.organizationId,
      connectionId: connection.id,
      expectedIdentityBinding,
      orgMembershipId,
      expectedCodeVerifier: codeVerifier,
    })
  } catch {
    // The state-keyed transaction is already gone; legacy cleanup is only a
    // rolling-deploy bridge and must stay idempotent/best-effort.
  }
}

export async function listExternalMcpTools(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
  lifecycleDeadline?: ExternalMcpLifecycleDeadline,
) {
  const client = buildClient()
  const deadline = lifecycleDeadline ?? createExternalMcpLifecycleDeadline()
  const { transport, diagnostic } = buildTransport(
    connection,
    redirectUri,
    undefined,
    member,
    diagnosticReferenceId,
    deadline,
  )
  let operationError: unknown
  try {
    await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic,
      phase: "MCP_INITIALIZE",
      operation: (options) => client.connect(transport, options),
    })
    diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
    return await collectExternalMcpToolPages({
      diagnostic,
      deadline,
      listPage: (cursor, options) => client.listTools(cursor ? { cursor } : undefined, options),
    })
  } catch (error) {
    operationError = error
    throw diagnostic.error(error)
  } finally {
    try {
      await client.close()
    } catch (error) {
      if (!operationError) throw diagnostic.error(error, "SHUTDOWN")
    }
  }
}

export async function callExternalMcpTool(input: {
  connection: ExternalMcpConnectionRow
  redirectUri: string
  toolName: string
  args: Record<string, unknown>
  member?: ExternalMcpMemberContext
  diagnosticReferenceId?: string
}) {
  const client = buildClient()
  const deadline = createExternalMcpLifecycleDeadline()
  const { transport, diagnostic } = buildTransport(
    input.connection,
    input.redirectUri,
    undefined,
    input.member,
    input.diagnosticReferenceId,
    deadline,
  )
  let operationError: unknown
  try {
    await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic,
      phase: "MCP_INITIALIZE",
      operation: (options) => client.connect(transport, options),
    })
    diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
    diagnostic.begin("MCP_TOOL_EXECUTION")
    const result = await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic,
      phase: "MCP_TOOL_EXECUTION",
      operation: (options) => client.callTool({ name: input.toolName, arguments: input.args }, undefined, options),
    })
    if (result.isError) {
      throw providerToolDiagnosticError({ tracker: diagnostic, result })
    }
    diagnostic.passed("PROVIDER_EXECUTION", "operation_ready")
    return result
  } catch (error) {
    operationError = error
    throw diagnostic.error(error)
  } finally {
    try {
      await client.close()
    } catch (error) {
      if (!operationError) throw diagnostic.error(error, "SHUTDOWN")
    }
  }
}
