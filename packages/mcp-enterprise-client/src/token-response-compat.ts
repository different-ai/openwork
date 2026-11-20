import type { EnterpriseMcpFetch, EnterpriseMcpRequestPhase } from "./contracts.js"
import { classifyEnterpriseMcpRequest } from "./request-observer.js"
import {
  ENTERPRISE_MCP_RESPONSE_BODY_EXCERPT_CHARS,
  redactedSensitiveResponseString,
} from "./response-body-excerpt.js"

type OAuthErrorCode = "invalid_grant" | "invalid_client" | "invalid_scope" | "access_denied" | "server_error"
type TokenRequestPhase = Extract<EnterpriseMcpRequestPhase, "oauth-token-exchange" | "oauth-token-refresh">

export const SLACK_STYLE_OAUTH_ERROR_MAPPING: Readonly<Record<string, OAuthErrorCode>> = Object.freeze({
  invalid_code: "invalid_grant",
  code_already_used: "invalid_grant",
  token_expired: "invalid_grant",
  token_revoked: "invalid_grant",
  invalid_refresh_token: "invalid_grant",
  bad_redirect_uri: "invalid_grant",
  invalid_client_id: "invalid_client",
  bad_client_secret: "invalid_client",
  invalid_scope: "invalid_scope",
  no_scopes: "invalid_scope",
  no_user_scopes: "invalid_scope",
  invalid_auth: "access_denied",
  accesslimited: "access_denied",
  access_denied: "access_denied",
})

export type EnterpriseMcpTokenResponseTranslation = {
  requestPhase: TokenRequestPhase
  outcome: "succeeded" | "failed"
  httpStatus: number
  responseBodyExcerpt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isTokenRequestPhase(phase: EnterpriseMcpRequestPhase): phase is TokenRequestPhase {
  return phase === "oauth-token-exchange" || phase === "oauth-token-refresh"
}

function structuredTokenResponseExcerpt(response: Record<string, unknown>): string {
  const allowed: Record<string, unknown> = {}
  if (typeof response.ok === "boolean") allowed.ok = response.ok
  for (const field of ["error", "error_description", "error_uri", "message"]) {
    const value = response[field]
    if (typeof value === "string") allowed[field] = redactedSensitiveResponseString(value)
  }
  return JSON.stringify(allowed).slice(0, ENTERPRISE_MCP_RESPONSE_BODY_EXCERPT_CHARS)
}

function jsonResponse(body: Record<string, unknown>, source: Response, status: number): Response {
  const headers = new Headers(source.headers)
  headers.set("content-type", "application/json")
  headers.delete("content-length")
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === source.status ? source.statusText : "Bad Request",
    headers,
  })
}

function notifyTranslation(
  callback: ((translation: EnterpriseMcpTokenResponseTranslation) => void) | undefined,
  translation: EnterpriseMcpTokenResponseTranslation,
): void {
  try {
    callback?.(translation)
  } catch {
    // Compatibility diagnostics must never change the response seen by the SDK.
  }
}

export function createEnterpriseMcpTokenResponseCompat(input: {
  fetch: EnterpriseMcpFetch
  onTranslation?: (translation: EnterpriseMcpTokenResponseTranslation) => void
}): EnterpriseMcpFetch {
  return async (rawUrl, init) => {
    const response = await input.fetch(rawUrl, init)
    const requestPhase = classifyEnterpriseMcpRequest(
      rawUrl instanceof URL ? rawUrl : new URL(rawUrl),
      init,
    )
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
    if (!isTokenRequestPhase(requestPhase) || !response.ok || !contentType.includes("json")) return response

    let text: string
    let parsed: unknown
    try {
      text = await response.clone().text()
      parsed = JSON.parse(text)
    } catch {
      return response
    }
    if (!isRecord(parsed)) return response

    if (parsed.ok === false && typeof parsed.error === "string") {
      const mappedError = SLACK_STYLE_OAUTH_ERROR_MAPPING[parsed.error] ?? "server_error"
      const ipAllowlistHint = parsed.error === "invalid_auth"
        ? " (may indicate the app's IP allowlist rejects our egress IPs)"
        : ""
      const translated = jsonResponse({
        error: mappedError,
        error_description: `Slack-style provider error: ${parsed.error}${ipAllowlistHint}`,
      }, response, 400)
      notifyTranslation(input.onTranslation, {
        requestPhase,
        outcome: "failed",
        httpStatus: translated.status,
        responseBodyExcerpt: structuredTokenResponseExcerpt(parsed),
      })
      return translated
    }

    if (
      parsed.ok === true
      && typeof parsed.token_type === "string"
      && parsed.token_type.length > 0
      && parsed.token_type.toLowerCase() !== "bearer"
    ) {
      const translated = jsonResponse({ ...parsed, token_type: "Bearer" }, response, response.status)
      notifyTranslation(input.onTranslation, {
        requestPhase,
        outcome: "succeeded",
        httpStatus: translated.status,
        responseBodyExcerpt: structuredTokenResponseExcerpt(parsed),
      })
      return translated
    }

    return response
  }
}
