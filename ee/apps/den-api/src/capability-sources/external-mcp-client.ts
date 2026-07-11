import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"
import { env } from "../env.js"
import { assertPublicUrl, createGuardedFetch, createRealmSafeFetch, PrivateUrlError } from "./url-guard.js"
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type {
  McpDiagnosticAttemptStatus,
  McpDiagnosticActionOwner,
  McpDiagnosticEventOutcome,
  McpDiagnosticHealthLevel,
  McpDiagnosticPhase,
  McpDiagnosticSafeEvidence,
} from "@openwork/types/den/mcp-diagnostics"
import type { ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import {
  clearExternalMcpTokens,
  getExternalMcpOAuthPendingGrantBinding,
  getExternalMcpOAuthPendingGrantForCallback,
  getExternalMcpConnection,
  saveExternalMcpOAuthPendingGrant,
  saveExternalMcpCallbackTokens,
  saveExternalMcpTokens,
} from "./external-mcp-connections.js"
import {
  getConnectedAccount,
  getOrClaimExternalMcpClientRegistration,
  getOrgOAuthClient,
  getOrgOAuthClientRevision,
  saveExternalMcpRegisteredClient,
  type OrgOAuthClientRow,
  upsertConnectedAccount,
} from "./oauth-credentials.js"
import { safeMcpDiagnosticEvidence } from "./external-mcp-live-diagnostics.js"
import {
  ExternalMcpDiagnosticError as StructuredExternalMcpDiagnosticError,
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
const EXTERNAL_MCP_CLOSE_TIMEOUT_MS = 5_000
const DIAGNOSTIC_FETCH_TIMEOUT_MS = 30_000
const DIAGNOSTIC_MAX_TOOL_PAGES = 20
const DIAGNOSTIC_MAX_TOOLS = 2_000
const DIAGNOSTIC_TOOL_NAME_LIMIT_BYTES = 512
const DIAGNOSTIC_TOOL_TITLE_LIMIT_BYTES = 4 * 1024
const DIAGNOSTIC_TOOL_DESCRIPTION_LIMIT_BYTES = 64 * 1024
const DIAGNOSTIC_TOOL_SCHEMA_LIMIT_BYTES = 512 * 1024
const DIAGNOSTIC_SCHEMA_DEPTH_LIMIT = 64
const DIAGNOSTIC_SCHEMA_NODE_LIMIT = 20_000
const DIAGNOSTIC_SCHEMA_KEY_LIMIT = 20_000
const DIAGNOSTIC_SCHEMA_ARRAY_ITEM_LIMIT = 20_000
const DIAGNOSTIC_SCHEMA_STRING_LIMIT_BYTES = 64 * 1024
const DIAGNOSTIC_SCHEMA_KEY_LIMIT_BYTES = 4 * 1024
const DIAGNOSTIC_CURSOR_LIMIT_BYTES = 16 * 1024
const DIAGNOSTIC_CATALOG_LIMIT_BYTES = 8 * 1024 * 1024
export const EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024
export const EXTERNAL_MCP_SSE_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024
const DIAGNOSTIC_PROTOCOL_VERSIONS = new Set(SUPPORTED_PROTOCOL_VERSIONS)

export class ExternalMcpLifecycleDeadlineError extends Error {
  readonly code = "MCP_LIFECYCLE_DEADLINE"
  constructor() {
    super("The external MCP lifecycle exceeded its deadline.")
    this.name = "ExternalMcpLifecycleDeadlineError"
  }
}

export type ExternalMcpLifecycleDeadline = {
  expiresAt: number
  signal: AbortSignal
  abort: (reason?: unknown) => void
}

export function createExternalMcpLifecycleDeadline(timeoutMs = EXTERNAL_MCP_LIFECYCLE_TIMEOUT_MS): ExternalMcpLifecycleDeadline {
  const controller = new AbortController()
  return {
    expiresAt: Date.now() + Math.max(1, timeoutMs),
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
  }
}

function externalMcpLifecycleDeadlineError(
  deadline: ExternalMcpLifecycleDeadline,
): ExternalMcpLifecycleDeadlineError | StructuredExternalMcpDiagnosticError {
  const reason = deadline.signal.reason
  return reason instanceof ExternalMcpLifecycleDeadlineError || reason instanceof StructuredExternalMcpDiagnosticError
    ? reason
    : new ExternalMcpLifecycleDeadlineError()
}

function assertExternalMcpLifecycleActive(deadline: ExternalMcpLifecycleDeadline): void {
  if (!deadline.signal.aborted && Date.now() < deadline.expiresAt) return
  const error = externalMcpLifecycleDeadlineError(deadline)
  if (!deadline.signal.aborted) deadline.abort(error)
  throw error
}

/**
 * Binds SDK-owned fetches (notably finishAuth(), which accepts no RequestOptions)
 * to the same absolute lifecycle deadline as the outer operation. The caller's
 * signal is preserved so transport shutdown and the lifecycle deadline can both
 * cancel discovery, token exchange, and response streaming.
 */
export function bindExternalMcpFetchToLifecycle(
  baseFetch: (url: string | URL, init?: RequestInit) => Promise<Response>,
  deadline: ExternalMcpLifecycleDeadline,
) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    assertExternalMcpLifecycleActive(deadline)
    const signal = init?.signal
      ? AbortSignal.any([init.signal, deadline.signal])
      : deadline.signal
    return baseFetch(url, { ...init, signal })
  }
}

class ExternalMcpCloseTimeoutError extends Error {
  readonly code = "MCP_CLOSE_TIMEOUT"
  constructor() {
    super("The external MCP client did not close before its deadline.")
    this.name = "ExternalMcpCloseTimeoutError"
  }
}

class ExternalMcpResponseBodyLimitError extends Error {
  readonly code = "MCP_RESPONSE_BODY_LIMIT"
  constructor() {
    super("The external MCP response exceeded its byte limit.")
    this.name = "ExternalMcpResponseBodyLimitError"
  }
}

class ExternalMcpCatalogLimitError extends Error {
  readonly code: string
  constructor(code: string) {
    super("The external MCP tool catalog exceeded a safety limit.")
    this.name = "ExternalMcpCatalogLimitError"
    this.code = code
  }
}

export async function runExternalMcpRequestWithinDeadline<T>(input: {
  deadline: ExternalMcpLifecycleDeadline
  operation: (options: RequestOptions) => Promise<T>
  diagnostic?: ExternalMcpDiagnosticTracker
  phase?: ExternalMcpDiagnosticPhase
}): Promise<T> {
  const phase = input.phase ?? input.diagnostic?.activePhase ?? "MCP_INITIALIZE"
  input.diagnostic?.begin(phase)
  const deadlineError = () => {
    const reason = input.deadline.signal.reason
    if (reason instanceof StructuredExternalMcpDiagnosticError) return reason
    return input.diagnostic
      ? lifecycleDeadlineDiagnosticError({ tracker: input.diagnostic, phase })
      : externalMcpLifecycleDeadlineError(input.deadline)
  }
  const remaining = Math.floor(input.deadline.expiresAt - Date.now())
  if (remaining <= 0 || input.deadline.signal.aborted) {
    const error = deadlineError()
    if (!input.deadline.signal.aborted) input.deadline.abort(error)
    throw error
  }
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
      const error = deadlineError()
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

async function boundedExternalMcpClose(close: () => Promise<void>, timeoutMs = EXTERNAL_MCP_CLOSE_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExternalMcpCloseTimeoutError()), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runExternalMcpLifecycleWithClose<T>(input: {
  operation: () => Promise<T>
  close: () => Promise<void>
  closeTimeoutMs?: number
}): Promise<T> {
  let result: T | undefined
  let primaryError: unknown
  try {
    result = await input.operation()
  } catch (error) {
    primaryError = error
  } finally {
    try {
      await boundedExternalMcpClose(input.close, input.closeTimeoutMs)
    } catch (error) {
      if (primaryError === undefined) primaryError = error
    }
  }
  if (primaryError !== undefined) throw primaryError
  return result as T
}

/**
 * Small injectable lifecycle used by regression tests and support probes. The
 * production callback below uses the fenced provider, but this keeps the
 * structured deadline/no-late-write contract independently testable.
 */
export async function runExternalMcpAuthCompletionLifecycle(input: {
  diagnostic: ExternalMcpDiagnosticTracker
  finishAuth: () => Promise<void>
  validateMcp: (options?: RequestOptions) => Promise<void>
  invalidateTokens: () => Promise<void>
  close: () => Promise<void>
  deadline?: ExternalMcpLifecycleDeadline
}): Promise<void> {
  const deadline = input.deadline ?? createExternalMcpLifecycleDeadline()
  let exchangedTokens = false
  let primaryError: StructuredExternalMcpDiagnosticError | null = null
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
    primaryError = error instanceof StructuredExternalMcpDiagnosticError
      ? error
      : input.diagnostic.error(error, exchangedTokens ? "MCP_INITIALIZE" : "AUTH_TOKEN_ACQUISITION")
    if (exchangedTokens) await input.invalidateTokens().catch(() => undefined)
  } finally {
    try {
      await boundedExternalMcpClose(input.close)
    } catch (error) {
      if (!primaryError) primaryError = input.diagnostic.error(error, "SHUTDOWN")
    }
  }
  if (primaryError) throw primaryError
}

