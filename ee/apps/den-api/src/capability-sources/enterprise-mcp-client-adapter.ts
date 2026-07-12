import { randomUUID } from "node:crypto"
import {
  createEnterpriseMcpClient,
  EnterpriseMcpCatalogError,
  EnterpriseMcpClientError,
  EnterpriseMcpToolResultError,
  type EnterpriseMcpClient,
  type EnterpriseMcpConnection,
  type EnterpriseMcpDiagnosticEvent,
  type EnterpriseMcpOAuthStore,
} from "@openwork/enterprise-mcp-client"
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { env } from "../env.js"
import { createGuardedFetch, createRealmSafeFetch } from "./url-guard.js"
import type { ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import {
  clearExternalMcpTokens,
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
import type { ExternalMcpMemberContext, ExternalMcpConnectResult } from "./external-mcp-client.js"
import type { ExternalMcpLifecycleDeadline } from "./external-mcp-client.js"
import {
  ExternalMcpDiagnosticError,
  ExternalMcpDiagnosticTracker,
  catalogDiagnosticError,
  createExternalMcpDiagnosticFetch,
  providerToolDiagnosticError,
  type ExternalMcpDiagnosticPhase,
} from "./external-mcp-diagnostics.js"

class DenEnterpriseMcpOAuthStore implements EnterpriseMcpOAuthStore {
  private connection: ExternalMcpConnectionRow
  private readonly member?: ExternalMcpMemberContext

  constructor(connection: ExternalMcpConnectionRow, member?: ExternalMcpMemberContext) {
    this.connection = connection
    this.member = member
    if (connection.credentialMode === "per_member" && !member) {
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

  async loadClientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const client = await getOrgOAuthClient(this.connection.organizationId, this.connection.id)
    if (!client) return undefined
    const candidate = client.extra?.clientInformation
    const parsed = OAuthClientInformationFullSchema.safeParse(candidate)
    if (parsed.success) return parsed.data
    return {
      client_id: client.clientId,
      client_secret: client.clientSecret ?? undefined,
    }
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

  async loadTokens(): Promise<OAuthTokens | undefined> {
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
    const refreshed = await getExternalMcpConnection({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
    })
    if (refreshed) this.connection = refreshed
  }

  async invalidateTokens(): Promise<void> {
    if (this.isPerMember && this.member) {
      await upsertConnectedAccount({
        organizationId: this.connection.organizationId,
        orgMembershipId: this.member.orgMembershipId,
        providerId: this.connection.id,
        accessToken: null,
        refreshToken: null,
        tokenType: null,
        scopes: null,
        expiresAt: null,
      })
      return
    }
    await clearExternalMcpTokens({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
    })
    const refreshed = await getExternalMcpConnection({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
    })
    if (refreshed) this.connection = refreshed
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
    await saveExternalMcpPendingCodeVerifier({
      connectionId: this.connection.id,
      codeVerifier,
    })
  }

  async loadCodeVerifier(): Promise<string> {
    if (this.isPerMember) {
      const account = await this.memberAccount()
      if (!account?.pendingCodeVerifier) {
        throw new Error("No pending PKCE code verifier exists for this member and MCP connection.")
      }
      return account.pendingCodeVerifier
    }
    if (!this.connection.pendingCodeVerifier) {
      throw new Error("No pending PKCE code verifier exists for this MCP connection.")
    }
    return this.connection.pendingCodeVerifier
  }
}

function toEnterpriseConnection(
  connection: ExternalMcpConnectionRow,
  member?: ExternalMcpMemberContext,
): EnterpriseMcpConnection {
  if (connection.authType === "oauth") {
    return {
      id: connection.id,
      serverUrl: connection.url,
      authorization: {
        type: "oauth",
        store: new DenEnterpriseMcpOAuthStore(connection, member),
      },
    }
  }
  if (connection.authType === "apikey") {
    if (!connection.apiKey) throw new Error(`Connection "${connection.id}" does not have an API key.`)
    return {
      id: connection.id,
      serverUrl: connection.url,
      authorization: { type: "api-key", token: connection.apiKey },
    }
  }
  return {
    id: connection.id,
    serverUrl: connection.url,
    authorization: { type: "none" },
  }
}

const guardedFetch = env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch()

function diagnosticPhase(event: EnterpriseMcpDiagnosticEvent): ExternalMcpDiagnosticPhase {
  if (event.requestPhase === "oauth-resource-discovery") return "AUTH_RESOURCE_DISCOVERY"
  if (event.requestPhase === "oauth-server-discovery") return "AUTH_ISSUER_DISCOVERY"
  if (event.requestPhase === "oauth-client-registration") return "AUTH_CLIENT_REGISTRATION"
  if (event.requestPhase === "oauth-token-exchange") return "AUTH_TOKEN_ACQUISITION"
  if (event.requestPhase === "oauth-token-refresh") return "CONTINUITY_REFRESH"
  if (event.requestPhase === "mcp-initialize") return "MCP_INITIALIZE"
  if (event.requestPhase === "mcp-tool-discovery") return "MCP_TOOL_DISCOVERY"
  if (event.requestPhase === "mcp-tool-execution") return "MCP_TOOL_EXECUTION"
  if (event.operationPhase === "configuration") return "CONFIGURATION"
  if (event.operationPhase === "authorization-callback") return "AUTH_TOKEN_ACQUISITION"
  if (event.operationPhase === "tool-discovery") return "MCP_TOOL_DISCOVERY"
  if (event.operationPhase === "tool-execution") return "MCP_TOOL_EXECUTION"
  if (event.operationPhase === "shutdown") return "SHUTDOWN"
  return "MCP_INITIALIZE"
}

function diagnosticSink(tracker: ExternalMcpDiagnosticTracker) {
  return (event: EnterpriseMcpDiagnosticEvent): void => {
    // Den's diagnostic fetch owns HTTP/request classification, including
    // authorization challenges and network causes. Package request events are
    // still available to package consumers, but must not overwrite that richer
    // Den evidence after a response settles.
    if (event.kind === "request") return
    const phase = diagnosticPhase(event)
    if (event.outcome === "started") {
      tracker.begin(phase)
      return
    }
    if (event.outcome === "failed") {
      // Preserve any richer HTTP/OAuth classification already recorded by
      // Den's diagnostic fetch. Package-only failures are translated in the
      // operation catch boundary below.
      return
    }
    if (event.kind === "operation" && event.requestPhase === "mcp-initialize") {
      tracker.passed("MCP_INITIALIZED", "protocol_ready")
      return
    }
    if (event.requestPhase !== null) return
    if (event.operationPhase === "tool-discovery") tracker.passed("MCP_TOOL_DISCOVERY", "catalog_ready")
    else if (event.operationPhase === "tool-execution") tracker.passed("PROVIDER_EXECUTION", "operation_ready")
    else tracker.passed("MCP_INITIALIZED", "protocol_ready")
  }
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current: unknown = error
  for (let depth = 0; depth < 6; depth += 1) {
    chain.push(current)
    if (typeof current !== "object" || current === null || !("cause" in current) || current.cause === undefined) break
    current = current.cause
  }
  return chain
}

function translateEnterpriseMcpError(
  error: unknown,
  tracker: ExternalMcpDiagnosticTracker,
): ExternalMcpDiagnosticError {
  const chain = errorChain(error)
  const existing = chain.find((cause) => cause instanceof ExternalMcpDiagnosticError)
  if (existing instanceof ExternalMcpDiagnosticError) return existing
  const catalog = chain.find((cause) => cause instanceof EnterpriseMcpCatalogError)
  if (catalog instanceof EnterpriseMcpCatalogError) {
    return catalogDiagnosticError({
      tracker,
      code: catalog.code,
      operatorAction: "Reduce or repair the provider tool catalog to satisfy the named enterprise MCP catalog limit.",
    })
  }
  const toolResult = chain.find((cause) => cause instanceof EnterpriseMcpToolResultError)
  if (toolResult instanceof EnterpriseMcpToolResultError) {
    return providerToolDiagnosticError({
      tracker,
      result: toolResult.providerSignal ? { structuredContent: toolResult.providerSignal } : undefined,
    })
  }
  const enterpriseError = chain.find((cause) => cause instanceof EnterpriseMcpClientError)
  const phase = enterpriseError instanceof EnterpriseMcpClientError
      ? diagnosticPhase({
        kind: "operation",
        connectionId: "",
        operationPhase: enterpriseError.operationPhase,
        requestPhase: enterpriseError.requestPhase,
        outcome: "failed",
      })
    : tracker.activePhase
  const source = [...chain].reverse().find((cause) => (
    !(cause instanceof EnterpriseMcpClientError)
    && !(cause instanceof EnterpriseMcpCatalogError)
    && !(cause instanceof EnterpriseMcpToolResultError)
  )) ?? error
  return tracker.error(source, phase)
}

function createOperationClient(input: {
  connection: ExternalMcpConnectionRow
  diagnosticReferenceId?: string
  lifecycleDeadline?: ExternalMcpLifecycleDeadline
}): { client: EnterpriseMcpClient; tracker: ExternalMcpDiagnosticTracker } {
  const tracker = new ExternalMcpDiagnosticTracker(input.diagnosticReferenceId ?? randomUUID(), {
    authType: input.connection.authType,
    credentialMode: input.connection.credentialMode,
  })
  const observedFetch = createExternalMcpDiagnosticFetch({
    fetch: guardedFetch,
    endpoint: input.connection.url,
    tracker,
  })
  return {
    tracker,
    client: createEnterpriseMcpClient({
      fetch: observedFetch,
      diagnosticSink: diagnosticSink(tracker),
      ...(input.lifecycleDeadline ? {
        lifecycle: {
          expiresAt: input.lifecycleDeadline.expiresAt,
          signal: input.lifecycleDeadline.signal,
        },
      } : {}),
    }),
  }
}

async function runEnterpriseMcpOperation<T>(input: {
  connection: ExternalMcpConnectionRow
  diagnosticReferenceId?: string
  lifecycleDeadline?: ExternalMcpLifecycleDeadline
  operation: (client: EnterpriseMcpClient) => Promise<T>
}): Promise<T> {
  const { client, tracker } = createOperationClient(input)
  try {
    return await input.operation(client)
  } catch (error) {
    throw translateEnterpriseMcpError(error, tracker)
  }
}

export async function connectExternalMcp(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  signedState?: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
): Promise<ExternalMcpConnectResult> {
  return runEnterpriseMcpOperation({
    connection,
    diagnosticReferenceId,
    operation: (client) => client.connect({
      connection: toEnterpriseConnection(connection, member),
      redirectUri,
      state: signedState,
    }),
  })
}

export async function completeExternalMcpAuth(
  connection: ExternalMcpConnectionRow,
  code: string,
  redirectUri: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
): Promise<void> {
  await runEnterpriseMcpOperation({
    connection,
    diagnosticReferenceId,
    operation: (client) => client.completeAuthorization({
      connection: toEnterpriseConnection(connection, member),
      redirectUri,
      code,
    }),
  })
}

export async function listExternalMcpTools(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
  lifecycleDeadline?: ExternalMcpLifecycleDeadline,
) {
  return runEnterpriseMcpOperation({
    connection,
    diagnosticReferenceId,
    lifecycleDeadline,
    operation: (client) => client.listTools({
      connection: toEnterpriseConnection(connection, member),
      redirectUri,
    }),
  })
}

export async function callExternalMcpTool(input: {
  connection: ExternalMcpConnectionRow
  redirectUri: string
  toolName: string
  args: Record<string, unknown>
  member?: ExternalMcpMemberContext
  diagnosticReferenceId?: string
}) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    diagnosticReferenceId: input.diagnosticReferenceId,
    operation: (client) => client.callTool({
      connection: toEnterpriseConnection(input.connection, input.member),
      redirectUri: input.redirectUri,
      toolName: input.toolName,
      arguments: input.args,
    }),
  })
}
