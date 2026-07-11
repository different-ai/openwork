import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { env } from "../env.js"
import { createGuardedFetch, createRealmSafeFetch } from "./url-guard.js"
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import {
  clearExternalMcpTokens,
  getExternalMcpConnection,
  saveExternalMcpPendingCodeVerifier,
  saveExternalMcpTokens,
} from "./external-mcp-connections.js"
import {
  deleteOrgOAuthClient,
  getConnectedAccount,
  getOrgOAuthClient,
  upsertConnectedAccount,
  upsertOrgOAuthClient,
} from "./oauth-credentials.js"
import {
  ExternalMcpDiagnosticError,
  ExternalMcpDiagnosticTracker,
  catalogDiagnosticError,
  createExternalMcpDiagnosticFetch,
  type ExternalMcpDiagnosticPhase,
  lifecycleDeadlineDiagnosticError,
  providerToolDiagnosticError,
} from "./external-mcp-diagnostics.js"

/**
 * Real MCP client for "add any MCP server" (External MCP Connections) —
 * as opposed to generic-oauth.ts, which only fits native providers with a
 * FIXED, admin-configured OAuth app (Google Workspace). Third-party MCP
 * servers (Notion, Linear, ...) don't have a pre-shared client_id: they
 * need RFC 9728 discovery + RFC 7591 dynamic client registration, which is
 * exactly what the MCP SDK's own OAuthClientProvider/auth() machinery
 * implements. This file is the one OAuthClientProvider implementation,
 * backed by our own tables, that every external connection uses.
 *
 * Dynamically-registered client info is stored in OrgOAuthClientTable
 * (providerId = the connection's own row id) — the same table used for
 * admin-configured native-provider clients, since the shape (client id +
 * optional secret + free-form extras) is identical either way.
 */

const CLIENT_NAME = "OpenWork"
const EXTERNAL_MCP_CALL_TIMEOUT_MS = 30_000
const EXTERNAL_MCP_LIFECYCLE_TIMEOUT_MS = 45_000
const EXTERNAL_MCP_TOOL_PAGE_LIMIT = 20
const EXTERNAL_MCP_TOOL_ITEM_LIMIT = 2_000
const EXTERNAL_MCP_TOOL_NAME_LIMIT_BYTES = 512
const EXTERNAL_MCP_TOOL_TITLE_LIMIT_BYTES = 4 * 1024
const EXTERNAL_MCP_TOOL_DESCRIPTION_LIMIT_BYTES = 64 * 1024
const EXTERNAL_MCP_TOOL_SCHEMA_LIMIT_BYTES = 512 * 1024
const EXTERNAL_MCP_TOOL_SCHEMA_DEPTH_LIMIT = 64
const EXTERNAL_MCP_CURSOR_LIMIT_BYTES = 16 * 1024
const EXTERNAL_MCP_CATALOG_LIMIT_BYTES = 8 * 1024 * 1024

export type ExternalMcpLifecycleDeadline = {
  expiresAt: number
  signal: AbortSignal
  abort: (reason?: unknown) => void
}

export function createExternalMcpLifecycleDeadline(
  timeoutMs = EXTERNAL_MCP_LIFECYCLE_TIMEOUT_MS,
): ExternalMcpLifecycleDeadline {
  const controller = new AbortController()
  return {
    expiresAt: Date.now() + Math.max(1, timeoutMs),
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
  }
}

function assertExternalMcpLifecycleActive(input: {
  deadline: ExternalMcpLifecycleDeadline
  diagnostic: ExternalMcpDiagnosticTracker
  phase: ExternalMcpDiagnosticPhase
}): void {
  if (!input.deadline.signal.aborted && Date.now() < input.deadline.expiresAt) return
  const reason = input.deadline.signal.reason
  if (reason instanceof ExternalMcpDiagnosticError) throw reason
  const error = lifecycleDeadlineDiagnosticError({ tracker: input.diagnostic, phase: input.phase })
  if (!input.deadline.signal.aborted) input.deadline.abort(error)
  throw error
}

/**
 * The MCP SDK owns OAuth discovery, registration, refresh, and finishAuth
 * fetches. finishAuth accepts no RequestOptions, so bind the transport fetch
 * itself to the lifecycle signal instead of relying on the outer promise race.
 */
