import {
  runtimeDiagnosticFetch,
  runtimeDiagnosticTransportInfo,
  type RuntimeDiagnosticRuntimeFamily,
  type RuntimeDiagnosticTransport,
} from "./server-fetch.js";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOOL_COUNT = 100;
const MAX_TOOL_ID_LENGTH = 160;
const MAX_AUTHORIZATION_LENGTH = 8 * 1024;
const MAX_ENDPOINT_LENGTH = 2 * 1024;
const MAX_SESSION_HEADER_LENGTH = 1024;
const MAX_PROTOCOL_HEADER_LENGTH = 128;
const MAX_STEP_SUMMARIES = 12;
const MAX_ACTIVE_PROBES = 16;
const STALE_ENGINE_EVIDENCE_MS = 60_000;
const MCP_ACCEPT = "application/json, text/event-stream";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const INITIALIZE_REQUEST_ID = "openwork-agent-diagnostics-initialize";
const TOOL_ID = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const SAFE_RESPONSE_HEADER = /^[!-~]+$/;
const SAFE_REFERENCE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const REQUIRED_TOOL_IDS = ["search_capabilities", "execute_capability"] as const;
const BEARER = /^Bearer [A-Za-z0-9\-._~+/]+=*$/;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const REQUIRED_TERMINAL_PATH = "/mcp/agent";
const DEFAULT_TRUSTED_ORIGINS = new Set([
  "https://app.openworklabs.com",
  "https://api.openworklabs.com",
]);

export type CloudCatalogProbeStatus = "observed" | "not-performed" | "failed";

export type CloudCatalogProbeStage =
  | "eligibility"
  | "dns"
  | "connect"
  | "tls"
  | "proxy"
  | "initialize_request"
  | "initialize_http"
  | "initialize_protocol"
  | "initialized_notification"
  | "tools_list_request"
  | "tools_list_http"
  | "tools_list_protocol"
  | "catalog_validation"
  | "session_cleanup"
  | "complete";

export type CloudCatalogProbeNetworkCode =
  | "ENOTFOUND"
  | "EAI_AGAIN"
  | "ECONNREFUSED"
  | "ECONNRESET"
  | "ETIMEDOUT"
  | "UND_ERR_CONNECT_TIMEOUT"
  | "CERT_HAS_EXPIRED"
  | "SELF_SIGNED_CERT_IN_CHAIN"
  | "DEPTH_ZERO_SELF_SIGNED_CERT"
  | "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  | "ERR_TLS_CERT_ALTNAME_INVALID"
  | "PROXY_ERROR"
  | "UNKNOWN_NETWORK_ERROR";

export type CloudCatalogProbeCode =
  | "catalog_observed"
  | "runtime_config_unavailable"
  | "remote_workspace_unavailable"
  | "cloud_mcp_missing"
  | "cloud_mcp_not_remote"
  | "cloud_mcp_disabled"
  | "invalid_endpoint"
  | "untrusted_endpoint"
  | "credential_missing"
  | "duplicate_authorization"
  | "probe_busy"
  | "timeout"
  | "network_error"
  | "dns_error"
  | "connection_refused"
  | "connection_reset"
  | "tls_error"
  | "proxy_error"
  | "redirect_rejected"
  | "unauthorized"
  | "forbidden"
  | "mcp_route_not_found"
  | "rate_limited"
  | "gateway_unavailable"
  | "http_error"
  | "response_too_large"
  | "invalid_content_type"
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_jsonrpc_envelope"
  | "request_id_mismatch"
  | "jsonrpc_error"
  | "unsupported_protocol_version"
  | "invalid_session_header"
  | "pagination_unsupported"
  | "invalid_catalog"
  | "required_tools_missing";

export type CloudEngineRegistrationStatus =
  | "connected"
  | "disabled"
  | "failed"
  | "needs-auth"
  | "needs-client-registration"
  | "not-recorded";

/**
 * Cached engine-side evidence for the exact managed OpenWork Cloud entry.
 * This is a comparison input for the differential verdict; it never gates
 * whether the independent runtime probe is allowed to run.
 */
export type CloudEngineRegistrationEvidence = {
  status: CloudEngineRegistrationStatus;
  source: "transport_failure" | "engine_status" | null;
  recordAgeMs: number | null;
};

export type CloudRuntimeEngineDifferential =
  | "runtime_and_engine_connected"
  | "runtime_connected_engine_failed"
  | "runtime_failed_engine_connected"
  | "runtime_and_engine_failed"
  | "runtime_probe_not_performed"
  | "engine_evidence_stale_or_unavailable";

/**
 * Which allowlist entry authorized the credentialed request, or why none did.
 * Reported instead of the origin itself so an administrator can distinguish
 * "this install is not enterprise activated" from "it is activated, but
 * against a different origin than the configured Cloud MCP" — a real
 * misconfiguration — without the report ever carrying a hostname.
 */
