import { randomBytes, timingSafeEqual } from "node:crypto";
import { desktopConfigSchema, type DesktopConfig } from "@openwork/types/den/desktop-policies-runtime";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";
import type { ServerConfig } from "./types.js";
import { isRecord } from "./workspace-kv-store.js";
import { externalFetch } from "./server-fetch.js";
import { ApiError } from "./errors.js";
import { readGlobalRuntimeOpencodeConfig, writeManagedDesktopPolicy, runtimeProviderMap } from "./runtime-opencode-config-store.js";
import { policyDenial, policyRequestActions, type ManagedPolicyAction } from "./managed-policy-rules.js";

const services = new WeakMap<ServerConfig, ManagedDesktopPolicy>();
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
    this.session = session;
    this.generation++;
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
      const response = await externalFetch(`${session.baseUrl}/v1/me/desktop-config`, {
        headers: { Authorization: `Bearer ${session.token}`, "x-openwork-legacy-org-id": session.orgId },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Policy request failed");
      policy = desktopConfigSchema.parse(await response.json());
    } catch {
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
        const response = await externalFetch(`${session.baseUrl}/v1/llm-providers`, {
          headers: { Authorization: `Bearer ${session.token}`, "x-openwork-legacy-org-id": session.orgId },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("Catalog unavailable");
        const catalog: unknown = await response.json();
        if (!isRecord(catalog) || !Array.isArray(catalog.llmProviders)) throw new Error("Invalid catalog");
        assigned = catalog.llmProviders.filter(isRecord).some((item) =>
          (item.source === "openwork" ? "openwork" : item.id) === providerID && Array.isArray(item.models)
          && item.models.filter(isRecord).some((model) => model.id === modelID));
      } catch { throw new ApiError(403, "policy_unavailable", "Your organization's assigned models could not be verified."); }
      if (generation !== this.generation) throw new ApiError(409, "policy_identity_changed", "The signed-in account changed. Retry the action.");
      if (!(assigned && /^(?:lpr_|openwork$)/i.test(providerID) && models && typeof models === "object" && Object.hasOwn(models, modelID))) {
        throw new ApiError(403, "organization_model_denied", "Choose an AI model assigned by your organization.");
      }
    }
  }
}
