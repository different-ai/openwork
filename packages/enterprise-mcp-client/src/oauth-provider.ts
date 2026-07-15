import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type {
  EnterpriseMcpClock,
  EnterpriseMcpLifecycle,
  EnterpriseMcpOAuthAuthorizationHandle,
  EnterpriseMcpOAuthClientRegistration,
  EnterpriseMcpOAuthCredential,
  EnterpriseMcpOAuthConfiguration,
  EnterpriseMcpOAuthPersistence,
  EnterpriseMcpPersistenceContext,
} from "./contracts.js"
import { EnterpriseMcpOAuthContractError } from "./errors.js"

type OAuthFlowContext =
  | { kind: "connect"; authorizationId?: string }
  | { kind: "callback"; authorizationId: string }
  | { kind: "runtime" }

const oauthClientInformationMixedSchema = OAuthClientInformationFullSchema.or(OAuthClientInformationSchema)

function assertFiniteEpoch(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_PERSISTENCE_INVALID",
      `The OAuth persistence adapter returned an invalid ${field}.`,
    )
  }
  return value
}

function clientExpiration(clientInformation: OAuthClientInformationMixed): number | undefined {
  const parsed = OAuthClientInformationFullSchema.safeParse(clientInformation)
  const seconds = parsed.success ? parsed.data.client_secret_expires_at : undefined
  if (seconds === undefined || seconds === 0) return undefined
  return assertFiniteEpoch(seconds * 1_000, "client expiration")
}

function tokenExpiration(tokens: OAuthTokens, now: number): number | undefined {
  if (tokens.expires_in === undefined) return undefined
  if (!Number.isFinite(tokens.expires_in) || tokens.expires_in < 0) {
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_PERSISTENCE_INVALID",
      "The OAuth provider returned an invalid access-token lifetime.",
    )
  }
  return assertFiniteEpoch(now + tokens.expires_in * 1_000, "token expiration")
}

export class EnterpriseMcpOAuthProvider implements OAuthClientProvider {
  private readonly redirectUri: string
  private readonly connectionId: string
  private readonly persistence: EnterpriseMcpOAuthPersistence
  private readonly flow: OAuthFlowContext
  private readonly clientName: string
  private readonly clock: EnterpriseMcpClock
  private readonly lifecycle: EnterpriseMcpLifecycle
  private readonly authorizationTransactionTtlMs: number
  private readonly expirationSkewMs: number
  private readonly applicationType: EnterpriseMcpOAuthConfiguration["applicationType"]
  private readonly authorizationServerIssuer: string | undefined
  private readonly requestedScopes: string[]
  readonly clientMetadataUrl: string | undefined
  private loadedClient: EnterpriseMcpOAuthClientRegistration | undefined
  private loadedCredential: EnterpriseMcpOAuthCredential | undefined
  private loadedDiscovery: OAuthDiscoveryState | undefined
  private authorizationHandle: EnterpriseMcpOAuthAuthorizationHandle | undefined
  authorizeUrl: string | null = null

  constructor(input: {
    redirectUri: string
    connectionId: string
    persistence: EnterpriseMcpOAuthPersistence
    flow: OAuthFlowContext
    clientName: string
    clock: EnterpriseMcpClock
    lifecycle: EnterpriseMcpLifecycle
    authorizationTransactionTtlMs: number
    expirationSkewMs: number
    oauthConfiguration?: EnterpriseMcpOAuthConfiguration
  }) {
    this.redirectUri = input.redirectUri
    this.connectionId = input.connectionId
    this.persistence = input.persistence
    this.flow = input.flow
    this.clientName = input.clientName
    this.clock = input.clock
    this.lifecycle = input.lifecycle
    this.authorizationTransactionTtlMs = input.authorizationTransactionTtlMs
    this.expirationSkewMs = input.expirationSkewMs
    this.applicationType = input.oauthConfiguration?.applicationType ?? "web"
    this.clientMetadataUrl = input.oauthConfiguration?.clientMetadataUrl
    this.authorizationServerIssuer = input.oauthConfiguration?.authorizationServerIssuer
    this.requestedScopes = [...new Set(input.oauthConfiguration?.requestedScopes ?? [])]
  }

