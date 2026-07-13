import type { IncomingMessage, ServerResponse } from "node:http"
import { z } from "zod"
import type { EnterpriseMcpScenario } from "../contracts/scenario.js"
import type { ProviderProfile } from "../contracts/profile.js"
import type { FaultDefinition } from "../contracts/fault.js"
import { validateToolArguments, type MockTool } from "../contracts/tool.js"
import type { AccessTokenRecord, InstanceState, SessionRecord } from "../runtime/instance-state.js"
import {
  jsonRpcError,
  jsonRpcRequestSchema,
  jsonRpcResult,
  acceptedMediaTypes,
  HttpInputError,
  readJson,
  sendJson,
  sendSse,
  type JsonRpcRequest,
} from "./http-utils.js"

interface McpRequestContext {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly baseUrl: string
  readonly correlationId: string
  readonly scenario: EnterpriseMcpScenario
  readonly profile: ProviderProfile
  readonly state: InstanceState
  readonly activeFault: FaultDefinition | undefined
}

const initializeParamsSchema = z.object({
  protocolVersion: z.string().min(1),
  capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({ name: z.string().min(1), version: z.string().min(1) }),
})

const listToolsParamsSchema = z.object({ cursor: z.string().optional() }).optional()
const callToolParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.unknown().optional(),
})
const sessionLifetimeMs = 24 * 60 * 60 * 1000

function faultApplies(context: McpRequestContext, effect: FaultDefinition["effect"]): boolean {
  return context.activeFault?.effect === effect && context.state.shouldApplyFault(context.activeFault, context.scenario)
}

function emitFault(context: McpRequestContext, summary: string): void {
  const fault = context.activeFault
  if (!fault) return
  context.state.emit({
    correlationId: context.correlationId,
    scenario: context.scenario,
    phase: fault.phase,
    direction: "outbound",
    kind: "fault",
    outcome: "applied",
    summary,
    details: { faultId: fault.id, category: fault.category },
  })
}

function sendRpc(context: McpRequestContext, body: unknown, headers?: Readonly<Record<string, string>>): boolean {
  if (faultApplies(context, "wrong-content-type")) {
    emitFault(context, "Returned HTML instead of an MCP response")
    context.response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    })
    context.response.end("<!doctype html><title>Synthetic login interception</title>")
    return false
  }
  if (context.scenario.protocol.responseMode === "sse") {
    if (faultApplies(context, "broken-sse")) {
      emitFault(context, "Returned an incomplete SSE data frame")
      context.response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        ...headers,
      })
      context.response.end("event: message\ndata: {\"jsonrpc\":")
      return false
    }
    sendSse(context.response, body, headers)
    return true
  }
  sendJson(context.response, 200, body, headers)
  return true
}

function extractBearer(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  const match = /^Bearer +([^\s]+)$/i.exec(authorization ?? "")
  return match?.[1]
}

function unauthorizedChallenge(context: McpRequestContext): void {
  if (faultApplies(context, "omit-auth-challenge")) {
    emitFault(context, "Returned 401 without OAuth protected-resource metadata")
    sendJson(context.response, 401, { error: "unauthorized" })
    return
  }
  const resourceMetadata = new URL(`/.well-known/oauth-protected-resource${context.profile.endpointPath}`, context.baseUrl).href
  sendJson(
    context.response,
    401,
    { error: "unauthorized" },
    { "www-authenticate": `Bearer resource_metadata="${resourceMetadata}", scope="${context.scenario.oauth.requiredResourceScopes.join(" ")}"` },
  )
}

function validateOrigin(context: McpRequestContext): boolean {
  const origin = context.request.headers.origin
  if (origin && origin !== new URL(context.baseUrl).origin) {
    context.state.emit({
      correlationId: context.correlationId,
      scenario: context.scenario,
      phase: "MCP_TRANSPORT",
      direction: "inbound",
      kind: "security",
      outcome: "failed",
      summary: "Rejected an untrusted Origin header",
      details: { origin },
    })
    sendJson(context.response, 403, { error: "origin_not_allowed" })
    return false
  }
  return true
}

