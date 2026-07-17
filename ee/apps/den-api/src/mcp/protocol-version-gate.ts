import {
  MCP_CURRENT_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSION,
  createMcpUnsupportedVersionError,
} from "@openwork/enterprise-mcp-client"

const MAX_ERROR_ID_BODY_BYTES = 64 * 1024

function requestId(value: unknown): string | number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const id = "id" in value ? value.id : null
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) ? id : null
}

async function boundedRequestBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length")
  if (
    declared !== null
    && (!/^\d+$/u.test(declared) || Number(declared) > MAX_ERROR_ID_BODY_BYTES)
  ) {
    await request.body?.cancel().catch(() => undefined)
    return null
  }
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_ERROR_ID_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(next.value)
    }
  } catch {
    await reader.cancel().catch(() => undefined)
    return null
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Fail closed on the locked 2026 release-candidate wire until the final spec,
 * stable SDK, official conformance profile, and shipped engine have all passed
 * qualification. Authentication intentionally runs before this gate.
 */
export async function rejectUnqualifiedCurrentMcpRequest(request: Request): Promise<Response | null> {
  const requested = request.headers.get("MCP-Protocol-Version")
  if (requested !== MCP_CURRENT_PROTOCOL_VERSION) return null

  let body: unknown
  body = await boundedRequestBody(request)
  return Response.json(createMcpUnsupportedVersionError({
    id: requestId(body),
    requested,
    supported: [MCP_LEGACY_PROTOCOL_VERSION],
  }), {
    status: 400,
    headers: {
      "MCP-Protocol-Version": MCP_LEGACY_PROTOCOL_VERSION,
    },
  })
}
