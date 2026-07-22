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
        authorization_servers: [config.publicOrigin],
        bearer_methods_supported: ["header"],
        resource: `${config.publicOrigin}/mcp`,
        scopes_supported: ["diagnostics:connectivity"],
      })
  return finalizeRecordedResponse({ request, requestBody: "", handled, startedAt })
}
