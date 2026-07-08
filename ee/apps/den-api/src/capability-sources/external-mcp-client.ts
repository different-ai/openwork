import { randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { env } from "../env.js"
import { createGuardedFetch, createRealmSafeFetch } from "./url-guard.js"
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import {
  getExternalMcpConnection,
  saveExternalMcpPendingCodeVerifier,
  saveExternalMcpTokens,
} from "./external-mcp-connections.js"
import {
  getConnectedAccount,
  getOrgOAuthClient,
  upsertConnectedAccount,
  upsertOrgOAuthClient,
} from "./oauth-credentials.js"

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
const EXTERNAL_MCP_CALL_OPTIONS: RequestOptions = {
  timeout: EXTERNAL_MCP_CALL_TIMEOUT_MS,
  resetTimeoutOnProgress: true,
}

/**
 * Which member's credential this session should use, for connections with
 * credentialMode "per_member". Absent for "shared" connections (tokens live
 * on the connection row itself).
 */
export type ExternalMcpMemberContext = {
  orgMembershipId: DenTypeId<"member">
}

export class ExternalMcpOAuthProvider implements OAuthClientProvider {
  private connection: ExternalMcpConnectionRow
  private readonly redirectUri: string
  private readonly signedState?: string
  private readonly member?: ExternalMcpMemberContext
  /** Captured by redirectToAuthorization so the HTTP route can hand it back to the admin's browser instead of actually redirecting anything server-side. */
  lastAuthorizeUrl: string | null = null

  constructor(connection: ExternalMcpConnectionRow, redirectUri: string, signedState?: string, member?: ExternalMcpMemberContext) {
    this.connection = connection
    this.redirectUri = redirectUri
    this.signedState = signedState
    this.member = member
    if (connection.credentialMode === "per_member" && connection.authType === "oauth" && !member) {
      throw new Error(`Connection "${connection.id}" uses per-member credentials; a member context is required.`)
    }
  }

  private get isPerMember(): boolean {
    return this.connection.credentialMode === "per_member"
  }

  private async memberAccount() {
    if (!this.member) return null
    return getConnectedAccount({
      organizationId: this.connection.organizationId,
      orgMembershipId: this.member.orgMembershipId,
      providerId: this.connection.id,
    })
  }

  get redirectUrl(): string {
    return this.redirectUri
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
    return this.signedState ?? randomUUID()
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUri],
      client_name: CLIENT_NAME,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const client = await getOrgOAuthClient(this.connection.organizationId, this.connection.id)
    if (!client) return undefined
    const extra = (client.extra ?? {}) as { clientInformation?: OAuthClientInformationFull }
    if (extra.clientInformation) return extra.clientInformation
    return { client_id: client.clientId, client_secret: client.clientSecret ?? undefined }
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await upsertOrgOAuthClient({
      organizationId: this.connection.organizationId,
      providerId: this.connection.id,
      clientId: clientInformation.client_id,
      clientSecret: clientInformation.client_secret ?? null,
      extra: { clientInformation },
      createdByOrgMembershipId: this.connection.createdByOrgMembershipId,
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.isPerMember) {
      const account = await this.memberAccount()
      if (!account?.accessToken) return undefined
      return {
        access_token: account.accessToken,
        token_type: account.tokenType ?? "Bearer",
        refresh_token: account.refreshToken ?? undefined,
        scope: account.scopes?.join(" ") ?? undefined,
      }
    }
    if (!this.connection.accessToken) return undefined
    return {
      access_token: this.connection.accessToken,
      token_type: this.connection.tokenType ?? "Bearer",
      refresh_token: this.connection.refreshToken ?? undefined,
      scope: this.connection.scope ?? undefined,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null
    if (this.isPerMember && this.member) {
      const existing = await this.memberAccount()
      await upsertConnectedAccount({
        organizationId: this.connection.organizationId,
        orgMembershipId: this.member.orgMembershipId,
        providerId: this.connection.id,
        accessToken: tokens.access_token,
        // Most providers omit refresh_token on refresh responses; keep the existing one.
        refreshToken: tokens.refresh_token ?? existing?.refreshToken ?? null,
        tokenType: tokens.token_type ?? null,
        scopes: tokens.scope ? tokens.scope.split(" ") : null,
        expiresAt,
        pendingCodeVerifier: null,
      })
      return
    }
    await saveExternalMcpTokens({
      connectionId: this.connection.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? this.connection.refreshToken ?? null,
      tokenType: tokens.token_type ?? null,
      scope: tokens.scope ?? null,
      expiresAt,
    })
    // Refresh the in-memory row so a subsequent tokens()/refresh in the same
    // connection attempt sees the just-saved values.
    const refreshed = await getExternalMcpConnection({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
    })
    if (refreshed) this.connection = refreshed
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizeUrl = authorizationUrl.toString()
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (this.isPerMember && this.member) {
      await upsertConnectedAccount({
        organizationId: this.connection.organizationId,
        orgMembershipId: this.member.orgMembershipId,
        providerId: this.connection.id,
        pendingCodeVerifier: codeVerifier,
      })
      return
    }
    await saveExternalMcpPendingCodeVerifier({ connectionId: this.connection.id, codeVerifier })
  }

  async codeVerifier(): Promise<string> {
    if (this.isPerMember) {
      const account = await this.memberAccount()
      if (!account?.pendingCodeVerifier) {
        throw new Error("No pending PKCE code verifier for this member on this external MCP connection.")
      }
      return account.pendingCodeVerifier
    }
    if (!this.connection.pendingCodeVerifier) {
      throw new Error("No pending PKCE code verifier for this external MCP connection.")
    }
    return this.connection.pendingCodeVerifier
  }
}

function buildTransport(connection: ExternalMcpConnectionRow, redirectUri: string, signedState?: string, member?: ExternalMcpMemberContext) {
  const provider = connection.authType === "oauth" ? new ExternalMcpOAuthProvider(connection, redirectUri, signedState, member) : undefined
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    authProvider: provider,
    // SSRF guard: every outbound request (the MCP endpoint itself, but also
    // discovery documents and token endpoints the SDK follows to OTHER
    // hosts) is checked against private/reserved address ranges at request
    // time. Hosted-deployment protection; self-hosted/dev opt out via env.
    fetch: env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch(),
    requestInit: connection.authType === "apikey" && connection.apiKey
      ? { headers: { authorization: `Bearer ${connection.apiKey}` } }
      : undefined,
  })
  return { transport, provider }
}