export function bindExternalMcpFetchToLifecycle(
  baseFetch: (url: string | URL, init?: RequestInit) => Promise<Response>,
  deadline: ExternalMcpLifecycleDeadline,
  diagnostic: ExternalMcpDiagnosticTracker,
) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    assertExternalMcpLifecycleActive({ deadline, diagnostic, phase: diagnostic.activePhase })
    const signal = init?.signal
      ? AbortSignal.any([init.signal, deadline.signal])
      : deadline.signal
    return baseFetch(url, { ...init, signal })
  }
}

export async function runExternalMcpRequestWithinDeadline<T>(input: {
  deadline: ExternalMcpLifecycleDeadline
  diagnostic: ExternalMcpDiagnosticTracker
  phase: ExternalMcpDiagnosticPhase
  operation: (options: RequestOptions) => Promise<T>
}): Promise<T> {
  input.diagnostic.begin(input.phase)
  const remaining = Math.floor(input.deadline.expiresAt - Date.now())
  assertExternalMcpLifecycleActive({ deadline: input.deadline, diagnostic: input.diagnostic, phase: input.phase })

  const controller = new AbortController()
  const options: RequestOptions = {
    signal: AbortSignal.any([controller.signal, input.deadline.signal]),
    timeout: Math.max(1, Math.min(EXTERNAL_MCP_CALL_TIMEOUT_MS, remaining)),
    maxTotalTimeout: remaining,
    resetTimeoutOnProgress: false,
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const error = lifecycleDeadlineDiagnosticError({
        tracker: input.diagnostic,
        phase: input.diagnostic.activePhase,
      })
      input.deadline.abort(error)
      controller.abort(error)
      reject(error)
    }, remaining)
    void Promise.resolve().then(() => input.operation(options)).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
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
export type ExternalMcpMemberContext = {
  orgMembershipId: DenTypeId<"member">
}

export class ExternalMcpOAuthProvider implements OAuthClientProvider {
  private connection: ExternalMcpConnectionRow
  private readonly redirectUri: string
  private readonly signedState?: string
  private readonly member?: ExternalMcpMemberContext
  private readonly diagnostic: ExternalMcpDiagnosticTracker
  private readonly lifecycleDeadline?: ExternalMcpLifecycleDeadline
  /** Captured by redirectToAuthorization so the HTTP route can hand it back to the admin's browser instead of actually redirecting anything server-side. */
  lastAuthorizeUrl: string | null = null

  constructor(
    connection: ExternalMcpConnectionRow,
    redirectUri: string,
    signedState: string | undefined,
    member: ExternalMcpMemberContext | undefined,
    diagnostic: ExternalMcpDiagnosticTracker,
    lifecycleDeadline?: ExternalMcpLifecycleDeadline,
  ) {
    this.connection = connection
    this.redirectUri = redirectUri
    this.signedState = signedState
    this.member = member
    this.diagnostic = diagnostic
    this.lifecycleDeadline = lifecycleDeadline
    if (connection.credentialMode === "per_member" && connection.authType === "oauth" && !member) {
      throw new Error(`Connection "${connection.id}" uses per-member credentials; a member context is required.`)
    }
  }

  private get isPerMember(): boolean {
    return this.connection.credentialMode === "per_member"
  }

  private async memberAccount() {
    if (!this.member) return null
    return getConnectedAccount({
      organizationId: this.connection.organizationId,
      orgMembershipId: this.member.orgMembershipId,
      providerId: this.connection.id,
    })
  }

