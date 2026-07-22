import { createHmac, randomUUID } from "node:crypto"
import {
  EGRESS_DIAGNOSTIC_ID_HEADER,
  EGRESS_DIAGNOSTIC_RUN_HEADER,
  EGRESS_DIAGNOSTIC_SIGNATURE_HEADER,
  EGRESS_DIAGNOSTIC_STEP_HEADER,
  EGRESS_DIAGNOSTIC_STEP_IDS,
  type EgressDiagnosticCategory,
  type EgressDiagnosticOwner,
  type EgressDiagnosticRun,
  type EgressDiagnosticStep,
  type EgressDiagnosticStepId,
} from "@openwork/types/den/egress-diagnostics"

type DiagnosticFetch = typeof fetch

type StepEvidence = {
  diagnosticIds: string[]
  httpStatuses: number[]
}

type DiagnosticFailureInput = {
  action: string
  category: EgressDiagnosticCategory
  code: string
  message: string
  owner: EgressDiagnosticOwner
}

class DiagnosticFailure extends Error {
  readonly action: string
  readonly category: EgressDiagnosticCategory
  readonly code: string
  readonly owner: EgressDiagnosticOwner

  constructor(input: DiagnosticFailureInput) {
    super(input.message)
    this.name = "DiagnosticFailure"
    this.action = input.action
    this.category = input.category
    this.code = input.code
    this.owner = input.owner
  }
}

const stepDefinition: Record<EgressDiagnosticStepId, {
  action: string
  category: EgressDiagnosticCategory
  label: string
  message: string
}> = {
  reachability: {
    action: "No action required.",
    category: "connectivity",
    label: "Public reachability",
    message: "Den reached the public Diagnostics service over HTTP.",
  },
  "http-methods": {
    action: "No action required.",
    category: "http",
    label: "HTTP methods and headers",
    message: "HEAD, OPTIONS, authenticated JSON POST, and response headers passed.",
  },
  redirect: {
    action: "No action required.",
    category: "http",
    label: "Same-origin redirect",
    message: "Den accepted and completed a controlled same-origin redirect.",
  },
  "oauth-discovery": {
    action: "No action required.",
    category: "oauth",
    label: "OAuth metadata discovery",
    message: "Protected-resource and authorization-server metadata were discovered and validated.",
  },
  "oauth-token": {
    action: "No action required.",
    category: "oauth",
    label: "OAuth-shaped token POST",
    message: "Den completed a client-secret Basic token request and received a short-lived synthetic token.",
  },
  "mcp-handshake": {
    action: "No action required.",
    category: "mcp",
    label: "MCP handshake and tool call",
    message: "Initialize, ready notification, tool discovery, and a content-free synthetic tool call passed.",
  },
}

const diagnosticIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const safeNetworkCodes = new Set([
  "ABORT_ERR",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeCauseCode(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < 5; depth += 1) {
    const record = asRecord(current)
    if (!record) return null
    if (typeof record.code === "string" && safeNetworkCodes.has(record.code)) return record.code
    if (record.name === "AbortError") return "ABORT_ERR"
    current = record.cause
  }
  return null
}

function networkFailure(error: unknown): DiagnosticFailure {
  const code = safeCauseCode(error) ?? "fetch_failed"
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new DiagnosticFailure({
      action: "Ask the network administrator to verify cluster DNS, DNS policy, and the diagnostic hostname.",
      category: "connectivity",
      code,
      message: "The Den container could not resolve the Diagnostics hostname.",
      owner: "network-administrator",
    })
  }
  if (code.includes("CERT") || code.includes("TLS") || code.includes("SSL") || code.includes("SIGNATURE") || code.includes("SELF_SIGNED")) {
    return new DiagnosticFailure({
      action: "Ask the network administrator to verify TLS inspection, the trusted CA bundle, hostname policy, and certificate expiry inside the Den container.",
      category: "connectivity",
      code,
      message: "TLS validation failed before Diagnostics received an HTTP request.",
      owner: "network-administrator",
    })
  }
  if (code === "ABORT_ERR" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return new DiagnosticFailure({
      action: "Ask the network administrator to inspect egress firewall, proxy routing, NetworkPolicy, service-mesh, and timeout configuration.",
      category: "connectivity",
      code,
      message: "The outbound request timed out before a valid Diagnostics response arrived.",
      owner: "network-administrator",
    })
  }
  return new DiagnosticFailure({
    action: "Ask the Den operator and network administrator to inspect container egress, proxy configuration, service-mesh policy, and connection resets.",
    category: "connectivity",
    code,
    message: "The Den container could not complete the outbound connection.",
    owner: "network-administrator",
  })
}