export type CloudEndpointTrustSource =
  | "builtin-cloud"
  | "loopback"
  | "administrator-env"
  | "enterprise-activation"
  | "untrusted"
  /** The endpoint was absent or structurally invalid, so trust never applied. */
  | "not-evaluated";

export type CloudCatalogProbe = {
  performed: boolean;
  trustSource: CloudEndpointTrustSource;
  enterpriseActivationPresent: boolean;
  status: CloudCatalogProbeStatus;
  stage: CloudCatalogProbeStage;
  code: CloudCatalogProbeCode;
  networkCode: CloudCatalogProbeNetworkCode | null;
  retryable: boolean;
  runtimeFamily: RuntimeDiagnosticRuntimeFamily;
  transport: RuntimeDiagnosticTransport;
  httpStatus: number | null;
  durationMs: number;
  toolsListPerformed: boolean;
  sessionEstablished: boolean;
  cleanupAttempted: boolean;
  cleanupSucceeded: boolean | null;
  toolIds: string[];
  totalToolCount: number | null;
  requiredToolsPresent: boolean | null;
  referenceId: string | null;
  proxyConfigured: boolean;
  extraCaConfigured: boolean;
  steps: string[];
  engineRegistrationStatus: CloudEngineRegistrationStatus;
  engineEvidenceSource: "transport_failure" | "engine_status" | null;
  engineEvidenceAgeMs: number | null;
};

export type CloudCatalogProbeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ProbeOpenworkCloudCatalogInput = {
  workspaceId: string;
  workspaceType: "local" | "remote";
  runtimeConfigAvailable?: boolean;
  config: Record<string, unknown> | null | undefined;
  engineRegistration: CloudEngineRegistrationEvidence;
  requestId: string;
  fetchImpl?: CloudCatalogProbeFetch;
  clock?: () => number;
  /** Backward-compatible name used by the analyzer dependency seam. */
  now?: () => number;
  /** Test seam; production callers cannot extend the 12-second ceiling. */
  timeoutMs?: number;
  /** Overall diagnostics deadline; aborting it prevents or cancels egress. */
  signal?: AbortSignal;
  /** Test seam for proxy and extra-CA presence detection. */
  env?: Record<string, string | undefined>;
  /**
   * Exact origin of the enterprise/on-prem Den control plane this install is
   * activated against, resolved by the caller from administrator-provisioned
   * desktop activation state. Null when the install is not enterprise
   * activated; never a renderer- or request-supplied value.
   */
  activatedEnterpriseOrigin?: string | null;
};

type PreparedProbe = {
  endpoint: string;
  authorization: string;
};

class SafeProbeFailure extends Error {
  constructor(readonly code: CloudCatalogProbeCode) {
    super(code);
  }
}

class ProbeHttpFailure extends SafeProbeFailure {
  constructor(code: CloudCatalogProbeCode, readonly httpStatus: number) {
    super(code);
  }
}

class CatalogRequiredToolsFailure extends SafeProbeFailure {
  constructor(readonly totalToolCount: number) {
    super("required_tools_missing");
  }
}

class ProbeTimeout extends Error {}

type ProbeDeadline = {
  signal: AbortSignal;
  race: <T>(operation: Promise<T>) => Promise<T>;
  timedOut: () => boolean;
  dispose: () => void;
};

type ProbeResponseBudget = {
  remaining: number;
};

type ProbeBaseFacts = {
  runtimeFamily: RuntimeDiagnosticRuntimeFamily;
  transport: RuntimeDiagnosticTransport;
  proxyConfigured: boolean;
  extraCaConfigured: boolean;
  trustSource: CloudEndpointTrustSource;
  enterpriseActivationPresent: boolean;
  engineRegistrationStatus: CloudEngineRegistrationStatus;
  engineEvidenceSource: "transport_failure" | "engine_status" | null;
  engineEvidenceAgeMs: number | null;
};

/** Classifies which allowlist entry authorized this exact endpoint origin. */
function resolveTrustSource(
  endpoint: URL,
  activatedEnterpriseOrigin?: string | null,
): CloudEndpointTrustSource {
  if (isLoopbackHostname(endpoint.hostname)) return "loopback";
  if (DEFAULT_TRUSTED_ORIGINS.has(endpoint.origin)) return "builtin-cloud";
  if (activatedEnterpriseOrigin && endpoint.origin === activatedEnterpriseOrigin) {
    return "enterprise-activation";
  }
  if (configuredTrustedOrigins(activatedEnterpriseOrigin).has(endpoint.origin)) {
    return "administrator-env";
  }
  return "untrusted";
}

const activeProbes = new Set<Promise<CloudCatalogProbe>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elapsed(startedAt: number, clock: () => number): number {
  const value = clock() - startedAt;
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function cloneResult(value: CloudCatalogProbe): CloudCatalogProbe {
  return { ...value, toolIds: [...value.toolIds], steps: [...value.steps] };
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (value === "localhost" || value === "::1" || value === "[::1]") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  return Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255);
}

