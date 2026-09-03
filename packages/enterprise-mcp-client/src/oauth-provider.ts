import { OAuthClientInformationFullSchema, OAuthClientInformationSchema, OAuthTokensSchema } from "@modelcontextprotocol/core"
import { discoverAuthorizationServerMetadata, IssuerMismatchError } from "@modelcontextprotocol/client"
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationContext,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client"
import { isEquivalentOAuthDiscoveryAlias } from "./oauth-resource-alias.js"
import type {
  EnterpriseMcpClock,
  EnterpriseMcpLifecycle,
  EnterpriseMcpOAuthAuthorizationHandle,
  EnterpriseMcpOAuthClientRegistration,
  EnterpriseMcpOAuthCredential,
  EnterpriseMcpOAuthConfiguration,
  EnterpriseMcpFetch,
  EnterpriseMcpOAuthPersistence,
  EnterpriseMcpPersistenceContext,
} from "./contracts.js"
import { EnterpriseMcpOAuthContractError } from "./errors.js"
import { isAuthorizationServerDiscoveryBound } from "./oauth-discovery-binding.js"

type OAuthFlowContext =
  | { kind: "connect"; authorizationId?: string }
  | { kind: "callback"; authorizationId: string }
  | { kind: "runtime" }

type VerifiedOAuthDiscoveryState = OAuthDiscoveryState & {
  openworkMetadataVerification?: {
    version: 1
    issuer: string
  }
}

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

function clientExpiration(clientInformation: StoredOAuthClientInformation): number | undefined {
  const parsed = OAuthClientInformationFullSchema.safeParse(clientInformation)
  const seconds = parsed.success ? parsed.data.client_secret_expires_at : undefined
  if (seconds === undefined || seconds === 0) return undefined
  return assertFiniteEpoch(seconds * 1_000, "client expiration")
}