function validateAccept(context: McpRequestContext): boolean {
  const accepted = acceptedMediaTypes(context.request.headers.accept)
  if (accepted.has("application/json") && accepted.has("text/event-stream")) return true
  sendJson(context.response, 406, {
    error: "not_acceptable",
    message: "Accept must include application/json and text/event-stream",
  })
  return false
}

function resolveSession(context: McpRequestContext, token: AccessTokenRecord): SessionRecord | undefined {
  const sessionHeader = context.request.headers["mcp-session-id"]
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader
  if (!sessionId) {
    sendJson(context.response, 400, { error: "missing_mcp_session" })
    return undefined
  }
  const session = context.state.sessions.get(sessionId)
  if (!session) {
    sendJson(context.response, 404, { error: "mcp_session_not_found" })
    return undefined
  }
  if (
    session.tokenFamilyId !== token.familyId ||
    session.profileId !== context.profile.id ||
    session.scenarioRevision !== context.scenario.revision
  ) {
    context.state.emit({
      correlationId: context.correlationId,
      scenario: context.scenario,
      phase: "CONTINUITY_SESSION",
      direction: "inbound",
      kind: "security",
      outcome: "failed",
      summary: "Rejected an MCP session outside its token, profile, or scenario boundary",
    })
    sendJson(context.response, 403, { error: "mcp_session_binding_mismatch" })
    return undefined
  }
  if (faultApplies(context, "expire-session")) {
    context.state.sessions.delete(sessionId)
    emitFault(context, "Expired the MCP session before the post-initialize request")
    sendJson(context.response, 404, { error: "mcp_session_expired" })
    return undefined
  }
  const protocolHeader = context.request.headers["mcp-protocol-version"]
  const protocolVersion = Array.isArray(protocolHeader) ? protocolHeader[0] : protocolHeader
  if (protocolVersion !== session.protocolVersion) {
    sendJson(context.response, 400, { error: "mcp_protocol_version_mismatch" })
    return undefined
  }
  return session
}

