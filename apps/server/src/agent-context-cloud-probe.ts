const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOOL_COUNT = 100;
const MAX_TOOL_ID_LENGTH = 160;
const MAX_AUTHORIZATION_LENGTH = 8 * 1024;
const MAX_ENDPOINT_LENGTH = 2 * 1024;
const MAX_SESSION_HEADER_LENGTH = 1024;
const MAX_PROTOCOL_HEADER_LENGTH = 128;
const MAX_ACTIVE_PROBES = 16;
const MCP_ACCEPT = "application/json, text/event-stream";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const INITIALIZE_REQUEST_ID = "openwork-agent-diagnostics-initialize";
const TOOL_ID = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const SAFE_RESPONSE_HEADER = /^[!-~]+$/;
const REQUIRED_TOOL_IDS = ["search_capabilities", "execute_capability"] as const;
const REQUIRED_TOOL_ID_SET = new Set<string>(REQUIRED_TOOL_IDS);
const BEARER = /^Bearer [A-Za-z0-9\-._~+/]+=*$/;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const REQUIRED_TERMINAL_PATH = "/mcp/agent";
const DEFAULT_TRUSTED_ORIGINS = new Set([
  "https://app.openworklabs.com",
  "https://api.openworklabs.com",
]);

export type CloudCatalogProbeStatus = "observed" | "not-performed" | "failed";

export type CloudCatalogProbeCode =
  | "catalog_observed"
  | "runtime_config_unavailable"
  | "remote_workspace_unavailable"
  | "cloud_mcp_missing"
  | "cloud_mcp_not_remote"
  | "cloud_mcp_disabled"
  | "cloud_tool_policy_unavailable"
  | "cloud_tool_policy_denied"
  | "invalid_endpoint"
  | "untrusted_endpoint"
  | "credential_missing"
  | "duplicate_authorization"
  | "registration_failed"
  | "registration_disabled"
  | "registration_needs_auth"
  | "registration_needs_client_registration"
  | "registration_not_recorded"
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
  | "rate_limited"
  | "probe_busy"
  | "http_error"
  | "response_too_large"
  | "invalid_content_type"
  | "invalid_response"
  | "jsonrpc_error"
  | "pagination_unsupported"
  | "invalid_catalog";