function buildClient() {
  return new Client({ name: "openwork-den", version: "1.0.0" }, { capabilities: {} })
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
export async function connectExternalMcp(connection: ExternalMcpConnectionRow, redirectUri: string, signedState?: string, member?: ExternalMcpMemberContext): Promise<ExternalMcpConnectResult> {
  const client = buildClient()
  const { transport, provider } = buildTransport(connection, redirectUri, signedState, member)
  try {
    await client.connect(transport)
    await client.close()
    return { status: "connected" }
  } catch (error) {
    if (error instanceof UnauthorizedError && provider?.lastAuthorizeUrl) {
      return { status: "needs_auth", authorizeUrl: provider.lastAuthorizeUrl }
    }
    throw error
  }
}

/** Completes the OAuth code exchange after the browser is redirected back with `code`. For per-member connections, `member` (from the signed state token) decides whose account the tokens are saved against. */
export async function completeExternalMcpAuth(connection: ExternalMcpConnectionRow, code: string, redirectUri: string, member?: ExternalMcpMemberContext): Promise<void> {
  const { transport } = buildTransport(connection, redirectUri, undefined, member)
  await transport.finishAuth(code)
}

export async function listExternalMcpTools(connection: ExternalMcpConnectionRow, redirectUri: string, member?: ExternalMcpMemberContext) {
  const client = buildClient()
  const { transport } = buildTransport(connection, redirectUri, undefined, member)
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    return tools
  } finally {
    await client.close()
  }
}

export async function callExternalMcpTool(input: {
  connection: ExternalMcpConnectionRow
  redirectUri: string
  toolName: string
  args: Record<string, unknown>
  member?: ExternalMcpMemberContext
}) {
  const client = buildClient()
  const { transport } = buildTransport(input.connection, input.redirectUri, undefined, input.member)
  await client.connect(transport)
  try {
    return await client.callTool({ name: input.toolName, arguments: input.args }, undefined, EXTERNAL_MCP_CALL_OPTIONS)
  } finally {
    await client.close()
  }
}
