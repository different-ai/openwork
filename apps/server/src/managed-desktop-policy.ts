import { randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { desktopConfigSchema, type DesktopConfig } from "@openwork/types/den/desktop-policies-runtime";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";
import type { ServerConfig } from "./types.js";
import { isRecord } from "./workspace-kv-store.js";
import { externalFetch } from "./server-fetch.js";
import { ApiError } from "./errors.js";
import { readGlobalRuntimeOpencodeConfig, writeManagedDesktopPolicy, runtimeProviderMap } from "./runtime-opencode-config-store.js";
import { policyDenial, policyRequestActions, type ManagedPolicyAction } from "./managed-policy-rules.js";

const services = new WeakMap<ServerConfig, ManagedDesktopPolicy>();
// The first cold read previously had 10s; keep two reads under the 15s plugin budget and one read under the 10s session-install budget.
const DEN_READ_DEADLINE_MS = 6_000;
const DEN_READ_ATTEMPT_TIMEOUT_MS = 3_500;
const DEN_READ_MAX_ATTEMPTS = 2;
const DEN_READ_RETRY_DELAY_MS = 200;
const RETRYABLE_DEN_STATUSES = new Set([502, 503, 504]);
const RETRYABLE_TRANSPORT_CODES = new Set([
  "ABORT_ERR",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
type DenRetryReason = "http_transient" | "transport_temporary" | "transport_timeout";

function transientTransportReason(error: unknown): DenRetryReason | null {
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 6 && isRecord(current) && !visited.has(current); depth += 1) {
    visited.add(current);
    if (current.name === "AbortError" || current.name === "TimeoutError" || current.code === "ABORT_ERR"
      || current.code === "ETIMEDOUT" || current.code === "UND_ERR_CONNECT_TIMEOUT" || current.code === "UND_ERR_HEADERS_TIMEOUT") {
      return "transport_timeout";
    }
    if (current.name === "NetworkError" || (typeof current.code === "string" && RETRYABLE_TRANSPORT_CODES.has(current.code))) {
      return "transport_temporary";
    }
    current = current.cause;
  }
  return null;
}

export function managedDesktopPolicy(config: ServerConfig): ManagedDesktopPolicy {
  const existing = services.get(config);
  if (existing) return existing;
  const service = new ManagedDesktopPolicy(config);
  services.set(config, service);
  return service;
}
class ManagedDesktopPolicy {
  // Only the evaluation route accepts this ephemeral engine credential.
  readonly evaluationToken = randomBytes(32).toString("base64url");
  private session: CloudProviderDenSession | null = null;
  private generation = 0;
  private fetching: { generation: number; promise: Promise<DesktopConfig | null> } | undefined;
  onChange: (() => void) | undefined;
  constructor(private readonly config: ServerConfig) {}
  authenticatesEvaluation(request: Request): boolean {
    const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!supplied) return false;
    const actual = Buffer.from(supplied);
    const expected = Buffer.from(this.evaluationToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  async setSession(session: CloudProviderDenSession): Promise<void> {
    // The desktop re-delivers the same identity on every launch, reload, and
    // resume. Only a different account may invalidate in-flight verifications.
    const current = this.session;
    if (!current || current.baseUrl !== session.baseUrl || current.token !== session.token || current.orgId !== session.orgId) {
      this.generation++;
    }
    this.session = session;
    await this.current();
  }
  async clearSession(): Promise<void> {
    this.session = null;
    this.generation++;
    // Keep the last managed restrictions until a fresh identity is verified.
  }
  current(): Promise<DesktopConfig | null> {
    if (this.fetching?.generation === this.generation) return this.fetching.promise;
    const generation = this.generation;
    const promise = this.fetchCurrent();
    this.fetching = { generation, promise };
    void promise.finally(() => { if (this.fetching?.promise === promise) this.fetching = undefined; }).catch(() => undefined);
    return promise;
  }
  private identityChanged(generation: number): void {
    if (generation !== this.generation) throw new ApiError(409, "policy_identity_changed", "The signed-in account changed. Retry the action.");
  }
  private async readDenJson(session: CloudProviderDenSession, path: string, generation: number, allowNotFound = false): Promise<unknown> {
    const deadline = performance.now() + DEN_READ_DEADLINE_MS;
    for (let attempt = 1; attempt <= DEN_READ_MAX_ATTEMPTS; attempt += 1) {
      this.identityChanged(generation);
      if (attempt > 1) {
        // An immediate retry can hit the same brief outage and leave a page's
        // stylesheet canceled. Back off inside the existing deadline, without
        // adding attempts or retrying denials, rate limits, or identity changes.
        if (deadline - performance.now() <= DEN_READ_RETRY_DELAY_MS) throw new Error("Den read deadline exceeded");
        await delay(DEN_READ_RETRY_DELAY_MS);
        this.identityChanged(generation);
      }
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs <= 0) throw new Error("Den read deadline exceeded");
      try {
        const response = await externalFetch(`${session.baseUrl}${path}`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${session.token}`, "x-openwork-org-id": session.orgId, "x-openwork-legacy-org-id": session.orgId },
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(DEN_READ_ATTEMPT_TIMEOUT_MS, remainingMs)),
        });
        this.identityChanged(generation);
        if (allowNotFound && response.status === 404) return null;
        if (!response.ok) {
          if (attempt < DEN_READ_MAX_ATTEMPTS && RETRYABLE_DEN_STATUSES.has(response.status)) {
            console.warn("[openwork:managed-policy] retrying Den verification", {
              reason: "http_transient", status: response.status, attempt: attempt + 1,
            });
            void response.body?.cancel().catch(() => undefined);
            continue;
          }
          throw new Error("Den request failed");
        }
        const payload: unknown = await response.json();
        this.identityChanged(generation);
        return payload;
      } catch (error) {
        this.identityChanged(generation);
        const reason = transientTransportReason(error);
        if (attempt < DEN_READ_MAX_ATTEMPTS && reason && performance.now() < deadline) {
          console.warn("[openwork:managed-policy] retrying Den verification", {
            reason, status: null, attempt: attempt + 1,
          });
          continue;
        }
        throw error;
      }
    }
    throw new Error("Den request failed");
  }
  private async fetchCurrent(): Promise<DesktopConfig | null> {
    const session = this.session;
    if (!session) {
      const persisted = await readGlobalRuntimeOpencodeConfig(this.config);
      if (persisted.managedPolicy) throw new ApiError(403, "policy_unavailable", "Sign in to verify your organization's policy before continuing.");
      return null;
    }
    const generation = this.generation;
    let policy: DesktopConfig;
    try {
      policy = desktopConfigSchema.parse(await this.readDenJson(session, "/v1/me/desktop-config", generation));
    } catch (error) {
      if (error instanceof ApiError && error.code === "policy_identity_changed") throw error;
      throw new ApiError(403, "policy_unavailable", "Your organization's policy could not be verified. Try again when connected.");
    }
    if (generation !== this.generation) throw new ApiError(409, "policy_identity_changed", "The signed-in account changed. Retry the action.");
    const result = await writeManagedDesktopPolicy(this.config, policy);
    if (generation !== this.generation) throw new ApiError(409, "policy_identity_changed", "The signed-in account changed. Retry the action.");
    if (result.changed) this.onChange?.();
    return policy;
  }
  async assertRequest(request: Request, path: string, engine = false): Promise<void> {
    const decoded = decodeURIComponent(path);
    const terminal = engine && /\/(?:shell|pty|persistent-pty|terminal)(?:\/|$)/.test(decoded);
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) && !terminal) return;
    if (!engine) {
      for (const action of policyRequestActions(request.method, decoded)) await this.assert(action);
      if (/\/files\/(?:raw|content|sessions\/[^/]+\/ops)$/.test(decoded)) {
        const body: unknown = await request.clone().json();
        if (typeof body === "object" && body !== null) await this.assert("file_write", Object.fromEntries(Object.entries(body)));
      }
      return;
    }
    const enginePath = decoded.replace(/^\/opencode2?/, "").replace(/^\/api/, "");
    let input: Record<string, unknown> = {};
    if (request.body) {
      // The HTTP adapter exposes a stream even for a bodyless POST (session
      // creation and instance disposal both use one in the legacy engine).
      const text = await request.clone().text();
      if (text.trim()) {
        let value: unknown;
        try { value = JSON.parse(text); }
        catch { throw new ApiError(400, "invalid_request", "Expected a JSON request body."); }
        if (typeof value === "object" && value !== null && !Array.isArray(value)) input = Object.fromEntries(Object.entries(value));
      }
    }
    await this.assert("sync");
    if (terminal) await this.assert(/\/shell(?:\/|$)/.test(decoded) ? "shell" : "terminal", input);
    // Command templates can run shell substitutions before tool hooks fire.
    if (/\/session\/[^/]+\/command(?:\/|$)/.test(enginePath)) await this.assert("saved_command");
    if (/^\/(?:config|global\/config)(?:\/|$)/.test(enginePath)) await this.assert("engine_config");
    if (/^\/(?:mcp|plugins?|skills?|agents?)(?:\/|$)/.test(enginePath)) await this.assert("extensions");
    if (/^\/(?:auth|providers?)(?:\/|$)/.test(enginePath)) {
      const providerID = enginePath.match(/^\/auth\/([^/]+)(?:\/|$)/)?.[1]
        ?? enginePath.match(/^\/provider\/([^/]+)\/oauth\/(?:authorize|callback)$/)?.[1];
      await this.assert("provider", providerID ? { providerID } : {});
    }
    const model = typeof input.model === "object" && input.model !== null ? Object.fromEntries(Object.entries(input.model)) : input;
    if ("providerID" in model) await this.assert("model", model);
  }
  async assert(action: ManagedPolicyAction, input: Record<string, unknown> = {}): Promise<void> {
    const policy = await this.current();
    if (!policy) return;
    const denial = policyDenial(policy, action, input);
    if (denial) throw new ApiError(403, "organization_policy_denied", denial);
    if (action === "model" && policy.allowCustomProviders === false && input.providerID !== "opencode") {
      const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
      const providerID = typeof input.providerID === "string" ? input.providerID : "";
      const modelID = typeof input.id === "string" ? input.id : typeof input.modelID === "string" ? input.modelID : "";
      const provider = runtimeProviderMap(runtime)[providerID];
      const models = provider?.models;
      const session = this.session;
      const generation = this.generation;
      if (!session) throw new ApiError(403, "policy_unavailable", "Sign in to verify assigned models.");
      let assigned = false;
      try {
        const grants = await Promise.all([
          { path: "/v1/llm-providers?scope=usable", field: "llmProviders", gateway: false },
          { path: "/v1/inference-providers?scope=usable", field: "inferenceProviders", gateway: true },
        ].map(async ({ path, field, gateway }) => {
          // Older Den deployments have no gateway resource. Never treat other
          // failures as an empty or cached grant list.
          const catalog = await this.readDenJson(session, path, generation, gateway);
          if (gateway && catalog === null) return false;
          const items = isRecord(catalog) ? catalog[field] : null;
          if (!Array.isArray(items)) throw new Error("Invalid catalog");
          return items.filter(isRecord).some((item) =>
            (gateway ? /^ipr_/.test(providerID) && item.source === "openwork_gateway" && item.status === "active" && item.credentialStatus === "ready" && item.id === providerID
              : /^(?:lpr_|openwork$)/i.test(providerID) && (item.source === "openwork" ? "openwork" : item.id) === providerID)
            && (item.organizationId === undefined || item.organizationId === session.orgId)
            && Array.isArray(item.models) && item.models.filter(isRecord).some((model) => model.id === modelID));
        }));
        assigned = grants.some(Boolean);
      } catch (error) {
        if (error instanceof ApiError && error.code === "policy_identity_changed") throw error;
        throw new ApiError(403, "policy_unavailable", "Your organization's assigned models could not be verified.");
      }
      if (generation !== this.generation) throw new ApiError(409, "policy_identity_changed", "The signed-in account changed. Retry the action.");
      if (!(assigned && isRecord(models) && Object.hasOwn(models, modelID))) {
        throw new ApiError(403, "organization_model_denied", "Choose an AI model assigned by your organization.");
      }
    }
  }
}