  private assertLifecycleActive(phase: ExternalMcpDiagnosticPhase): void {
    if (!this.lifecycleDeadline) return
    assertExternalMcpLifecycleActive({ deadline: this.lifecycleDeadline, diagnostic: this.diagnostic, phase })
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  /**
   * The SDK includes whatever this returns as the standard OAuth `state`
   * param, and — critically — every spec-compliant authorization server
   * (real or our stand-in) echoes `state` back verbatim on redirect. Our
   * own signed state token (which encodes which connection this is for)
   * MUST travel as this standard param, not a custom one: a custom param
   * would simply be dropped by any real server, since only `state` is
   * required to be preserved.
   */
  state(): string {
    // Only reached when a fresh authorize URL is actually being built (i.e.
    // connect/start, which always supplies signedState); this fallback only
    // exists to satisfy the type when connect() is attempted opportunistically
    // with an existing valid token and no authorization step is needed.
    return this.signedState ?? randomUUID()
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUri],
      client_name: CLIENT_NAME,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
    const client = await getOrgOAuthClient(this.connection.organizationId, this.connection.id)
    this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
    if (!client) return undefined
    this.diagnostic.passed("AUTH_CLIENT_REGISTRATION", "reachable")
    const extra = (client.extra ?? {}) as { clientInformation?: OAuthClientInformationFull }
    if (extra.clientInformation) return extra.clientInformation
    return { client_id: client.clientId, client_secret: client.clientSecret ?? undefined }
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.assertLifecycleActive("AUTH_CLIENT_REGISTRATION")
    await upsertOrgOAuthClient({
      organizationId: this.connection.organizationId,
      providerId: this.connection.id,
      clientId: clientInformation.client_id,
      clientSecret: clientInformation.client_secret ?? null,
      extra: { clientInformation },
      createdByOrgMembershipId: this.connection.createdByOrgMembershipId,
    })
    this.diagnostic.passed("AUTH_CLIENT_REGISTRATION", "reachable")
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    this.assertLifecycleActive("CONTINUITY_REFRESH")
    if (this.isPerMember) {
      const account = await this.memberAccount()
      this.assertLifecycleActive("CONTINUITY_REFRESH")
      if (!account?.accessToken) return undefined
      return {
        access_token: account.accessToken,
        token_type: account.tokenType ?? "Bearer",
        refresh_token: account.refreshToken ?? undefined,
        scope: account.scopes?.join(" ") ?? undefined,
      }
    }
    if (!this.connection.accessToken) return undefined
    return {
      access_token: this.connection.accessToken,
      token_type: this.connection.tokenType ?? "Bearer",
      refresh_token: this.connection.refreshToken ?? undefined,
      scope: this.connection.scope ?? undefined,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null
    if (this.isPerMember && this.member) {
      const existing = await this.memberAccount()
      this.assertLifecycleActive(this.diagnostic.activePhase === "CONTINUITY_REFRESH" ? "CONTINUITY_REFRESH" : "AUTH_TOKEN_ACQUISITION")
      await upsertConnectedAccount({
        organizationId: this.connection.organizationId,
        orgMembershipId: this.member.orgMembershipId,
        providerId: this.connection.id,
        accessToken: tokens.access_token,
        // Most providers omit refresh_token on refresh responses; keep the existing one.
        refreshToken: tokens.refresh_token ?? existing?.refreshToken ?? null,
        tokenType: tokens.token_type ?? null,
        scopes: tokens.scope ? tokens.scope.split(" ") : null,
        expiresAt,
        pendingCodeVerifier: null,
      })
      this.diagnostic.passed("AUTH_TOKEN_ACQUISITION")
      return
    }
    this.assertLifecycleActive(this.diagnostic.activePhase === "CONTINUITY_REFRESH" ? "CONTINUITY_REFRESH" : "AUTH_TOKEN_ACQUISITION")
    await saveExternalMcpTokens({
      connectionId: this.connection.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? this.connection.refreshToken ?? null,
      tokenType: tokens.token_type ?? null,
      scope: tokens.scope ?? null,
      expiresAt,
    })
    // Refresh the in-memory row so a subsequent tokens()/refresh in the same
    // connection attempt sees the just-saved values.
    const refreshed = await getExternalMcpConnection({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
    })
    if (refreshed) this.connection = refreshed
    this.diagnostic.passed("AUTH_TOKEN_ACQUISITION")
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") {
      await deleteOrgOAuthClient(this.connection.organizationId, this.connection.id)
    }
    if (scope === "all" || scope === "tokens") {
      if (this.isPerMember && this.member) {
        await upsertConnectedAccount({
          organizationId: this.connection.organizationId,
          orgMembershipId: this.member.orgMembershipId,
          providerId: this.connection.id,
          accessToken: null,
          refreshToken: null,
          tokenType: null,
          scopes: null,
          expiresAt: null,
          ...(scope === "all" ? { pendingCodeVerifier: null } : {}),
        })
      } else {
        await clearExternalMcpTokens({
          organizationId: this.connection.organizationId,
          connectionId: this.connection.id,
        })
        const refreshed = await getExternalMcpConnection({
          organizationId: this.connection.organizationId,
          connectionId: this.connection.id,
        })
        if (refreshed) this.connection = refreshed
      }
    }
    if ((scope === "all" || scope === "verifier") && !this.isPerMember) {
      await saveExternalMcpPendingCodeVerifier({ connectionId: this.connection.id, codeVerifier: null })
    }
    if (scope === "verifier" && this.isPerMember && this.member) {
      await upsertConnectedAccount({
        organizationId: this.connection.organizationId,
        orgMembershipId: this.member.orgMembershipId,
        providerId: this.connection.id,
        pendingCodeVerifier: null,
      })
    }
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizeUrl = authorizationUrl.toString()
    this.diagnostic.begin("AUTH_USER_OR_WORKLOAD")
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.assertLifecycleActive("AUTH_USER_OR_WORKLOAD")
    if (this.isPerMember && this.member) {
      await upsertConnectedAccount({
        organizationId: this.connection.organizationId,
        orgMembershipId: this.member.orgMembershipId,
        providerId: this.connection.id,
        pendingCodeVerifier: codeVerifier,
      })
      return
    }
    await saveExternalMcpPendingCodeVerifier({ connectionId: this.connection.id, codeVerifier })
  }

