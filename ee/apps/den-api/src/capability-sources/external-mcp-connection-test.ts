import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../env.js"
import type { ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import { getConnectedAccount } from "./oauth-credentials.js"
import { createGuardedFetch, createRealmSafeFetch } from "./url-guard.js"

type ExternalMcpMemberContext = { orgMembershipId: DenTypeId<"member"> }

const EXTERNAL_MCP_TEST_MAX_PAGES = 25
const EXTERNAL_MCP_TEST_MAX_TOOLS = 1_000
const EXTERNAL_MCP_TEST_MAX_TOOLS_PER_PAGE = 200
const EXTERNAL_MCP_TEST_TIMEOUT_MS = 40_000
const EXTERNAL_MCP_TEST_MAX_CLEANUP_RESERVE_MS = 50
const EXTERNAL_MCP_TEST_NETWORK_SETTLE_MS = 50
const EXTERNAL_MCP_TEST_MAX_RESPONSE_BYTES = 512 * 1024
const EXTERNAL_MCP_TEST_MAX_TOTAL_RESPONSE_BYTES = 2 * 1024 * 1024
const EXTERNAL_MCP_TEST_MAX_TOOL_NAME_CHARS = 256
const EXTERNAL_MCP_TEST_MAX_TOOL_NAME_BYTES = 1_024
const EXTERNAL_MCP_TEST_MAX_TOTAL_TOOL_NAME_BYTES = 128 * 1024
const EXTERNAL_MCP_TEST_MAX_CURSOR_CHARS = 2_048
const EXTERNAL_MCP_TEST_MAX_CURSOR_BYTES = 8 * 1024
const EXTERNAL_MCP_TEST_MAX_SERVER_INFO_CHARS = 256
const EXTERNAL_MCP_TEST_MAX_SERVER_INFO_BYTES = 1_024
const EXTERNAL_MCP_TEST_MAX_PROTOCOL_CHARS = 64

type DiagnosticJsonBounds = {
  maxDepth: number
  maxNodes: number
  maxObjectKeys: number
  maxArrayItems: number
  maxStringChars: number
  maxStringBytes: number
  maxTotalStringBytes: number
  maxSerializedBytes: number
}

const EXTERNAL_MCP_TEST_TOOL_BOUNDS: DiagnosticJsonBounds = {
  maxDepth: 20,
  maxNodes: 4_096,
  maxObjectKeys: 512,
  maxArrayItems: 1_024,
  maxStringChars: 16_384,
  maxStringBytes: 64 * 1024,
  maxTotalStringBytes: 160 * 1024,
  maxSerializedBytes: 192 * 1024,
}

const EXTERNAL_MCP_TEST_SCHEMA_BOUNDS: DiagnosticJsonBounds = {
  maxDepth: 16,
  maxNodes: 2_048,
  maxObjectKeys: 256,
  maxArrayItems: 512,
  maxStringChars: 8_192,
  maxStringBytes: 32 * 1024,
  maxTotalStringBytes: 96 * 1024,
  maxSerializedBytes: 128 * 1024,
}

export const EXTERNAL_MCP_CONNECTION_TEST_FAILURE_CODES = [
  "mcp_test_timeout",
  "mcp_initialize_failed",
  "mcp_reauth_required",
  "mcp_catalog_unavailable",
  "mcp_catalog_cursor_cycle",
  "mcp_catalog_duplicate_tool",
  "mcp_catalog_limit_exceeded",
  "mcp_response_limit_exceeded",
  "mcp_catalog_page_limit_exceeded",
  "mcp_catalog_item_limit_exceeded",
  "mcp_catalog_cursor_limit_exceeded",
  "mcp_catalog_tool_name_invalid",
] as const

export const EXTERNAL_MCP_CONNECTION_TEST_WARNING_CODES = [
  "empty_tool_catalog",
] as const

export type ExternalMcpConnectionTestWarningCode = typeof EXTERNAL_MCP_CONNECTION_TEST_WARNING_CODES[number]

export type ExternalMcpConnectionTestFailureCode = typeof EXTERNAL_MCP_CONNECTION_TEST_FAILURE_CODES[number]

export const EXTERNAL_MCP_CONNECTION_TEST_FAILURE_MESSAGES = {
  mcp_test_timeout: "The MCP connection test timed out.",
  mcp_initialize_failed: "The MCP server did not complete protocol initialization.",
  mcp_reauth_required: "The existing MCP credential was rejected. Reconnect this account, then test again.",
  mcp_catalog_unavailable: "The MCP server did not return a valid tool catalog.",
  mcp_catalog_cursor_cycle: "The MCP server repeated a tool-catalog pagination cursor.",
  mcp_catalog_duplicate_tool: "The MCP server returned duplicate tool names.",
  mcp_catalog_limit_exceeded: "The MCP tool catalog exceeded the diagnostic safety limit.",
  mcp_response_limit_exceeded: "An MCP response exceeded the diagnostic byte limit.",
  mcp_catalog_page_limit_exceeded: "An MCP tool-catalog page contained too many tools.",
  mcp_catalog_item_limit_exceeded: "An MCP tool-catalog item exceeded the diagnostic size or nesting limits.",
  mcp_catalog_cursor_limit_exceeded: "The MCP server returned an oversized pagination cursor.",
  mcp_catalog_tool_name_invalid: "The MCP server returned an invalid or oversized tool name.",
} as const satisfies Record<ExternalMcpConnectionTestFailureCode, string>

export class ExternalMcpConnectionTestFailure extends Error {
  readonly name = "ExternalMcpConnectionTestFailure"

  constructor(
    readonly testId: string,
    readonly code: ExternalMcpConnectionTestFailureCode,
  ) {
    super(EXTERNAL_MCP_CONNECTION_TEST_FAILURE_MESSAGES[code])
  }
}

function connectionTestFailure(
  testId: string,
  code: ExternalMcpConnectionTestFailureCode,
): ExternalMcpConnectionTestFailure {
  return new ExternalMcpConnectionTestFailure(testId, code)
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function assertBoundedText(input: {
  value: string
  maxChars: number
  maxBytes: number
  testId: string
  code: ExternalMcpConnectionTestFailureCode
  requireSafeName?: boolean
}): number {
  const bytes = utf8Bytes(input.value)
  const unsafeName = input.requireSafeName
    && (input.value.length === 0
      || input.value !== input.value.trim()
      || /[\u0000-\u001f\u007f]/u.test(input.value))
  if (unsafeName || input.value.length > input.maxChars || bytes > input.maxBytes) {
    throw connectionTestFailure(input.testId, input.code)
  }
  return bytes
}

function serializeBoundedDiagnosticJson(
  value: unknown,
  bounds: DiagnosticJsonBounds,
  testId: string,
): string {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new WeakSet<object>()
  let nodes = 0
  let totalStringBytes = 0

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    nodes += 1
    if (nodes > bounds.maxNodes || current.depth > bounds.maxDepth) {
      throw connectionTestFailure(testId, "mcp_catalog_item_limit_exceeded")
    }

    const item = current.value
    if (typeof item === "string") {
      const bytes = assertBoundedText({
        value: item,
        maxChars: bounds.maxStringChars,
        maxBytes: bounds.maxStringBytes,
        testId,
        code: "mcp_catalog_item_limit_exceeded",
      })
      totalStringBytes += bytes
      if (totalStringBytes > bounds.maxTotalStringBytes) {
        throw connectionTestFailure(testId, "mcp_catalog_item_limit_exceeded")
      }
      continue
    }
    if (item === null || typeof item === "boolean") continue
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw connectionTestFailure(testId, "mcp_catalog_item_limit_exceeded")
      continue
    }
    if (typeof item !== "object") {
      throw connectionTestFailure(testId, "mcp_catalog_item_limit_exceeded")
    }
    if (seen.has(item)) throw connectionTestFailure(testId, "mcp_catalog_item_limit_exceeded")
    seen.add(item)

    if (Array.isArray(item)) {
      if (item.length > bounds.maxArrayItems) {
        throw connectionTestFailure(testId, "mcp_catalog_item_limit_exceeded")
      }
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], depth: current.depth + 1 })
      }
      continue
    }

    const keys = Object.keys(item)
    if (keys.length > bounds.maxObjectKeys) {
      throw connectionTestFailure(testId, "mcp_catalog_item_limit_exceeded")
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]
      const keyBytes = assertBoundedText({
        value: key,
        maxChars: bounds.maxStringChars,
        maxBytes: bounds.maxStringBytes,
        testId,
        code: "mcp_catalog_item_limit_exceeded",
      })
      totalStringBytes += keyBytes
      if (totalStringBytes > bounds.maxTotalStringBytes) {
        throw connectionTestFailure(testId, "mcp_catalog_item_limit_exceeded")
      }
      stack.push({ value: (item as Record<string, unknown>)[key], depth: current.depth + 1 })
    }
  }

  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw connectionTestFailure(testId, "mcp_catalog_item_limit_exceeded")
  }
  if (utf8Bytes(serialized) > bounds.maxSerializedBytes) {
    throw connectionTestFailure(testId, "mcp_catalog_item_limit_exceeded")
  }
  return serialized
}