/**
 * Origins the credentialed diagnostic request may reach: built-in OpenWork
 * Cloud origins plus exact administrator-configured diagnostic origins. An
 * enterprise/on-prem Den origin must be provisioned through the same explicit
 * administrator setting; the desktop bootstrap's Den activation state is not
 * visible to this server process, so it can never widen this list implicitly.
 */
function configuredTrustedOrigins(activatedEnterpriseOrigin?: string | null): Set<string> {
  const origins = new Set(DEFAULT_TRUSTED_ORIGINS);
  // The activated enterprise/on-prem control-plane origin is administrator
  // provisioned (written only after a signed activation claim verifies), so
  // it joins the allowlist as an exact origin without an explicit override.
  if (activatedEnterpriseOrigin) origins.add(activatedEnterpriseOrigin);
  const configured = process.env.OPENWORK_AGENT_DIAGNOSTICS_TRUSTED_ORIGINS ?? "";
  for (const entry of configured.split(",")) {
    const raw = entry.trim().replace(/\/+$/u, "");
    if (!raw || raw.includes("?") || raw.includes("#")) continue;
    try {
      const url = new URL(raw);
      if (url.username || url.password || url.pathname !== "/") continue;
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) continue;
      if (raw !== url.origin) continue;
      origins.add(url.origin);
    } catch {
      // Invalid administrator entries fail closed.
    }
  }
  return origins;
}

function safeCatalogEndpoint(rawValue: unknown): URL | null {
  if (typeof rawValue !== "string") return null;
  const raw = rawValue.trim();
  if (!raw || raw.length > MAX_ENDPOINT_LENGTH || raw.includes("?") || raw.includes("#")) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/iu.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) return null;
    // Deployments can mount Den below an origin-specific prefix, but the MCP
    // route itself must be the final two path segments. The report therefore
    // describes this as terminal-path evidence, not a canonical full URL.
    if (!url.pathname.endsWith(REQUIRED_TERMINAL_PATH) || url.pathname.endsWith(REQUIRED_TERMINAL_PATH + "/")) return null;
    if (url.origin !== raw.slice(0, raw.length - url.pathname.length)) return null;
    return url;
  } catch {
    return null;
  }
}

function authorizationHeader(config: Record<string, unknown>): { value: string | null; duplicate: boolean } {
  if (!isRecord(config.headers)) return { value: null, duplicate: false };
  const matches = Object.entries(config.headers)
    .filter(([name]) => name.toLowerCase() === "authorization");
  if (matches.length > 1) return { value: null, duplicate: true };
  const value = matches[0]?.[1];
  if (typeof value !== "string" || value.length > MAX_AUTHORIZATION_LENGTH || !BEARER.test(value)) {
    return { value: null, duplicate: false };
  }
  return { value, duplicate: false };
}

/**
 * Eligibility is deliberately independent of cached OpenCode registration
 * state and of agent tool policy: the probe exists to diagnose engine-side
 * failures, and tool visibility is a separate diagnostic dimension reported
 * by its own check. Only structural, trust, credential, and privacy
 * boundaries can skip the probe.
 */
function prepare(input: ProbeOpenworkCloudCatalogInput): PreparedProbe | CloudCatalogProbeCode {
  if (input.workspaceType !== "local") return "remote_workspace_unavailable";
  if (input.runtimeConfigAvailable === false) return "runtime_config_unavailable";
  if (!isRecord(input.config)) return "cloud_mcp_missing";
  if (input.config.type !== "remote") return "cloud_mcp_not_remote";
  if (input.config.enabled !== true) return "cloud_mcp_disabled";
  const endpoint = safeCatalogEndpoint(input.config.url);
  if (!endpoint) return "invalid_endpoint";
  if (
    !isLoopbackHostname(endpoint.hostname)
    && !configuredTrustedOrigins(input.activatedEnterpriseOrigin).has(endpoint.origin)
  ) {
    return "untrusted_endpoint";
  }
  const authorization = authorizationHeader(input.config);
  if (authorization.duplicate) return "duplicate_authorization";
  if (!authorization.value) return "credential_missing";
  if (!REQUEST_ID.test(input.requestId)) return "invalid_endpoint";
  return {
    endpoint: endpoint.toString(),
    authorization: authorization.value,
  };
}