  async codeVerifier(): Promise<string> {
    this.assertLifecycleActive("AUTH_TOKEN_ACQUISITION")
    if (this.isPerMember) {
      const account = await this.memberAccount()
      this.assertLifecycleActive("AUTH_TOKEN_ACQUISITION")
      if (!account?.pendingCodeVerifier) {
        throw new Error("No pending PKCE code verifier for this member on this external MCP connection.")
      }
      return account.pendingCodeVerifier
    }
    if (!this.connection.pendingCodeVerifier) {
      throw new Error("No pending PKCE code verifier for this external MCP connection.")
    }
    return this.connection.pendingCodeVerifier
  }
}

function buildTransport(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  signedState?: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
  lifecycleDeadline?: ExternalMcpLifecycleDeadline,
) {
  const diagnostic = new ExternalMcpDiagnosticTracker(diagnosticReferenceId ?? randomUUID(), {
    authType: connection.authType,
    credentialMode: connection.credentialMode,
  })
  const provider = connection.authType === "oauth"
    ? new ExternalMcpOAuthProvider(connection, redirectUri, signedState, member, diagnostic, lifecycleDeadline)
    : undefined
  const guardedFetch = env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch()
  const lifecycleFetch = lifecycleDeadline
    ? bindExternalMcpFetchToLifecycle(guardedFetch, lifecycleDeadline, diagnostic)
    : guardedFetch
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    authProvider: provider,
    // SSRF guard: every outbound request (the MCP endpoint itself, but also
    // discovery documents and token endpoints the SDK follows to OTHER
    // hosts) is checked against private/reserved address ranges at request
    // time. Hosted-deployment protection; self-hosted/dev opt out via env.
    fetch: createExternalMcpDiagnosticFetch({ fetch: lifecycleFetch, endpoint: connection.url, tracker: diagnostic }),
    requestInit: connection.authType === "apikey" && connection.apiKey
      ? { headers: { authorization: `Bearer ${connection.apiKey}` } }
      : undefined,
  })
  return { transport, provider, diagnostic }
}

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

type SerializedMeasurement =
  | { ok: true; bytes: number }
  | { ok: false; reason: "size" | "depth" | "cycle" }

function serializedStringBytes(value: string): number {
  return utf8Bytes(JSON.stringify(value))
}