type ExternalMcpFetch = ReturnType<typeof createRealmSafeFetch>

type BoundedConnectionTestFetch = {
  fetch: ExternalMcpFetch
  cancelActiveResponses: (reason?: unknown) => Promise<void>
}

function forwardAbort(source: AbortSignal | null | undefined, target: AbortController): void {
  if (!source) return
  if (source.aborted) {
    abortLifecycle(target, source.reason)
    return
  }
  source.addEventListener("abort", () => abortLifecycle(target, source.reason), { once: true })
}

function copyResponseMetadata(target: Response, source: Response): void {
  for (const [property, value] of [
    ["url", source.url],
    ["redirected", source.redirected],
    ["type", source.type],
  ] as const) {
    try {
      Object.defineProperty(target, property, { value })
    } catch {
      // These metadata properties are advisory; the bounded body is authoritative.
    }
  }
}

function createBoundedConnectionTestFetch(testId: string, lifecycleSignal: AbortSignal): BoundedConnectionTestFetch {
  let totalResponseBytes = 0
  const activeCancellations = new Set<(reason?: unknown) => Promise<void>>()
  const requestControllers = new Set<AbortController>()
  const redirectSafeFetch = env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch()

  const fetch: ExternalMcpFetch = async (input, init) => {
    const requestController = new AbortController()
    requestControllers.add(requestController)
    forwardAbort(lifecycleSignal, requestController)
    forwardAbort(init?.signal, requestController)
    const response = await redirectSafeFetch(input, {
      ...init,
      signal: requestController.signal,
    })
    const remainingTotalBytes = EXTERNAL_MCP_TEST_MAX_TOTAL_RESPONSE_BYTES - totalResponseBytes
    const contentLengthHeader = response.headers.get("content-length")
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : Number.NaN
    if ((Number.isFinite(contentLength) && contentLength > EXTERNAL_MCP_TEST_MAX_RESPONSE_BYTES)
      || (Number.isFinite(contentLength) && contentLength > remainingTotalBytes)
      || remainingTotalBytes <= 0
    ) {
      await response.body?.cancel().catch(() => undefined)
      throw connectionTestFailure(testId, "mcp_response_limit_exceeded")
    }

    if (!response.body) {
      const bounded = new globalThis.Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      copyResponseMetadata(bounded, response)
      return bounded
    }

    const reader = response.body.getReader()
    let responseBytes = 0
    let finalized = false
    let cancellation: Promise<void> | undefined
    const finalize = () => {
      if (finalized) return
      finalized = true
      activeCancellations.delete(cancel)
      try {
        reader.releaseLock()
      } catch {
        // The underlying stream may already have released its reader.
      }
    }
    const cancel = (reason?: unknown): Promise<void> => {
      if (cancellation) return cancellation
      cancellation = reader.cancel(reason).catch(() => undefined).finally(finalize)
      return cancellation
    }
    activeCancellations.add(cancel)

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            finalize()
            controller.close()
            return
          }
          responseBytes += value.byteLength
          totalResponseBytes += value.byteLength
          if (responseBytes > EXTERNAL_MCP_TEST_MAX_RESPONSE_BYTES
            || totalResponseBytes > EXTERNAL_MCP_TEST_MAX_TOTAL_RESPONSE_BYTES
          ) {
            const failure = connectionTestFailure(testId, "mcp_response_limit_exceeded")
            await cancel(failure)
            controller.error(failure)
            return
          }
          controller.enqueue(value)
        } catch (error) {
          finalize()
          controller.error(error)
        }
      },
      cancel,
    })
    const bounded = new globalThis.Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    copyResponseMetadata(bounded, response)
    return bounded
  }

  return {
    fetch,
    async cancelActiveResponses(reason) {
      for (const controller of requestControllers) abortLifecycle(controller, reason)
      await Promise.allSettled([...activeCancellations].map((cancel) => cancel(reason)))
      requestControllers.clear()
    },
  }
}