function httpFailure(status: number, category: EgressDiagnosticCategory): DiagnosticFailure {
  if (status === 401 || status === 403) {
    return new DiagnosticFailure({
      action: "Verify that Den and the Diagnostics deployment use the same synthetic diagnostic token and that the proxy forwards Authorization headers.",
      category,
      code: `http_${status}`,
      message: `Diagnostics rejected the synthetic authorization with HTTP ${status}.`,
      owner: "den-operator",
    })
  }
  if (status === 407) {
    return new DiagnosticFailure({
      action: "Configure the customer proxy credentials for the Den runtime and confirm Node outbound requests use the approved proxy path.",
      category: "connectivity",
      code: "http_407",
      message: "The corporate proxy requires authentication.",
      owner: "network-administrator",
    })
  }
  if (status >= 500) {
    return new DiagnosticFailure({
      action: "Give OpenWork support the run ID and diagnostic reference so the Diagnostics deployment can be inspected.",
      category,
      code: `http_${status}`,
      message: `The Diagnostics service returned HTTP ${status}.`,
      owner: "openwork-support",
    })
  }
  return new DiagnosticFailure({
    action: "Give OpenWork support the run ID and response status, then compare the matching remote trace.",
    category,
    code: `http_${status}`,
    message: `The diagnostic request returned unexpected HTTP ${status}.`,
    owner: "openwork-support",
  })
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const maximumBytes = 64 * 1024
  const reader = response.body?.getReader()
  if (!reader) throw new DiagnosticFailure({
    action: "Give OpenWork support the run ID and diagnostic reference.",
    category: "http",
    code: "empty_response_body",
    message: "Diagnostics returned an empty response where JSON was required.",
    owner: "openwork-support",
  })
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      text += decoder.decode()
      break
    }
    bytes += value.byteLength
    if (bytes > maximumBytes) {
      await reader.cancel()
      throw new DiagnosticFailure({
        action: "Give OpenWork support the run ID; the diagnostic response exceeded its declared safety bound.",
        category: "http",
        code: "response_too_large",
        message: "Diagnostics returned more than 64 KiB of response data.",
        owner: "openwork-support",
      })
    }
    text += decoder.decode(value, { stream: true })
  }
  try {
    const value: unknown = JSON.parse(text)
    const record = asRecord(value)
    if (record) return record
  } catch {
    // Report a stable safe error below.
  }
  throw new DiagnosticFailure({
    action: "Give OpenWork support the run ID and diagnostic reference.",
    category: "http",
    code: "invalid_json_response",
    message: "Diagnostics returned a malformed JSON response.",
    owner: "openwork-support",
  })
}

function requireValue(condition: boolean, input: DiagnosticFailureInput | DiagnosticFailure): asserts condition {
  if (!condition) throw input instanceof DiagnosticFailure ? input : new DiagnosticFailure(input)
}

function requestHeaders(runId: string, step: string, additional: HeadersInit = {}): Headers {
  const headers = new Headers(additional)
  headers.set(EGRESS_DIAGNOSTIC_RUN_HEADER, runId)
  headers.set(EGRESS_DIAGNOSTIC_STEP_HEADER, step)
  headers.set("user-agent", "openwork-den-egress-diagnostics/1.0")
  return headers
}

function diagnosticRunSignature(secret: string, runId: string, step: string): string {
  return createHmac("sha256", secret)
    .update(`openwork-diagnostics-v1\n${runId}\n${step}`)
    .digest("hex")
}

async function sendRequest(input: {
  category: EgressDiagnosticCategory
  evidence: StepEvidence
  expectedStatuses: readonly number[]
  fetchImpl: DiagnosticFetch
  init?: RequestInit
  runId: string
  step: string
  timeoutMs: number
  url: string
}): Promise<Response> {
  let response: Response
  try {
    response = await input.fetchImpl(input.url, {
      ...input.init,
      headers: requestHeaders(input.runId, input.step, input.init?.headers),
      signal: input.init?.signal ?? AbortSignal.timeout(input.timeoutMs),
    })
  } catch (error) {
    throw networkFailure(error)
  }
  input.evidence.httpStatuses.push(response.status)
  const diagnosticId = response.headers.get(EGRESS_DIAGNOSTIC_ID_HEADER) ?? ""
  if (diagnosticIdPattern.test(diagnosticId)) input.evidence.diagnosticIds.push(diagnosticId)
  if (!input.expectedStatuses.includes(response.status)) throw httpFailure(response.status, input.category)
  if (!diagnosticIdPattern.test(diagnosticId)) {
    throw new DiagnosticFailure({
      action: "Ask the network administrator to inspect whether a proxy, gateway, or service mesh replaced the response or removed x-openwork-diagnostic-id.",
      category: input.category,
      code: "diagnostic_reference_missing",
      message: "A response arrived, but it did not contain proof that it came from the Diagnostics application.",
      owner: "network-administrator",
    })
  }
  return response
}