function createDeadline(timeoutMs: number, parentSignal?: AbortSignal): ProbeDeadline {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let disposed = false;
  let rejectDeadline: ((reason: ProbeTimeout) => void) | undefined;
  const deadlinePromise = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  // A parent can abort in the tiny window before the first race is installed.
  // Mark the promise handled while preserving its rejection for every race.
  void deadlinePromise.catch(() => undefined);
  const expire = () => {
    if (expired || disposed) return;
    expired = true;
    // Settle the deadline before aborting the underlying operation so an
    // abort-aware fetch/stream cannot win the race with a generic error.
    rejectDeadline?.(new ProbeTimeout());
    controller.abort();
  };
  const parentAbort = () => expire();
  if (parentSignal?.aborted) {
    expire();
  } else {
    parentSignal?.addEventListener("abort", parentAbort, { once: true });
  }
  timeout = setTimeout(expire, timeoutMs);
  return {
    signal: controller.signal,
    race: <T>(operation: Promise<T>) => Promise.race([operation, deadlinePromise]),
    timedOut: () => expired,
    dispose: () => {
      disposed = true;
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", parentAbort);
    },
  };
}

async function cancelBody(response: Response, deadline?: ProbeDeadline): Promise<void> {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) await (deadline ? deadline.race(cancellation) : cancellation);
  } catch {
    // Cancellation is best effort and its error is never reported.
  }
}

async function readBoundedBody(
  response: Response,
  deadline: ProbeDeadline,
  budget: ProbeResponseBudget,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > budget.remaining) {
    await cancelBody(response, deadline);
    throw new SafeProbeFailure("response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await deadline.race(reader.read());
      if (next.done) break;
      size += next.value.byteLength;
      if (next.value.byteLength > budget.remaining) {
        await deadline.race(reader.cancel());
        throw new SafeProbeFailure("response_too_large");
      }
      budget.remaining -= next.value.byteLength;
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof SafeProbeFailure) throw error;
    // Invoke cancellation even after the deadline has fired. Do not await it:
    // a hostile stream can ignore both AbortSignal and cancellation.
    void reader.cancel().catch(() => undefined);
    if (error instanceof ProbeTimeout || deadline.timedOut()) throw new ProbeTimeout();
    // Mid-body transport failures keep their original cause so the outer
    // classifier can attribute them to the network layer, not the protocol.
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SafeProbeFailure("invalid_utf8");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SafeProbeFailure("invalid_json");
  }
}

function parseSse(text: string): unknown {
  const messages: unknown[] = [];
  let event = "";
  let data: string[] = [];
  const dispatch = () => {
    if (data.length === 0) {
      event = "";
      return;
    }
    if (event && event !== "message") throw new SafeProbeFailure("invalid_json");
    messages.push(parseJson(data.join("\n")));
    event = "";
    data = [];
  };
  for (const line of text.split(/\r\n|\r|\n/u)) {
    if (line === "") {
      dispatch();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const rawValue = colon < 0 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  dispatch();
  if (messages.length !== 1) throw new SafeProbeFailure("invalid_json");
  return messages[0];
}

function parseJsonRpcResult(payload: unknown, requestId: string): Record<string, unknown> {
  if (!isRecord(payload) || payload.jsonrpc !== "2.0") {
    throw new SafeProbeFailure("invalid_jsonrpc_envelope");
  }
  if (Object.hasOwn(payload, "error")) throw new SafeProbeFailure("jsonrpc_error");
  if (payload.id !== requestId) throw new SafeProbeFailure("request_id_mismatch");
  if (!isRecord(payload.result)) throw new SafeProbeFailure("invalid_jsonrpc_envelope");
  return payload.result;
}

function requireSupportedProtocolVersion(initializeResult: Record<string, unknown>): void {
  const version = initializeResult.protocolVersion;
  if (typeof version !== "string" || version.length === 0 || version.length > MAX_PROTOCOL_HEADER_LENGTH) {
    throw new SafeProbeFailure("invalid_jsonrpc_envelope");
  }
  if (version !== MCP_PROTOCOL_VERSION) throw new SafeProbeFailure("unsupported_protocol_version");
}

function validateCatalog(rpcResult: Record<string, unknown>): { toolIds: string[]; totalToolCount: number } {
  if (rpcResult.nextCursor !== undefined && rpcResult.nextCursor !== null) {
    throw new SafeProbeFailure("pagination_unsupported");
  }
  if (!Array.isArray(rpcResult.tools) || rpcResult.tools.length > MAX_TOOL_COUNT) {
    throw new SafeProbeFailure("invalid_catalog");
  }
  const seen = new Set<string>();
  for (const tool of rpcResult.tools) {
    if (!isRecord(tool) || typeof tool.name !== "string" || tool.name.length > MAX_TOOL_ID_LENGTH || !TOOL_ID.test(tool.name)) {
      throw new SafeProbeFailure("invalid_catalog");
    }
    if (seen.has(tool.name)) throw new SafeProbeFailure("invalid_catalog");
    seen.add(tool.name);
  }
  // Additional provider tools are forward-compatible and allowed, but never
  // reflect provider-controlled catalog names into the diagnostic report. In
  // particular, a compromised trusted endpoint must not be able to echo the
  // bearer token back as a syntactically valid tool identifier. Only the
  // expected allowlisted IDs and the aggregate count are exported.
  const missing = REQUIRED_TOOL_IDS.filter((toolId) => !seen.has(toolId));
  if (missing.length > 0) throw new CatalogRequiredToolsFailure(rpcResult.tools.length);
  return { toolIds: [...REQUIRED_TOOL_IDS], totalToolCount: rpcResult.tools.length };
}

function httpFailureCode(status: number): CloudCatalogProbeCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "mcp_route_not_found";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504) return "gateway_unavailable";
  if (status >= 300 && status < 400) return "redirect_rejected";
  return "http_error";
}