function tokenExpiration(tokens: StoredOAuthTokens, now: number): number | undefined {
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
  private readonly fetch: EnterpriseMcpFetch
  readonly clientMetadataUrl: string | undefined
  private loadedClient: EnterpriseMcpOAuthClientRegistration | undefined
  private loadedCredential: EnterpriseMcpOAuthCredential | undefined
  private loadedDiscovery: OAuthDiscoveryState | undefined
  private verifiedAuthorizationServerMetadata: AuthorizationServerMetadata | undefined
  private authorizationHandle: EnterpriseMcpOAuthAuthorizationHandle | undefined
  private pendingAuthorizationCodeCredential: {
    tokens: StoredOAuthTokens
    expiresAt?: number
    authorization: EnterpriseMcpOAuthAuthorizationHandle
    clientRegistrationRevision?: string
  } | undefined
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
    fetch: EnterpriseMcpFetch
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
    this.fetch = input.fetch
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
    if (!isAuthorizationServerDiscoveryBound(state, selectedIssuer)) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_ISSUER_MISMATCH",
        "The OAuth authorization server does not match the issuer selected for this MCP connection.",
      )
    }
  }

  private expectedCredentialIssuer(context?: OAuthClientInformationContext): string | undefined {
    const boundIssuer = this.authorizationServerIssuer
      ?? this.loadedDiscovery?.authorizationServerMetadata?.issuer
      ?? this.loadedDiscovery?.authorizationServerUrl
    if (context?.issuer && boundIssuer && !isEquivalentOAuthDiscoveryAlias(context.issuer, boundIssuer)) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_ISSUER_MISMATCH",
        "The OAuth credential context does not match the selected authorization server issuer.",
      )
    }
    return boundIssuer ?? context?.issuer
  }

  private assertStoredIssuer(issuer: string | undefined, expectedIssuer: string | undefined): void {
    if (issuer === undefined || expectedIssuer === undefined || isEquivalentOAuthDiscoveryAlias(issuer, expectedIssuer)) return
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_ISSUER_MISMATCH",
      "The stored OAuth credential does not match the selected authorization server issuer.",
    )
  }

  private storedClientInformation(
    clientInformation: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): StoredOAuthClientInformation {
    const expectedIssuer = this.expectedCredentialIssuer(context)
    this.assertStoredIssuer(clientInformation.issuer, expectedIssuer)
    const validated = oauthClientInformationMixedSchema.parse(clientInformation)
    const issuer = clientInformation.issuer ?? expectedIssuer
    return { ...validated, ...(issuer ? { issuer } : {}) }
  }

  private storedTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext): StoredOAuthTokens {
    const expectedIssuer = this.expectedCredentialIssuer(context)
    this.assertStoredIssuer(tokens.issuer, expectedIssuer)
    const validated = OAuthTokensSchema.parse(tokens)
    const issuer = tokens.issuer ?? expectedIssuer
    return { ...validated, ...(issuer ? { issuer } : {}) }
  }

  private async canonicalAuthorizationServerMetadata(): Promise<AuthorizationServerMetadata | undefined> {
    const selectedIssuer = this.authorizationServerIssuer
    if (!selectedIssuer) return undefined
    if (isEquivalentOAuthDiscoveryAlias(this.verifiedAuthorizationServerMetadata?.issuer, selectedIssuer)) {
      return this.verifiedAuthorizationServerMetadata
    }

    let metadata: AuthorizationServerMetadata | undefined
    try {
      metadata = await discoverAuthorizationServerMetadata(selectedIssuer, { fetchFn: this.fetch })
    } catch (error) {
      if (error instanceof IssuerMismatchError) {
        throw new EnterpriseMcpOAuthContractError(
          "MCP_OAUTH_ISSUER_MISMATCH",
          "The selected OAuth issuer could not be verified against its canonical metadata.",
        )
      }
      throw error
    }
    if (!metadata) {
      throw new Error(`No OAuth metadata was found for the selected issuer ${selectedIssuer}.`)
    }
    this.verifiedAuthorizationServerMetadata = metadata
    return metadata
  }

  private hasCurrentMetadataVerification(state: OAuthDiscoveryState, selectedIssuer: string): boolean {
    const verification = (state as VerifiedOAuthDiscoveryState).openworkMetadataVerification
    // The stamp records the canonical metadata issuer; the selected issuer may
    // be its equivalent root trailing-slash alias (RFC 8414's one tolerance).
    return verification?.version === 1
      && isEquivalentOAuthDiscoveryAlias(verification.issuer, selectedIssuer)
      && state.authorizationServerUrl === verification.issuer
      && state.authorizationServerMetadata?.issuer === verification.issuer
  }

  private async normalizeDiscoveryState(state: OAuthDiscoveryState | undefined): Promise<VerifiedOAuthDiscoveryState | undefined> {
    const selectedIssuer = this.authorizationServerIssuer
    if (!selectedIssuer) return state
    if (state) {
      this.assertDiscoveryBinding(state)
      if (this.hasCurrentMetadataVerification(state, selectedIssuer)) {
        this.verifiedAuthorizationServerMetadata = state.authorizationServerMetadata
        return state
      }
    }
    const metadata = await this.canonicalAuthorizationServerMetadata()
    if (!metadata) return state

    const normalized: VerifiedOAuthDiscoveryState = {
      ...state,
      authorizationServerUrl: metadata.issuer,
      authorizationServerMetadata: metadata,
      openworkMetadataVerification: {
        version: 1,
        issuer: metadata.issuer,
      },
    }
    this.assertDiscoveryBinding(normalized)
    return normalized
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const persistedState = await this.persistence.discovery?.load(this.context())
    const state = await this.normalizeDiscoveryState(persistedState)
    if (state) {
      this.assertDiscoveryBinding(state)
      // normalizeDiscoveryState returns the same object when nothing needed
      // verification or repair; only a rebuilt state warrants a re-save.
      if (persistedState && state !== persistedState) {
        await this.persistence.discovery?.save({ context: this.context(), state })
      }
      this.loadedDiscovery = state
    }
    return state
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    let normalizedState: OAuthDiscoveryState | undefined
    try {
      normalizedState = await this.normalizeDiscoveryState(state)
      if (!normalizedState) throw new Error("OAuth discovery state was unavailable.")
      this.assertDiscoveryBinding(normalizedState)
    } catch (error) {
      // Only a proven binding violation invalidates persisted discovery and
      // flags issuer review; a transient metadata outage must stay retryable.
      if (error instanceof EnterpriseMcpOAuthContractError) {
        await this.persistence.discovery?.invalidate({
          context: this.context(),
          reason: "issuer-mismatch",
        })
      }
      throw error
    }
    await this.persistence.discovery?.save({ context: this.context(), state: normalizedState })
    this.loadedDiscovery = normalizedState
  }

  async clientInformation(context?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
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
    const clientInformation = this.storedClientInformation(record.clientInformation, context)
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
    return clientInformation
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const validated = this.storedClientInformation(clientInformation, context)
    const source = this.clientMetadataUrl === validated.client_id ? "client-metadata" : "dynamic"
    const saved = await this.persistence.clientRegistrations.save({
      context: this.context(),
      clientInformation: validated,
      redirectUri: this.redirectUri,
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

  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    if (this.pendingAuthorizationCodeCredential) {
      return this.pendingAuthorizationCodeCredential.tokens
    }
    const record = await this.persistence.credentials.load(this.context())
    if (!record) {
      this.loadedCredential = undefined
      return undefined
    }
    const tokens = this.storedTokens(record.tokens, context)
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

  async saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext): Promise<void> {
    const validated = this.storedTokens(tokens, context)
    const authorization = this.authorizationHandle
    const source = authorization ? "authorization-code" : "refresh"
    const existing = source === "refresh"
      ? (this.loadedCredential ?? await this.persistence.credentials.load(this.context()))
      : undefined
    const merged = source === "refresh" && !validated.refresh_token && existing?.tokens.refresh_token
      ? { ...validated, refresh_token: existing.tokens.refresh_token }
      : validated
    const expiresAt = tokenExpiration(merged, this.clock.now())
    if (authorization) {
      this.pendingAuthorizationCodeCredential = {
        tokens: merged,
        expiresAt,
        authorization,
        clientRegistrationRevision: this.loadedClient?.revision,
      }
      this.loadedCredential = undefined
      return
    }
    await this.persistence.credentials.save({
      context: this.context(),
      tokens: merged,
      expiresAt,
      source: "refresh",
      clientRegistrationRevision: this.loadedClient?.revision,
      expectedCredentialRevision: existing?.revision,
    })
    this.loadedCredential = undefined
  }

  async commitPendingAuthorizationCodeCredential(): Promise<void> {
    const pending = this.pendingAuthorizationCodeCredential
    if (!pending) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_PERSISTENCE_INVALID",
        "The OAuth callback completed without a pending credential.",
      )
    }
    await this.persistence.credentials.save({
      context: this.context(),
      tokens: pending.tokens,
      expiresAt: pending.expiresAt,
      source: "authorization-code",
      authorization: pending.authorization,
      clientRegistrationRevision: pending.clientRegistrationRevision,
    })
    this.pendingAuthorizationCodeCredential = undefined
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