export type ExternalMcpDiagnosticSignal = {
  phase: McpDiagnosticPhase
  outcome: McpDiagnosticEventOutcome
  healthLevel: McpDiagnosticHealthLevel
  messageSafe: string
  phaseDurationMs?: number | null
  category?: string | null
  retryable?: boolean | null
  actionOwner?: McpDiagnosticActionOwner | null
  operatorAction?: string | null
  evidence?: McpDiagnosticSafeEvidence
  attemptStatus?: McpDiagnosticAttemptStatus
}

export type ExternalMcpDiagnosticObserver = (signal: ExternalMcpDiagnosticSignal) => Promise<void>

export class ExternalMcpDiagnosticError extends Error {
  readonly phase: McpDiagnosticPhase
  readonly evidence?: McpDiagnosticSafeEvidence
  readonly http?: ExternalMcpHttpDiagnostic

  constructor(
    phase: McpDiagnosticPhase,
    cause: unknown,
    evidence?: McpDiagnosticSafeEvidence,
    http?: ExternalMcpHttpDiagnostic,
  ) {
    super("The external MCP diagnostic failed.", { cause })
    this.name = "ExternalMcpDiagnosticError"
    this.phase = phase
    this.evidence = evidence
    this.http = http
  }
}

export type ExternalMcpHttpDiagnostic = {
  phase: McpDiagnosticPhase
  status: number
  hadAuthorization: boolean
  bearerChallenge: boolean
  invalidToken: boolean
  insufficientScope: boolean
}

export class ExternalMcpHttpStatusError extends Error {
  readonly status: number
  readonly http: ExternalMcpHttpDiagnostic

  constructor(http: ExternalMcpHttpDiagnostic) {
    super(`The MCP endpoint returned HTTP ${http.status}.`)
    this.name = "ExternalMcpHttpStatusError"
    this.status = http.status
    this.http = http
  }
}

export type DiagnosticContext = {
  connectionUrl: string
  networkPassed: boolean
  routingPassed?: boolean
  lastPhase: McpDiagnosticPhase
  lastEvidence: McpDiagnosticSafeEvidence
  lastHttp?: ExternalMcpHttpDiagnostic
  observing: boolean
  observe: ExternalMcpDiagnosticObserver
}

async function observe(context: DiagnosticContext | undefined, signal: ExternalMcpDiagnosticSignal): Promise<void> {
  if (context) await context.observe(signal)
}

function requestBodyText(body: BodyInit | null | undefined): string | null {
  return typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : null
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return init?.headers ? new Headers(init.headers).get(name) : null
}

function jsonRpcMethod(body: string | null): string | null {
  if (!body || Buffer.byteLength(body, "utf8") > 64 * 1024) return null
  try {
    const value: unknown = JSON.parse(body)
    return typeof value === "object" && value !== null && "method" in value && typeof value.method === "string"
      ? value.method
      : null
  } catch {
    return null
  }
}

export function classifyExternalMcpRequestPhase(
  url: URL,
  init: RequestInit | undefined,
  connectionUrl: string,
): McpDiagnosticPhase {
  if (url.pathname.includes("oauth-protected-resource")) return "AUTH_RESOURCE_DISCOVERY"
  if (url.pathname.includes("oauth-authorization-server") || url.pathname.includes("openid-configuration")) return "AUTH_ISSUER_DISCOVERY"

  const body = requestBodyText(init?.body)
  const contentType = requestHeader(init, "content-type")?.toLowerCase() ?? ""
  if (contentType.includes("application/x-www-form-urlencoded") && body) {
    const grantType = new URLSearchParams(body).get("grant_type")
    return grantType === "refresh_token" ? "CONTINUITY_REFRESH" : "AUTH_TOKEN_ACQUISITION"
  }
  if (contentType.includes("application/json") && body) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (
        typeof parsed === "object"
        && parsed !== null
        && "redirect_uris" in parsed
        && "client_name" in parsed
      ) return "AUTH_CLIENT_REGISTRATION"
    } catch {
      // A malformed body is classified by the consumer, never substring-matched.
    }
  }

  const endpoint = new URL(connectionUrl)
  if (url.origin === endpoint.origin && url.pathname === endpoint.pathname) {
    const method = jsonRpcMethod(body)
    if (method === "initialize") return "MCP_INITIALIZE"
    if (method === "notifications/initialized") return "MCP_INITIALIZED"
    if (method === "tools/list") return "MCP_TOOL_DISCOVERY"
    if (method === "tools/call") return "MCP_TOOL_EXECUTION"
    return "MCP_TRANSPORT"
  }
  return "HTTP_ROUTING"
}

function nestedErrorCode(error: unknown, depth = 0): string | null {
  if (typeof error !== "object" || error === null || depth > 6) return null
  if ("code" in error && typeof error.code === "string") return error.code
  return "cause" in error ? nestedErrorCode(error.cause, depth + 1) : null
}

function nestedErrorName(error: unknown, depth = 0): string | null {
  if (typeof error !== "object" || error === null || depth > 6) return null
  if ("name" in error && typeof error.name === "string") return error.name
  return "cause" in error ? nestedErrorName(error.cause, depth + 1) : null
}

function nestedErrorText(error: unknown, depth = 0): string {
  if (typeof error !== "object" || error === null || depth > 6) return ""
  const message = "message" in error && typeof error.message === "string" ? error.message.toLowerCase() : ""
  const cause = "cause" in error ? nestedErrorText(error.cause, depth + 1) : ""
  return `${message} ${cause}`.trim()
}

function initializeFailurePhase(error: unknown, fallback: McpDiagnosticPhase): McpDiagnosticPhase {
  const text = nestedErrorText(error)
  if (text.includes("protocol version") || text.includes("unsupported version")) return "MCP_VERSION"
  return fallback === "HTTP_ROUTING" ? "MCP_INITIALIZE" : fallback
}

function diagnosticPhaseAfterSdkFailure(error: unknown, context: DiagnosticContext): McpDiagnosticPhase {
  const http = context.lastHttp
  if (http?.phase.startsWith("MCP_") && http.status === 404) return "HTTP_ROUTING"
  if (http?.phase.startsWith("MCP_") && http.status === 405) return "MCP_TRANSPORT"
  return initializeFailurePhase(error, context.lastPhase)
}