function isTimeoutFailure(error: unknown, deadline: number): boolean {
  return Date.now() >= deadline
    || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
}

function sanitizeConnectionTestFailure(
  error: unknown,
  testId: string,
  stage: "initialize" | "catalog",
  deadline: number,
): ExternalMcpConnectionTestFailure {
  if (error instanceof ExternalMcpConnectionTestFailure) return error
  if (isTimeoutFailure(error, deadline)) return connectionTestFailure(testId, "mcp_test_timeout")
  if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
    return connectionTestFailure(testId, "mcp_reauth_required")
  }
  return connectionTestFailure(
    testId,
    stage === "initialize" ? "mcp_initialize_failed" : "mcp_catalog_unavailable",
  )
}

export function toExternalMcpConnectionTestFailure(error: unknown): ExternalMcpConnectionTestFailure {
  if (error instanceof ExternalMcpConnectionTestFailure) return error
  return connectionTestFailure(`mcp-test-${randomUUID()}`, "mcp_initialize_failed")
}

function connectionTestRequestOptions(deadline: number, testId: string): RequestOptions {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw connectionTestFailure(testId, "mcp_test_timeout")
  return { timeout: remaining, resetTimeoutOnProgress: false }
}

function abortLifecycle(controller: AbortController, reason: unknown): void {
  if (!controller.signal.aborted) controller.abort(reason)
}

