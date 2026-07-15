import { Buffer } from "node:buffer"
import { z } from "zod"
import { MCP_CURRENT_PROTOCOL_VERSION } from "./contracts.js"

const rpcIdSchema = z.union([z.string(), z.number().finite()])
const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: rpcIdSchema,
  method: z.string().trim().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
})

const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const MAX_TRACE_STATE_BYTES = 512
const MAX_BAGGAGE_BYTES = 8 * 1024
const MAX_ROUTING_HEADER_BYTES = 8 * 1024

export type McpCurrentProtocolErrorCode =
  | "MCP_CURRENT_HEADER_MISMATCH"
  | "MCP_CURRENT_METADATA_REQUIRED"
  | "MCP_CURRENT_MIXED_MODE"
  | "MCP_CURRENT_ROUTING_HEADER_INVALID"
  | "MCP_CURRENT_VERSION_UNSUPPORTED"

const jsonRpcCodeByError: Record<McpCurrentProtocolErrorCode, number> = {
  MCP_CURRENT_HEADER_MISMATCH: -32020,
  MCP_CURRENT_METADATA_REQUIRED: -32602,
  MCP_CURRENT_MIXED_MODE: -32020,
  MCP_CURRENT_ROUTING_HEADER_INVALID: -32020,
  MCP_CURRENT_VERSION_UNSUPPORTED: -32022,
}

export class McpCurrentProtocolError extends Error {
  readonly code: McpCurrentProtocolErrorCode
  readonly jsonRpcCode: number
  readonly httpStatus = 400

  constructor(code: McpCurrentProtocolErrorCode, message: string) {
    super(message)
    this.name = "McpCurrentProtocolError"
    this.code = code
    this.jsonRpcCode = jsonRpcCodeByError[code]
  }
}

export type McpCurrentClientMetadata = {
  clientInfo: {
    name: string
    version: string
  }
  clientCapabilities: Record<string, unknown>
  traceparent?: string
  tracestate?: string
  baggage?: string
}

export type McpHeaderParameterBinding = {
  parameterPath: string[]
  /** The x-mcp-header name portion, without the Mcp-Param- prefix. */
  headerName: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertHeaderText(value: string, label: string): void {
  if (value.includes("\r") || value.includes("\n")) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_ROUTING_HEADER_INVALID",
      `${label} cannot contain a carriage return or line feed.`,
    )
  }
}

function assertMetadata(metadata: McpCurrentClientMetadata): void {
  if (!metadata.clientInfo.name.trim() || !metadata.clientInfo.version.trim()) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_METADATA_REQUIRED",
      "Current MCP requests require a non-empty client name and version.",
    )
  }
  if (metadata.traceparent && !TRACEPARENT_PATTERN.test(metadata.traceparent)) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_METADATA_REQUIRED",
      "The traceparent value is not a supported W3C trace context.",
    )
  }
  if (metadata.tracestate && Buffer.byteLength(metadata.tracestate, "utf8") > MAX_TRACE_STATE_BYTES) {
    throw new McpCurrentProtocolError("MCP_CURRENT_METADATA_REQUIRED", "The tracestate value is too large.")
  }
  if (metadata.baggage && Buffer.byteLength(metadata.baggage, "utf8") > MAX_BAGGAGE_BYTES) {
    throw new McpCurrentProtocolError("MCP_CURRENT_METADATA_REQUIRED", "The baggage value is too large.")
  }
}

function routingHeaderName(binding: McpHeaderParameterBinding): string {
  if (binding.parameterPath.length === 0 || binding.parameterPath.some((segment) => !segment.trim())) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_ROUTING_HEADER_INVALID",
      "An MCP parameter routing header requires a non-empty static property path.",
    )
  }
  if (!binding.headerName || !HEADER_NAME_PATTERN.test(binding.headerName)) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_ROUTING_HEADER_INVALID",
      "An x-mcp-header value must be a non-empty HTTP field-name token.",
    )
  }
  const name = `Mcp-Param-${binding.headerName}`
  assertHeaderText(name, "The MCP routing header name")
  return name
}

