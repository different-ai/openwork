import { bearerAuthorized } from "../../../src/auth"
import { diagnosticsConfig, validateProductionConfig } from "../../../src/config"
import {
  emptyResponse,
  finalizeRecordedResponse,
  jsonResponse,
  readBoundedBody,
  type HandledResponse,
} from "../../../src/recorded-route"

export const dynamic = "force-dynamic"
export const maxDuration = 10

const maximumBodyBytes = 16 * 1024

async function handle(request: Request): Promise<{ handled: HandledResponse; requestBody: string }> {
  const missing = validateProductionConfig()
  if (missing.length > 0) return { handled: jsonResponse(503, { error: "diagnostics_not_configured", missing }), requestBody: "" }
  if (request.method === "GET") return { handled: jsonResponse(200, { ok: true, method: "GET" }), requestBody: "" }
  if (request.method === "HEAD") return { handled: emptyResponse(204), requestBody: "" }
  if (request.method === "OPTIONS") {
    return { handled: emptyResponse(204, { allow: "GET, HEAD, OPTIONS, POST" }), requestBody: "" }
  }
  if (request.method !== "POST") {
    return { handled: emptyResponse(405, { allow: "GET, HEAD, OPTIONS, POST" }), requestBody: "" }
  }

  const bounded = await readBoundedBody(request, maximumBodyBytes)
  if (bounded.tooLarge) return { handled: jsonResponse(413, { error: "payload_too_large" }), requestBody: "" }
  if (!bearerAuthorized(request, diagnosticsConfig().bearerToken)) {
    return {
      handled: jsonResponse(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" }),
      requestBody: bounded.body,
    }
  }
  try {
    const body: unknown = JSON.parse(bounded.body)
    if (!body || typeof body !== "object" || Array.isArray(body) || !("probe" in body) || body.probe !== "openwork-egress-diagnostic") {
      return { handled: jsonResponse(400, { error: "invalid_probe" }), requestBody: bounded.body }
    }
  } catch {
    return { handled: jsonResponse(400, { error: "invalid_json" }), requestBody: bounded.body }
  }
  return { handled: jsonResponse(200, { ok: true, method: "POST" }), requestBody: bounded.body }
}

async function execute(request: Request): Promise<Response> {
  const startedAt = Date.now()
  const result = await handle(request)
  return finalizeRecordedResponse({ request, requestBody: result.requestBody, handled: result.handled, startedAt })
}

export const GET = execute
export const HEAD = execute
export const OPTIONS = execute
export const POST = execute
