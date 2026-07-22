import { diagnosticsConfig, validateProductionConfig } from "../../../src/config"
import { finalizeRecordedResponse, jsonResponse } from "../../../src/recorded-route"

export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now()
  const missing = validateProductionConfig()
  const handled = missing.length > 0
    ? jsonResponse(503, { error: "diagnostics_not_configured", missing })
    : {
        body: "",
        response: new Response(null, {
          headers: {
            "cache-control": "no-store",
            location: new URL("/diagnostics/egress?redirected=1", diagnosticsConfig().publicOrigin).toString(),
          },
          status: 302,
        }),
      }
  return finalizeRecordedResponse({ request, requestBody: "", handled, startedAt })
}