function measureSerializedJson(
  value: unknown,
  byteLimit: number,
  depthLimit: number,
): SerializedMeasurement {
  type Frame =
    | { kind: "value"; value: unknown; depth: number }
    | { kind: "leave"; value: object }
  const stack: Frame[] = [{ kind: "value", value, depth: 0 }]
  const active = new WeakSet<object>()
  let bytes = 0
  const add = (amount: number): boolean => {
    bytes += amount
    return bytes <= byteLimit
  }

  while (stack.length > 0) {
    const frame = stack.pop()
    if (!frame) break
    if (frame.kind === "leave") {
      active.delete(frame.value)
      continue
    }
    if (frame.depth > depthLimit) return { ok: false, reason: "depth" }
    const current = frame.value
    if (current === null) {
      if (!add(4)) return { ok: false, reason: "size" }
      continue
    }
    if (typeof current === "string") {
      // Two quote bytes plus the UTF-8 payload. Escaping can only make the
      // serialized value larger, so account for the exact JSON string when
      // it contains characters that need escaping.
      const serialized = JSON.stringify(current)
      if (!add(utf8Bytes(serialized))) return { ok: false, reason: "size" }
      continue
    }
    if (typeof current === "number" || typeof current === "boolean") {
      if (!add(utf8Bytes(JSON.stringify(current)))) return { ok: false, reason: "size" }
      continue
    }
    if (typeof current !== "object") {
      if (!add(4)) return { ok: false, reason: "size" }
      continue
    }
    if (active.has(current)) return { ok: false, reason: "cycle" }
    active.add(current)
    stack.push({ kind: "leave", value: current })

    if (Array.isArray(current)) {
      if (!add(2 + Math.max(0, current.length - 1))) return { ok: false, reason: "size" }
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "value", value: current[index], depth: frame.depth + 1 })
      }
      continue
    }

    const entries = Object.entries(current)
    if (!add(2 + Math.max(0, entries.length - 1))) return { ok: false, reason: "size" }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!
      if (!add(utf8Bytes(JSON.stringify(key)) + 1)) return { ok: false, reason: "size" }
      stack.push({ kind: "value", value: child, depth: frame.depth + 1 })
    }
  }
  return { ok: true, bytes }
}

function fieldLimitError(input: {
  diagnostic: ExternalMcpDiagnosticTracker
  code: "MCP_CATALOG_TOOL_NAME_LIMIT" | "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT" | "MCP_CATALOG_TOOL_TITLE_LIMIT"
  field: string
  limit: number
}): ExternalMcpDiagnosticError {
  return catalogDiagnosticError({
    tracker: input.diagnostic,
    code: input.code,
    operatorAction: `Reduce each serialized tool ${input.field} below ${input.limit} UTF-8 bytes.`,
  })
}

function validateToolCatalogField(input: {
  diagnostic: ExternalMcpDiagnosticTracker
  value: string | undefined
  limit: number
  field: string
  code: "MCP_CATALOG_TOOL_NAME_LIMIT" | "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT" | "MCP_CATALOG_TOOL_TITLE_LIMIT"
}): void {
  if (input.value !== undefined && serializedStringBytes(input.value) > input.limit) {
    throw fieldLimitError(input)
  }
}

function validateToolSchema(input: {
  diagnostic: ExternalMcpDiagnosticTracker
  schema: unknown
}): void {
  const measurement = measureSerializedJson(
    input.schema,
    EXTERNAL_MCP_TOOL_SCHEMA_LIMIT_BYTES,
    EXTERNAL_MCP_TOOL_SCHEMA_DEPTH_LIMIT,
  )
  if (measurement.ok) return
  const code = measurement.reason === "depth"
    ? "MCP_CATALOG_SCHEMA_DEPTH_LIMIT"
    : measurement.reason === "cycle"
      ? "MCP_CATALOG_SCHEMA_CYCLE"
      : "MCP_CATALOG_SCHEMA_SIZE_LIMIT"
  const operatorAction = measurement.reason === "depth"
    ? `Flatten each tool schema below ${EXTERNAL_MCP_TOOL_SCHEMA_DEPTH_LIMIT} nested levels.`
    : measurement.reason === "cycle"
      ? "Return JSON-serializable, acyclic tool schemas."
      : `Reduce each serialized tool schema below ${EXTERNAL_MCP_TOOL_SCHEMA_LIMIT_BYTES} bytes.`
  throw catalogDiagnosticError({ tracker: input.diagnostic, code, operatorAction })
}

