import { diagnosticsConfig, validateProductionConfig } from "../../../src/config"
import { finalizeRecordedResponse, jsonResponse } from "../../../src/recorded-route"

export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now()
  const config = diagnosticsConfig()
  const missing = validateProductionConfig()
  const handled = missing.length > 0
    ? jsonResponse(503, { error: "diagnostics_not_configured", missing })
    : jsonResponse(200, {
        grant_types_supported: ["client_credentials"],
        issuer: config.publicOrigin,
        scopes_supported: ["diagnostics:connectivity"],
        token_endpoint: `${config.publicOrigin}/oauth/token`,
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      })
  return finalizeRecordedResponse({ request, requestBody: "", handled, startedAt })
}