function classifyNetworkError(error: unknown): { code: CloudCatalogProbeCode; networkCode: CloudCatalogProbeNetworkCode } {
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : null;
  const code = cause && typeof cause.code === "string" ? cause.code.toUpperCase() : "";
  if (code === "ENOTFOUND") return { code: "dns_error", networkCode: "ENOTFOUND" };
  if (code === "EAI_AGAIN") return { code: "dns_error", networkCode: "EAI_AGAIN" };
  if (code === "ECONNREFUSED") return { code: "connection_refused", networkCode: "ECONNREFUSED" };
  if (code === "ECONNRESET" || code === "EPIPE") return { code: "connection_reset", networkCode: "ECONNRESET" };
  if (code === "ETIMEDOUT") return { code: "timeout", networkCode: "ETIMEDOUT" };
  if (code === "UND_ERR_CONNECT_TIMEOUT") return { code: "timeout", networkCode: "UND_ERR_CONNECT_TIMEOUT" };
  if (code.includes("PROXY")) return { code: "proxy_error", networkCode: "PROXY_ERROR" };
  if (code === "CERT_HAS_EXPIRED") return { code: "tls_error", networkCode: "CERT_HAS_EXPIRED" };
  if (code === "SELF_SIGNED_CERT_IN_CHAIN") return { code: "tls_error", networkCode: "SELF_SIGNED_CERT_IN_CHAIN" };
  if (code === "DEPTH_ZERO_SELF_SIGNED_CERT") return { code: "tls_error", networkCode: "DEPTH_ZERO_SELF_SIGNED_CERT" };
  if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return { code: "tls_error", networkCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" };
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return { code: "tls_error", networkCode: "ERR_TLS_CERT_ALTNAME_INVALID" };
  if (code.startsWith("ERR_TLS_") || code.startsWith("CERT_") || code.includes("CERTIFICATE")) {
    return { code: "tls_error", networkCode: "UNKNOWN_NETWORK_ERROR" };
  }
  return { code: "network_error", networkCode: "UNKNOWN_NETWORK_ERROR" };
}

function networkStageFor(networkCode: CloudCatalogProbeNetworkCode): CloudCatalogProbeStage | null {
  if (networkCode === "ENOTFOUND" || networkCode === "EAI_AGAIN") return "dns";
  if (
    networkCode === "ECONNREFUSED"
    || networkCode === "ECONNRESET"
    || networkCode === "ETIMEDOUT"
    || networkCode === "UND_ERR_CONNECT_TIMEOUT"
  ) return "connect";
  if (networkCode === "PROXY_ERROR") return "proxy";
  if (networkCode === "UNKNOWN_NETWORK_ERROR") return null;
  return "tls";
}

/**
 * Retryability is derived only from the closed code sets, never from raw
 * error message text: transient DNS, timeouts, resets, rate limits, gateway
 * availability, and local probe-capacity exhaustion are retryable; TLS
 * validation, credential, route, protocol, and catalog failures are not.
 */
function retryableFor(code: CloudCatalogProbeCode, networkCode: CloudCatalogProbeNetworkCode | null): boolean {
  if (networkCode === "EAI_AGAIN" || networkCode === "ETIMEDOUT" || networkCode === "UND_ERR_CONNECT_TIMEOUT" || networkCode === "ECONNRESET") {
    return true;
  }
  switch (code) {
    case "timeout":
    case "connection_reset":
    case "rate_limited":
    case "gateway_unavailable":
    case "probe_busy":
      return true;
    default:
      return false;
  }
}

function stepPhaseFor(stage: CloudCatalogProbeStage): string {
  if (stage === "initialize_request" || stage === "initialize_http" || stage === "initialize_protocol") return "initialize";
  if (stage === "tools_list_request" || stage === "tools_list_http" || stage === "tools_list_protocol") return "tools_list";
  return stage;
}

function proxyEnvConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.HTTPS_PROXY?.trim()
    || env.https_proxy?.trim()
    || env.HTTP_PROXY?.trim()
    || env.http_proxy?.trim()
    || env.ALL_PROXY?.trim()
    || env.all_proxy?.trim(),
  );
}

function extraCaEnvConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.NODE_EXTRA_CA_CERTS?.trim());
}

function baseProbeHeaders(authorization: string): Record<string, string> {
  return {
    Accept: MCP_ACCEPT,
    Authorization: authorization,
    "Content-Type": "application/json",
  };
}