export async function handleMcpRequest(context: McpRequestContext): Promise<boolean> {
  const { request, response, scenario, profile, state, correlationId, baseUrl } = context
  const mcpUrl = new URL(profile.endpointPath, baseUrl).href
  const bearer = extractBearer(request)

  if (!validateOrigin(context)) return true

  state.emit({
    correlationId,
    scenario,
    phase: "MCP_TRANSPORT",
    direction: "inbound",
    kind: "request",
    outcome: "started",
    summary: "MCP endpoint request received",
    details: { method: request.method ?? "UNKNOWN", path: profile.endpointPath },
  })

  if (!bearer) {
    unauthorizedChallenge(context)
    return true
  }

  const token = state.tokens.get(bearer)
  if (faultApplies(context, "reject-audience") || !token || token.expiresAt < state.now() || token.resource !== mcpUrl) {
    if (context.activeFault?.effect === "reject-audience") emitFault(context, "Rejected the access token MCP resource audience")
    unauthorizedChallenge(context)
    return true
  }
  if (
    faultApplies(context, "reject-scope") ||
    scenario.oauth.requiredResourceScopes.some((scope) => !token.scopes.includes(scope))
  ) {
    if (context.activeFault?.effect === "reject-scope") emitFault(context, "Rejected the access token for insufficient MCP resource scope")
    sendJson(response, 403, { error: "insufficient_scope" }, { "www-authenticate": `Bearer error="insufficient_scope"` })
    return true
  }

  state.emit({
    correlationId,
    scenario,
    phase: "AUTH_RESOURCE_VALIDATION",
    direction: "internal",
    kind: "lifecycle",
    outcome: "passed",
    summary: "Accepted synthetic access token for this MCP resource",
    details: { scopeCount: token.scopes.length, subjectHash: "synthetic-subject" },
  })

  if (request.method === "DELETE") {
    const sessionHeader = request.headers["mcp-session-id"]
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader
    if (!sessionId) {
      sendJson(response, 404, { error: "mcp_session_not_found" })
      return true
    }
    const session = state.sessions.get(sessionId)
    if (!session) {
      sendJson(response, 404, { error: "mcp_session_not_found" })
      return true
    }
    if (
      session.tokenFamilyId !== token.familyId ||
      session.profileId !== profile.id ||
      session.scenarioRevision !== scenario.revision
    ) {
      sendJson(response, 403, { error: "mcp_session_binding_mismatch" })
      return true
    }
    const protocolHeader = request.headers["mcp-protocol-version"]
    const protocolVersion = Array.isArray(protocolHeader) ? protocolHeader[0] : protocolHeader
    if (protocolVersion !== session.protocolVersion) {
      sendJson(response, 400, { error: "mcp_protocol_version_mismatch" })
      return true
    }
    state.sessions.delete(sessionId)
    response.writeHead(204, { "cache-control": "no-store" })
    response.end()
    state.emit({
      correlationId,
      scenario,
      phase: "SHUTDOWN",
      direction: "internal",
      kind: "lifecycle",
      outcome: "completed",
      summary: "Terminated the synthetic MCP session",
    })
    return true
  }

  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST, DELETE", "cache-control": "no-store" })
    response.end()
    return true
  }
  if (!validateAccept(context)) return true

  let body: unknown
  try {
    body = await readJson(request)
  } catch (error) {
    if (error instanceof HttpInputError && error.status === 400) {
      sendRpc(context, jsonRpcError(null, -32700, "Parse error"))
      return true
    }
    throw error
  }
  const parsedRequest = jsonRpcRequestSchema.safeParse(body)
  if (isJsonRpcResponse(body)) {
    const responseSession = resolveSession(context, token)
    if (!responseSession) return true
    context.state.emit({
      correlationId,
      scenario,
      phase: "MCP_TRANSPORT",
      direction: "inbound",
      kind: "response",
      outcome: "passed",
      summary: "Accepted a syntactically valid JSON-RPC response message",
    })
    response.writeHead(202, { "cache-control": "no-store" })
    response.end()
    return true
  }
  if (!parsedRequest.success) {
    sendRpc(context, jsonRpcError(null, -32600, "Invalid Request", { issues: parsedRequest.error.issues.map((issue) => issue.message) }))
    return true
  }
  const rpc = parsedRequest.data

  if (rpc.method === "initialize") {
    if (rpc.id === undefined) {
      response.writeHead(202, { "cache-control": "no-store" })
      response.end()
      return true
    }
    handleInitialize(context, rpc, token)
    return true
  }

  const session = resolveSession(context, token)
  if (!session) return true

  if (rpc.method === "notifications/initialized") {
    if (rpc.id !== undefined) {
      sendRpc(context, jsonRpcError(rpc.id, -32600, "notifications/initialized must not include a JSON-RPC id"))
      return true
    }
    if (faultApplies(context, "reject-initialized")) {
      emitFault(context, "Rejected notifications/initialized")
      sendJson(response, 400, { error: "initialized_notification_rejected" })
      return true
    }
    session.initialized = true
    response.writeHead(202, { "cache-control": "no-store" })
    response.end()
    state.emit({
      correlationId,
      scenario,
      phase: "MCP_INITIALIZED",
      direction: "internal",
      kind: "lifecycle",
      outcome: "passed",
      summary: "Accepted notifications/initialized",
    })
    return true
  }

  if (!session.initialized) {
    sendRpc(context, jsonRpcError(rpc.id ?? null, -32002, "MCP session is not initialized"))
    return true
  }

  if (rpc.id === undefined) {
    state.emit({
      correlationId,
      scenario,
      phase: "MCP_TRANSPORT",
      direction: "inbound",
      kind: "request",
      outcome: "passed",
      summary: "Accepted an unhandled JSON-RPC notification without emitting a response",
      details: { method: rpc.method },
    })
    response.writeHead(202, { "cache-control": "no-store" })
    response.end()
    return true
  }

  if (rpc.method === "tools/list") {
    handleToolsList(context, rpc, session)
    return true
  }

  if (rpc.method === "tools/call") {
    handleToolCall(context, rpc, session)
    return true
  }

  sendRpc(context, jsonRpcError(rpc.id ?? null, -32601, `Unknown MCP method '${rpc.method}'`))
  return true
}