function measureCatalogTool(input: {
  diagnostic: ExternalMcpDiagnosticTracker
  tool: ExternalMcpToolPage["tools"][number]
  remainingBytes: number
}): number {
  validateToolCatalogField({
    diagnostic: input.diagnostic,
    value: input.tool.name,
    field: "name",
    limit: EXTERNAL_MCP_TOOL_NAME_LIMIT_BYTES,
    code: "MCP_CATALOG_TOOL_NAME_LIMIT",
  })
  validateToolCatalogField({
    diagnostic: input.diagnostic,
    value: input.tool.title,
    field: "title",
    limit: EXTERNAL_MCP_TOOL_TITLE_LIMIT_BYTES,
    code: "MCP_CATALOG_TOOL_TITLE_LIMIT",
  })
  validateToolCatalogField({
    diagnostic: input.diagnostic,
    value: input.tool.description,
    field: "description",
    limit: EXTERNAL_MCP_TOOL_DESCRIPTION_LIMIT_BYTES,
    code: "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT",
  })
  validateToolSchema({ diagnostic: input.diagnostic, schema: input.tool.inputSchema })
  if (input.tool.outputSchema !== undefined) {
    validateToolSchema({ diagnostic: input.diagnostic, schema: input.tool.outputSchema })
  }

  const measurement = measureSerializedJson(
    input.tool,
    Math.max(0, input.remainingBytes),
    EXTERNAL_MCP_TOOL_SCHEMA_DEPTH_LIMIT + 4,
  )
  if (!measurement.ok) {
    throw catalogDiagnosticError({
      tracker: input.diagnostic,
      code: "MCP_CATALOG_BYTE_LIMIT",
      operatorAction: `Reduce the complete serialized tool catalog below ${EXTERNAL_MCP_CATALOG_LIMIT_BYTES} bytes.`,
    })
  }
  return measurement.bytes
}

export async function collectExternalMcpToolPages(input: {
  listPage: (cursor: string | undefined, options: RequestOptions) => Promise<ExternalMcpToolPage>
  diagnostic: ExternalMcpDiagnosticTracker
  pageLimit?: number
  itemLimit?: number
  deadline?: ExternalMcpLifecycleDeadline
}): Promise<ExternalMcpToolPage["tools"]> {
  const pageLimit = input.pageLimit ?? EXTERNAL_MCP_TOOL_PAGE_LIMIT
  const itemLimit = input.itemLimit ?? EXTERNAL_MCP_TOOL_ITEM_LIMIT
  const deadline = input.deadline ?? createExternalMcpLifecycleDeadline()
  const tools: ExternalMcpToolPage["tools"] = []
  const seenCursors = new Set<string>()
  const seenToolNames = new Set<string>()
  let catalogBytes = 0
  let cursor: string | undefined
  for (let page = 0; page < pageLimit; page += 1) {
    input.diagnostic.begin("MCP_TOOL_DISCOVERY")
    const result = await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic: input.diagnostic,
      phase: "MCP_TOOL_DISCOVERY",
      operation: (options) => input.listPage(cursor, options),
    })
    if (tools.length + result.tools.length > itemLimit) {
      throw catalogDiagnosticError({
        tracker: input.diagnostic,
        code: "MCP_CATALOG_ITEM_LIMIT",
        operatorAction: `Reduce the provider catalog below ${itemLimit} tools or use a scoped MCP server.`,
      })
    }
    for (const tool of result.tools) {
      catalogBytes += measureCatalogTool({
        diagnostic: input.diagnostic,
        tool,
        remainingBytes: EXTERNAL_MCP_CATALOG_LIMIT_BYTES - catalogBytes,
      })
      if (seenToolNames.has(tool.name)) {
        throw catalogDiagnosticError({
          tracker: input.diagnostic,
          code: "MCP_CATALOG_DUPLICATE_TOOL",
          operatorAction: "Ensure every tools/list page uses a unique, stable tool name.",
        })
      }
      seenToolNames.add(tool.name)
      tools.push(tool)
    }
    if (!result.nextCursor) {
      input.diagnostic.passed("MCP_TOOL_DISCOVERY", "catalog_ready")
      return tools
    }
    if (serializedStringBytes(result.nextCursor) > EXTERNAL_MCP_CURSOR_LIMIT_BYTES) {
      throw catalogDiagnosticError({
        tracker: input.diagnostic,
        code: "MCP_CATALOG_CURSOR_SIZE_LIMIT",
        operatorAction: `Reduce each serialized tools/list cursor below ${EXTERNAL_MCP_CURSOR_LIMIT_BYTES} UTF-8 bytes.`,
      })
    }
    const cursorMeasurement = measureSerializedJson(
      result.nextCursor,
      EXTERNAL_MCP_CATALOG_LIMIT_BYTES - catalogBytes,
      1,
    )
    if (!cursorMeasurement.ok) {
      throw catalogDiagnosticError({
        tracker: input.diagnostic,
        code: "MCP_CATALOG_BYTE_LIMIT",
        operatorAction: `Reduce the complete serialized tool catalog below ${EXTERNAL_MCP_CATALOG_LIMIT_BYTES} bytes.`,
      })
    }
    catalogBytes += cursorMeasurement.bytes
    if (seenCursors.has(result.nextCursor)) {
      throw catalogDiagnosticError({
        tracker: input.diagnostic,
        code: "MCP_CATALOG_CURSOR_LOOP",
        operatorAction: "Fix the provider's tools/list pagination so each nextCursor advances.",
      })
    }
    seenCursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw catalogDiagnosticError({
    tracker: input.diagnostic,
    code: "MCP_CATALOG_PAGE_LIMIT",
    operatorAction: `Reduce the provider catalog to at most ${pageLimit} pages or use a scoped MCP server.`,
  })
}