export type CloudCatalogProbe = {
  performed: boolean;
  toolsListPerformed: boolean;
  status: CloudCatalogProbeStatus;
  code: CloudCatalogProbeCode;
  toolIds: string[];
  durationMs: number;
  httpStatus: number | null;
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
  toolPolicyStatus: "available" | "denied" | "unavailable";
  toolPolicyProvenance: "authoritative-effective-engine" | "passive-static-subset" | "unavailable";
  registrationStatus:
    | "connected"
    | "disabled"
    | "failed"
    | "needs-auth"
    | "needs-client-registration"
    | "not-recorded";
  requestId: string;
  fetchImpl?: CloudCatalogProbeFetch;
  clock?: () => number;
  /** Backward-compatible name used by the analyzer dependency seam. */
  now?: () => number;
  /** Test seam; production callers cannot extend the 12-second ceiling. */
  timeoutMs?: number;
  /** Overall diagnostics deadline; aborting it prevents or cancels egress. */
  signal?: AbortSignal;
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

const activeProbes = new Set<Promise<CloudCatalogProbe>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elapsed(startedAt: number, clock: () => number): number {
  const value = clock() - startedAt;
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function result(
  startedAt: number,
  clock: () => number,
  input: Omit<CloudCatalogProbe, "durationMs" | "toolIds" | "toolsListPerformed"> & {
    toolIds?: string[];
    toolsListPerformed?: boolean;
  },
): CloudCatalogProbe {
  return {
    ...input,
    toolsListPerformed: input.toolsListPerformed ?? false,
    toolIds: input.toolIds ? [...input.toolIds] : [],
    durationMs: elapsed(startedAt, clock),
  };
}

function cloneResult(value: CloudCatalogProbe): CloudCatalogProbe {
  return { ...value, toolIds: [...value.toolIds] };
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (value === "localhost" || value === "::1" || value === "[::1]") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  return Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255);
}

function configuredTrustedOrigins(): Set<string> {
  const origins = new Set(DEFAULT_TRUSTED_ORIGINS);
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

function prepare(input: ProbeOpenworkCloudCatalogInput): PreparedProbe | CloudCatalogProbeCode {
  if (input.workspaceType !== "local") return "remote_workspace_unavailable";
  if (input.runtimeConfigAvailable === false) return "runtime_config_unavailable";
  if (!isRecord(input.config)) return "cloud_mcp_missing";
  if (input.config.type !== "remote") return "cloud_mcp_not_remote";
  if (input.config.enabled !== true) return "cloud_mcp_disabled";
  if (input.toolPolicyStatus === "unavailable") return "cloud_tool_policy_unavailable";
  if (input.toolPolicyStatus === "denied") return "cloud_tool_policy_denied";
  // Absence of a deny in passively inspected config is never authority to
  // send a credentialed request. Only a complete effective-engine snapshot
  // may authorize the catalog probe's available path.
  if (input.toolPolicyProvenance !== "authoritative-effective-engine") {
    return "cloud_tool_policy_unavailable";
  }
  const endpoint = safeCatalogEndpoint(input.config.url);
  if (!endpoint) return "invalid_endpoint";
  if (!isLoopbackHostname(endpoint.hostname) && !configuredTrustedOrigins().has(endpoint.origin)) {
    return "untrusted_endpoint";
  }
  const authorization = authorizationHeader(input.config);
  if (authorization.duplicate) return "duplicate_authorization";
  if (!authorization.value) return "credential_missing";
  if (input.registrationStatus === "failed") return "registration_failed";
  if (input.registrationStatus === "disabled") return "registration_disabled";
  if (input.registrationStatus === "needs-auth") return "registration_needs_auth";
  if (input.registrationStatus === "needs-client-registration") {
    return "registration_needs_client_registration";
  }
  if (input.registrationStatus !== "connected") return "registration_not_recorded";
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
    throw new SafeProbeFailure("invalid_response");
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
    throw new SafeProbeFailure("invalid_response");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SafeProbeFailure("invalid_response");
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
    if (event && event !== "message") throw new SafeProbeFailure("invalid_response");
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
  if (messages.length !== 1) throw new SafeProbeFailure("invalid_response");
  return messages[0];
}

function parseJsonRpcResult(payload: unknown, requestId: string): Record<string, unknown> {
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || payload.id !== requestId) {
    throw new SafeProbeFailure("invalid_response");
  }
  if (Object.hasOwn(payload, "error")) throw new SafeProbeFailure("jsonrpc_error");
  if (!isRecord(payload.result)) throw new SafeProbeFailure("invalid_response");
  return payload.result;
}

function parseToolIds(payload: unknown, requestId: string): string[] {
  const rpcResult = parseJsonRpcResult(payload, requestId);
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
    // Never reflect provider-controlled catalog names into the diagnostic
    // report. In particular, a compromised trusted endpoint must not be able
    // to echo the bearer token back as a syntactically valid tool identifier.
    if (!REQUIRED_TOOL_ID_SET.has(tool.name)) throw new SafeProbeFailure("invalid_catalog");
    if (seen.has(tool.name)) throw new SafeProbeFailure("invalid_catalog");
    seen.add(tool.name);
  }
  if (seen.size !== REQUIRED_TOOL_IDS.length) throw new SafeProbeFailure("invalid_catalog");
  return [...REQUIRED_TOOL_IDS];
}

function httpFailureCode(status: number): CloudCatalogProbeCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 300 && status < 400) return "redirect_rejected";
  return "http_error";
}

function networkFailureCode(error: unknown): CloudCatalogProbeCode {
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : null;
  const code = cause && typeof cause.code === "string" ? cause.code.toUpperCase() : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_error";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ECONNRESET" || code === "EPIPE") return "connection_reset";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (code.includes("PROXY")) return "proxy_error";
  if (
    code.startsWith("ERR_TLS_")
    || code.startsWith("CERT_")
    || code.includes("CERTIFICATE")
    || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    || code === "SELF_SIGNED_CERT_IN_CHAIN"
    || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) return "tls_error";
  return "network_error";
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
    throw new SafeProbeFailure("invalid_response");
  }
  return value;
}