export function externalMcpNetworkFailureProof(error: unknown): {
  phase: McpDiagnosticPhase | null
  passed: McpDiagnosticPhase[]
} {
  if (error instanceof PrivateUrlError || nestedErrorName(error) === "PrivateUrlError") {
    return { phase: "CONFIGURATION", passed: [] }
  }
  const code = nestedErrorCode(error)
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { phase: "NETWORK_DNS", passed: [] }
  if (code && [
    "CERT_HAS_EXPIRED",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  ].includes(code)) return { phase: "NETWORK_TLS", passed: ["NETWORK_DNS", "NETWORK_TCP"] }
  if (code && ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    return { phase: "NETWORK_TCP", passed: ["NETWORK_DNS"] }
  }
  if (code === "ETIMEDOUT" && nestedErrorText(error).includes("connect")) {
    return { phase: "NETWORK_TCP", passed: ["NETWORK_DNS"] }
  }
  // TimeoutError, AbortError, redirect rejections, parser failures, and
  // unrecognized fetch failures do not prove any lower network layer.
  return { phase: null, passed: [] }
}

function timedRequestInit(init: RequestInit | undefined): RequestInit {
  const timeoutSignal = AbortSignal.timeout(DIAGNOSTIC_FETCH_TIMEOUT_MS)
  const callerSignal = init?.signal
  return {
    ...init,
    signal: callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal,
  }
}

export async function assertSafeMcpAuthorizationUrl(rawUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new PrivateUrlError(rawUrl, "the authorization URL is invalid")
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw new PrivateUrlError(rawUrl, "the authorization URL scheme or authority is unsafe")
  }
  if (!env.allowPrivateMcpUrls) {
    if (parsed.protocol !== "https:") {
      throw new PrivateUrlError(rawUrl, "hosted authorization URLs must use HTTPS")
    }
    await assertPublicUrl(rawUrl)
  }
}

function responseBodyLimit(contentType: string): number {
  return contentType === "text/event-stream"
    ? EXTERNAL_MCP_SSE_RESPONSE_LIMIT_BYTES
    : EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES
}

function preserveResponseMetadata(target: Response, source: Response): void {
  for (const key of ["url", "redirected", "type"] as const) {
    try {
      Object.defineProperty(target, key, { configurable: true, value: source[key] })
    } catch {
      // Status, headers, and the bounded body are protocol-relevant.
    }
  }
}

function cancelExternalMcpResponseBody(response: Response, reason: unknown): Promise<void> {
  if (!response.body) return Promise.resolve()
  try {
    return response.body.cancel(reason).catch(() => undefined)
  } catch {
    return Promise.resolve()
  }
}

export function boundExternalMcpResponse(response: Response): Response {
  if (!response.body) return response
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? ""
  const limit = responseBodyLimit(contentType)
  const advertised = response.headers.get("content-length")
  if (advertised && /^\d+$/.test(advertised)) {
    const length = Number(advertised)
    if (Number.isSafeInteger(length) && length > limit) {
      const error = new ExternalMcpResponseBodyLimitError()
      void cancelExternalMcpResponseBody(response, error)
      throw error
    }
  }

  const reader = response.body.getReader()
  let bytesRead = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          controller.close()
          return
        }
        bytesRead += next.value.byteLength
        if (bytesRead > limit) {
          const error = new ExternalMcpResponseBodyLimitError()
          await reader.cancel(error).catch(() => undefined)
          controller.error(error)
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  const bounded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  preserveResponseMetadata(bounded, response)
  return bounded
}

export function observedFetch(baseFetch: (url: string | URL, init?: RequestInit) => Promise<Response>, context: DiagnosticContext) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (!context.observing) return baseFetch(input, init)
    const url = input instanceof URL ? input : new URL(input)
    const phase = classifyExternalMcpRequestPhase(url, init, context.connectionUrl)
    context.lastPhase = phase
    context.lastHttp = undefined
    const method = init?.method ?? "GET"
    context.lastEvidence = safeMcpDiagnosticEvidence({ url, method })
    const startedAt = Date.now()
    if (!context.networkPassed) {
      await observe(context, {
        phase: "NETWORK_DNS",
        outcome: "running",
        healthLevel: "configured",
        messageSafe: "Resolving the MCP destination from the Den server.",
        evidence: safeMcpDiagnosticEvidence({ url }),
      })
    }
    if (!context.routingPassed && phase !== "HTTP_ROUTING") {
      await observe(context, {
        phase: "HTTP_ROUTING",
        outcome: "running",
        healthLevel: context.networkPassed ? "reachable" : "configured",
        messageSafe: "Checking the configured MCP endpoint route.",
        evidence: safeMcpDiagnosticEvidence({ url, method }),
      })
    }
    await observe(context, {
      phase,
      outcome: "running",
      healthLevel: context.networkPassed ? "reachable" : "configured",
      messageSafe: phase === "HTTP_ROUTING" ? "Checking the configured MCP endpoint." : "Checking this handshake phase.",
      evidence: safeMcpDiagnosticEvidence({ url, method: init?.method ?? "GET" }),
    })

    let response: Response
    try {
      response = await baseFetch(input, timedRequestInit(init))
    } catch (error) {
      const proof = externalMcpNetworkFailureProof(error)
      if (proof.passed.includes("NETWORK_DNS")) {
        await observe(context, {
          phase: "NETWORK_DNS",
          outcome: "passed",
          healthLevel: "configured",
          messageSafe: "The completed connection attempt confirms that DNS resolution succeeded.",
          evidence: safeMcpDiagnosticEvidence({ url }),
        })
      }
      if (proof.passed.includes("NETWORK_TCP")) {
        await observe(context, {
          phase: "NETWORK_TCP",
          outcome: "passed",
          healthLevel: "configured",
          messageSafe: "The TLS attempt confirms that Den opened a TCP connection to the provider.",
          evidence: safeMcpDiagnosticEvidence({ url }),
        })
      }
      throw new ExternalMcpDiagnosticError(proof.phase ?? phase, error, context.lastEvidence)
    }

    const duration = Date.now() - startedAt
    const responseEvidence = safeMcpDiagnosticEvidence({
      url,
      method,
      status: response.status,
      contentType: response.headers.get("content-type"),
    })
    context.lastEvidence = responseEvidence
    const challenge = response.headers.get("www-authenticate") ?? ""
    const http: ExternalMcpHttpDiagnostic = {
      phase,
      status: response.status,
      hadAuthorization: Boolean(requestHeader(init, "authorization")),
      bearerChallenge: /\bbearer\b/i.test(challenge),
      invalidToken: /\binvalid_token\b/i.test(challenge),
      insufficientScope: /\binsufficient_scope\b/i.test(challenge),
    }
    if (!response.ok) context.lastHttp = http
    if (!context.networkPassed) {
      context.networkPassed = true
      await observe(context, {
        phase: "NETWORK_DNS",
        outcome: "passed",
        healthLevel: "configured",
        messageSafe: "The completed HTTP exchange confirms that DNS resolution succeeded.",
        evidence: safeMcpDiagnosticEvidence({ url }),
      })
      await observe(context, {
        phase: "NETWORK_TCP",
        outcome: "passed",
        healthLevel: "configured",
        messageSafe: "The completed HTTP exchange confirms that Den established a network connection.",
        evidence: safeMcpDiagnosticEvidence({ url }),
      })
      await observe(context, {
        phase: "NETWORK_TLS",
        outcome: url.protocol === "https:" ? "passed" : "skipped",
        healthLevel: "configured",
        messageSafe: url.protocol === "https:"
          ? "The completed HTTPS exchange confirms that Den accepted the provider TLS connection."
          : "TLS is not used by this development endpoint.",
        evidence: safeMcpDiagnosticEvidence({ url }),
      })
    }
    if (!context.routingPassed && response.status !== 404) {
      context.routingPassed = true
      if (phase !== "HTTP_ROUTING") {
        await observe(context, {
          phase: "HTTP_ROUTING",
          outcome: "passed",
          healthLevel: "reachable",
          messageSafe: "The request reached the configured MCP endpoint route.",
          phaseDurationMs: duration,
          evidence: responseEvidence,
        })
      }
    }

    if (!response.ok) {
      // The MCP SDK is the protocol state machine. It must receive every
      // bounded HTTP response so it can perform discovery fallbacks, parse
      // OAuth errors, refresh/upscope and retry, and accept optional GET 405.
      // If recovery is exhausted, the enclosing lifecycle wraps the SDK error
      // with this request's typed, redacted context for final classification.
      await observe(context, {
        phase,
        outcome: "running",
        healthLevel: "reachable",
        messageSafe: phase === "AUTH_RESOURCE_DISCOVERY" || phase === "AUTH_ISSUER_DISCOVERY"
          ? "This metadata candidate was not accepted; continuing the standards-based discovery fallback."
          : phase.startsWith("MCP_") && (response.status === 401 || http.insufficientScope)
            ? "The MCP SDK is evaluating this authentication challenge and any bounded recovery."
            : "The MCP SDK is evaluating this OAuth response.",
        phaseDurationMs: duration,
        evidence: responseEvidence,
      })
    }

    if (response.ok) {
      if (phase === "HTTP_ROUTING") context.routingPassed = true
      await observe(context, {
        phase,
        outcome: "passed",
        healthLevel: "reachable",
        messageSafe: phase === "HTTP_ROUTING"
          ? "The request reached the configured MCP endpoint."
          : "The provider accepted this handshake request.",
        phaseDurationMs: duration,
        evidence: responseEvidence,
      })
    }
    try {
      return boundExternalMcpResponse(response)
    } catch (error) {
      throw new ExternalMcpDiagnosticError(phase, error, responseEvidence, http)
    }
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