export type ExternalMcpConnectResult =
  | { status: "connected" }
  | { status: "needs_auth"; authorizeUrl: string }

/**
 * Attempts to connect. For authType "none"/"apikey" this either succeeds or
 * throws. For "oauth", if there's no valid token yet, the SDK's transport
 * drives discovery (+ dynamic client registration if needed) and returns the
 * authorize URL to send the admin's browser to — no token exchange happens
 * yet, that's connect/callback's job. `signedState` (our own signed token
 * identifying which connection this is for) is passed through as the
 * standard OAuth `state` param, since that's the only param guaranteed to
 * round-trip back to connect/callback on any spec-compliant server.
 */
export async function connectExternalMcp(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  signedState?: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
): Promise<ExternalMcpConnectResult> {
  const client = buildClient()
  const deadline = createExternalMcpLifecycleDeadline()
  const { transport, provider, diagnostic } = buildTransport(
    connection,
    redirectUri,
    signedState,
    member,
    diagnosticReferenceId,
    deadline,
  )
  let result: ExternalMcpConnectResult | undefined
  let primaryError: unknown
  try {
    await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic,
      phase: "MCP_INITIALIZE",
      operation: (options) => client.connect(transport, options),
    })
    diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
    result = { status: "connected" }
  } catch (error) {
    if (error instanceof UnauthorizedError && provider?.lastAuthorizeUrl) {
      diagnostic.begin("AUTH_USER_OR_WORKLOAD")
      result = { status: "needs_auth", authorizeUrl: provider.lastAuthorizeUrl }
    } else {
      // Freeze the causal phase before close() can perform any additional
      // transport work and move the tracker to another lifecycle phase.
      primaryError = diagnostic.error(error)
    }
  } finally {
    try {
      await client.close()
    } catch (error) {
      // Never replace the causal handshake error. A close failure after a
      // successful connection is its own lifecycle diagnostic; closing an
      // unauthenticated transport is best-effort but still always attempted.
      if (!primaryError && result?.status === "connected") {
        primaryError = diagnostic.error(error, "SHUTDOWN")
      }
    }
  }
  if (primaryError) throw diagnostic.error(primaryError)
  if (!result) throw diagnostic.error(new Error("MCP connection ended without a result."), "MCP_INITIALIZE")
  return result
}