function handleInitialize(context: McpRequestContext, rpc: JsonRpcRequest, token: AccessTokenRecord): void {
  const { state, scenario, profile, correlationId } = context
  const requestId = rpc.id ?? null
  if (requestId === null) {
    sendRpc(context, jsonRpcError(null, -32600, "initialize must be a JSON-RPC request with an id"))
    return
  }
  const params = initializeParamsSchema.safeParse(rpc.params)
  if (!params.success) {
    sendRpc(context, jsonRpcError(requestId, -32602, "Invalid initialize params"))
    return
  }
  if (faultApplies(context, "reject-version")) {
    emitFault(context, "Rejected MCP protocol version negotiation")
    sendRpc(
      context,
      jsonRpcError(requestId, -32602, "Unsupported MCP protocol version", { supportedVersions: profile.protocol.versions }),
    )
    return
  }

  const negotiatedProtocolVersion = profile.protocol.versions.includes(params.data.protocolVersion)
    ? params.data.protocolVersion
    : profile.protocol.versions[0]
  if (!negotiatedProtocolVersion) {
    sendRpc(context, jsonRpcError(requestId, -32603, "Server profile has no supported MCP protocol version"))
    return
  }

  const sessionId = state.issueOpaque("mcp-session")
  state.putSession({
    sessionId,
    tokenFamilyId: token.familyId,
    operationNamespace: `${token.clientId}\u0000${token.subject}`,
    profileId: profile.id,
    protocolVersion: negotiatedProtocolVersion,
    scenarioRevision: scenario.revision,
    expiresAt: state.now() + sessionLifetimeMs,
    initialized: false,
  })
  const responseId = faultApplies(context, "malform-initialize") ? `${requestId}-mismatch` : requestId
  if (responseId !== requestId) emitFault(context, "Returned an initialize response with a mismatched JSON-RPC id")
  const responseWasConformant = sendRpc(
    context,
    jsonRpcResult(responseId, {
      protocolVersion: negotiatedProtocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "openwork-enterprise-mcp-mock", version: "0.1.0" },
      instructions: `Synthetic ${profile.displayName} development server. No provider data or authority is present.`,
    }),
    { "mcp-session-id": sessionId, "mcp-protocol-version": negotiatedProtocolVersion },
  )
  if (!responseWasConformant || responseId !== requestId) return
  state.emit({
    correlationId,
    scenario,
    phase: "MCP_INITIALIZE",
    direction: "outbound",
    kind: "response",
    outcome: "passed",
    summary: "Negotiated MCP protocol and created an isolated session",
    details: { protocolVersion: negotiatedProtocolVersion, profileId: profile.id },
  })
}

