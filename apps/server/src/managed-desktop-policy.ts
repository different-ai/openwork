import { desktopConfigSchema, type DesktopConfig } from "@openwork/types/den/desktop-policies";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";
import type { ServerConfig } from "./types.js";
import { externalFetch } from "./server-fetch.js";
import { ApiError } from "./errors.js";
import { readGlobalRuntimeOpencodeConfig, writeManagedDesktopPolicy, runtimeProviderMap } from "./runtime-opencode-config-store.js";
import { policyDenial, policyRequestActions } from "./managed-policy-rules.js";

const services = new WeakMap<ServerConfig, ManagedDesktopPolicy>();
export function managedDesktopPolicy(config: ServerConfig): ManagedDesktopPolicy {
  const existing = services.get(config);
  if (existing) return existing;
  const service = new ManagedDesktopPolicy(config);
  services.set(config, service);
  return service;
}
class ManagedDesktopPolicy {
  private session: CloudProviderDenSession | null = null;
  private generation = 0;
  onChange: (() => void) | undefined;
  constructor(private readonly config: ServerConfig) {}
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
  async current(): Promise<DesktopConfig | null> {
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
    if (result.changed) this.onChange?.();
    return policy;
  }
  async assertRequest(request: Request, path: string, engine = false): Promise<void> {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const decoded = decodeURIComponent(path);
    if (!engine) {
      for (const action of policyRequestActions(request.method, decoded)) await this.assert(action);
      if (/\/files\/(?:raw|content|sessions\/[^/]+\/ops)$/.test(decoded) && request.headers.get("content-type")?.includes("application/json")) {
        const body: unknown = await request.clone().json();
        if (typeof body === "object" && body !== null) await this.assert("file_write", Object.fromEntries(Object.entries(body)));
      }
      return;
    }
    const enginePath = decoded.replace(/^\/opencode2?/, "").replace(/^\/api/, "");
    let input: Record<string, unknown> = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
      const value: unknown = await request.clone().json();
      if (typeof value === "object" && value !== null && !Array.isArray(value)) input = Object.fromEntries(Object.entries(value));
    }
    await this.assert("sync");
    if (/\/(?:shell|pty|terminal)(?:\/|$)/.test(enginePath)) await this.assert("shell", input);
    if (/^\/(?:config|global\/config)(?:\/|$)/.test(enginePath)) await this.assert("engine_config");
    if (/^\/(?:mcp|plugin|skill)(?:\/|$)/.test(enginePath)) await this.assert("extensions");
    if (/^\/auth(?:\/|$)/.test(enginePath)) await this.assert("provider");
    const model = typeof input.model === "object" && input.model !== null ? Object.fromEntries(Object.entries(input.model)) : input;
    if ("providerID" in model) await this.assert("model", model);
  }
  async assert(action: string, input: Record<string, unknown> = {}): Promise<void> {
    const policy = await this.current();
    if (!policy) return;
    const denial = policyDenial(policy, action, input);
    if (denial) throw new ApiError(403, "organization_policy_denied", denial);
    if (action === "model" && policy.allowCustomProviders === false) {
      const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
      const providerID = typeof input.providerID === "string" ? input.providerID : "";
      const modelID = typeof input.id === "string" ? input.id : typeof input.modelID === "string" ? input.modelID : "";
      const provider = runtimeProviderMap(runtime)[providerID];
      const models = provider?.models;
      if (!(/^(?:lpr_|openwork$)/i.test(providerID) && models && typeof models === "object" && Object.hasOwn(models, modelID))) {
        throw new ApiError(403, "organization_model_denied", "Choose an AI model assigned by your organization.");
      }
    }
  }
}
