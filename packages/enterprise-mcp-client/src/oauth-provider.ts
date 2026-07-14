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
  EnterpriseMcpOAuthPersistence,
  EnterpriseMcpPersistenceContext,
} from "./contracts.js"
import { EnterpriseMcpOAuthContractError } from "./errors.js"

type OAuthFlowContext =
  | { kind: "connect"; authorizationId?: string }
  | { kind: "callback"; authorizationId: string }
  | { kind: "runtime" }

const oauthClientInformationMixedSchema = OAuthClientInformationFullSchema.or(OAuthClientInformationSchema)

type TokenEndpointAuthMethod = "client_secret_basic" | "client_secret_post" | "none"

type OAuthRegistrationPolicy = {
  provenance: "dynamic" | "client-metadata"
  tokenEndpointAuthMethod: TokenEndpointAuthMethod
}

const tokenEndpointAuthMethods = [
  "client_secret_basic",
  "client_secret_post",
  "none",
] satisfies TokenEndpointAuthMethod[]

function isTokenEndpointAuthMethod(value: unknown): value is TokenEndpointAuthMethod {
  return value === "client_secret_basic" || value === "client_secret_post" || value === "none"
}

function supportedTokenEndpointAuthMethods(state: OAuthDiscoveryState): string[] {
  const advertised = state.authorizationServerMetadata?.token_endpoint_auth_methods_supported
  // RFC 8414 section 2 defines client_secret_basic as the default when the
  // authorization server omits this field.
  return advertised?.length ? [...new Set(advertised)] : ["client_secret_basic"]
}

function registrationPolicy(
  state: OAuthDiscoveryState,
  clientMetadataUrl: string | undefined,
): OAuthRegistrationPolicy {
  const supported = supportedTokenEndpointAuthMethods(state)
  if (
    clientMetadataUrl
    && state.authorizationServerMetadata?.client_id_metadata_document_supported === true
    && supported.includes("none")
  ) {
    return { provenance: "client-metadata", tokenEndpointAuthMethod: "none" }
  }
  const method = tokenEndpointAuthMethods.find((candidate) => supported.includes(candidate))
  if (!method) {
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_SERVER_INCOMPATIBLE",
      "The MCP authorization server does not advertise a supported token endpoint client authentication method.",
    )
  }
  return { provenance: "dynamic", tokenEndpointAuthMethod: method }
}