async function waitForOperationOrAbort(operation: Promise<unknown>, signal: AbortSignal): Promise<void> {
  const settled = operation.then(() => undefined, () => undefined)
  if (signal.aborted) return
  await Promise.race([
    settled,
    new Promise<void>((resolveAbort) => signal.addEventListener("abort", () => resolveAbort(), { once: true })),
  ])
}

async function waitForOperationUntilDeadline(operation: Promise<unknown>, deadline: number): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation.then(() => undefined, () => undefined),
      new Promise<void>((resolveDeadline) => {
        timer = setTimeout(resolveDeadline, remaining)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function allowNetworkCancellationToSettle(deadline: number): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, Math.min(EXTERNAL_MCP_TEST_NETWORK_SETTLE_MS, remaining))
  })
}

async function terminateConnectionTestSession(
  transport: StreamableHTTPClientTransport | undefined,
  lifecycleController: AbortController,
  deadline: number,
  testId: string,
): Promise<void> {
  if (!transport?.sessionId || lifecycleController.signal.aborted) return
  const remaining = Math.min(2_000, deadline - Date.now())
  if (remaining <= 0) {
    abortLifecycle(lifecycleController, connectionTestFailure(testId, "mcp_test_timeout"))
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    timer = setTimeout(() => {
      abortLifecycle(lifecycleController, connectionTestFailure(testId, "mcp_test_timeout"))
    }, remaining)
    await waitForOperationOrAbort(transport.terminateSession(), lifecycleController.signal)
  } catch {
    // Teardown is best effort and never replaces the bounded diagnostic result.
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function closeConnectionTestClient(
  client: { close: () => Promise<void> },
  lifecycleController: AbortController,
  deadline: number,
  testId: string,
): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    abortLifecycle(lifecycleController, connectionTestFailure(testId, "mcp_test_timeout"))
  }
  try {
    await waitForOperationOrAbort(client.close(), lifecycleController.signal)
  } catch {
    // Closing is best effort and cannot replace the diagnostic's causal result.
  }
}

/**
 * Which member's credential this session should use, for connections with
 * credentialMode "per_member". Absent for "shared" connections (tokens live
 * on the connection row itself).
 */
async function buildConnectionTestTransport(
  connection: ExternalMcpConnectionRow,
  member: ExternalMcpMemberContext | undefined,
  fetch: ExternalMcpFetch,
): Promise<StreamableHTTPClientTransport> {
  let bearerToken: string | null = null
  if (connection.authType === "apikey") {
    bearerToken = connection.apiKey
  } else if (connection.authType === "oauth") {
    if (connection.credentialMode === "per_member") {
      if (!member) throw new Error(`Connection "${connection.id}" requires a member credential.`)
      const account = await getConnectedAccount({
        organizationId: connection.organizationId,
        orgMembershipId: member.orgMembershipId,
        providerId: connection.id,
      })
      bearerToken = account?.accessToken ?? null
    } else {
      bearerToken = connection.accessToken
    }
  }

  // Deliberately omit authProvider. A readiness test may consume an existing
  // bearer credential, but a 401/403 must never trigger discovery, DCR,
  // refresh persistence, authorization redirects, or PKCE verifier writes.
  return new StreamableHTTPClientTransport(new URL(connection.url), {
    fetch,
    requestInit: bearerToken ? { headers: { authorization: `Bearer ${bearerToken}` } } : undefined,
  })
}