export type ExternalMcpDiagnosticAuthorization = {
  attemptId: DenTypeId<"mcpDiagnosticAttempt">
  generation: number
}

export type ExternalMcpDiagnosticCredentialFence = ExternalMcpDiagnosticAuthorization & {
  leaseId: string
}

function clientInformationFromRow(client: OrgOAuthClientRow): OAuthClientInformationMixed {
  const extra = (client.extra ?? {}) as { clientInformation?: Record<string, unknown> }
  return {
    ...(extra.clientInformation ?? {}),
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    token_endpoint_auth_method: typeof extra.clientInformation?.token_endpoint_auth_method === "string"
      ? extra.clientInformation.token_endpoint_auth_method
      : client.clientSecret ? "client_secret_post" : "none",
  } as OAuthClientInformationMixed
}

function safeClientInformationExtra(clientInformation: OAuthClientInformationMixed): Record<string, unknown> {
  const source = clientInformation as unknown as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  for (const key of [
    "client_id_issued_at",
    "client_secret_expires_at",
    "token_endpoint_auth_method",
  ]) {
    const value = source[key]
    if (typeof value === "string" || typeof value === "number") safe[key] = value
  }
  return { clientInformation: safe }
}

export class ExternalMcpOAuthProvider implements OAuthClientProvider {
  private connection: ExternalMcpConnectionRow
  private readonly redirectUri: string
  private readonly stateValue: string
  private readonly member?: ExternalMcpMemberContext
  private readonly diagnosticAuthorization?: ExternalMcpDiagnosticAuthorization
  private readonly credentialFence?: ExternalMcpDiagnosticCredentialFence
  private readonly authorizationCallback: boolean
  private readonly lifecycleDeadline?: ExternalMcpLifecycleDeadline
  private activeClient: OrgOAuthClientRow | null = null
  private callbackGrant: Awaited<ReturnType<typeof getExternalMcpOAuthPendingGrantForCallback>> | null = null
  private tokensInvalidatedForLifecycle = false
  /** Captured by redirectToAuthorization so the HTTP route can hand it back to the admin's browser instead of actually redirecting anything server-side. */
  lastAuthorizeUrl: string | null = null

