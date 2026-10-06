export type OAuthTokenExchangeFailureCode =
  | "oauth_invalid_client_secret"
  | "oauth_invalid_client"
  | "oauth_invalid_grant"
  | "oauth_invalid_scope"
  | "oauth_access_denied"
  | "oauth_provider_unavailable"
  | "oauth_token_response_invalid"
  | "oauth_token_response_oversized"
  | "oauth_token_endpoint_unreachable"
  | "oauth_token_exchange_failed"
  | "oauth_scope_required"
  | "oauth_refresh_token_required"
  | "oauth_identity_invalid"
  | "oauth_identity_unavailable"
  | "oauth_reauthentication_required"
  | "oauth_token_endpoint_unavailable"

export class OAuthTokenExchangeError extends Error {
  readonly phase = "AUTH_TOKEN_ACQUISITION"

  constructor(
    message: string,
    readonly code: OAuthTokenExchangeFailureCode = "oauth_token_exchange_failed",
    readonly details: {
      httpStatus?: number
      providerOAuthError?: string
      providerErrorCode?: number
      providerTraceId?: string
      providerCorrelationId?: string
      providerTimestamp?: string
    } = {},
  ) {
    super(message)
    this.name = "OAuthTokenExchangeError"
  }
}