function buildClient() {
  return new Client({ name: "openwork-den", version: "1.0.0" }, { capabilities: {} })
}

type ExternalMcpToolPage = Awaited<ReturnType<Client["listTools"]>>
export type ExternalMcpConnectionTestResult = {
  status: "ready" | "warning"
  warnings: ExternalMcpConnectionTestWarningCode[]
  testId: string
  protocolVersion: string
  transport: "streamable_http"
  sessionUsed: boolean
  serverName: string | null
  serverVersion: string | null
  toolPageCount: number
  toolCount: number
  toolNames: string[]
  catalogHash: string
  elapsedMs: number
}

export type ExternalMcpConnectionTestOptions = {
  /** Test-only/controlled caller override; production routes use the default. */
  timeoutMs?: number
}

/**
 * Performs a read-only lifecycle check with the connection's existing Den-owned
 * credential. It initializes the protocol and exhausts tools/list with bounded,
 * cycle-safe pagination. It never invokes a tool, so an arbitrary server cannot
 * turn the dashboard's "Test connection" action into a provider mutation.
 */
export async function testExternalMcpConnection(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  member?: ExternalMcpMemberContext,
  options?: ExternalMcpConnectionTestOptions,
): Promise<ExternalMcpConnectionTestResult> {
  const startedAt = Date.now()
  const requestedTimeout = options?.timeoutMs ?? EXTERNAL_MCP_TEST_TIMEOUT_MS
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(10, Math.min(requestedTimeout, EXTERNAL_MCP_TEST_TIMEOUT_MS))
    : EXTERNAL_MCP_TEST_TIMEOUT_MS
  const deadline = startedAt + timeoutMs
  const cleanupReserveMs = Math.min(EXTERNAL_MCP_TEST_MAX_CLEANUP_RESERVE_MS, Math.floor(timeoutMs / 3))
  const operationDeadline = deadline - cleanupReserveMs
  const testId = `mcp-test-${randomUUID()}`
  const lifecycleController = new AbortController()
  const deadlineTimer = setTimeout(() => {
    abortLifecycle(lifecycleController, connectionTestFailure(testId, "mcp_test_timeout"))
  }, Math.max(1, operationDeadline - Date.now()))
  const boundedFetch = createBoundedConnectionTestFetch(testId, lifecycleController.signal)
  const client = buildClient()
  let transport: StreamableHTTPClientTransport | undefined
  let stage: "initialize" | "catalog" = "initialize"
  try {
    transport = await buildConnectionTestTransport(
      connection,
      member,
      boundedFetch.fetch,
    )
    await client.connect(transport, connectionTestRequestOptions(deadline, testId))
    const protocolVersion = transport.protocolVersion ?? "unknown"
    assertBoundedText({
      value: protocolVersion,
      maxChars: EXTERNAL_MCP_TEST_MAX_PROTOCOL_CHARS,
      maxBytes: EXTERNAL_MCP_TEST_MAX_PROTOCOL_CHARS,
      testId,
      code: "mcp_initialize_failed",
    })
    const server = client.getServerVersion()
    for (const value of [server?.name, server?.version]) {
      if (value !== undefined) {
        assertBoundedText({
          value,
          maxChars: EXTERNAL_MCP_TEST_MAX_SERVER_INFO_CHARS,
          maxBytes: EXTERNAL_MCP_TEST_MAX_SERVER_INFO_BYTES,
          testId,
          code: "mcp_initialize_failed",
        })
      }
    }
    stage = "catalog"
    const toolNames: string[] = []
    const catalogEntries: Array<{ name: string; schemaHash: string }> = []
    const seenNames = new Set<string>()
    const seenCursorHashes = new Set<string>()
    let cursor: string | undefined
    let toolPageCount = 0
    let totalToolNameBytes = 0

    while (toolPageCount < EXTERNAL_MCP_TEST_MAX_PAGES) {
      const page = await client.listTools(cursor ? { cursor } : undefined, connectionTestRequestOptions(deadline, testId))
      toolPageCount += 1
      if (page.tools.length > EXTERNAL_MCP_TEST_MAX_TOOLS_PER_PAGE) {
        throw connectionTestFailure(testId, "mcp_catalog_page_limit_exceeded")
      }
      let nextCursorHash: string | undefined
      if (page.nextCursor) {
        assertBoundedText({
          value: page.nextCursor,
          maxChars: EXTERNAL_MCP_TEST_MAX_CURSOR_CHARS,
          maxBytes: EXTERNAL_MCP_TEST_MAX_CURSOR_BYTES,
          testId,
          code: "mcp_catalog_cursor_limit_exceeded",
        })
        nextCursorHash = createHash("sha256").update(page.nextCursor).digest("hex")
        if (seenCursorHashes.has(nextCursorHash)) {
          throw connectionTestFailure(testId, "mcp_catalog_cursor_cycle")
        }
      }
      for (const tool of page.tools) {
        serializeBoundedDiagnosticJson(tool, EXTERNAL_MCP_TEST_TOOL_BOUNDS, testId)
        const toolNameBytes = assertBoundedText({
          value: tool.name,
          maxChars: EXTERNAL_MCP_TEST_MAX_TOOL_NAME_CHARS,
          maxBytes: EXTERNAL_MCP_TEST_MAX_TOOL_NAME_BYTES,
          testId,
          code: "mcp_catalog_tool_name_invalid",
          requireSafeName: true,
        })
        totalToolNameBytes += toolNameBytes
        if (totalToolNameBytes > EXTERNAL_MCP_TEST_MAX_TOTAL_TOOL_NAME_BYTES) {
          throw connectionTestFailure(testId, "mcp_catalog_tool_name_invalid")
        }
        if (seenNames.has(tool.name)) {
          throw connectionTestFailure(testId, "mcp_catalog_duplicate_tool")
        }
        seenNames.add(tool.name)
        toolNames.push(tool.name)
        const schemaJson = serializeBoundedDiagnosticJson(tool.inputSchema, EXTERNAL_MCP_TEST_SCHEMA_BOUNDS, testId)
        const schemaHash = createHash("sha256").update(schemaJson).digest("hex")
        catalogEntries.push({ name: tool.name, schemaHash })
        if (toolNames.length > EXTERNAL_MCP_TEST_MAX_TOOLS) {
          throw connectionTestFailure(testId, "mcp_catalog_limit_exceeded")
        }
      }

      if (!page.nextCursor) {
        cursor = undefined
        break
      }
      if (!nextCursorHash) throw connectionTestFailure(testId, "mcp_catalog_cursor_limit_exceeded")
      seenCursorHashes.add(nextCursorHash)
      cursor = page.nextCursor
    }

    if (cursor) {
      throw connectionTestFailure(testId, "mcp_catalog_limit_exceeded")
    }

    catalogEntries.sort((left, right) => left.name.localeCompare(right.name))
    const catalogHash = `sha256:${createHash("sha256").update(JSON.stringify(catalogEntries)).digest("hex")}`
    const warnings: ExternalMcpConnectionTestWarningCode[] = toolNames.length === 0
      ? ["empty_tool_catalog"]
      : []
    return {
      status: warnings.length > 0 ? "warning" : "ready",
      warnings,
      testId,
      protocolVersion,
      transport: "streamable_http",
      sessionUsed: Boolean(transport.sessionId),
      serverName: server?.name ?? null,
      serverVersion: server?.version ?? null,
      toolPageCount,
      toolCount: toolNames.length,
      toolNames,
      catalogHash,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    throw sanitizeConnectionTestFailure(error, testId, stage, deadline)
  } finally {
    await terminateConnectionTestSession(transport, lifecycleController, operationDeadline, testId)
    await closeConnectionTestClient(client, lifecycleController, deadline, testId)
    const cancellation = boundedFetch.cancelActiveResponses(lifecycleController.signal.reason)
    await waitForOperationUntilDeadline(cancellation, deadline)
    await allowNetworkCancellationToSettle(deadline)
    abortLifecycle(lifecycleController, new DOMException("MCP diagnostic lifecycle complete.", "AbortError"))
    clearTimeout(deadlineTimer)
  }
}
