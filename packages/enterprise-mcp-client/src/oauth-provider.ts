import { randomUUID } from "node:crypto"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { EnterpriseMcpOAuthStore } from "./contracts.js"

export class EnterpriseMcpOAuthProvider implements OAuthClientProvider {
  private readonly redirectUri: string
  private readonly store: EnterpriseMcpOAuthStore
  private readonly signedState?: string
  private readonly clientName: string
  authorizeUrl: string | null = null

  constructor(input: {
    redirectUri: string
    store: EnterpriseMcpOAuthStore
    state?: string
    clientName: string
  }) {
    this.redirectUri = input.redirectUri
    this.store = input.store
    this.signedState = input.state
    this.clientName = input.clientName
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  state(): string {
    return this.signedState ?? randomUUID()
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUri],
      client_name: this.clientName,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
  }

  clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.store.loadClientInformation()
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    return this.store.saveClientInformation(clientInformation)
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.store.loadTokens()
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.store.saveTokens(tokens)
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizeUrl = authorizationUrl.toString()
  }

  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return this.store.saveCodeVerifier(codeVerifier)
  }

  codeVerifier(): Promise<string> {
    return this.store.loadCodeVerifier()
  }
}