function protocolFailure(category: EgressDiagnosticCategory, code: string, message: string): DiagnosticFailure {
  return new DiagnosticFailure({
    action: "Give OpenWork support the run ID and diagnostic reference so the response contract can be compared with the remote trace.",
    category,
    code,
    message,
    owner: "openwork-support",
  })
}

export async function runEgressDiagnostic(input: {
  bearerToken: string
  fetchImpl?: DiagnosticFetch
  now?: () => number
  origin: string
  requestTimeoutMs?: number
  runId?: string
}): Promise<EgressDiagnosticRun> {
  const baseFetch = input.fetchImpl ?? fetch
  const fetchImpl: DiagnosticFetch = (url, init) => {
    const headers = new Headers(init?.headers)
    const runId = headers.get(EGRESS_DIAGNOSTIC_RUN_HEADER) ?? ""
    const step = headers.get(EGRESS_DIAGNOSTIC_STEP_HEADER) ?? ""
    if (runId && step) {
      headers.set(
        EGRESS_DIAGNOSTIC_SIGNATURE_HEADER,
        diagnosticRunSignature(input.bearerToken, runId, step),
      )
    }
    return baseFetch(url, { ...init, headers })
  }
  const now = input.now ?? Date.now
  const timeoutMs = input.requestTimeoutMs ?? 5_000
  const origin = input.origin.replace(/\/+$/u, "")
  const runId = input.runId ?? randomUUID()
  const runStartedAt = now()
  let accessToken = ""
  let stopped = false
  let highestPassingStep: EgressDiagnosticStepId | null = null
  let failedStep: EgressDiagnosticStepId | null = null
  const steps: EgressDiagnosticStep[] = []

  const tasks: Record<EgressDiagnosticStepId, (evidence: StepEvidence) => Promise<void>> = {
    reachability: async (evidence) => {
      const response = await sendRequest({
        category: "connectivity", evidence, expectedStatuses: [200], fetchImpl, runId,
        step: "reachability-get", timeoutMs, url: `${origin}/diagnostics/egress`,
      })
      const body = await readJson(response)
      requireValue(body.ok === true, {
        action: "Give OpenWork support the run ID and diagnostic reference.",
        category: "connectivity", code: "invalid_reachability_response",
        message: "The reachability endpoint returned an unexpected response.", owner: "openwork-support",
      })
    },
    "http-methods": async (evidence) => {
      await sendRequest({
        category: "http", evidence, expectedStatuses: [204], fetchImpl,
        init: { method: "HEAD" }, runId, step: "http-head", timeoutMs,
        url: `${origin}/diagnostics/egress`,
      })
      const options = await sendRequest({
        category: "http", evidence, expectedStatuses: [204], fetchImpl,
        init: { method: "OPTIONS" }, runId, step: "http-options", timeoutMs,
        url: `${origin}/diagnostics/egress`,
      })
      requireValue((options.headers.get("allow") ?? "").includes("POST"), {
        action: "Ask the network administrator to inspect proxy handling of OPTIONS and response headers.",
        category: "http", code: "options_header_missing",
        message: "The OPTIONS response did not preserve its Allow header.", owner: "network-administrator",
      })
      const response = await sendRequest({
        category: "http", evidence, expectedStatuses: [200], fetchImpl,
        init: {
          body: JSON.stringify({ probe: "openwork-egress-diagnostic" }),
          headers: { authorization: `Bearer ${input.bearerToken}`, "content-type": "application/json" },
          method: "POST",
        },
        runId, step: "http-post", timeoutMs, url: `${origin}/diagnostics/egress`,
      })
      const body = await readJson(response)
      requireValue(body.ok === true && body.method === "POST", protocolFailure("http", "invalid_post_response", "The JSON POST endpoint returned an unexpected response."))
    },
    redirect: async (evidence) => {
      const first = await sendRequest({
        category: "http", evidence, expectedStatuses: [302], fetchImpl,
        init: { redirect: "manual" }, runId, step: "redirect-start", timeoutMs,
        url: `${origin}/diagnostics/redirect`,
      })
      const location = first.headers.get("location") ?? ""
      const redirectUrl = new URL(location, origin)
      requireValue(redirectUrl.origin === origin && redirectUrl.pathname === "/diagnostics/egress", {
        action: "Give OpenWork support the run ID and diagnostic reference.",
        category: "http", code: "unsafe_redirect_target",
        message: "The controlled redirect did not remain on the Diagnostics origin.", owner: "openwork-support",
      })
      const second = await sendRequest({
        category: "http", evidence, expectedStatuses: [200], fetchImpl, runId,
        step: "redirect-complete", timeoutMs, url: redirectUrl.toString(),
      })
      const body = await readJson(second)
      requireValue(body.ok === true, protocolFailure("http", "invalid_redirect_response", "The redirect destination returned an unexpected response."))
    },
    "oauth-discovery": async (evidence) => {
      const protectedResponse = await sendRequest({
        category: "oauth", evidence, expectedStatuses: [200], fetchImpl, runId,
        step: "oauth-protected-resource", timeoutMs,
        url: `${origin}/.well-known/oauth-protected-resource/mcp`,
      })
      const protectedMetadata = await readJson(protectedResponse)
      const authorizationServers = Array.isArray(protectedMetadata.authorization_servers)
        ? protectedMetadata.authorization_servers
        : []
      requireValue(protectedMetadata.resource === `${origin}/mcp` && authorizationServers.includes(origin), {
        action: "Give OpenWork support the run ID and diagnostic reference.",
        category: "oauth", code: "protected_resource_metadata_mismatch",
        message: "OAuth protected-resource metadata did not describe the expected MCP resource.", owner: "openwork-support",
      })
      const authorizationResponse = await sendRequest({
        category: "oauth", evidence, expectedStatuses: [200], fetchImpl, runId,
        step: "oauth-authorization-server", timeoutMs,
        url: `${origin}/.well-known/oauth-authorization-server`,
      })
      const authorizationMetadata = await readJson(authorizationResponse)
      requireValue(authorizationMetadata.issuer === origin && authorizationMetadata.token_endpoint === `${origin}/oauth/token`, {
        action: "Give OpenWork support the run ID and diagnostic reference.",
        category: "oauth", code: "authorization_server_metadata_mismatch",
        message: "OAuth authorization-server metadata did not describe the expected token endpoint.", owner: "openwork-support",
      })
    },
    "oauth-token": async (evidence) => {
      const form = new URLSearchParams({
        grant_type: "client_credentials",
        resource: `${origin}/mcp`,
        scope: "diagnostics:connectivity",
      })
      const response = await sendRequest({
        category: "oauth", evidence, expectedStatuses: [200], fetchImpl,
        init: {
          body: form.toString(),
          headers: {
            authorization: `Basic ${Buffer.from(`openwork-diagnostics:${input.bearerToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          method: "POST",
        },
        runId, step: "oauth-token", timeoutMs, url: `${origin}/oauth/token`,
      })
      const body = await readJson(response)
      requireValue(body.token_type === "Bearer" && typeof body.access_token === "string" && body.access_token.length > 20, {
        action: "Give OpenWork support the run ID and diagnostic reference.",
        category: "oauth", code: "invalid_token_response",
        message: "The OAuth-shaped token response did not contain a usable synthetic Bearer token.", owner: "openwork-support",
      })
      accessToken = body.access_token
    },
    "mcp-handshake": async (evidence) => {
      const baseHeaders = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      }
      const initialized = await sendRequest({
        category: "mcp", evidence, expectedStatuses: [200], fetchImpl,
        init: {
          body: JSON.stringify({
            id: 1, jsonrpc: "2.0", method: "initialize",
            params: { capabilities: {}, clientInfo: { name: "openwork-den-egress-diagnostics", version: "1.0" }, protocolVersion: "2025-11-25" },
          }),
          headers: baseHeaders, method: "POST",
        },
        runId, step: "mcp-initialize", timeoutMs, url: `${origin}/mcp`,
      })
      const initializedBody = await readJson(initialized)
      const result = asRecord(initializedBody.result)
      const session = initialized.headers.get("mcp-session-id") ?? ""
      const version = initialized.headers.get("mcp-protocol-version") ?? ""
      requireValue(result !== null && result.protocolVersion === "2025-11-25" && session.length > 20 && version === "2025-11-25", {
        action: "Give OpenWork support the run ID and initialize diagnostic reference.",
        category: "mcp", code: "mcp_initialize_contract_mismatch",
        message: "MCP initialization did not return the expected protocol version and session.", owner: "openwork-support",
      })
      const sessionHeaders = { ...baseHeaders, "mcp-protocol-version": version, "mcp-session-id": session }
      await sendRequest({
        category: "mcp", evidence, expectedStatuses: [202], fetchImpl,
        init: { body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }), headers: sessionHeaders, method: "POST" },
        runId, step: "mcp-initialized", timeoutMs, url: `${origin}/mcp`,
      })
      const catalogResponse = await sendRequest({
        category: "mcp", evidence, expectedStatuses: [200], fetchImpl,
        init: { body: JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} }), headers: sessionHeaders, method: "POST" },
        runId, step: "mcp-tools-list", timeoutMs, url: `${origin}/mcp`,
      })
      const catalogBody = await readJson(catalogResponse)
      const catalogResult = asRecord(catalogBody.result)
      requireValue(catalogResult !== null && Array.isArray(catalogResult.tools) && catalogResult.tools.length === 1, {
        action: "Give OpenWork support the run ID and catalog diagnostic reference.",
        category: "mcp", code: "mcp_catalog_contract_mismatch",
        message: "MCP tool discovery did not return the single synthetic diagnostic tool.", owner: "openwork-support",
      })
      const tool = asRecord(catalogResult.tools[0])
      requireValue(tool !== null && typeof tool.name === "string" && tool.name.length > 0, {
        action: "Give OpenWork support the run ID and catalog diagnostic reference.",
        category: "mcp", code: "mcp_tool_name_missing",
        message: "MCP tool discovery returned a tool without a usable name.", owner: "openwork-support",
      })
      const toolResponse = await sendRequest({
        category: "mcp", evidence, expectedStatuses: [200], fetchImpl,
        init: {
          body: JSON.stringify({ id: 3, jsonrpc: "2.0", method: "tools/call", params: { arguments: { query: "private-cloud-egress" }, name: tool.name } }),
          headers: sessionHeaders, method: "POST",
        },
        runId, step: "mcp-tools-call", timeoutMs, url: `${origin}/mcp`,
      })
      const toolBody = await readJson(toolResponse)
      const toolResult = asRecord(toolBody.result)
      requireValue(toolResult !== null && toolResult.isError === false, {
        action: "Give OpenWork support the run ID and tool-call diagnostic reference.",
        category: "mcp", code: "mcp_tool_contract_mismatch",
        message: "The synthetic MCP tool call was not reported as successful.", owner: "openwork-support",
      })
    },
  }

  for (const id of EGRESS_DIAGNOSTIC_STEP_IDS) {
    const definition = stepDefinition[id]
    const startedAt = now()
    const evidence: StepEvidence = { diagnosticIds: [], httpStatuses: [] }
    if (stopped) {
      const completedAt = now()
      steps.push({
        id,
        label: definition.label,
        category: definition.category,
        status: "skipped",
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: Math.max(0, completedAt - startedAt),
        httpStatuses: [],
        diagnosticIds: [],
        code: "blocked_by_previous_failure",
        message: "This step was not attempted because an earlier layer failed.",
        owner: "den-operator",
        action: "Resolve the first failed step, then run the diagnostic again.",
      })
      continue
    }

    try {
      await tasks[id](evidence)
      const completedAt = now()
      highestPassingStep = id
      steps.push({
        id,
        label: definition.label,
        category: definition.category,
        status: "passed",
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: Math.max(0, completedAt - startedAt),
        httpStatuses: evidence.httpStatuses,
        diagnosticIds: evidence.diagnosticIds,
        code: null,
        message: definition.message,
        owner: "openwork-support",
        action: definition.action,
      })
    } catch (error) {
      const failure = error instanceof DiagnosticFailure ? error : networkFailure(error)
      const completedAt = now()
      stopped = true
      failedStep = id
      steps.push({
        id,
        label: definition.label,
        category: failure.category,
        status: "failed",
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: Math.max(0, completedAt - startedAt),
        httpStatuses: evidence.httpStatuses,
        diagnosticIds: evidence.diagnosticIds,
        code: failure.code,
        message: failure.message,
        owner: failure.owner,
        action: failure.action,
      })
    }
  }

  const completedAt = now()
  return {
    runId,
    targetOrigin: origin,
    supportUrl: `${origin}/?runId=${encodeURIComponent(runId)}`,
    startedAt: new Date(runStartedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    overallStatus: failedStep ? "failed" : "passed",
    highestPassingStep,
    failedStep,
    steps,
  }
}