function handleToolsList(context: McpRequestContext, rpc: JsonRpcRequest, session: SessionRecord): void {
  const requestId = rpc.id ?? null
  if (requestId === null) {
    sendRpc(context, jsonRpcError(null, -32600, "tools/list must be a JSON-RPC request with an id"))
    return
  }
  const params = listToolsParamsSchema.safeParse(rpc.params)
  if (!params.success) {
    sendRpc(context, jsonRpcError(requestId, -32602, "Invalid tools/list params"))
    return
  }
  const cursorText = params.data?.cursor
  const cursorMatch = cursorText ? /^page:(0|[1-9]\d*)$/.exec(cursorText) : null
  const offset = cursorText ? (cursorMatch ? Number(cursorMatch[1]) : Number.NaN) : 0
  if (!Number.isSafeInteger(offset) || offset < 0) {
    sendRpc(context, jsonRpcError(requestId, -32602, "Invalid catalog cursor"))
    return
  }

  const emptyCatalogApplied = faultApplies(context, "empty-catalog")
  let tools = emptyCatalogApplied ? [] : context.profile.tools
  if (emptyCatalogApplied) emitFault(context, "Returned an empty MCP tool catalog")
  const page = tools.slice(offset, offset + context.scenario.protocol.pageSize).map((tool) => serializeTool(tool))
  let nextOffset = offset + context.scenario.protocol.pageSize
  let nextCursor: string | undefined = nextOffset < tools.length ? `page:${nextOffset}` : undefined

  const repeatCursorApplied = Boolean(cursorText) && faultApplies(context, "repeat-cursor")
  if (repeatCursorApplied) {
    nextCursor = cursorText
    emitFault(context, "Repeated the MCP catalog cursor")
  }
  const duplicateToolApplied = offset > 0 && Boolean(tools[0]) && faultApplies(context, "duplicate-tool")
  if (duplicateToolApplied && tools[0]) {
    page.unshift(serializeTool(tools[0]))
    emitFault(context, "Repeated a tool name on a later MCP catalog page")
  }
  const invalidSchemaApplied = Boolean(page[0]) && faultApplies(context, "invalid-tool-schema")
  if (invalidSchemaApplied && page[0]) {
    page[0] = { ...page[0], inputSchema: { type: "object", properties: {}, required: "missing", additionalProperties: false } }
    emitFault(context, "Returned a tool with an invalid input schema")
  }

  const responseWasConformant = sendRpc(
    context,
    jsonRpcResult(requestId, { tools: page, ...(nextCursor ? { nextCursor } : {}) }),
    { "mcp-session-id": session.sessionId, "mcp-protocol-version": session.protocolVersion },
  )
  if (!responseWasConformant || emptyCatalogApplied || repeatCursorApplied || duplicateToolApplied || invalidSchemaApplied) return
  context.state.emit({
    correlationId: context.correlationId,
    scenario: context.scenario,
    phase: "MCP_TOOL_DISCOVERY",
    direction: "outbound",
    kind: "response",
    outcome: "passed",
    summary: "Returned one bounded MCP tool-catalog page",
    details: { toolCount: page.length, offset, hasNextPage: nextCursor !== undefined },
  })
}

function serializeTool(tool: MockTool): Readonly<Record<string, unknown>> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: tool.kind === "read",
      destructiveHint: tool.kind === "mutation",
      idempotentHint: tool.kind === "read",
      openWorldHint: false,
    },
  }
}