  constructor(
    connection: ExternalMcpConnectionRow,
    redirectUri: string,
    signedState?: string,
    member?: ExternalMcpMemberContext,
    diagnosticAuthorization?: ExternalMcpDiagnosticAuthorization,
    credentialFence?: ExternalMcpDiagnosticCredentialFence,
    authorizationCallback = false,
    lifecycleDeadline?: ExternalMcpLifecycleDeadline,
  ) {
    this.connection = connection
    this.redirectUri = redirectUri
    this.stateValue = signedState ?? randomUUID()
    this.member = member
    this.diagnosticAuthorization = diagnosticAuthorization
    this.credentialFence = credentialFence
    this.authorizationCallback = authorizationCallback
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

  private assertLifecycleActive(): void {
    if (this.lifecycleDeadline) assertExternalMcpLifecycleActive(this.lifecycleDeadline)
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
    return this.stateValue
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
    this.assertLifecycleActive()
    if (this.callbackGrant) {
      const client = await getOrgOAuthClientRevision({
        organizationId: this.connection.organizationId,
        providerId: this.connection.id,
        clientId: this.callbackGrant.orgOAuthClientId,
        revision: this.callbackGrant.clientRevision,
      })
      this.assertLifecycleActive()
      if (!client) throw new Error("The MCP OAuth client registration changed after authorization started.")
      this.activeClient = client
      return clientInformationFromRow(client)
    }
    if (this.authorizationCallback) {
      const binding = await getExternalMcpOAuthPendingGrantBinding({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        orgMembershipId: this.isPerMember && this.member ? this.member.orgMembershipId : null,
        signedState: this.stateValue,
        diagnosticAttemptId: this.diagnosticAuthorization?.attemptId ?? null,
        diagnosticGeneration: this.diagnosticAuthorization?.generation ?? null,
      })
      this.assertLifecycleActive()
      const client = await getOrgOAuthClientRevision({
        organizationId: this.connection.organizationId,
        providerId: this.connection.id,
        clientId: binding.orgOAuthClientId,
        revision: binding.clientRevision,
      })
      this.assertLifecycleActive()
      if (!client) throw new Error("The MCP OAuth client registration changed after authorization started.")
      this.activeClient = client
      return clientInformationFromRow(client)
    }
    if (this.activeClient) return clientInformationFromRow(this.activeClient)
    const registration = await getOrClaimExternalMcpClientRegistration({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
      signedState: this.stateValue,
    })
    this.assertLifecycleActive()
    if (registration.status === "claimed") return undefined
    this.activeClient = registration.client
    return clientInformationFromRow(registration.client)
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.assertLifecycleActive()
    this.activeClient = await saveExternalMcpRegisteredClient({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
      signedState: this.stateValue,
      clientId: clientInformation.client_id,
      clientSecret: clientInformation.client_secret ?? null,
      safeExtra: safeClientInformationExtra(clientInformation),
      createdByOrgMembershipId: this.connection.createdByOrgMembershipId,
    })
    this.assertLifecycleActive()
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    this.assertLifecycleActive()
    if (this.tokensInvalidatedForLifecycle) return undefined
    if (this.isPerMember) {
      const account = await this.memberAccount()
      this.assertLifecycleActive()
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
    this.assertLifecycleActive()
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null
    if (this.authorizationCallback) {
      if (!this.callbackGrant) {
        throw new Error("The pending MCP OAuth authorization was not loaded before token persistence.")
      }
      if (this.lifecycleDeadline) assertExternalMcpLifecycleActive(this.lifecycleDeadline)
      await saveExternalMcpCallbackTokens({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        orgMembershipId: this.isPerMember && this.member ? this.member.orgMembershipId : null,
        orgOAuthClientId: this.callbackGrant.orgOAuthClientId,
        clientRevision: this.callbackGrant.clientRevision,
        diagnosticFence: this.credentialFence,
        pendingGrant: {
          signedState: this.stateValue,
          diagnosticAttemptId: this.callbackGrant.diagnosticAttemptId,
          diagnosticGeneration: this.callbackGrant.diagnosticGeneration,
        },
        lifecycleDeadlineAt: this.lifecycleDeadline ? new Date(this.lifecycleDeadline.expiresAt) : undefined,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        tokenType: tokens.token_type ?? null,
        scope: tokens.scope ?? null,
        expiresAt,
      })
      this.assertLifecycleActive()
      if (!this.isPerMember) {
        const refreshed = await getExternalMcpConnection({
          organizationId: this.connection.organizationId,
          connectionId: this.connection.id,
        })
        this.assertLifecycleActive()
        if (refreshed) this.connection = refreshed
      }
      this.tokensInvalidatedForLifecycle = false
      return
    }
    if (this.isPerMember && this.member) {
      const existing = await this.memberAccount()
      this.assertLifecycleActive()
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
      this.assertLifecycleActive()
      this.tokensInvalidatedForLifecycle = false
      return
    }
    await saveExternalMcpTokens({
      connectionId: this.connection.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? this.connection.refreshToken ?? null,
      tokenType: tokens.token_type ?? null,
      scope: tokens.scope ?? null,
      expiresAt,
    })
    this.assertLifecycleActive()
    // Refresh the in-memory row so a subsequent tokens()/refresh in the same
    // connection attempt sees the just-saved values.
    const refreshed = await getExternalMcpConnection({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
    })
    this.assertLifecycleActive()
    if (refreshed) this.connection = refreshed
    this.tokensInvalidatedForLifecycle = false
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope !== "tokens" && scope !== "all") return
    // InvalidGrant recovery must not retry a revoked refresh token in this or
    // the next lifecycle. Clear both the in-memory view and Den-owned durable
    // credential while leaving the fenced replacement path atomic.
    this.tokensInvalidatedForLifecycle = true
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

  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizeUrl = authorizationUrl.toString()
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.assertLifecycleActive()
    const client = this.activeClient ?? await getOrgOAuthClient(this.connection.organizationId, this.connection.id)
    this.assertLifecycleActive()
    if (!client) throw new Error("The MCP OAuth client registration is missing before PKCE persistence.")
    await saveExternalMcpOAuthPendingGrant({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
      orgMembershipId: this.isPerMember && this.member ? this.member.orgMembershipId : null,
      signedState: this.stateValue,
      codeVerifier,
      orgOAuthClientId: client.id,
      clientRevision: client.revision,
      diagnosticAttemptId: this.diagnosticAuthorization?.attemptId ?? null,
      diagnosticGeneration: this.diagnosticAuthorization?.generation ?? null,
    })
    this.assertLifecycleActive()
  }

  async codeVerifier(): Promise<string> {
    if (this.lifecycleDeadline) assertExternalMcpLifecycleActive(this.lifecycleDeadline)
    this.callbackGrant = await getExternalMcpOAuthPendingGrantForCallback({
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
      orgMembershipId: this.isPerMember && this.member ? this.member.orgMembershipId : null,
      signedState: this.stateValue,
      diagnosticAttemptId: this.diagnosticAuthorization?.attemptId ?? null,
      diagnosticGeneration: this.diagnosticAuthorization?.generation ?? null,
    })
    if (this.lifecycleDeadline) assertExternalMcpLifecycleActive(this.lifecycleDeadline)
    return this.callbackGrant.codeVerifier
  }
}

function buildTransport(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  signedState?: string,
  member?: ExternalMcpMemberContext,
  diagnosticContext?: DiagnosticContext,
  diagnosticAuthorization?: ExternalMcpDiagnosticAuthorization,
  credentialFence?: ExternalMcpDiagnosticCredentialFence,
  authorizationCallback = false,
  lifecycleDeadline?: ExternalMcpLifecycleDeadline,
  structuredDiagnostic?: ExternalMcpDiagnosticTracker,
) {
  const provider = connection.authType === "oauth"
    ? new ExternalMcpOAuthProvider(
        connection,
        redirectUri,
        signedState,
        member,
        diagnosticAuthorization,
        credentialFence,
        authorizationCallback,
        lifecycleDeadline,
      )
    : undefined
  const guardedFetch = env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch()
  const baseFetch = lifecycleDeadline
    ? bindExternalMcpFetchToLifecycle(guardedFetch, lifecycleDeadline)
    : guardedFetch
  const observed = diagnosticContext ? observedFetch(baseFetch, diagnosticContext) : baseFetch
  const instrumentedFetch = structuredDiagnostic
    ? createExternalMcpDiagnosticFetch({ fetch: observed, endpoint: connection.url, tracker: structuredDiagnostic })
    : observed
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    authProvider: provider,
    // SSRF guard: every outbound request (the MCP endpoint itself, but also
    // discovery documents and token endpoints the SDK follows to OTHER
    // hosts) is checked against private/reserved address ranges at request
    // time. Hosted-deployment protection; self-hosted/dev opt out via env.
    fetch: instrumentedFetch,
    requestInit: connection.authType === "apikey" && connection.apiKey
      ? { headers: { authorization: `Bearer ${connection.apiKey}` } }
      : undefined,
  })
  return { transport, provider }
}

function buildClient() {
  return new Client({ name: "openwork-den", version: "1.0.0" }, { capabilities: {} })
}

type ExternalMcpToolPage = Awaited<ReturnType<Client["listTools"]>>
type SerializedMeasurement =
  | { ok: true; bytes: number }
  | { ok: false; reason: "size" | "depth" | "cycle" | "nodes" | "keys" | "array_items" | "string" | "key_size" }

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function serializedStringBytes(value: string): number {
  return utf8Bytes(JSON.stringify(value))
}

export function measureExternalMcpSerializedJson(
  value: unknown,
  byteLimit = DIAGNOSTIC_TOOL_SCHEMA_LIMIT_BYTES,
  depthLimit = DIAGNOSTIC_SCHEMA_DEPTH_LIMIT,
): SerializedMeasurement {
  type Frame = { kind: "value"; value: unknown; depth: number } | { kind: "leave"; value: object }
  const stack: Frame[] = [{ kind: "value", value, depth: 0 }]
  const active = new WeakSet<object>()
  let bytes = 0
  let nodes = 0
  let keys = 0
  let arrayItems = 0
  const add = (amount: number) => {
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
    nodes += 1
    if (nodes > DIAGNOSTIC_SCHEMA_NODE_LIMIT) return { ok: false, reason: "nodes" }
    if (frame.depth > depthLimit) return { ok: false, reason: "depth" }
    const current = frame.value
    if (current === null) {
      if (!add(4)) return { ok: false, reason: "size" }
      continue
    }
    if (typeof current === "string") {
      const stringBytes = serializedStringBytes(current)
      if (stringBytes > DIAGNOSTIC_SCHEMA_STRING_LIMIT_BYTES) return { ok: false, reason: "string" }
      if (!add(stringBytes)) return { ok: false, reason: "size" }
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
      arrayItems += current.length
      if (arrayItems > DIAGNOSTIC_SCHEMA_ARRAY_ITEM_LIMIT) return { ok: false, reason: "array_items" }
      if (!add(2 + Math.max(0, current.length - 1))) return { ok: false, reason: "size" }
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "value", value: current[index], depth: frame.depth + 1 })
      }
      continue
    }

    const entries = Object.entries(current)
    keys += entries.length
    if (keys > DIAGNOSTIC_SCHEMA_KEY_LIMIT) return { ok: false, reason: "keys" }
    if (!add(2 + Math.max(0, entries.length - 1))) return { ok: false, reason: "size" }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!
      const keyBytes = serializedStringBytes(key)
      if (keyBytes > DIAGNOSTIC_SCHEMA_KEY_LIMIT_BYTES) return { ok: false, reason: "key_size" }
      if (!add(keyBytes + 1)) return { ok: false, reason: "size" }
      stack.push({ kind: "value", value: child, depth: frame.depth + 1 })
    }
  }
  return { ok: true, bytes }
}