function plainHeaderSafe(value: string): boolean {
  if (value.startsWith("=?base64?") && value.endsWith("?=")) return false
  if (value.trim() !== value) return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code !== 0x09 && (code < 0x20 || code > 0x7e)) return false
  }
  return true
}

function encodeHeaderText(value: string): string {
  const encoded = plainHeaderSafe(value)
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`
  if (Buffer.byteLength(encoded, "utf8") > MAX_ROUTING_HEADER_BYTES) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_ROUTING_HEADER_INVALID",
      "An MCP routing header value exceeds the bounded transport limit.",
    )
  }
  return encoded
}

function decodeHeaderText(value: string): string {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value
  const encoded = value.slice("=?base64?".length, -2)
  const decoded = Buffer.from(encoded, "base64").toString("utf8")
  if (Buffer.from(decoded, "utf8").toString("base64") !== encoded) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_ROUTING_HEADER_INVALID",
      "An MCP routing header contains invalid Base64 sentinel encoding.",
    )
  }
  return decoded
}

function routingBodyValue(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value)
  throw new McpCurrentProtocolError(
    "MCP_CURRENT_ROUTING_HEADER_INVALID",
    "Only safe integers, booleans, and strings may be copied into MCP routing headers.",
  )
}

function routingHeaderValue(value: unknown): string {
  return encodeHeaderText(routingBodyValue(value))
}

function toolArguments(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (params?.arguments === undefined || params.arguments === null) return {}
  if (!isRecord(params?.arguments)) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_ROUTING_HEADER_INVALID",
      "A declared MCP parameter routing header requires an arguments object.",
    )
  }
  return params.arguments
}

function routedArgument(
  argumentsValue: Record<string, unknown>,
  path: string[],
): { found: boolean; value?: unknown } {
  let current: unknown = argumentsValue
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return { found: false }
    current = current[segment]
  }
  return { found: true, value: current }
}

function requestName(method: string, params: Record<string, unknown> | undefined): string | undefined {
  if (method === "tools/call" && typeof params?.name === "string") return params.name
  if (method === "resources/read" && typeof params?.uri === "string") return params.uri
  if (method === "prompts/get" && typeof params?.name === "string") return params.name
  return undefined
}

function requestRequiresName(method: string): boolean {
  return method === "tools/call" || method === "resources/read" || method === "prompts/get"
}

export function createCurrentMcpRequest(input: {
  id: string | number
  method: string
  params?: Record<string, unknown>
  metadata: McpCurrentClientMetadata
  parameterHeaders?: McpHeaderParameterBinding[]
}): {
  headers: Headers
  body: {
    jsonrpc: "2.0"
    id: string | number
    method: string
    params: Record<string, unknown>
  }
} {
  assertHeaderText(input.method, "The MCP method")
  assertMetadata(input.metadata)
  const existingMeta = isRecord(input.params?._meta) ? input.params._meta : {}
  const meta: Record<string, unknown> = {
    ...existingMeta,
    "io.modelcontextprotocol/protocolVersion": MCP_CURRENT_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": input.metadata.clientInfo,
    "io.modelcontextprotocol/clientCapabilities": input.metadata.clientCapabilities,
    ...(input.metadata.traceparent ? { traceparent: input.metadata.traceparent } : {}),
    ...(input.metadata.tracestate ? { tracestate: input.metadata.tracestate } : {}),
    ...(input.metadata.baggage ? { baggage: input.metadata.baggage } : {}),
  }
  const params: Record<string, unknown> = { ...input.params, _meta: meta }
  const jsonrpc: "2.0" = "2.0"
  const body = {
    jsonrpc,
    id: rpcIdSchema.parse(input.id),
    method: input.method,
    params,
  }
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "MCP-Protocol-Version": MCP_CURRENT_PROTOCOL_VERSION,
    "Mcp-Method": input.method,
  })
  const name = requestName(input.method, params)
  if (requestRequiresName(input.method) && name === undefined) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_ROUTING_HEADER_INVALID",
      `${input.method} requires a string name or URI for Mcp-Name routing.`,
    )
  }
  if (name) {
    headers.set("Mcp-Name", encodeHeaderText(name))
  }
  if (input.parameterHeaders?.length) {
    const argumentsValue = toolArguments(params)
    const usedNames = new Set<string>()
    for (const binding of input.parameterHeaders) {
      const headerName = routingHeaderName(binding)
      const foldedName = headerName.toLowerCase()
      if (usedNames.has(foldedName)) {
        throw new McpCurrentProtocolError(
          "MCP_CURRENT_ROUTING_HEADER_INVALID",
          "Tool definitions must not declare duplicate x-mcp-header names.",
        )
      }
      usedNames.add(foldedName)
      const argument = routedArgument(argumentsValue, binding.parameterPath)
      if (!argument.found || argument.value === null) continue
      headers.set(headerName, routingHeaderValue(argument.value))
    }
  }
  return { headers, body }
}

function requireMetadata(params: Record<string, unknown> | undefined): void {
  if (!isRecord(params?._meta)) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_METADATA_REQUIRED",
      "A current MCP request is missing its per-request metadata.",
    )
  }
  const meta = params._meta
  if (
    meta["io.modelcontextprotocol/protocolVersion"] !== MCP_CURRENT_PROTOCOL_VERSION
    || !isRecord(meta["io.modelcontextprotocol/clientInfo"])
    || !isRecord(meta["io.modelcontextprotocol/clientCapabilities"])
  ) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_METADATA_REQUIRED",
      "A current MCP request has incomplete or mismatched per-request metadata.",
    )
  }
}

export function validateCurrentMcpRouting(input: {
  headers: HeadersInit
  body: unknown
  parameterHeaders?: McpHeaderParameterBinding[]
}): z.infer<typeof rpcRequestSchema> {
  const headers = new Headers(input.headers)
  if (headers.has("Mcp-Session-Id")) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_MIXED_MODE",
      "A current MCP request cannot carry a legacy MCP session identifier.",
    )
  }
  if (headers.get("MCP-Protocol-Version") !== MCP_CURRENT_PROTOCOL_VERSION) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_VERSION_UNSUPPORTED",
      `This endpoint requires MCP ${MCP_CURRENT_PROTOCOL_VERSION}.`,
    )
  }
  const request = rpcRequestSchema.parse(input.body)
  if (headers.get("Mcp-Method") !== request.method) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_HEADER_MISMATCH",
      "The Mcp-Method header does not match the JSON-RPC request body.",
    )
  }
  const name = requestName(request.method, request.params)
  const encodedName = headers.get("Mcp-Name")
  if (requestRequiresName(request.method) && name === undefined) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_HEADER_MISMATCH",
      `${request.method} is missing the body value required for Mcp-Name.`,
    )
  }
  if (name !== undefined && (encodedName === null || decodeHeaderText(encodedName) !== name)) {
    throw new McpCurrentProtocolError(
      "MCP_CURRENT_HEADER_MISMATCH",
      "The Mcp-Name header does not match the JSON-RPC request body.",
    )
  }
  requireMetadata(request.params)
  if (input.parameterHeaders?.length) {
    const argumentsValue = toolArguments(request.params)
    for (const binding of input.parameterHeaders) {
      const headerName = routingHeaderName(binding)
      const argument = routedArgument(argumentsValue, binding.parameterPath)
      const headerValue = headers.get(headerName)
      if (!argument.found || argument.value === null) {
        if (headerValue === null) continue
        throw new McpCurrentProtocolError(
          "MCP_CURRENT_HEADER_MISMATCH",
          `${headerName} is present but the routed tool argument is absent or null.`,
        )
      }
      if (headerValue === null || decodeHeaderText(headerValue) !== routingBodyValue(argument.value)) {
        throw new McpCurrentProtocolError(
          "MCP_CURRENT_HEADER_MISMATCH",
          `${headerName} does not match the routed tool argument.`,
        )
      }
    }
  }
  return request
}