function sessionProbeHeaders(response: Response, authorization: string): Record<string, string> {
  const sessionId = returnedSessionHeader(response, "mcp-session-id", MAX_SESSION_HEADER_LENGTH);
  const protocolVersion = returnedSessionHeader(response, "mcp-protocol-version", MAX_PROTOCOL_HEADER_LENGTH);
  return {
    ...baseProbeHeaders(authorization),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
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

async function performProbe(
  prepared: PreparedProbe,
  requestId: string,
  fetchImpl: CloudCatalogProbeFetch,
  startedAt: number,
  clock: () => number,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<CloudCatalogProbe> {
  const deadline = createDeadline(timeoutMs, parentSignal);
  const budget: ProbeResponseBudget = { remaining: MAX_RESPONSE_BYTES };
  let currentHttpStatus: number | null = null;
  let toolsListPerformed = false;
  try {
    const baseHeaders = baseProbeHeaders(prepared.authorization);
    const initialized = await postJsonRpc(
      prepared,
      baseHeaders,
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
    await requireHttpStatus(initialized, deadline, (status) => status === 200);
    parseJsonRpcResult(await readJsonRpcPayload(initialized, deadline, budget), INITIALIZE_REQUEST_ID);
    const sessionHeaders = sessionProbeHeaders(initialized, prepared.authorization);

    currentHttpStatus = null;
    const acknowledged = await postJsonRpc(
      prepared,
      sessionHeaders,
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      fetchImpl,
      deadline,
    );
    currentHttpStatus = acknowledged.status;
    await requireHttpStatus(acknowledged, deadline, (status) => status >= 200 && status < 300);
    await readBoundedBody(acknowledged, deadline, budget);

    currentHttpStatus = null;
    toolsListPerformed = true;
    const listed = await postJsonRpc(
      prepared,
      sessionHeaders,
      { jsonrpc: "2.0", id: requestId, method: "tools/list", params: {} },
      fetchImpl,
      deadline,
    );
    currentHttpStatus = listed.status;
    await requireHttpStatus(listed, deadline, (status) => status === 200);
    const toolIds = parseToolIds(await readJsonRpcPayload(listed, deadline, budget), requestId);
    return result(startedAt, clock, {
      performed: true,
      status: "observed",
      code: "catalog_observed",
      toolsListPerformed,
      toolIds,
      httpStatus: listed.status,
    });
  } catch (error) {
    const timedOut = error instanceof ProbeTimeout || deadline.timedOut();
    return result(startedAt, clock, {
      performed: true,
      status: "failed",
      code: timedOut
        ? "timeout"
        : error instanceof SafeProbeFailure
          ? error.code
          : networkFailureCode(error),
      toolsListPerformed,
      httpStatus: error instanceof ProbeHttpFailure
        ? error.httpStatus
        : timedOut || error instanceof SafeProbeFailure
          ? currentHttpStatus
          : null,
    });
  } finally {
    deadline.dispose();
  }
}

/**
 * Performs one credential-safe direct catalog observation for the exact
 * runtime-managed OpenWork Cloud entry supplied by the caller. This function
 * never discovers another MCP, follows redirects, calls a tool, or returns
 * endpoint, credential, header, response-body, or caught-error values.
 */
export async function probeOpenworkCloudCatalog(
  input: ProbeOpenworkCloudCatalogInput,
): Promise<CloudCatalogProbe> {
  const clock = input.clock ?? input.now ?? Date.now;
  const startedAt = clock();
  if (input.signal?.aborted) {
    return result(startedAt, clock, {
      performed: false,
      status: "not-performed",
      code: "timeout",
      httpStatus: null,
    });
  }
  const prepared = prepare(input);
  if (typeof prepared === "string") {
    return result(startedAt, clock, {
      performed: false,
      status: "not-performed",
      code: prepared,
      httpStatus: null,
    });
  }

  if (activeProbes.size >= MAX_ACTIVE_PROBES) {
    return result(startedAt, clock, {
      performed: false,
      status: "not-performed",
      code: "probe_busy",
      httpStatus: null,
    });
  }

  const task = performProbe(
    prepared,
    input.requestId,
    input.fetchImpl ?? fetch,
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