type ExternalMcpCatalogCode =
  | "MCP_CATALOG_CURSOR_LOOP"
  | "MCP_CATALOG_PAGE_LIMIT"
  | "MCP_CATALOG_ITEM_LIMIT"
  | "MCP_CATALOG_DUPLICATE_TOOL"
  | "MCP_CATALOG_TOOL_NAME_LIMIT"
  | "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT"
  | "MCP_CATALOG_TOOL_TITLE_LIMIT"
  | "MCP_CATALOG_SCHEMA_SIZE_LIMIT"
  | "MCP_CATALOG_SCHEMA_DEPTH_LIMIT"
  | "MCP_CATALOG_SCHEMA_CYCLE"
  | "MCP_CATALOG_SCHEMA_NODE_LIMIT"
  | "MCP_CATALOG_SCHEMA_KEY_LIMIT"
  | "MCP_CATALOG_SCHEMA_ARRAY_LIMIT"
  | "MCP_CATALOG_SCHEMA_STRING_LIMIT"
  | "MCP_CATALOG_CURSOR_SIZE_LIMIT"
  | "MCP_CATALOG_BYTE_LIMIT"

function catalogLimit(code: ExternalMcpCatalogCode, diagnostic?: ExternalMcpDiagnosticTracker): never {
  if (diagnostic) {
    throw catalogDiagnosticError({
      tracker: diagnostic,
      code,
      operatorAction: "Reduce and validate the provider tool catalog within OpenWork's documented safety limits.",
    })
  }
  throw new ExternalMcpCatalogLimitError(code)
}

function validateToolField(
  value: string | undefined,
  limit: number,
  code: ExternalMcpCatalogCode,
  diagnostic?: ExternalMcpDiagnosticTracker,
): void {
  if (value !== undefined && serializedStringBytes(value) > limit) catalogLimit(code, diagnostic)
}

function validateToolSchema(schema: unknown, diagnostic?: ExternalMcpDiagnosticTracker): void {
  const measurement = measureExternalMcpSerializedJson(schema)
  if (measurement.ok) return
  const code = measurement.reason === "depth"
    ? "MCP_CATALOG_SCHEMA_DEPTH_LIMIT"
    : measurement.reason === "cycle"
      ? "MCP_CATALOG_SCHEMA_CYCLE"
      : measurement.reason === "nodes"
        ? "MCP_CATALOG_SCHEMA_NODE_LIMIT"
        : measurement.reason === "keys" || measurement.reason === "key_size"
          ? "MCP_CATALOG_SCHEMA_KEY_LIMIT"
          : measurement.reason === "array_items"
            ? "MCP_CATALOG_SCHEMA_ARRAY_LIMIT"
            : measurement.reason === "string"
              ? "MCP_CATALOG_SCHEMA_STRING_LIMIT"
              : "MCP_CATALOG_SCHEMA_SIZE_LIMIT"
  catalogLimit(code, diagnostic)
}

function measureCatalogTool(
  tool: ExternalMcpToolPage["tools"][number],
  remainingBytes: number,
  diagnostic?: ExternalMcpDiagnosticTracker,
): number {
  validateToolField(tool.name, DIAGNOSTIC_TOOL_NAME_LIMIT_BYTES, "MCP_CATALOG_TOOL_NAME_LIMIT", diagnostic)
  validateToolField(tool.title, DIAGNOSTIC_TOOL_TITLE_LIMIT_BYTES, "MCP_CATALOG_TOOL_TITLE_LIMIT", diagnostic)
  validateToolField(tool.description, DIAGNOSTIC_TOOL_DESCRIPTION_LIMIT_BYTES, "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT", diagnostic)
  validateToolSchema(tool.inputSchema, diagnostic)
  if (tool.outputSchema !== undefined) validateToolSchema(tool.outputSchema, diagnostic)
  const measurement = measureExternalMcpSerializedJson(
    tool,
    Math.max(0, remainingBytes),
    DIAGNOSTIC_SCHEMA_DEPTH_LIMIT + 4,
  )
  if (!measurement.ok) catalogLimit("MCP_CATALOG_BYTE_LIMIT", diagnostic)
  return measurement.bytes
}

export async function collectExternalMcpToolPages(input: {
  listPage: (cursor: string | undefined, options: RequestOptions) => Promise<ExternalMcpToolPage>
  deadline?: ExternalMcpLifecycleDeadline
  diagnostic?: ExternalMcpDiagnosticTracker
  pageLimit?: number
  itemLimit?: number
}): Promise<{ tools: ExternalMcpToolPage["tools"]; pageCount: number }> {
  const deadline = input.deadline ?? createExternalMcpLifecycleDeadline()
  const pageLimit = input.pageLimit ?? DIAGNOSTIC_MAX_TOOL_PAGES
  const itemLimit = input.itemLimit ?? DIAGNOSTIC_MAX_TOOLS
  const tools: ExternalMcpToolPage["tools"] = []
  const seenCursors = new Set<string>()
  const seenToolNames = new Set<string>()
  let catalogBytes = 0
  let cursor: string | undefined
  for (let page = 0; page < pageLimit; page += 1) {
    const result = await runExternalMcpRequestWithinDeadline({
      deadline,
      diagnostic: input.diagnostic,
      phase: "MCP_TOOL_DISCOVERY",
      operation: (options) => input.listPage(cursor, options),
    })
    if (tools.length + result.tools.length > itemLimit) catalogLimit("MCP_CATALOG_ITEM_LIMIT", input.diagnostic)
    for (const tool of result.tools) {
      catalogBytes += measureCatalogTool(tool, DIAGNOSTIC_CATALOG_LIMIT_BYTES - catalogBytes, input.diagnostic)
      if (seenToolNames.has(tool.name)) catalogLimit("MCP_CATALOG_DUPLICATE_TOOL", input.diagnostic)
      seenToolNames.add(tool.name)
      tools.push(tool)
    }
    if (!result.nextCursor) {
      input.diagnostic?.passed("MCP_TOOL_DISCOVERY", "catalog_ready")
      return { tools, pageCount: page + 1 }
    }
    if (serializedStringBytes(result.nextCursor) > DIAGNOSTIC_CURSOR_LIMIT_BYTES) {
      catalogLimit("MCP_CATALOG_CURSOR_SIZE_LIMIT", input.diagnostic)
    }
    const cursorMeasurement = measureExternalMcpSerializedJson(
      result.nextCursor,
      DIAGNOSTIC_CATALOG_LIMIT_BYTES - catalogBytes,
      1,
    )
    if (!cursorMeasurement.ok) catalogLimit("MCP_CATALOG_BYTE_LIMIT", input.diagnostic)
    catalogBytes += cursorMeasurement.bytes
    if (seenCursors.has(result.nextCursor)) catalogLimit("MCP_CATALOG_CURSOR_LOOP", input.diagnostic)
    seenCursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  catalogLimit("MCP_CATALOG_PAGE_LIMIT", input.diagnostic)
}

export type ExternalMcpConnectResult =
  | { status: "connected" }
  | { status: "needs_auth"; authorizeUrl: string }

export type ExternalMcpDiagnosticResult =
  | {
      status: "connected"
      protocolVersion: string
      toolCount: number
      pageCount: number
    }
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
  const diagnostic = new ExternalMcpDiagnosticTracker(diagnosticReferenceId ?? randomUUID(), {
    authType: connection.authType,
    credentialMode: connection.credentialMode,
  })
  const { transport, provider } = buildTransport(
    connection,
    redirectUri,
    signedState,
    member,
    undefined,
    undefined,
    undefined,
    false,
    deadline,
    diagnostic,
  )
  try {
    return await runExternalMcpLifecycleWithClose({
      operation: async () => {
        try {
          await runExternalMcpRequestWithinDeadline({
            deadline,
            diagnostic,
            phase: "MCP_INITIALIZE",
            operation: (options) => client.connect(transport, options),
          })
          diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
          return { status: "connected" as const }
        } catch (error) {
          if (error instanceof UnauthorizedError && provider?.lastAuthorizeUrl) {
            await assertSafeMcpAuthorizationUrl(provider.lastAuthorizeUrl)
            diagnostic.begin("AUTH_USER_OR_WORKLOAD")
            return { status: "needs_auth" as const, authorizeUrl: provider.lastAuthorizeUrl }
          }
          throw diagnostic.error(error)
        }
      },
      close: () => client.close(),
    })
  } catch (error) {
    if (error instanceof StructuredExternalMcpDiagnosticError) throw error
    throw diagnostic.error(error, "SHUTDOWN")
  }
}

