import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
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
  clearExternalMcpTokensForIdentity,
  deleteOrgOAuthClientForExternalMcpIdentity,
  getExternalMcpConnection,
  readConnectedAccountForExternalMcpIdentity,
  readOrgOAuthClientForExternalMcpIdentity,
  saveExternalMcpPendingCodeVerifierForIdentity,
  saveExternalMcpTokensForIdentity,
  upsertConnectedAccountForExternalMcpIdentity,
  upsertOrgOAuthClientForExternalMcpIdentity,
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
import {
  withExternalMcpToolCallInspection,
  type ExternalMcpToolCallInspector,
} from "./external-mcp-tool-inspection.js"

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
const EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS = 120_000
const EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS = 150_000
const EXTERNAL_MCP_TOOL_PAGE_LIMIT = 20
const EXTERNAL_MCP_TOOL_ITEM_LIMIT = 2_000
const EXTERNAL_MCP_TOOL_NAME_LIMIT_BYTES = 512
const EXTERNAL_MCP_TOOL_TITLE_LIMIT_BYTES = 4 * 1024
const EXTERNAL_MCP_TOOL_DESCRIPTION_LIMIT_BYTES = 64 * 1024
const EXTERNAL_MCP_TOOL_SCHEMA_LIMIT_BYTES = 512 * 1024
const EXTERNAL_MCP_TOOL_SCHEMA_DEPTH_LIMIT = 64
const EXTERNAL_MCP_CURSOR_LIMIT_BYTES = 16 * 1024
const EXTERNAL_MCP_CATALOG_LIMIT_BYTES = 8 * 1024 * 1024

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
  requestTimeoutMs?: number
  operation: (options: RequestOptions) => Promise<T>
}): Promise<T> {
  input.diagnostic.begin(input.phase)
  const remaining = Math.floor(input.deadline.expiresAt - Date.now())
  assertExternalMcpLifecycleActive({ deadline: input.deadline, diagnostic: input.diagnostic, phase: input.phase })

  const controller = new AbortController()
  const options: RequestOptions = {
    signal: AbortSignal.any([controller.signal, input.deadline.signal]),
    timeout: Math.max(1, Math.min(input.requestTimeoutMs ?? EXTERNAL_MCP_CALL_TIMEOUT_MS, remaining)),
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

export class ExternalMcpOAuthProvider implements OAuthClientProvider {
  private connection: ExternalMcpConnectionRow
  private readonly redirectUri: string
  private readonly signedState?: string
  private readonly member?: ExternalMcpMemberContext
  private readonly diagnostic: ExternalMcpDiagnosticTracker
  private readonly lifecycleDeadline?: ExternalMcpLifecycleDeadline
  /** Captured by redirectToAuthorization so the HTTP route can hand it back to the admin's browser instead of actually redirecting anything server-side. */
  lastAuthorizeUrl: string | null = null

  constructor(
    connection: ExternalMcpConnectionRow,
    redirectUri: string,
    signedState: string | undefined,
    member: ExternalMcpMemberContext | undefined,
    diagnostic: ExternalMcpDiagnosticTracker,
    lifecycleDeadline?: ExternalMcpLifecycleDeadline,
  ) {
    this.connection = connection
    this.redirectUri = redirectUri
    this.signedState = signedState
    this.member = member
    this.diagnostic = diagnostic
    this.lifecycleDeadline = lifecycleDeadline
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

  private assertLifecycleActive(phase: ExternalMcpDiagnosticPhase): void {
    if (!this.lifecycleDeadline) return
    assertExternalMcpLifecycleActive({ deadline: this.lifecycleDeadline, diagnostic: this.diagnostic, phase })
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
      application_type: "web",
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
    const result = await readOrgOAuthClientForExternalMcpIdentity(this.connection)
    if (!result.current) throw new Error("The external MCP connection identity changed during authorization.")
    const client = result.value
    this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
    if (!client) return undefined
    this.diagnostic.passed("AUTH_CLIENT_REGISTRATION", "reachable")
    const extra = (client.extra ?? {}) as { clientInformation?: OAuthClientInformationFull }
    if (extra.clientInformation) return extra.clientInformation
    return { client_id: client.clientId, client_secret: client.clientSecret ?? undefined }
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
    const saved = await upsertOrgOAuthClientForExternalMcpIdentity({
      connection: this.connection,
      clientId: clientInformation.client_id,
      clientSecret: clientInformation.client_secret ?? null,
      extra: {
        clientInformation,
        enterpriseMcpRegistrationSource: "dynamic",
        registrationContractVersion: 2,
        registeredRedirectUri: this.redirectUri,
        authorizationServerIssuer: this.connection.oauthConfiguration?.authorizationServerIssuer ?? undefined,
      },
    })
    if (!saved) throw new Error("The external MCP connection identity changed during client registration.")
    this.diagnostic.passed("AUTH_CLIENT_REGISTRATION", "reachable")
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    this.assertLifecycleActive("CONTINUITY_REFRESH")
    if (this.isPerMember) {
      const account = await this.memberAccount()
      this.assertLifecycleActive("CONTINUITY_REFRESH")
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
      this.assertLifecycleActive(this.diagnostic.activePhase === "CONTINUITY_REFRESH" ? "CONTINUITY_REFRESH" : "AUTH_TOKEN_ACQUISITION")
      const saved = await upsertConnectedAccountForExternalMcpIdentity({
        connection: this.connection,
        orgMembershipId: this.member.orgMembershipId,
        changes: {
          accessToken: tokens.access_token,
          // Most providers omit refresh_token on refresh responses; keep the existing one.
          refreshToken: tokens.refresh_token ?? existing?.refreshToken ?? null,
          tokenType: tokens.token_type ?? null,
          scopes: tokens.scope ? tokens.scope.split(" ") : null,
          expiresAt,
          pendingCodeVerifier: null,
        },
      })
      if (!saved) throw new Error("The external MCP connection identity changed during token persistence.")
      this.diagnostic.passed("AUTH_TOKEN_ACQUISITION")
      return
    }
    this.assertLifecycleActive(this.diagnostic.activePhase === "CONTINUITY_REFRESH" ? "CONTINUITY_REFRESH" : "AUTH_TOKEN_ACQUISITION")
    const saved = await saveExternalMcpTokensForIdentity({
      connection: this.connection,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? this.connection.refreshToken ?? null,
      tokenType: tokens.token_type ?? null,
      scope: tokens.scope ?? null,
      expiresAt,
    })
    if (!saved) throw new Error("The external MCP connection identity changed during token persistence.")
    // Refresh the in-memory row so a subsequent tokens()/refresh in the same
    // connection attempt sees the just-saved values.
    const refreshed = await getExternalMcpConnection({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
    })
    if (refreshed) this.connection = refreshed
    this.diagnostic.passed("AUTH_TOKEN_ACQUISITION")
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") {
      const deleted = await deleteOrgOAuthClientForExternalMcpIdentity(this.connection)
      if (!deleted) throw new Error("The external MCP connection identity changed during credential invalidation.")
    }
    if (scope === "all" || scope === "tokens") {
      if (this.isPerMember && this.member) {
        const cleared = await upsertConnectedAccountForExternalMcpIdentity({
          connection: this.connection,
          orgMembershipId: this.member.orgMembershipId,
          changes: {
            accessToken: null,
            refreshToken: null,
            tokenType: null,
            scopes: null,
            expiresAt: null,
            ...(scope === "all" ? { pendingCodeVerifier: null } : {}),
          },
        })
        if (!cleared) throw new Error("The external MCP connection identity changed during credential invalidation.")
      } else {
        const cleared = await clearExternalMcpTokensForIdentity(this.connection)
        if (!cleared) throw new Error("The external MCP connection identity changed during credential invalidation.")
        const refreshed = await getExternalMcpConnection({
          organizationId: this.connection.organizationId,
          connectionId: this.connection.id,
        })
        if (refreshed) this.connection = refreshed
      }
    }
    if ((scope === "all" || scope === "verifier") && !this.isPerMember) {
      const cleared = await saveExternalMcpPendingCodeVerifierForIdentity({ connection: this.connection, codeVerifier: null })
      if (!cleared) throw new Error("The external MCP connection identity changed during verifier invalidation.")
    }
    if (scope === "verifier" && this.isPerMember && this.member) {
      const cleared = await upsertConnectedAccountForExternalMcpIdentity({
        connection: this.connection,
        orgMembershipId: this.member.orgMembershipId,
        changes: { pendingCodeVerifier: null },
      })
      if (!cleared) throw new Error("The external MCP connection identity changed during verifier invalidation.")
    }
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizeUrl = authorizationUrl.toString()
    this.diagnostic.begin("AUTH_USER_OR_WORKLOAD")
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.assertLifecycleActive("AUTH_USER_OR_WORKLOAD")
    if (this.isPerMember && this.member) {
      const saved = await upsertConnectedAccountForExternalMcpIdentity({
        connection: this.connection,
        orgMembershipId: this.member.orgMembershipId,
        changes: { pendingCodeVerifier: codeVerifier },
      })
      if (!saved) throw new Error("The external MCP connection identity changed during verifier persistence.")
      return
    }
    const saved = await saveExternalMcpPendingCodeVerifierForIdentity({ connection: this.connection, codeVerifier })
    if (!saved) throw new Error("The external MCP connection identity changed during verifier persistence.")
  }

  async codeVerifier(): Promise<string> {
    this.assertLifecycleActive("AUTH_TOKEN_ACQUISITION")
    if (this.isPerMember) {
      const account = await this.memberAccount()
      this.assertLifecycleActive("AUTH_TOKEN_ACQUISITION")
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

function buildTransport(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  signedState?: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
  lifecycleDeadline?: ExternalMcpLifecycleDeadline,
  toolCallInspector?: ExternalMcpToolCallInspector,
) {
  const diagnostic = new ExternalMcpDiagnosticTracker(diagnosticReferenceId ?? randomUUID(), {
    authType: connection.authType,
    credentialMode: connection.credentialMode,
  })
  const provider = connection.authType === "oauth"
    ? new ExternalMcpOAuthProvider(connection, redirectUri, signedState, member, diagnostic, lifecycleDeadline)
    : undefined
  const guardedFetch = env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch()
  const lifecycleFetch = lifecycleDeadline
    ? bindExternalMcpFetchToLifecycle(guardedFetch, lifecycleDeadline, diagnostic)
    : guardedFetch
  const diagnosticFetch = createExternalMcpDiagnosticFetch({ fetch: lifecycleFetch, endpoint: connection.url, tracker: diagnostic })
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    authProvider: provider,
    // SSRF guard: every outbound request (the MCP endpoint itself, but also
    // discovery documents and token endpoints the SDK follows to OTHER
    // hosts) is checked against private/reserved address ranges at request
    // time. Hosted-deployment protection; self-hosted/dev opt out via env.
    fetch: toolCallInspector ? toolCallInspector.observeFetch(diagnosticFetch) : diagnosticFetch,
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
): Promise<ExternalMcpConnectResult> {
  const client = buildClient()
  const deadline = createExternalMcpLifecycleDeadline()
  const { transport, provider, diagnostic } = buildTransport(
    connection,
    redirectUri,
    signedState,
    member,
    diagnosticReferenceId,
    deadline,
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
): Promise<void> {
  const client = buildClient()
  const deadline = createExternalMcpLifecycleDeadline()
  const { transport, provider, diagnostic } = buildTransport(
    connection,
    redirectUri,
    undefined,
    member,
    diagnosticReferenceId,
    deadline,
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

/**
 * Compatibility cleanup for a version-one authorization that was started by
 * the pre-enterprise runtime. Those flows stored one plaintext verifier slot,
 * so they cannot be consumed by the version-two state-hash transaction store.
 */
export async function abandonExternalMcpAuth(
  connection: ExternalMcpConnectionRow,
  _signedState: string,
  member?: ExternalMcpMemberContext,
  _diagnosticReferenceId?: string,
): Promise<void> {
  if (connection.credentialMode === "per_member") {
    if (!member) return
    const existing = await readConnectedAccountForExternalMcpIdentity({
      connection,
      orgMembershipId: member.orgMembershipId,
    })
    if (!existing.current) throw new Error("The external MCP connection identity changed during authorization cleanup.")
    if (!existing.value) return
    const cleared = await upsertConnectedAccountForExternalMcpIdentity({
      connection,
      orgMembershipId: member.orgMembershipId,
      changes: { pendingCodeVerifier: null },
    })
    if (!cleared) throw new Error("The external MCP connection identity changed during authorization cleanup.")
    return
  }
  const cleared = await saveExternalMcpPendingCodeVerifierForIdentity({ connection, codeVerifier: null })
  if (!cleared) throw new Error("The external MCP connection identity changed during authorization cleanup.")
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

type ExternalMcpToolCallInput = {
  connection: ExternalMcpConnectionRow
  redirectUri: string
  toolName: string
  args: Record<string, unknown>
  member?: ExternalMcpMemberContext
  diagnosticReferenceId?: string
}

async function runExternalMcpToolCall(
  input: ExternalMcpToolCallInput,
  toolCallInspector?: ExternalMcpToolCallInspector,
) {
  const client = buildClient()
  const deadline = createExternalMcpLifecycleDeadline(EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS)
  const { transport, diagnostic } = buildTransport(
    input.connection,
    input.redirectUri,
    undefined,
    input.member,
    input.diagnosticReferenceId,
    deadline,
    toolCallInspector,
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
      requestTimeoutMs: EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS,
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

export function callExternalMcpTool(input: ExternalMcpToolCallInput) {
  return runExternalMcpToolCall(input)
}

export function inspectExternalMcpToolCall(input: ExternalMcpToolCallInput) {
  return withExternalMcpToolCallInspection((inspector) => runExternalMcpToolCall(input, inspector))
}