function handleToolCall(context: McpRequestContext, rpc: JsonRpcRequest, session: SessionRecord): void {
  const requestId = rpc.id ?? null
  if (requestId === null) {
    sendRpc(context, jsonRpcError(null, -32600, "tools/call must be a JSON-RPC request with an id"))
    return
  }
  const params = callToolParamsSchema.safeParse(rpc.params)
  if (!params.success) {
    sendRpc(context, jsonRpcError(requestId, -32602, "Invalid tools/call params"))
    return
  }
  const tool = context.profile.tools.find((candidate) => candidate.name === params.data.name)
  if (!tool) {
    sendRpc(context, jsonRpcError(requestId, -32602, `Unknown tool '${params.data.name}'`))
    return
  }
  const argumentsResult = validateToolArguments(tool.inputSchema, params.data.arguments ?? {})
  if (!argumentsResult.success) {
    sendRpc(context, jsonRpcError(requestId, -32602, "Tool arguments do not match the declared input schema", { issues: argumentsResult.issues }))
    return
  }

  if (tool.kind === "mutation") {
    const approved = argumentsResult.value.approved
    const idempotencyKey = argumentsResult.value.idempotency_key
    if (approved !== true || typeof idempotencyKey !== "string") {
      sendRpc(context, jsonRpcResult(requestId, toolError(context.state.issueOpaque("provider-request"), "MOCK_APPROVAL_REQUIRED", "Synthetic mutations require approved=true and an idempotency key", 400, "mock_approval_required")))
      return
    }
    const prepared = context.state.prepareOperation(session.operationNamespace, tool.name, idempotencyKey, argumentsResult.value)
    if (prepared.kind === "capacity") {
      sendRpc(context, jsonRpcResult(requestId, toolError(context.state.issueOpaque("provider-request"), "MUTATION_LEDGER_CAPACITY", "The bounded mutation ledger is full of unresolved operations; reconcile or reset explicitly before accepting another mutation", 507, "mutation_ledger_capacity")))
      return
    }
    if (prepared.kind === "conflict") {
      sendRpc(context, jsonRpcResult(requestId, toolError(context.state.issueOpaque("provider-request"), "IDEMPOTENCY_CONFLICT", "This idempotency key was already used with different operation arguments", 409, "idempotency_conflict")))
      return
    }
    if (prepared.kind === "reconcile") {
      sendRpc(context, jsonRpcResult(requestId, toolError(context.state.issueOpaque("provider-request"), "MUTATION_RECONCILIATION_REQUIRED", "The earlier mutation outcome is indeterminate; reconcile provider state before retrying", 409, "mutation_reconciliation_required")))
      return
    }
    if (prepared.kind === "duplicate") {
      sendRpc(context, jsonRpcResult(requestId, successResult({ operation: prepared.operation, duplicate: true })))
      return
    }
    const providerError = providerErrorResult(context)
    if (providerError) {
      context.state.operations.delete(prepared.operation.operationId)
      sendRpc(context, jsonRpcResult(requestId, providerError), {
        "mcp-session-id": session.sessionId,
        "mcp-protocol-version": session.protocolVersion,
      })
      return
    }
    const operation = prepared.operation
    const resultReference = stateReference(context)
    context.state.transitionOperation(operation.operationId, "committed", resultReference)
    context.state.emit({
      correlationId: context.correlationId,
      scenario: context.scenario,
      phase: "PROVIDER_EXECUTION",
      direction: "internal",
      kind: "mutation",
      outcome: "completed",
      summary: "Committed a synthetic mutation to the in-memory ledger",
      details: { operationId: operation.operationId, tool: tool.name },
    })
    if (faultApplies(context, "commit-then-disconnect")) {
      context.state.transitionOperation(operation.operationId, "indeterminate", resultReference)
      emitFault(context, "Disconnected after the synthetic mutation committed")
      context.request.socket.destroy()
      return
    }
    const completed = context.state.transitionOperation(operation.operationId, "responded", resultReference)
    sendRpc(context, jsonRpcResult(requestId, successResult({ operation: completed })), {
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": session.protocolVersion,
    })
    return
  }

  const providerError = providerErrorResult(context)
  if (providerError) {
    sendRpc(context, jsonRpcResult(requestId, providerError), {
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": session.protocolVersion,
    })
    return
  }

  const responseWasConformant = sendRpc(context, jsonRpcResult(requestId, successResult(syntheticReadResult(context.profile.id, tool.name, argumentsResult.value, context.state.issueOpaque("provider-request")))), {
    "mcp-session-id": session.sessionId,
    "mcp-protocol-version": session.protocolVersion,
  })
  if (!responseWasConformant) return
  context.state.emit({
    correlationId: context.correlationId,
    scenario: context.scenario,
    phase: "PROVIDER_EXECUTION",
    direction: "outbound",
    kind: "response",
    outcome: "passed",
    summary: "Returned deterministic synthetic provider data",
    details: { profileId: context.profile.id, tool: tool.name },
  })
}