/** Completes the OAuth code exchange after the browser is redirected back with `code`. For per-member connections, `member` (from the signed state token) decides whose account the tokens are saved against. */
export async function completeExternalMcpAuth(input: {
  connection: ExternalMcpConnectionRow
  code: string
  redirectUri: string
  signedState: string
  credentialFence?: ExternalMcpDiagnosticCredentialFence
  member?: ExternalMcpMemberContext
  diagnosticObserver?: ExternalMcpDiagnosticObserver
  lifecycleDeadline?: ExternalMcpLifecycleDeadline
  diagnosticReferenceId?: string
}): Promise<void> {
  const {
    connection,
    code,
    redirectUri,
    signedState,
    credentialFence,
    member,
    diagnosticObserver,
    diagnosticReferenceId,
  } = input
  const context: DiagnosticContext | undefined = diagnosticObserver
    ? {
        connectionUrl: connection.url,
        networkPassed: false,
        lastPhase: "AUTH_TOKEN_ACQUISITION" as const,
        lastEvidence: safeMcpDiagnosticEvidence({ url: connection.url }),
        observing: true,
        observe: diagnosticObserver,
      }
    : undefined
  const diagnosticAuthorization = credentialFence
    ? { attemptId: credentialFence.attemptId, generation: credentialFence.generation }
    : undefined
  const deadline = input.lifecycleDeadline ?? createExternalMcpLifecycleDeadline()
  const structuredDiagnostic = diagnosticObserver
    ? undefined
    : new ExternalMcpDiagnosticTracker(diagnosticReferenceId ?? randomUUID(), {
        authType: connection.authType,
        credentialMode: connection.credentialMode,
      })
  const validationClient = diagnosticObserver ? null : buildClient()
  const { transport, provider } = buildTransport(
    connection,
    redirectUri,
    signedState,
    member,
    context,
    diagnosticAuthorization,
    credentialFence,
    true,
    deadline,
    structuredDiagnostic,
  )
  const startedAt = Date.now()
  await observe(context, {
    phase: "AUTH_TOKEN_ACQUISITION",
    outcome: "running",
    healthLevel: "reachable",
    messageSafe: "Exchanging the authorization response for an MCP access token.",
    evidence: safeMcpDiagnosticEvidence(),
  })
  let exchangedTokens = false
  try {
    await runExternalMcpLifecycleWithClose({
      operation: async () => {
        await runExternalMcpRequestWithinDeadline({
          deadline,
          diagnostic: structuredDiagnostic,
          phase: "AUTH_TOKEN_ACQUISITION",
          operation: async () => transport.finishAuth(code),
        })
        exchangedTokens = true
        structuredDiagnostic?.passed("AUTH_TOKEN_ACQUISITION")
        await observe(context, {
          phase: "AUTH_TOKEN_ACQUISITION",
          outcome: "passed",
          healthLevel: "reachable",
          messageSafe: "The authorization server completed the token exchange.",
          phaseDurationMs: Date.now() - startedAt,
          evidence: safeMcpDiagnosticEvidence(),
        })
        await observe(context, {
          phase: "AUTH_USER_OR_WORKLOAD",
          outcome: "passed",
          healthLevel: "reachable",
          messageSafe: "The provider completed administrator authorization for this MCP connection.",
          phaseDurationMs: Date.now() - startedAt,
          evidence: safeMcpDiagnosticEvidence(),
        })
        if (validationClient) {
          try {
            await runExternalMcpRequestWithinDeadline({
              deadline,
              diagnostic: structuredDiagnostic,
              phase: "MCP_INITIALIZE",
              operation: (options) => validationClient.connect(transport, options),
            })
            structuredDiagnostic?.passed("MCP_INITIALIZED", "protocol_ready")
          } catch (error) {
            await provider?.invalidateCredentials?.("tokens").catch(() => undefined)
            throw error
          }
        }
      },
      close: () => validationClient ? validationClient.close() : transport.close(),
    })
  } catch (error) {
    if (structuredDiagnostic) {
      if (error instanceof StructuredExternalMcpDiagnosticError) throw error
      throw structuredDiagnostic.error(error, exchangedTokens ? "MCP_INITIALIZE" : "AUTH_TOKEN_ACQUISITION")
    }
    throw error instanceof ExternalMcpDiagnosticError
      ? error
      : new ExternalMcpDiagnosticError(
          context?.lastPhase ?? "AUTH_TOKEN_ACQUISITION",
          error,
          context?.lastEvidence,
          context?.lastHttp,
        )
  }
}

export function diagnosticPhaseFromError(error: unknown): McpDiagnosticPhase {
  if (error instanceof ExternalMcpDiagnosticError) return error.phase
  if (error instanceof StructuredExternalMcpDiagnosticError) return error.diagnostic.phase
  return "MCP_INITIALIZE"
}

export function diagnosticEvidenceFromError(error: unknown, depth = 0): McpDiagnosticSafeEvidence | undefined {
  if (typeof error !== "object" || error === null || depth > 6) return undefined
  if (error instanceof ExternalMcpDiagnosticError && error.evidence) return error.evidence
  return "cause" in error ? diagnosticEvidenceFromError(error.cause, depth + 1) : undefined
}

