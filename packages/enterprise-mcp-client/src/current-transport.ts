import { z } from "zod"
import { MCP_CURRENT_PROTOCOL_VERSION } from "./contracts.js"

export const MCP_CURRENT_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024
export const MCP_CURRENT_SSE_EVENT_LIMIT = 1_024

const rpcIdSchema = z.union([z.string(), z.number().finite(), z.null()])
const rpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
}).strict()
const rpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: rpcIdSchema,
  result: z.unknown().optional(),
  error: rpcErrorSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.result === undefined) === (value.error === undefined)) {
    context.addIssue({
      code: "custom",
      message: "A JSON-RPC response must contain exactly one of result or error.",
    })
  }
})
const rpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().trim().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict()

export type McpCurrentTransportErrorCode =
  | "MCP_CURRENT_HTTP_ERROR"
  | "MCP_CURRENT_RESPONSE_CONTENT_TYPE"
  | "MCP_CURRENT_RESPONSE_INVALID"
  | "MCP_CURRENT_RESPONSE_SIZE_LIMIT"
  | "MCP_CURRENT_RESPONSE_VERSION_MISMATCH"
  | "MCP_CURRENT_RPC_ERROR"

export class McpCurrentTransportError extends Error {
  readonly code: McpCurrentTransportErrorCode
  readonly httpStatus: number
  readonly rpcCode: number | null

  constructor(input: {
    code: McpCurrentTransportErrorCode
    message: string
    httpStatus: number
    rpcCode?: number
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "McpCurrentTransportError"
    this.code = input.code
    this.httpStatus = input.httpStatus
    this.rpcCode = input.rpcCode ?? null
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MCP_CURRENT_RESPONSE_LIMIT_BYTES) {
    throw new Error(`A current MCP response limit must be between 1 and ${MCP_CURRENT_RESPONSE_LIMIT_BYTES} bytes.`)
  }
  const declared = response.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined)
    throw new McpCurrentTransportError({
      code: "MCP_CURRENT_RESPONSE_SIZE_LIMIT",
      message: "The current MCP response exceeded its bounded transport limit.",
      httpStatus: response.status,
    })
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new McpCurrentTransportError({
          code: "MCP_CURRENT_RESPONSE_SIZE_LIMIT",
          message: "The current MCP response exceeded its bounded transport limit.",
          httpStatus: response.status,
        })
      }
      chunks.push(next.value)
    }
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
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new McpCurrentTransportError({
      code: "MCP_CURRENT_RESPONSE_INVALID",
      message: "The current MCP endpoint returned invalid UTF-8.",
      httpStatus: response.status,
      cause: error,
    })
  }
}

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new McpCurrentTransportError({
      code: "MCP_CURRENT_RESPONSE_INVALID",
      message: "The current MCP endpoint returned malformed JSON.",
      httpStatus: status,
      cause: error,
    })
  }
}

function parseSse(text: string, status: number): unknown[] {
  const messages: unknown[] = []
  let eventName = ""
  let data: string[] = []
  const dispatch = () => {
    if (data.length === 0) {
      eventName = ""
      return
    }
    if (eventName && eventName !== "message") {
      throw new McpCurrentTransportError({
        code: "MCP_CURRENT_RESPONSE_INVALID",
        message: "The current MCP endpoint returned an unsupported SSE event.",
        httpStatus: status,
      })
    }
    if (messages.length >= MCP_CURRENT_SSE_EVENT_LIMIT) {
      throw new McpCurrentTransportError({
        code: "MCP_CURRENT_RESPONSE_SIZE_LIMIT",
        message: "The current MCP endpoint returned too many SSE events.",
        httpStatus: status,
      })
    }
    messages.push(parseJson(data.join("\n"), status))
    eventName = ""
    data = []
  }
  for (const line of text.split(/\r\n|\r|\n/u)) {
    if (line === "") {
      dispatch()
      continue
    }
    if (line.startsWith(":")) continue
    const separator = line.indexOf(":")
    const field = separator < 0 ? line : line.slice(0, separator)
    const raw = separator < 0 ? "" : line.slice(separator + 1)
    const value = raw.startsWith(" ") ? raw.slice(1) : raw
    if (field === "event") eventName = value
    if (field === "data") data.push(value)
  }
  dispatch()
  return messages
}

function sameRpcId(left: string | number | null, right: string | number): boolean {
  return left === right
}

export async function parseCurrentMcpResponse(input: {
  response: Response
  requestId: string | number
  maxBytes?: number
}): Promise<unknown> {
  const { response } = input
  if (response.headers.has("Mcp-Session-Id")) {
    throw new McpCurrentTransportError({
      code: "MCP_CURRENT_RESPONSE_VERSION_MISMATCH",
      message: "A current MCP response cannot establish a legacy session.",
      httpStatus: response.status,
    })
  }
  const version = response.headers.get("MCP-Protocol-Version")
  if (version !== null && version !== MCP_CURRENT_PROTOCOL_VERSION) {
    throw new McpCurrentTransportError({
      code: "MCP_CURRENT_RESPONSE_VERSION_MISMATCH",
      message: "The current MCP response protocol version does not match the request.",
      httpStatus: response.status,
    })
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json" && mediaType !== "text/event-stream") {
    await response.body?.cancel().catch(() => undefined)
    throw new McpCurrentTransportError({
      code: "MCP_CURRENT_RESPONSE_CONTENT_TYPE",
      message: "The current MCP endpoint returned an unsupported content type.",
      httpStatus: response.status,
    })
  }
  const text = await readBoundedBody(response, input.maxBytes ?? MCP_CURRENT_RESPONSE_LIMIT_BYTES)
  const candidates = mediaType === "text/event-stream"
    ? parseSse(text, response.status)
    : [parseJson(text, response.status)]
  const matching: Array<z.infer<typeof rpcResponseSchema>> = []
  for (const candidate of candidates) {
    const parsedResponse = rpcResponseSchema.safeParse(candidate)
    if (parsedResponse.success) {
      if (sameRpcId(parsedResponse.data.id, input.requestId)) matching.push(parsedResponse.data)
      continue
    }
    if (mediaType === "text/event-stream" && rpcNotificationSchema.safeParse(candidate).success) {
      continue
    }
    throw new McpCurrentTransportError({
      code: "MCP_CURRENT_RESPONSE_INVALID",
      message: "The current MCP endpoint returned an invalid or unsolicited JSON-RPC message.",
      httpStatus: response.status,
    })
  }
  if (matching.length !== 1) {
    throw new McpCurrentTransportError({
      code: "MCP_CURRENT_RESPONSE_INVALID",
      message: "The current MCP endpoint did not return exactly one matching JSON-RPC response.",
      httpStatus: response.status,
    })
  }
  const parsed = matching[0]
  if (!parsed) {
    throw new McpCurrentTransportError({
      code: "MCP_CURRENT_RESPONSE_INVALID",
      message: "The current MCP endpoint did not return a valid JSON-RPC response.",
      httpStatus: response.status,
    })
  }
  if (parsed.error) {
    throw new McpCurrentTransportError({
      code: "MCP_CURRENT_RPC_ERROR",
      message: `The current MCP endpoint returned JSON-RPC error ${parsed.error.code}.`,
      httpStatus: response.status,
      rpcCode: parsed.error.code,
    })
  }
  if (!response.ok) {
    throw new McpCurrentTransportError({
      code: "MCP_CURRENT_HTTP_ERROR",
      message: `The current MCP endpoint returned HTTP ${response.status}.`,
      httpStatus: response.status,
    })
  }
  return parsed.result
}
