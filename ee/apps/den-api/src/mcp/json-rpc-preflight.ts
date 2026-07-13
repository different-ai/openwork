function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonContentType(headers: Headers) {
  const contentType = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (!contentType) return false

  const [type, subtype] = contentType.split("/")
  return type === "application" && (subtype === "json" || Boolean(subtype?.endsWith("+json")))
}

function jsonRpcErrorResponse(code: -32700 | -32600, message: "Parse error" | "Invalid Request", referenceId: string) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: {
      code,
      message,
      data: { referenceId },
    },
  }), {
    status: 400,
    headers: {
      "content-type": "application/json",
      "X-Request-Id": referenceId,
    },
  })
}

function isValidJsonRpcRequest(value: unknown) {
  if (!isJsonObject(value)) return false
  return value.jsonrpc === "2.0"
    && typeof value.method === "string"
    && value.method.trim().length > 0
}

export async function preflightMcpJsonRpcRequest(request: Request, referenceId: string) {
  if (request.method.toUpperCase() !== "POST" || !isJsonContentType(request.headers)) {
    return null
  }

  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return jsonRpcErrorResponse(-32700, "Parse error", referenceId)
  }

  if (!isValidJsonRpcRequest(body)) {
    return jsonRpcErrorResponse(-32600, "Invalid Request", referenceId)
  }

  return null
}