export async function diagnoseExternalMcp(input: {
  connection: ExternalMcpConnectionRow
  redirectUri: string
  signedState?: string
  member?: ExternalMcpMemberContext
  diagnosticAuthorization?: ExternalMcpDiagnosticAuthorization
  observe: ExternalMcpDiagnosticObserver
}): Promise<ExternalMcpDiagnosticResult> {
  const context: DiagnosticContext = {
    connectionUrl: input.connection.url,
    networkPassed: false,
    lastPhase: "HTTP_ROUTING",
    lastEvidence: safeMcpDiagnosticEvidence({ url: input.connection.url }),
    observing: true,
    observe: input.observe,
  }
  const client = buildClient()
  const deadline = createExternalMcpLifecycleDeadline()
  const { transport, provider } = buildTransport(
    input.connection,
    input.redirectUri,
    input.signedState,
    input.member,
    context,
    input.diagnosticAuthorization,
    undefined,
    false,
    deadline,
  )

  return runExternalMcpLifecycleWithClose({
    operation: async () => {
      const initializeStartedAt = Date.now()
      await observe(context, {
        phase: "MCP_INITIALIZE",
        outcome: "running",
        healthLevel: "configured",
        messageSafe: "Starting the MCP initialization exchange.",
        evidence: safeMcpDiagnosticEvidence({ url: input.connection.url, method: "POST" }),
      })

      try {
        await runExternalMcpRequestWithinDeadline({
          deadline,
          operation: (options) => client.connect(transport, options),
        })
      } catch (error) {
        if (error instanceof UnauthorizedError && provider?.lastAuthorizeUrl) {
          try {
            await assertSafeMcpAuthorizationUrl(provider.lastAuthorizeUrl)
          } catch (authorizationUrlError) {
            throw new ExternalMcpDiagnosticError(
              "AUTH_USER_OR_WORKLOAD",
              authorizationUrlError,
              safeMcpDiagnosticEvidence({ url: provider.lastAuthorizeUrl }),
            )
          }
          await observe(context, {
            phase: "AUTH_USER_OR_WORKLOAD",
            outcome: "waiting",
            healthLevel: "reachable",
            messageSafe: "The provider is waiting for administrator authorization in the new tab.",
            actionOwner: input.connection.credentialMode === "shared" ? "organization_admin" : "member",
            operatorAction: "complete_provider_authorization",
            evidence: safeMcpDiagnosticEvidence(),
            attemptStatus: "waiting_for_authorization",
          })
          return { status: "needs_auth", authorizeUrl: provider.lastAuthorizeUrl }
        }
        throw error instanceof ExternalMcpDiagnosticError
          ? error
          : new ExternalMcpDiagnosticError(
              diagnosticPhaseAfterSdkFailure(error, context),
              error,
              context.lastEvidence,
              context.lastHttp,
            )
      }

      try {
        await observe(context, {
          phase: "AUTH_RESOURCE_VALIDATION",
          outcome: input.connection.authType === "none" ? "skipped" : "passed",
          healthLevel: "authorized",
          messageSafe: input.connection.authType === "none"
            ? "This MCP server does not require a credential."
            : "The MCP resource accepted the configured credential.",
          evidence: safeMcpDiagnosticEvidence({ url: input.connection.url }),
        })
        await observe(context, {
          phase: "MCP_TRANSPORT",
          outcome: "passed",
          healthLevel: "authorized",
          messageSafe: "The server completed the Streamable HTTP transport exchange.",
          phaseDurationMs: Date.now() - initializeStartedAt,
          evidence: safeMcpDiagnosticEvidence({ url: input.connection.url, method: "POST" }),
        })

        const selectedVersion = transport.protocolVersion
        await observe(context, {
          phase: "MCP_VERSION",
          outcome: "running",
          healthLevel: "authorized",
          messageSafe: "Checking the negotiated stable MCP revision.",
          evidence: safeMcpDiagnosticEvidence(),
        })
        if (!selectedVersion || !DIAGNOSTIC_PROTOCOL_VERSIONS.has(selectedVersion)) {
          throw new ExternalMcpDiagnosticError("MCP_VERSION", new Error("Unsupported protocol version."))
        }
        const protocolVersion = selectedVersion
        await observe(context, {
          phase: "MCP_VERSION",
          outcome: "passed",
          healthLevel: "authorized",
          messageSafe: `The server negotiated MCP ${protocolVersion}.`,
          evidence: safeMcpDiagnosticEvidence({ protocolVersion }),
        })
        await observe(context, {
          phase: "MCP_INITIALIZE",
          outcome: "passed",
          healthLevel: "protocol_ready",
          messageSafe: "The MCP initialize request and response were valid.",
          phaseDurationMs: Date.now() - initializeStartedAt,
          evidence: safeMcpDiagnosticEvidence({ protocolVersion }),
        })
        await observe(context, {
          phase: "MCP_INITIALIZED",
          outcome: "passed",
          healthLevel: "protocol_ready",
          messageSafe: "The server accepted the initialized lifecycle notification.",
          evidence: safeMcpDiagnosticEvidence({ protocolVersion }),
        })

        const catalogStartedAt = Date.now()
        await observe(context, {
          phase: "MCP_TOOL_DISCOVERY",
          outcome: "running",
          healthLevel: "protocol_ready",
          messageSafe: "Reading the complete MCP tool catalog.",
          evidence: safeMcpDiagnosticEvidence({ protocolVersion }),
        })
        let catalog
        try {
          catalog = await collectExternalMcpToolPages({
            deadline,
            listPage: (cursor, options) => client.listTools(cursor ? { cursor } : undefined, options),
          })
        } catch (error) {
          throw error instanceof ExternalMcpDiagnosticError
            ? error
            : new ExternalMcpDiagnosticError("MCP_TOOL_DISCOVERY", error, context.lastEvidence, context.lastHttp)
        }
        const pageCount = catalog.pageCount
        const toolCount = catalog.tools.length

        await observe(context, {
          phase: "MCP_TOOL_DISCOVERY",
          outcome: "passed",
          healthLevel: "catalog_ready",
          messageSafe: `The complete tool catalog is available (${toolCount} tools across ${pageCount} pages).`,
          phaseDurationMs: Date.now() - catalogStartedAt,
          evidence: safeMcpDiagnosticEvidence({ protocolVersion, toolCount, pageCount }),
          attemptStatus: "succeeded",
        })
        return { status: "connected", protocolVersion, toolCount, pageCount }
      } catch (error) {
        throw error instanceof ExternalMcpDiagnosticError
          ? error
          : new ExternalMcpDiagnosticError(context.lastPhase, error, context.lastEvidence, context.lastHttp)
      }
    },
    close: async () => {
      context.observing = false
      await client.close()
    },
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
  const diagnostic = new ExternalMcpDiagnosticTracker(diagnosticReferenceId ?? randomUUID(), {
    authType: connection.authType,
    credentialMode: connection.credentialMode,
  })
  const { transport } = buildTransport(
    connection,
    redirectUri,
    undefined,
    member,
    undefined,
    undefined,
    undefined,
    false,
    deadline,
    diagnostic,
  )
  try {
    return await runExternalMcpLifecycleWithClose({
      operation: async () => {
        await runExternalMcpRequestWithinDeadline({
          deadline,
          diagnostic,
          phase: "MCP_INITIALIZE",
          operation: (options) => client.connect(transport, options),
        })
        diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
        const catalog = await collectExternalMcpToolPages({
          deadline,
          diagnostic,
          listPage: (cursor, options) => client.listTools(cursor ? { cursor } : undefined, options),
        })
        return catalog.tools
      },
      close: () => client.close(),
    })
  } catch (error) {
    if (error instanceof StructuredExternalMcpDiagnosticError) throw error
    throw diagnostic.error(error)
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
  const diagnostic = new ExternalMcpDiagnosticTracker(input.diagnosticReferenceId ?? randomUUID(), {
    authType: input.connection.authType,
    credentialMode: input.connection.credentialMode,
  })
  const { transport } = buildTransport(
    input.connection,
    input.redirectUri,
    undefined,
    input.member,
    undefined,
    undefined,
    undefined,
    false,
    deadline,
    diagnostic,
  )
  try {
    return await runExternalMcpLifecycleWithClose({
      operation: async () => {
        await runExternalMcpRequestWithinDeadline({
          deadline,
          diagnostic,
          phase: "MCP_INITIALIZE",
          operation: (options) => client.connect(transport, options),
        })
        diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
        const result = await runExternalMcpRequestWithinDeadline({
          deadline,
          diagnostic,
          phase: "MCP_TOOL_EXECUTION",
          operation: (options) => client.callTool({ name: input.toolName, arguments: input.args }, undefined, options),
        })
        if (result.isError) throw providerToolDiagnosticError({ tracker: diagnostic })
        diagnostic.passed("MCP_TOOL_EXECUTION", "operation_ready")
        return result
      },
      close: () => client.close(),
    })
  } catch (error) {
    if (error instanceof StructuredExternalMcpDiagnosticError) throw error
    throw diagnostic.error(error)
  }
}

// The dashboard's byte-stable, read-only readiness probe is deliberately
// isolated from the production OAuth client. It may consume an existing
// bearer credential, but it never refreshes, registers, redirects, or writes.
export {
  EXTERNAL_MCP_CONNECTION_TEST_FAILURE_CODES,
  EXTERNAL_MCP_CONNECTION_TEST_FAILURE_MESSAGES,
  EXTERNAL_MCP_CONNECTION_TEST_WARNING_CODES,
  ExternalMcpConnectionTestFailure,
  testExternalMcpConnection,
  toExternalMcpConnectionTestFailure,
  type ExternalMcpConnectionTestFailureCode,
  type ExternalMcpConnectionTestOptions,
  type ExternalMcpConnectionTestResult,
  type ExternalMcpConnectionTestWarningCode,
} from "./external-mcp-connection-test.js"