function providerErrorResult(context: McpRequestContext): unknown | undefined {
  const fault = context.activeFault
  if (!fault) return undefined
  if (fault.effect === "provider-authorization-denial" && context.state.shouldApplyFault(fault, context.scenario)) {
    emitFault(context, "Returned a provider ACL denial as an MCP tool error")
    return toolError(context.state.issueOpaque("provider-request"), "PROVIDER_ACL_DENIED", "The synthetic provider denied this operation through roles or ACLs", 403, "provider_acl", false)
  }
  if (fault.effect === "provider-policy-denial" && context.state.shouldApplyFault(fault, context.scenario)) {
    emitFault(context, "Returned a provider governance denial as an MCP tool error")
    return toolError(context.state.issueOpaque("provider-request"), "PROVIDER_POLICY_DENIED", "A synthetic tenant policy or guardian blocked this operation", 403, "provider_policy", false)
  }
  if (fault.effect === "provider-throttle" && context.state.shouldApplyFault(fault, context.scenario)) {
    emitFault(context, "Returned synthetic provider throttling as an MCP tool error")
    return toolError(context.state.issueOpaque("provider-request"), "PROVIDER_THROTTLED", "The synthetic provider temporarily throttled this operation", 429, "provider_throttle", true, 3000)
  }
  if (fault.effect === "provider-unavailable" && context.state.shouldApplyFault(fault, context.scenario)) {
    emitFault(context, "Returned synthetic provider unavailability as an MCP tool error")
    return toolError(context.state.issueOpaque("provider-request"), "PROVIDER_UNAVAILABLE", "The synthetic provider is temporarily unavailable", 503, "provider_unavailable", true, 1000)
  }
  return undefined
}

function toolError(
  providerRequestId: string,
  code: string,
  message: string,
  providerStatus: number,
  category: string,
  retryable = false,
  retryAfterMs?: number,
): unknown {
  const structuredContent = {
    providerStatus,
    category,
    requestId: providerRequestId,
    retryAfterSeconds: retryAfterMs === undefined ? null : Math.ceil(retryAfterMs / 1000),
    error: {
      code,
      message,
      retryable,
      retryAfterMs: retryAfterMs ?? null,
      providerRequestId,
    },
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
}

function successResult(value: unknown): unknown {
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

function syntheticReadResult(
  profileId: string,
  toolName: string,
  argumentsValue: Readonly<Record<string, unknown>>,
  providerRequestId: string,
): unknown {
  if (profileId === "servicenow-inbound-quickstart") {
    return {
      provider: "servicenow",
      tool: toolName,
      requestId: providerRequestId,
      records: [
        {
          number: "INC0000001",
          short_description: "Synthetic printer test incident",
          state: "In Progress",
          sys_id: "00000000000000000000000000000001",
        },
      ],
      arguments: Object.keys(argumentsValue).sort(),
    }
  }
  return {
    provider: profileId === "synthetic-enterprise-oauth-mcp" ? "synthetic" : "microsoft",
    tool: toolName,
    requestId: providerRequestId,
    items: [
      {
        id: "00000000-0000-0000-0000-000000000001",
        displayName: "Synthetic Enterprise User",
        userPrincipalName: "synthetic.user@example.invalid",
      },
    ],
    arguments: Object.keys(argumentsValue).sort(),
  }
}

function isJsonRpcResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.jsonrpc !== "2.0" || "method" in record || !("id" in record)) return false
  if (!(typeof record.id === "string" || (typeof record.id === "number" && Number.isFinite(record.id)) || record.id === null)) {
    return false
  }
  const hasResult = Object.hasOwn(record, "result")
  const hasError = Object.hasOwn(record, "error")
  if (hasResult === hasError) return false
  if (!hasError) return true
  if (typeof record.error !== "object" || record.error === null || Array.isArray(record.error)) return false
  const error = record.error as Record<string, unknown>
  return typeof error.code === "number" && Number.isFinite(error.code) && typeof error.message === "string"
}

function stateReference(context: McpRequestContext): string {
  return `synthetic:${context.state.issueOpaque("result")}`
}