/** Completes the OAuth code exchange after the browser is redirected back with `code`. For per-member connections, `member` (from the signed state token) decides whose account the tokens are saved against. */
export async function runExternalMcpAuthCompletionLifecycle(input: {
  diagnostic: ExternalMcpDiagnosticTracker
  finishAuth: () => Promise<void>
  validateMcp: (options?: RequestOptions) => Promise<void>
  invalidateTokens: () => Promise<void>
  close: () => Promise<void>
  deadline?: ExternalMcpLifecycleDeadline
}): Promise<void> {
  const deadline = input.deadline ?? createExternalMcpLifecycleDeadline()
  input.diagnostic.begin("AUTH_TOKEN_ACQUISITION")
  let exchangedTokens = false
  let primaryError: ExternalMcpDiagnosticError | null = null
  try {
    await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic: input.diagnostic,
      phase: "AUTH_TOKEN_ACQUISITION",
      operation: () => input.finishAuth(),
    })
    exchangedTokens = true
    input.diagnostic.passed("AUTH_TOKEN_ACQUISITION")
    await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic: input.diagnostic,
      phase: "MCP_INITIALIZE",
      operation: (options) => input.validateMcp(options),
    })
    input.diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
  } catch (error) {
    primaryError = input.diagnostic.error(error, exchangedTokens ? "MCP_INITIALIZE" : "AUTH_TOKEN_ACQUISITION")
    if (exchangedTokens) {
      try {
        await input.invalidateTokens()
      } catch {
        // Cleanup must not replace the causal validation diagnostic.
      }
    }
  } finally {
    try {
      await input.close()
    } catch (error) {
      if (!primaryError) primaryError = input.diagnostic.error(error, "SHUTDOWN")
    }
  }
  if (primaryError) throw primaryError
}

export async function completeExternalMcpAuth(
  connection: ExternalMcpConnectionRow,
  code: string,
  redirectUri: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
): Promise<void> {
  const client = buildClient()
  const deadline = createExternalMcpLifecycleDeadline()
  const { transport, provider, diagnostic } = buildTransport(
    connection,
    redirectUri,
    undefined,
    member,
    diagnosticReferenceId,
    deadline,
  )
  await runExternalMcpAuthCompletionLifecycle({
    diagnostic,
    finishAuth: () => transport.finishAuth(code),
    // A token response alone does not prove audience, tenant, scopes, or MCP
    // readiness. Initialize with the newly stored credential before success.
    validateMcp: (options) => client.connect(transport, options),
    invalidateTokens: () => provider?.invalidateCredentials?.("tokens") ?? Promise.resolve(),
    close: () => client.close(),
    deadline,
  })
}

export async function listExternalMcpTools(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
  lifecycleDeadline?: ExternalMcpLifecycleDeadline,
) {
  const client = buildClient()
  const deadline = lifecycleDeadline ?? createExternalMcpLifecycleDeadline()
  const { transport, diagnostic } = buildTransport(
    connection,
    redirectUri,
    undefined,
    member,
    diagnosticReferenceId,
    deadline,
  )
  let operationError: unknown
  try {
    await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic,
      phase: "MCP_INITIALIZE",
      operation: (options) => client.connect(transport, options),
    })
    diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
    return await collectExternalMcpToolPages({
      diagnostic,
      deadline,
      listPage: (cursor, options) => client.listTools(cursor ? { cursor } : undefined, options),
    })
  } catch (error) {
    operationError = error
    throw diagnostic.error(error)
  } finally {
    try {
      await client.close()
    } catch (error) {
      if (!operationError) throw diagnostic.error(error, "SHUTDOWN")
    }
  }
}

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

export async function callExternalMcpTool(input: {
  connection: ExternalMcpConnectionRow
  redirectUri: string
  toolName: string
  args: Record<string, unknown>
  member?: ExternalMcpMemberContext
  diagnosticReferenceId?: string
}) {
  const client = buildClient()
  const deadline = createExternalMcpLifecycleDeadline()
  const { transport, diagnostic } = buildTransport(
    input.connection,
    input.redirectUri,
    undefined,
    input.member,
    input.diagnosticReferenceId,
    deadline,
  )
  let operationError: unknown
  try {
    await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic,
      phase: "MCP_INITIALIZE",
      operation: (options) => client.connect(transport, options),
    })
    diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
    diagnostic.begin("MCP_TOOL_EXECUTION")
    const result = await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic,
      phase: "MCP_TOOL_EXECUTION",
      operation: (options) => client.callTool({ name: input.toolName, arguments: input.args }, undefined, options),
    })
    if (result.isError) {
      throw providerToolDiagnosticError({ tracker: diagnostic })
    }
    diagnostic.passed("PROVIDER_EXECUTION", "operation_ready")
    return result
  } catch (error) {
    operationError = error
    throw diagnostic.error(error)
  } finally {
    try {
      await client.close()
    } catch (error) {
      if (!operationError) throw diagnostic.error(error, "SHUTDOWN")
    }
  }
}