function compatibleTokenEndpointAuthMethod(input: {
  clientInformation: OAuthClientInformationMixed
  discoveryState: OAuthDiscoveryState
}): TokenEndpointAuthMethod {
  const supported = supportedTokenEndpointAuthMethods(input.discoveryState)
  const candidate = "token_endpoint_auth_method" in input.clientInformation
    ? input.clientInformation.token_endpoint_auth_method
    : undefined
  const hasClientSecret = typeof input.clientInformation.client_secret === "string"
    && input.clientInformation.client_secret.length > 0

  if (candidate !== undefined) {
    if (!isTokenEndpointAuthMethod(candidate) || !supported.includes(candidate)) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_CLIENT_INCOMPATIBLE",
        "The saved OAuth client uses a token endpoint authentication method this authorization server does not support.",
      )
    }
    if (candidate === "none" && hasClientSecret) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_CLIENT_INCOMPATIBLE",
        "OAuth token endpoint authentication method none is only valid for a public client without a client secret.",
      )
    }
    if (candidate !== "none" && !hasClientSecret) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_CLIENT_INCOMPATIBLE",
        `OAuth token endpoint authentication method ${candidate} requires a client secret.`,
      )
    }
    return candidate
  }

  if (hasClientSecret) {
    if (supported.includes("client_secret_basic")) return "client_secret_basic"
    if (supported.includes("client_secret_post")) return "client_secret_post"
    throw new EnterpriseMcpOAuthContractError(
      "MCP_OAUTH_CLIENT_INCOMPATIBLE",
      "The MCP authorization server does not accept a supported confidential OAuth client authentication method.",
    )
  }
  if (supported.includes("none")) return "none"
  throw new EnterpriseMcpOAuthContractError(
    "MCP_OAUTH_CLIENT_INCOMPATIBLE",
    "This MCP authorization server requires a confidential OAuth client, but no client secret is configured.",
  )
}

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
  private readonly requestedScopes: string[] | undefined
  private readonly clock: EnterpriseMcpClock
  private readonly lifecycle: EnterpriseMcpLifecycle
  private readonly authorizationTransactionTtlMs: number
  private readonly expirationSkewMs: number
  private loadedClient: EnterpriseMcpOAuthClientRegistration | undefined
  private loadedCredential: EnterpriseMcpOAuthCredential | undefined
  private authorizationHandle: EnterpriseMcpOAuthAuthorizationHandle | undefined
  private savedDiscoveryState: OAuthDiscoveryState | undefined
  private oauthRegistrationPolicy: OAuthRegistrationPolicy | undefined
  private dynamicRegistrationClaim: string | undefined
  readonly clientMetadataUrl: string | undefined
  authorizeUrl: string | null = null

  /** Exact credential revision most recently supplied to this transport. */
  get credentialRevision(): string | undefined {
    return this.loadedCredential?.revision
  }

  constructor(input: {
    redirectUri: string
    connectionId: string
    persistence: EnterpriseMcpOAuthPersistence
    flow: OAuthFlowContext
    clientName: string
    requestedScopes?: string[]
    clientMetadataUrl?: string
    clock: EnterpriseMcpClock
    lifecycle: EnterpriseMcpLifecycle
    authorizationTransactionTtlMs: number
    expirationSkewMs: number
  }) {
    this.redirectUri = input.redirectUri
    this.connectionId = input.connectionId
    this.persistence = input.persistence
    this.flow = input.flow
    this.clientName = input.clientName
    this.requestedScopes = input.requestedScopes
    this.clientMetadataUrl = input.clientMetadataUrl
    this.clock = input.clock
    this.lifecycle = input.lifecycle
    this.authorizationTransactionTtlMs = input.authorizationTransactionTtlMs
    this.expirationSkewMs = input.expirationSkewMs
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
    return {
      redirect_uris: [this.redirectUri],
      client_name: this.clientName,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.oauthRegistrationPolicy?.tokenEndpointAuthMethod ?? "none",
      ...(this.requestedScopes?.length ? { scope: this.requestedScopes.join(" ") } : {}),
    }
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    if (!state.authorizationServerMetadata?.code_challenge_methods_supported?.includes("S256")) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_SERVER_INCOMPATIBLE",
        "The MCP authorization server must advertise PKCE code_challenge_methods_supported including S256.",
      )
    }
    this.oauthRegistrationPolicy = registrationPolicy(state, this.clientMetadataUrl)
    this.savedDiscoveryState = state
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    let record = await this.persistence.clientRegistrations.load(this.context())
    if (!record) {
      if (this.flow.kind !== "connect") {
        throw new EnterpriseMcpOAuthContractError(
          "MCP_OAUTH_CLIENT_REQUIRED",
          "A saved OAuth client is required before an MCP runtime operation can continue.",
        )
      }
      if (this.oauthRegistrationPolicy?.provenance === "dynamic") {
        const claimed = await this.persistence.clientRegistrations.claimDynamicRegistration(this.context())
        if (claimed.status === "existing") {
          record = claimed.registration
        } else {
          this.dynamicRegistrationClaim = claimed.claim
          this.loadedClient = undefined
          return undefined
        }
      } else {
        this.loadedClient = undefined
        return undefined
      }
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
        if (record.source === "dynamic") {
          await this.persistence.clientRegistrations.invalidate({
            context: this.context(),
            reason: "expired",
            revision: record.revision,
          })
        }
        throw new EnterpriseMcpOAuthContractError(
          "MCP_OAUTH_CLIENT_EXPIRED",
          "The OAuth client registration or client secret has expired and must be renewed.",
        )
      }
    }
    const discoveryState = this.savedDiscoveryState
    if (!discoveryState) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_SERVER_INCOMPATIBLE",
        "OAuth discovery must complete before loading client credentials.",
      )
    }
    const tokenEndpointAuthMethod = compatibleTokenEndpointAuthMethod({
      clientInformation: record.clientInformation,
      discoveryState,
    })
    const clientInformation = {
      ...record.clientInformation,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    }
    this.loadedClient = record
    return clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const validated = oauthClientInformationMixedSchema.parse(clientInformation)
    const discoveryState = this.savedDiscoveryState
    const policy = this.oauthRegistrationPolicy
    if (!discoveryState || !policy) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_SERVER_INCOMPATIBLE",
        "OAuth discovery must complete before saving client credentials.",
      )
    }
    const tokenEndpointAuthMethod = compatibleTokenEndpointAuthMethod({
      clientInformation: validated,
      discoveryState,
    })
    if (tokenEndpointAuthMethod !== policy.tokenEndpointAuthMethod) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_CLIENT_INCOMPATIBLE",
        "The OAuth registration response changed the requested token endpoint client authentication method.",
      )
    }
    const source = policy.provenance === "client-metadata"
      && validated.client_id === this.clientMetadataUrl
      && validated.client_secret === undefined
      ? "client-metadata"
      : "dynamic"
    const normalized = { ...validated, token_endpoint_auth_method: tokenEndpointAuthMethod }
    const saved = await this.persistence.clientRegistrations.save({
      context: this.context(),
      clientInformation: normalized,
      expiresAt: clientExpiration(normalized),
      source,
      ...(source === "dynamic" ? { claim: this.dynamicRegistrationClaim } : {}),
    })
    if (saved.clientInformation.client_id !== validated.client_id) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_AUTHORIZATION_CLIENT_CHANGED",
        "A different OAuth client registration won a concurrent registration attempt; retry the connection.",
      )
    }
    if (
      source === "client-metadata"
      && (
        saved.clientInformation.client_secret !== undefined
        || compatibleTokenEndpointAuthMethod({
          clientInformation: saved.clientInformation,
          discoveryState,
        }) !== "none"
      )
    ) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_AUTHORIZATION_CLIENT_CHANGED",
        "A concurrently configured OAuth client is incompatible with Client ID Metadata; retry with the saved client.",
      )
    }
    this.loadedClient = saved
    this.dynamicRegistrationClaim = undefined
  }

  async releaseDynamicRegistrationClaim(): Promise<void> {
    const claim = this.dynamicRegistrationClaim
    if (!claim) return
    this.dynamicRegistrationClaim = undefined
    await this.persistence.clientRegistrations.releaseDynamicRegistration(claim)
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
        await this.persistence.credentials.invalidate({
          context: this.context(),
          reason: "expired",
          revision: record.revision,
        })
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
    const saved = await this.persistence.credentials.save({
      context: this.context(),
      tokens: merged,
      expiresAt: tokenExpiration(merged, this.clock.now()),
      source,
      authorization: this.authorizationHandle,
      clientRegistrationRevision: this.loadedClient?.revision,
    })
    if (!saved.revision.trim()) {
      throw new EnterpriseMcpOAuthContractError(
        "MCP_OAUTH_PERSISTENCE_INVALID",
        "The saved OAuth credential is missing its persistence revision.",
      )
    }
    this.loadedCredential = saved
    if (source === "authorization-code") this.authorizationHandle = undefined
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
      const client = this.loadedClient
      if (client?.source === "dynamic") {
        await this.persistence.clientRegistrations.invalidate({
          context: this.context(),
          reason: "provider-rejected",
          revision: client.revision,
        })
      }
      this.loadedClient = undefined
    }
    if (scope === "all" || scope === "tokens") {
      const revision = this.loadedCredential?.revision
      if (revision) {
        await this.persistence.credentials.invalidate({
          context: this.context(),
          reason: "provider-rejected",
          revision,
        })
      }
      this.loadedCredential = undefined
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
      this.savedDiscoveryState = undefined
      this.oauthRegistrationPolicy = undefined
    }
  }
}