function returnedSessionHeader(response: Response, name: string, maxLength: number): string | undefined {
  const value = response.headers.get(name);
  if (value === null) return undefined;
  if (value.length === 0 || value.length > maxLength || !SAFE_RESPONSE_HEADER.test(value)) {
    throw new SafeProbeFailure("invalid_session_header");
  }
  return value;
}

function captureReferenceId(response: Response, current: string | null): string | null {
  const value = response.headers.get("x-request-id");
  if (value !== null && SAFE_REFERENCE_ID.test(value)) return value;
  return current;
}

type ProbeSession = {
  headers: Record<string, string>;
  sessionId: string | undefined;
  protocolVersion: string | undefined;
};

function sessionProbe(response: Response, authorization: string): ProbeSession {
  const sessionId = returnedSessionHeader(response, "mcp-session-id", MAX_SESSION_HEADER_LENGTH);
  const protocolVersion = returnedSessionHeader(response, "mcp-protocol-version", MAX_PROTOCOL_HEADER_LENGTH);
  return {
    headers: {
      ...baseProbeHeaders(authorization),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    sessionId,
    protocolVersion,
  };
}

async function postJsonRpc(
  prepared: PreparedProbe,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  fetchImpl: CloudCatalogProbeFetch,
  deadline: ProbeDeadline,
): Promise<Response> {
  if (deadline.timedOut()) throw new ProbeTimeout();
  return deadline.race(fetchImpl(prepared.endpoint, {
    method: "POST",
    // Manual mode applies to every handshake phase so credentials and MCP
    // session headers never reach a redirect target.
    redirect: "manual",
    headers,
    body: JSON.stringify(body),
    signal: deadline.signal,
  }));
}

async function requireHttpStatus(
  response: Response,
  deadline: ProbeDeadline,
  accepted: (status: number) => boolean,
): Promise<void> {
  if (accepted(response.status)) return;
  await cancelBody(response, deadline);
  throw new ProbeHttpFailure(httpFailureCode(response.status), response.status);
}

async function readJsonRpcPayload(
  response: Response,
  deadline: ProbeDeadline,
  budget: ProbeResponseBudget,
): Promise<unknown> {
  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" && mediaType !== "text/event-stream") {
    await cancelBody(response, deadline);
    throw new SafeProbeFailure("invalid_content_type");
  }
  const body = await readBoundedBody(response, deadline, budget);
  return mediaType === "text/event-stream" ? parseSse(body) : parseJson(body);
}

/**
 * Bounded best-effort termination of the diagnostic MCP session. Failure here
 * is reported but never converts a successful availability observation into
 * a failed one.
 */
