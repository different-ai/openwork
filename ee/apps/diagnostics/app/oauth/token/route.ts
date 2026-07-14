import { oauthBasicAuthorized } from "../../../src/auth"
import { diagnosticsConfig, validateProductionConfig } from "../../../src/config"
import { createAccessToken } from "../../../src/session"
import { finalizeRecordedResponse, jsonResponse, readBoundedBody } from "../../../src/recorded-route"

export const dynamic = "force-dynamic"
export const maxDuration = 10

const maximumBodyBytes = 16 * 1024

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now()
  const config = diagnosticsConfig()
  const missing = validateProductionConfig()
  const bounded = await readBoundedBody(request, maximumBodyBytes)
  let handled
  if (missing.length > 0) {
    handled = jsonResponse(503, { error: "diagnostics_not_configured", missing })
  } else if (bounded.tooLarge) {
    handled = jsonResponse(413, { error: "payload_too_large" })
  } else if (!oauthBasicAuthorized(request, config.bearerToken)) {
    handled = jsonResponse(401, { error: "invalid_client" }, { "www-authenticate": "Basic" })
  } else {
    const form = new URLSearchParams(bounded.body)
    if (form.get("grant_type") !== "client_credentials") {
      handled = jsonResponse(400, { error: "unsupported_grant_type" })
    } else if (form.get("resource") !== `${config.publicOrigin}/mcp`) {
      handled = jsonResponse(400, { error: "invalid_target" })
    } else {
      handled = jsonResponse(200, {
        access_token: createAccessToken(config.signingSecret),
        expires_in: 300,
        scope: "diagnostics:connectivity",
        token_type: "Bearer",
      })
    }
  }
  return finalizeRecordedResponse({
    request,
    requestBody: bounded.tooLarge ? "" : bounded.body,
    handled,
    startedAt,
  })
}
