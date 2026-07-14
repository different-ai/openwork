import type { Context } from "hono"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value)
}

function isMcpOperationalPath(path: string) {
  return path === "/mcp" || path === "/mcp/agent" || path === "/mcp/admin"
}

function isOAuthOperationalPath(path: string) {
  return path === "/register" || path.startsWith("/api/auth/oauth2/")
}

export function isOperationalErrorPath(path: string) {
  return isMcpOperationalPath(path) || isOAuthOperationalPath(path)
}

function withReferenceId(body: unknown, requestId: string, path: string) {
  if (isOAuthOperationalPath(path)) {
    const base: Record<string, unknown> = isRecord(body) ? { ...body } : { error: "request_failed" }
    if (typeof base.error !== "string") base.error = "request_failed"
    if (typeof base.error_description !== "string" && typeof base.message === "string") {
      base.error_description = base.message
    }
    if (typeof base.error_description !== "string") base.error_description = "The OAuth request failed."
    base.reference_id = requestId
    return base
  }

  if (isRecord(body)) {
    const bodyError = body.error
    if (isRecord(bodyError)) {
      const data = isRecord(bodyError.data) ? { ...bodyError.data } : {}
      data.referenceId = requestId
      return {
        ...body,
        error: {
          ...bodyError,
          data,
        },
      }
    }
    return {
      ...body,
      referenceId: requestId,
    }
  }

  return {
    error: "request_failed",
    message: "The MCP request failed.",
    referenceId: requestId,
  }
}

async function readJsonBody(response: Response): Promise<unknown | null> {
  try {
    const body: unknown = await response.clone().json()
    return body
  } catch {
    return null
  }
}

async function readTextJsonObjectBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await response.clone().text())
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function contentTypeEssence(headers: Headers) {
  return headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function isFiniteJsonContentType(headers: Headers) {
  const contentType = contentTypeEssence(headers)
  if (!contentType) return false

  const [type, subtype] = contentType.split("/")
  if (subtype === "json-seq" || subtype === "stream+json") return false
  return type === "application" && (subtype === "json" || Boolean(subtype?.endsWith("+json")))
}

function isMislabeledPlainTextJsonContentType(headers: Headers) {
  return contentTypeEssence(headers) === "text/plain"
}

async function readOperationalJsonBody(path: string, response: Response, headers: Headers) {
  if (isFiniteJsonContentType(headers)) {
    return readJsonBody(response)
  }

  if (isOAuthOperationalPath(path) && isMislabeledPlainTextJsonContentType(headers)) {
    return readTextJsonObjectBody(response)
  }

  return null
}

function normalizeRetryAfter(headers: Headers, status: number) {
  if (status !== 429 || headers.has("retry-after")) return
  const retryAfter = headers.get("x-retry-after")
  if (retryAfter) headers.set("Retry-After", retryAfter)
}

function normalizeOperationalHeaders(headers: Headers, path: string, status: number, requestId: string) {
  headers.set("X-Request-Id", requestId)
  normalizeRetryAfter(headers, status)
  if (isOAuthOperationalPath(path)) {
    headers.set("Cache-Control", "no-store")
    headers.set("Pragma", "no-cache")
  }
}

function normalizeJsonOperationalHeaders(headers: Headers) {
  headers.delete("content-length")
  headers.set("content-type", "application/json")
}

export async function normalizeOperationalErrorResponse(path: string, response: Response, requestId: string) {
  if (!isOperationalErrorPath(path) || response.status < 400) {
    return response
  }

  const headers = new Headers(response.headers)
  normalizeOperationalHeaders(headers, path, response.status, requestId)
  const jsonBody = await readOperationalJsonBody(path, response, headers)
  if (jsonBody === null) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  normalizeJsonOperationalHeaders(headers)
  const body = withReferenceId(jsonBody, requestId, path)
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function operationalErrorResponse(error: Error, c: Context, requestId: string) {
  const path = c.req.path
  if (!isOperationalErrorPath(path)) {
    console.error(error)
    return new Response("Internal Server Error", { status: 500 })
  }

  console.error("[operational_error]", {
    category: "operational_route_exception",
    referenceId: requestId,
    method: c.req.method,
    path,
  })

  const headers = new Headers({
    "content-type": "application/json",
    "X-Request-Id": requestId,
  })
  if (isOAuthOperationalPath(path)) {
    headers.set("Cache-Control", "no-store")
    headers.set("Pragma", "no-cache")
  }

  const body = isOAuthOperationalPath(path)
    ? { error: "server_error", error_description: "An unexpected server error occurred.", reference_id: requestId }
    : { error: "internal_server_error", message: "An unexpected server error occurred.", referenceId: requestId }
  return new Response(JSON.stringify(body), { status: 500, headers })
}