async function terminateSession(
  prepared: PreparedProbe,
  session: ProbeSession,
  fetchImpl: CloudCatalogProbeFetch,
  deadline: ProbeDeadline,
): Promise<boolean> {
  try {
    const response = await deadline.race(fetchImpl(prepared.endpoint, {
      method: "DELETE",
      redirect: "manual",
      headers: {
        Accept: MCP_ACCEPT,
        Authorization: prepared.authorization,
        ...(session.sessionId ? { "mcp-session-id": session.sessionId } : {}),
        ...(session.protocolVersion ? { "mcp-protocol-version": session.protocolVersion } : {}),
      },
      signal: deadline.signal,
    }));
    await cancelBody(response, deadline);
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

async function performProbe(
  prepared: PreparedProbe,
  requestId: string,
  fetchImpl: CloudCatalogProbeFetch,
  base: ProbeBaseFacts,
  startedAt: number,
  clock: () => number,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<CloudCatalogProbe> {
  const deadline = createDeadline(timeoutMs, parentSignal);
  const budget: ProbeResponseBudget = { remaining: MAX_RESPONSE_BYTES };
  const steps: string[] = [];
  const record = (label: string) => {
    if (steps.length < MAX_STEP_SUMMARIES) steps.push(label);
  };
  let stage: CloudCatalogProbeStage = "initialize_request";
  let currentHttpStatus: number | null = null;
  let toolsListPerformed = false;
  let session: ProbeSession | null = null;
  let referenceId: string | null = null;
  let totalToolCount: number | null = null;
  let requiredToolsPresent: boolean | null = null;
  let toolIds: string[] = [];
  let failure: {
    stage: CloudCatalogProbeStage;
    code: CloudCatalogProbeCode;
    networkCode: CloudCatalogProbeNetworkCode | null;
    httpStatus: number | null;
  } | null = null;
  let phaseStart = clock();
  const phaseMs = () => `${elapsed(phaseStart, clock)}ms`;
  try {
    let initialized = await postJsonRpc(
      prepared,
      baseProbeHeaders(prepared.authorization),
      {
        jsonrpc: "2.0",
        id: INITIALIZE_REQUEST_ID,
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "openwork-server-agent-context-diagnostics", version: "1.0.0" },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
      },
      fetchImpl,
      deadline,
    );
    currentHttpStatus = initialized.status;
    referenceId = captureReferenceId(initialized, referenceId);
    if (initialized.status === 401) {
      await cancelBody(initialized, deadline);
      record(`initialize transient 401 observed ${phaseMs()}`);
      currentHttpStatus = null;
      initialized = await postJsonRpc(
        prepared,
        baseProbeHeaders(prepared.authorization),
        {
          jsonrpc: "2.0",
          id: INITIALIZE_REQUEST_ID,
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "openwork-server-agent-context-diagnostics", version: "1.0.0" },
            protocolVersion: MCP_PROTOCOL_VERSION,
          },
        },
        fetchImpl,
        deadline,
      );
      currentHttpStatus = initialized.status;
      referenceId = captureReferenceId(initialized, referenceId);
      if (initialized.status === 200) record(`initialize recovered after transient 401 ${phaseMs()}`);
    }
    stage = "initialize_http";
    await requireHttpStatus(initialized, deadline, (status) => status === 200);
    stage = "initialize_protocol";
    const initializeResult = parseJsonRpcResult(
      await readJsonRpcPayload(initialized, deadline, budget),
      INITIALIZE_REQUEST_ID,
    );
    requireSupportedProtocolVersion(initializeResult);
    session = sessionProbe(initialized, prepared.authorization);
    record(`initialize ok ${initialized.status} ${phaseMs()}`);

    phaseStart = clock();
    stage = "initialized_notification";
    currentHttpStatus = null;
    const acknowledged = await postJsonRpc(
      prepared,
      session.headers,
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      fetchImpl,
      deadline,
    );
    currentHttpStatus = acknowledged.status;
    referenceId = captureReferenceId(acknowledged, referenceId);
    await requireHttpStatus(acknowledged, deadline, (status) => status >= 200 && status < 300);
    await readBoundedBody(acknowledged, deadline, budget);
    record(`initialized_notification ok ${acknowledged.status} ${phaseMs()}`);

    phaseStart = clock();
    stage = "tools_list_request";
    currentHttpStatus = null;
    toolsListPerformed = true;
    const listed = await postJsonRpc(
      prepared,
      session.headers,
      { jsonrpc: "2.0", id: requestId, method: "tools/list", params: {} },
      fetchImpl,
      deadline,
    );
    currentHttpStatus = listed.status;
    referenceId = captureReferenceId(listed, referenceId);
    stage = "tools_list_http";
    await requireHttpStatus(listed, deadline, (status) => status === 200);
    stage = "tools_list_protocol";
    const listResult = parseJsonRpcResult(await readJsonRpcPayload(listed, deadline, budget), requestId);
    stage = "catalog_validation";
    const catalog = validateCatalog(listResult);
    toolIds = catalog.toolIds;
    totalToolCount = catalog.totalToolCount;
    requiredToolsPresent = true;
    record(`tools_list ok ${listed.status} ${phaseMs()}`);
    stage = "complete";
  } catch (error) {
    const timedOut = error instanceof ProbeTimeout || deadline.timedOut();
    if (error instanceof CatalogRequiredToolsFailure) {
      totalToolCount = error.totalToolCount;
      requiredToolsPresent = false;
    }
    let code: CloudCatalogProbeCode;
    let networkCode: CloudCatalogProbeNetworkCode | null = null;
    let failureStage: CloudCatalogProbeStage = stage;
    if (timedOut) {
      code = "timeout";
    } else if (error instanceof SafeProbeFailure) {
      code = error.code;
    } else {
      const classified = classifyNetworkError(error);
      code = classified.code;
      networkCode = classified.networkCode;
      failureStage = networkStageFor(classified.networkCode) ?? stage;
    }
    failure = {
      stage: failureStage,
      code,
      networkCode,
      httpStatus: error instanceof ProbeHttpFailure
        ? error.httpStatus
        : timedOut || error instanceof SafeProbeFailure
          ? currentHttpStatus
          : null,
    };
    record(`${stepPhaseFor(stage)} failed ${code} ${phaseMs()}`);
  }

  let cleanupAttempted = false;
  let cleanupSucceeded: boolean | null = null;
  if (session?.sessionId !== undefined && !deadline.timedOut()) {
    phaseStart = clock();
    cleanupAttempted = true;
    cleanupSucceeded = await terminateSession(prepared, session, fetchImpl, deadline);
    record(`session_cleanup ${cleanupSucceeded ? "ok" : "failed"} ${phaseMs()}`);
  }
  deadline.dispose();

  const common = {
    performed: true,
    toolsListPerformed,
    sessionEstablished: session?.sessionId !== undefined,
    cleanupAttempted,
    cleanupSucceeded,
    totalToolCount,
    requiredToolsPresent,
    referenceId,
    steps,
    durationMs: elapsed(startedAt, clock),
    ...base,
  };
  if (failure) {
    return {
      ...common,
      status: "failed",
      stage: failure.stage,
      code: failure.code,
      networkCode: failure.networkCode,
      retryable: retryableFor(failure.code, failure.networkCode),
      httpStatus: failure.httpStatus,
      toolIds: [],
    };
  }
  return {
    ...common,
    status: "observed",
    stage: "complete",
    code: "catalog_observed",
    networkCode: null,
    retryable: false,
    httpStatus: currentHttpStatus,
    toolIds,
  };
}