  private context(): EnterpriseMcpPersistenceContext {
    const now = this.clock.now()
    if (this.lifecycle.signal.aborted || now >= this.lifecycle.expiresAt) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_LIFECYCLE_DEADLINE",
        "The enterprise MCP lifecycle expired before OAuth persistence could continue.",
      )
    }
    return {
      connectionId: this.connectionId,
      commitExpiresAt: this.lifecycle.expiresAt,
      signal: this.lifecycle.signal,
    }
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  state(): string {
    if (this.flow.kind !== "connect" || !this.flow.authorizationId) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_AUTHORIZATION_ID_REQUIRED",
        "A signed authorization transaction id is required before starting OAuth.",
      )
    }
    return this.flow.authorizationId
  }

  get clientMetadata() {
    const scope = this.requestedScopes.join(" ")
    return {
      redirect_uris: [this.redirectUri],
      client_name: this.clientName,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: this.applicationType,
      ...(scope ? { scope } : {}),
    }
  }

  private assertDiscoveryBinding(state: OAuthDiscoveryState): void {
    const selectedIssuer = this.authorizationServerIssuer
    if (!selectedIssuer) {
      if ((state.resourceMetadata?.authorization_servers?.length ?? 0) > 1) {
        throw new EnterpriseMcpOAuthContractError(
          "MCP_OAUTH_CONFIGURATION_REQUIRED",
          "This MCP resource advertises multiple authorization servers; an administrator must select one before connecting.",
        )
      }
      return
    }
    const discoveredIssuer = state.authorizationServerMetadata?.issuer
    const advertisedIssuers = state.resourceMetadata?.authorization_servers
    if (
      state.authorizationServerUrl !== selectedIssuer
      || discoveredIssuer !== selectedIssuer
      || (advertisedIssuers !== undefined && !advertisedIssuers.includes(selectedIssuer))
    ) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_ISSUER_MISMATCH",
        "The OAuth authorization server does not match the issuer selected for this MCP connection.",
      )
    }
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = await this.persistence.discovery?.load(this.context())
    if (state) {
      this.assertDiscoveryBinding(state)
      this.loadedDiscovery = state
    }
    return state
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    try {
      this.assertDiscoveryBinding(state)
    } catch (error) {
      await this.persistence.discovery?.invalidate({
        context: this.context(),
        reason: "issuer-mismatch",
      })
      throw error
    }
    await this.persistence.discovery?.save({ context: this.context(), state })
    this.loadedDiscovery = state
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const record = await this.persistence.clientRegistrations.load(this.context())
    if (!record) {
      this.loadedClient = undefined
      const metadata = this.loadedDiscovery?.authorizationServerMetadata
      const canUseClientMetadata = metadata?.client_id_metadata_document_supported === true && Boolean(this.clientMetadataUrl)
      if (metadata && !canUseClientMetadata && !metadata.registration_endpoint) {
        throw new EnterpriseMcpOAuthContractError(
          "MCP_OAUTH_CONFIGURATION_REQUIRED",
          "The authorization server does not advertise client metadata documents or dynamic registration; an administrator must supply a pre-registered OAuth client.",
        )
      }
      return undefined
    }
    oauthClientInformationMixedSchema.parse(record.clientInformation)
    if (!record.revision.trim()) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_PERSISTENCE_INVALID",
        "The OAuth client registration is missing its persistence revision.",
      )
    }
    if (record.expiresAt !== undefined) {
      assertFiniteEpoch(record.expiresAt, "client expiration")
      if (record.expiresAt <= this.clock.now() + this.expirationSkewMs) {
        await this.persistence.clientRegistrations.invalidate({ context: this.context(), reason: "expired" })
        throw new EnterpriseMcpOAuthContractError(
          "MCP_OAUTH_CLIENT_EXPIRED",
          "The OAuth client registration or client secret has expired and must be renewed.",
        )
      }
    }
    this.loadedClient = record
    return record.clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const validated = oauthClientInformationMixedSchema.parse(clientInformation)
    const source = this.clientMetadataUrl === validated.client_id ? "client-metadata" : "dynamic"
    const saved = await this.persistence.clientRegistrations.save({
      context: this.context(),
      clientInformation: validated,
      expiresAt: clientExpiration(validated),
      source,
    })
    if (saved.clientInformation.client_id !== validated.client_id) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_AUTHORIZATION_CLIENT_CHANGED",
        "A different OAuth client registration won a concurrent registration attempt; retry the connection.",
      )
    }
    this.loadedClient = saved
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const record = await this.persistence.credentials.load(this.context())
    if (!record) {
      this.loadedCredential = undefined
      return undefined
    }
    const tokens = OAuthTokensSchema.parse(record.tokens)
    if (!record.revision.trim()) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_PERSISTENCE_INVALID",
        "The OAuth credential is missing its persistence revision.",
      )
    }
    if (record.expiresAt !== undefined) {
      assertFiniteEpoch(record.expiresAt, "token expiration")
      if (record.expiresAt <= this.clock.now() + this.expirationSkewMs && !tokens.refresh_token) {
        await this.persistence.credentials.invalidate({ context: this.context(), reason: "expired" })
        throw new EnterpriseMcpOAuthContractError(
          "MCP_OAUTH_CREDENTIAL_EXPIRED",
          "The OAuth access token has expired and no refresh token is available.",
        )
      }
    }
    this.loadedCredential = { ...record, tokens }
    return tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const validated = OAuthTokensSchema.parse(tokens)
    const source = this.authorizationHandle ? "authorization-code" : "refresh"
    const existing = source === "refresh"
      ? (this.loadedCredential ?? await this.persistence.credentials.load(this.context()))
      : undefined
    const merged = source === "refresh" && !validated.refresh_token && existing?.tokens.refresh_token
      ? { ...validated, refresh_token: existing.tokens.refresh_token }
      : validated
    await this.persistence.credentials.save({
      context: this.context(),
      tokens: merged,
      expiresAt: tokenExpiration(merged, this.clock.now()),
      source,
      authorization: this.authorizationHandle,
      clientRegistrationRevision: this.loadedClient?.revision,
      expectedCredentialRevision: source === "refresh" ? existing?.revision : undefined,
    })
    this.loadedCredential = undefined
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizeUrl = authorizationUrl.toString()
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (this.flow.kind !== "connect" || !this.flow.authorizationId) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_AUTHORIZATION_ID_REQUIRED",
        "A signed authorization transaction id is required before PKCE can be persisted.",
      )
    }
    const expiresAt = this.clock.now() + this.authorizationTransactionTtlMs
    await this.persistence.authorizations.begin({
      context: this.context(),
      id: this.flow.authorizationId,
      codeVerifier,
      expiresAt,
      clientRegistrationRevision: this.loadedClient?.revision,
    })
  }

  async codeVerifier(): Promise<string> {
    if (this.flow.kind !== "callback") {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_AUTHORIZATION_ID_REQUIRED",
        "The OAuth callback is missing its signed authorization transaction id.",
      )
    }
    const transaction = await this.persistence.authorizations.load({
      context: this.context(),
      id: this.flow.authorizationId,
    })
    if (!transaction) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_AUTHORIZATION_MISSING",
        "The OAuth authorization transaction is missing or was already consumed.",
      )
    }
    if (transaction.handle.expiresAt <= this.clock.now() + this.expirationSkewMs) {
      await this.persistence.authorizations.invalidate({
        context: this.context(),
        id: this.flow.authorizationId,
        reason: "expired",
      })
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_AUTHORIZATION_EXPIRED",
        "The OAuth authorization transaction has expired; start the connection again.",
      )
    }
    const clientRevision = this.loadedClient?.revision
    if (
      transaction.handle.clientRegistrationRevision !== undefined
      && transaction.handle.clientRegistrationRevision !== clientRevision
    ) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_AUTHORIZATION_CLIENT_CHANGED",
        "The OAuth client registration changed after authorization started.",
      )
    }
    this.authorizationHandle = transaction.handle
    return transaction.codeVerifier
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") {
      await this.persistence.clientRegistrations.invalidate({
        context: this.context(),
        reason: "provider-rejected",
      })
    }
    if (scope === "all" || scope === "tokens") {
      await this.persistence.credentials.invalidate({
        context: this.context(),
        reason: "provider-rejected",
      })
    }
    if ((scope === "all" || scope === "verifier") && this.flow.kind !== "runtime") {
      const id = this.flow.authorizationId
      if (id) {
        await this.persistence.authorizations.invalidate({
          context: this.context(),
          id,
          reason: "provider-rejected",
        })
      }
    }
    if (scope === "all" || scope === "discovery") {
      await this.persistence.discovery?.invalidate({
        context: this.context(),
        reason: "provider-rejected",
      })
    }
  }
}
