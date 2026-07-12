import {
  createEnterpriseMcpClient,
  type EnterpriseMcpConnection,
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

const enterpriseMcpClient = createEnterpriseMcpClient({
  fetch: env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch(),
})

export async function connectExternalMcp(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  signedState?: string,
  member?: ExternalMcpMemberContext,
): Promise<ExternalMcpConnectResult> {
  return enterpriseMcpClient.connect({
    connection: toEnterpriseConnection(connection, member),
    redirectUri,
    state: signedState,
  })
}

export async function completeExternalMcpAuth(
  connection: ExternalMcpConnectionRow,
  code: string,
  redirectUri: string,
  member?: ExternalMcpMemberContext,
): Promise<void> {
  await enterpriseMcpClient.completeAuthorization({
    connection: toEnterpriseConnection(connection, member),
    redirectUri,
    code,
  })
}

export async function listExternalMcpTools(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  member?: ExternalMcpMemberContext,
) {
  return enterpriseMcpClient.listTools({
    connection: toEnterpriseConnection(connection, member),
    redirectUri,
  })
}

export async function callExternalMcpTool(input: {
  connection: ExternalMcpConnectionRow
  redirectUri: string
  toolName: string
  args: Record<string, unknown>
  member?: ExternalMcpMemberContext
}) {
  return enterpriseMcpClient.callTool({
    connection: toEnterpriseConnection(input.connection, input.member),
    redirectUri: input.redirectUri,
    toolName: input.toolName,
    arguments: input.args,
  })
}