/**
 * Compares the independent runtime observation with the engine's cached
 * registration evidence for the same managed entry, so a report can implicate
 * the correct runtime boundary instead of collapsing both into one failure.
 */
export function differentialCloudVerdict(
  probe: CloudCatalogProbe,
  engineReachableNow: boolean,
): CloudRuntimeEngineDifferential {
  if (!probe.performed) return "runtime_probe_not_performed";
  if (probe.engineRegistrationStatus === "not-recorded") return "engine_evidence_stale_or_unavailable";
  const engineConnected = probe.engineRegistrationStatus === "connected";
  // A connected record is the engine's standing state and ages naturally
  // between syncs, so it stays trustworthy. Only a failure record the
  // reachable engine could already have refreshed is downgraded, mirroring
  // the mcp_registration_stale_failure rule on the sync check.
  if (
    !engineConnected
    && engineReachableNow
    && probe.engineEvidenceAgeMs !== null
    && probe.engineEvidenceAgeMs > STALE_ENGINE_EVIDENCE_MS
  ) {
    return "engine_evidence_stale_or_unavailable";
  }
  const runtimeConnected = probe.status === "observed";
  if (runtimeConnected && engineConnected) return "runtime_and_engine_connected";
  if (runtimeConnected) return "runtime_connected_engine_failed";
  if (engineConnected) return "runtime_failed_engine_connected";
  return "runtime_and_engine_failed";
}

/**
 * Performs one credential-safe direct verification of the exact
 * runtime-managed OpenWork Cloud entry supplied by the caller, running the
 * complete bounded MCP handshake (initialize, initialized notification,
 * tools/list, best-effort session termination) on the OpenWork runtime's own
 * fetch stack. This function never discovers another MCP, follows redirects,
 * calls a tool, mutates configuration, or returns endpoint, credential,
 * header, response-body, or caught-error values.
 */
export async function probeOpenworkCloudCatalog(
  input: ProbeOpenworkCloudCatalogInput,
): Promise<CloudCatalogProbe> {
  const clock = input.clock ?? input.now ?? Date.now;
  const startedAt = clock();
  const env = input.env ?? process.env;
  const transportInfo = input.fetchImpl
    ? { runtimeFamily: runtimeDiagnosticTransportInfo().runtimeFamily, transport: "test-seam" as const }
    : runtimeDiagnosticTransportInfo();
  const endpointForTrust = isRecord(input.config) ? safeCatalogEndpoint(input.config.url) : null;
  const base: ProbeBaseFacts = {
    runtimeFamily: transportInfo.runtimeFamily,
    transport: transportInfo.transport,
    proxyConfigured: proxyEnvConfigured(env),
    extraCaConfigured: extraCaEnvConfigured(env),
    trustSource: endpointForTrust
      ? resolveTrustSource(endpointForTrust, input.activatedEnterpriseOrigin)
      : "not-evaluated",
    enterpriseActivationPresent: Boolean(input.activatedEnterpriseOrigin),
    engineRegistrationStatus: input.engineRegistration.status,
    engineEvidenceSource: input.engineRegistration.source,
    engineEvidenceAgeMs: input.engineRegistration.recordAgeMs,
  };
  const notPerformed = (code: CloudCatalogProbeCode): CloudCatalogProbe => ({
    performed: false,
    status: "not-performed",
    stage: "eligibility",
    code,
    networkCode: null,
    retryable: retryableFor(code, null),
    httpStatus: null,
    durationMs: elapsed(startedAt, clock),
    toolsListPerformed: false,
    sessionEstablished: false,
    cleanupAttempted: false,
    cleanupSucceeded: null,
    toolIds: [],
    totalToolCount: null,
    requiredToolsPresent: null,
    referenceId: null,
    steps: [`eligibility ${code}`],
    ...base,
  });
  if (input.signal?.aborted) return notPerformed("timeout");
  const prepared = prepare(input);
  if (typeof prepared === "string") return notPerformed(prepared);
  if (activeProbes.size >= MAX_ACTIVE_PROBES) return notPerformed("probe_busy");

  const task = performProbe(
    prepared,
    input.requestId,
    input.fetchImpl ?? runtimeDiagnosticFetch,
    base,
    startedAt,
    clock,
    Math.min(REQUEST_TIMEOUT_MS, Math.max(1, Math.round(input.timeoutMs ?? REQUEST_TIMEOUT_MS))),
    input.signal,
  );
  activeProbes.add(task);
  try {
    return cloneResult(await task);
  } finally {
    activeProbes.delete(task);
  }
}
