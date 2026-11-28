import { randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DESKTOP_POLICY_ENFORCEMENT_ENABLED, desktopConfigSchema, isLocalModelProviderId, localModelsAllowed, type DesktopConfig } from "@openwork/types/den/desktop-policies-runtime";
import { PRIVATE_VALUE_FILLS_ROUTE, privateValueFillReportResponseSchema, type PrivateValueFillReport } from "@openwork/types/den/private-value-fills";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";
import type { ServerConfig } from "./types.js";
import { isRecord } from "./workspace-kv-store.js";
import { createComputersDen } from "./computers/den.js";
import { externalFetch } from "./server-fetch.js";
import { createPersonalAgentsFeatureLookup } from "./personal-agents-feature.js";
import { ApiError } from "./errors.js";
import { clearManagedDesktopPolicy, readGlobalRuntimeOpencodeConfig, writeManagedDesktopPolicy, runtimeProviderMap } from "./runtime-opencode-config-store.js";
import { policyDenial, policyRequestActions, type ManagedPolicyAction } from "./managed-policy-rules.js";
import { agentPermissionDenial, agentPermissionRulesOf } from "./agent-permission-engine.js";
import { AGENT_MCP_SKILLS_CAPABILITY_HEADER, AGENT_PRIVATE_VALUES_CAPABILITY_HEADER, AGENT_PRIVATE_VALUE_PERMISSION_ACTIONS, AGENT_SANDBOX_MODES_CAPABILITY_HEADER, resolveSandboxRequirement, type AgentPermissionAction, type AgentPermissionRule } from "@openwork/types/den/agent-permissions-runtime";
import { readSandboxSettings, readAppliedSandboxSettings, readSandboxRequirement, sandboxSettingsRevision, writeSandboxRequirement, type SandboxSettings } from "./sandbox-settings-store.js";
import { readActivatedEnterpriseDenOrigin } from "./enterprise-den-origin.js";
import { sandboxHostRequest, sandboxPromptHasHostFiles } from "./sandbox-host-guards.js";

export function agentPermissionRulesForActions(rules: readonly AgentPermissionRule[], actions: readonly AgentPermissionAction[]): AgentPermissionRule[] {
  return rules.filter((rule) => actions.includes(rule.action));
}

const services = new WeakMap<ServerConfig, ManagedDesktopPolicy>();
const MANAGED_PROVIDER = /^(?:lpr_|ipr_)|^openwork(?:-auto)?$/i;
function sessionKey(session: CloudProviderDenSession) { return `${session.baseUrl}\n${session.orgId}\n${session.token}`; }
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

const SANDBOX_FRESHNESS_MS = 2_000;
type SandboxAccess = { enabled: boolean; scope: string; hostDenied: boolean; hostPolicyVerified: boolean; useRequired: boolean };
type SandboxVerification = "verified" | "refreshing" | "checking" | "unavailable";
export type SandboxSettingsSnapshot = SandboxSettings & {
  effectiveUseSandbox: boolean;
  effectiveForceSandbox: boolean;
  managedUse: boolean;
  managedForce: boolean;
  verification: SandboxVerification;
  allowHostExecution: boolean;
  effectiveAllowHostExecution: boolean;
  managed: boolean;
};

export function managedDesktopPolicy(config: ServerConfig, options?: { sandboxFreshnessMs?: number }): ManagedDesktopPolicy {
  const existing = services.get(config);
  if (existing) return existing;
  const service = new ManagedDesktopPolicy(config, options?.sandboxFreshnessMs ?? SANDBOX_FRESHNESS_MS);
  services.set(config, service);
  return service;
}
class ManagedDesktopPolicy {
  readonly evaluationToken = randomBytes(32).toString("base64url");
  private session: CloudProviderDenSession | null = null;
  readonly computersDen = createComputersDen(() => this.session);
  private generation = 0;
  private readonly lookupPersonalAgentsFeature = createPersonalAgentsFeatureLookup(externalFetch);
  private installed: { generation: number; policy: DesktopConfig | null } | undefined;
  private fetching: { generation: number; promise: Promise<DesktopConfig | null> } | undefined;
  private lastKnown: { key: string; policy: DesktopConfig } | undefined;
  onChange: (() => void) | undefined;
  onV2OnlyChange: ((enabled: boolean) => void) | undefined;
  onIdentityDelivered: (() => void) | undefined;
  constructor(private readonly config: ServerConfig, private readonly sandboxFreshnessMs: number) {}
  authenticatesEvaluation(request: Request): boolean {
    const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!supplied) return false;
    const actual = Buffer.from(supplied);
    const expected = Buffer.from(this.evaluationToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  async setSession(session: CloudProviderDenSession): Promise<void> {
    const current = this.session;
    if (!current || sessionKey(current) !== sessionKey(session)) {
      this.generation++;
      const generation = this.generation;
      this.session = session;
      this.resetSandboxAuthority();
      this.installed = undefined;
      this.onV2OnlyChange?.(false);
      const required = await readSandboxRequirement(this.config, session.baseUrl, session.orgId);
      this.identityChanged(generation);
      if (!this.sandboxOrgVerified) this.sandboxOrgForce = required;
    }
    this.session = session;
    this.onIdentityDelivered?.();
    if (current && sessionKey(current) !== sessionKey(session)) {
      this.lastKnown = undefined;
      const cleared = await clearManagedDesktopPolicy(this.config);
      if (cleared.changed) this.onChange?.();
    }
    if (DESKTOP_POLICY_ENFORCEMENT_ENABLED) await this.current();
    else void this.current().catch(() => undefined);
  }
  async clearSession(): Promise<void> {
    this.session = null;
    this.resetSandboxAuthority();
    this.generation++;
    this.installed = undefined;
    this.lastKnown = undefined;
    this.onV2OnlyChange?.(false);
    this.onIdentityDelivered?.();
    const cleared = await clearManagedDesktopPolicy(this.config);
    if (cleared.changed) this.onChange?.();
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
  private async readDenJson(session: CloudProviderDenSession, path: string, generation: number, allowNotFound = false, onSend?: () => void): Promise<unknown> {
    const deadline = performance.now() + DEN_READ_DEADLINE_MS;
    for (let attempt = 1; attempt <= DEN_READ_MAX_ATTEMPTS; attempt += 1) {
      this.identityChanged(generation);
      if (attempt > 1) {
        if (deadline - performance.now() <= DEN_READ_RETRY_DELAY_MS) throw new Error("Den read deadline exceeded");
        await delay(DEN_READ_RETRY_DELAY_MS);
        this.identityChanged(generation);
      }
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs <= 0) throw new Error("Den read deadline exceeded");
      try {
        onSend?.();
        const response = await externalFetch(`${session.baseUrl}${path}`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${session.token}`, "x-openwork-org-id": session.orgId, "x-openwork-legacy-org-id": session.orgId,
            ...(path === "/v1/me/desktop-config" ? { "X-OpenWork-Browser-Upload-Permissions": "1", "X-OpenWork-File-Send-Permissions": "1", "X-OpenWork-Sandbox-Only": "1", [AGENT_SANDBOX_MODES_CAPABILITY_HEADER]: "1", [AGENT_PRIVATE_VALUES_CAPABILITY_HEADER]: "1", [AGENT_MCP_SKILLS_CAPABILITY_HEADER]: "1" } : {}),
          },
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
    const generation = this.generation;
    if (!session) {
      await readGlobalRuntimeOpencodeConfig(this.config);
      this.identityChanged(generation);
      return null;
    }
    let policy: DesktopConfig;
    try {
      policy = await this.readSandboxDesktopConfig(session, generation);
    } catch (error) {
      this.identityChanged(generation);
      if (error instanceof ApiError && error.code === "policy_identity_changed") throw error;
      this.onV2OnlyChange?.(false);
      if (!DESKTOP_POLICY_ENFORCEMENT_ENABLED) {
        console.warn("[openwork:model-access] Den unreachable; using the last known model access");
        return this.lastKnown?.key === sessionKey(session) ? { ...this.lastKnown.policy, opencodeV2Only: false } : null;
      }
      throw new ApiError(403, "policy_unavailable", "Your organization's policy could not be verified. Try again when connected.");
    }
    if (generation !== this.generation) throw new ApiError(409, "policy_identity_changed", "The signed-in account changed. Retry the action.");
    const restrictsModelAccess = policy.allowCustomProviders === false || !localModelsAllowed(policy);
    const hasAgentPermissions = (policy.agentPermissions?.rules.length ?? 0) > 0;
    const result = DESKTOP_POLICY_ENFORCEMENT_ENABLED || restrictsModelAccess || hasAgentPermissions
      ? await writeManagedDesktopPolicy(this.config, policy)
      : await clearManagedDesktopPolicy(this.config);
    if (generation !== this.generation) throw new ApiError(409, "policy_identity_changed", "The signed-in account changed. Retry the action.");
    this.installed = { generation, policy };
    this.lastKnown = { key: sessionKey(session), policy };
    this.onV2OnlyChange?.(policy.opencodeV2Only === true);
    if (result.changed) this.onChange?.();
    return policy;
  }
  async assertLegacyExecutionRequest(request: Request, path: string): Promise<void> {
    const decoded = decodeURIComponent(path);
    const terminal = /\/(?:pty|persistent-pty|terminal)(?:\/|$)/.test(decoded);
    if (request.method === "POST" && /\/session\/[^/]+\/abort\/?$/.test(decoded)) return;
    await this.assertLegacyHostExecution();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) && !terminal) return;
    const generation = this.generation;
    const rules = await this.agentPermissionRulesFor(["external_directory"], true);
    this.identityChanged(generation);
    const restrictive = rules.find((rule) => rule.effect !== "allow");
    if (!restrictive) return;
    throw new ApiError(403, "organization_policy_denied",
      `Your organization's agent permissions restrict folders outside the workspace (set for ${restrictive.source}). OpenCode v1 cannot enforce this policy. Use the default OpenCode v2 engine to continue.`);
  }
  async assertRequest(request: Request, path: string, engine = false): Promise<void> {
    if (sandboxHostRequest(request.method, path, engine)) await this.assertHostExecution();
    if (!engine && request.method === "POST" && path === "/experimental/ui-control/request") {
      const value: unknown = await request.clone().json().catch(() => null);
      if (isRecord(value) && value.kind === "command") await this.assertHostExecution();
    }
    if (engine && !["GET", "HEAD", "OPTIONS"].includes(request.method) && /\/session(?:\/|$)/.test(path) && request.body) {
      const value: unknown = await request.clone().json().catch(() => null);
      if (sandboxPromptHasHostFiles(value)) await this.assertHostExecution();
    }
    if (!DESKTOP_POLICY_ENFORCEMENT_ENABLED) return this.assertProviderUse(request, path, engine);
    const generation = this.generation;
    try { await this.assertInstalledRequest(request, path, engine, generation); }
    finally { this.identityChanged(generation); }
  }
  private async assertInstalledRequest(request: Request, path: string, engine: boolean, generation: number): Promise<void> {
    const assert = async (action: ManagedPolicyAction, input: Record<string, unknown> = {}) => {
      this.identityChanged(generation);
      try { await this.assert(action, input); }
      finally { this.identityChanged(generation); }
    };
    const decoded = decodeURIComponent(path);
    const terminal = engine && /\/(?:shell|pty|persistent-pty|terminal)(?:\/|$)/.test(decoded);
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) && !terminal) return;
    if (!engine) {
      for (const action of policyRequestActions(request.method, decoded)) await assert(action);
      if (/\/files\/(?:raw|content|sessions\/[^/]+\/ops)$/.test(decoded)) {
        const body: unknown = await request.clone().json();
        this.identityChanged(generation);
        if (typeof body === "object" && body !== null) await assert("file_write", Object.fromEntries(Object.entries(body)));
      }
      return;
    }
    const enginePath = decoded.replace(/^\/opencode2?/, "").replace(/^\/api/, "");
    let input: Record<string, unknown> = {};
    if (request.body) {
      const text = await request.clone().text();
      this.identityChanged(generation);
      if (text.trim()) {
        let value: unknown;
        try { value = JSON.parse(text); }
        catch { throw new ApiError(400, "invalid_request", "Expected a JSON request body."); }
        if (typeof value === "object" && value !== null && !Array.isArray(value)) input = Object.fromEntries(Object.entries(value));
      }
    }
    await assert("sync");
    if (terminal) await assert(/\/shell(?:\/|$)/.test(decoded) ? "shell" : "terminal", input);
    if (/\/session\/[^/]+\/command(?:\/|$)/.test(enginePath)) await assert("saved_command");
    if (/^\/(?:config|global\/config)(?:\/|$)/.test(enginePath)) await assert("engine_config");
    if (/^\/(?:mcp|plugins?|skills?|agents?)(?:\/|$)/.test(enginePath)) await assert("extensions");
    if (/^\/(?:auth|providers?|integration)(?:\/|$)/.test(enginePath)) {
      const providerID = enginePath.match(/^\/auth\/([^/]+)(?:\/|$)/)?.[1]
        ?? enginePath.match(/^\/provider\/([^/]+)\/oauth\/(?:authorize|callback)$/)?.[1]
        ?? enginePath.match(/^\/integration\/([^/]+)(?:\/|$)/)?.[1];
      await assert("provider", providerID ? { providerID } : {});
    }
    const model = typeof input.model === "object" && input.model !== null ? Object.fromEntries(Object.entries(input.model)) : input;
    if ("providerID" in model) await assert("model", model);
  }
  private async assertProviderUse(request: Request, path: string, engine: boolean): Promise<void> {
    if (!engine || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const policy = this.knownPolicy();
    if (policy?.allowCustomProviders !== false && localModelsAllowed(policy)) return;
    const enginePath = decodeURIComponent(path).replace(/^\/opencode2?/, "").replace(/^\/api/, "");
    const providerID = enginePath.match(/^\/auth\/([^/]+)(?:\/|$)/)?.[1]
      ?? enginePath.match(/^\/provider\/([^/]+)\/oauth\/(?:authorize|callback)$/)?.[1]
      ?? enginePath.match(/^\/integration\/([^/]+)(?:\/|$)/)?.[1];
    if (providerID) return this.assert("provider", { providerID });
    if (!request.body || !/^\/session(?:\/|$)/.test(enginePath)) return;
    let body: unknown;
    try { body = JSON.parse(await request.clone().text()); } catch { return; }
    if (!isRecord(body)) return;
    const model = isRecord(body.model) ? body.model : body;
    if (typeof model.providerID === "string") await this.assert("model", { providerID: model.providerID });
  }
  async assertAgentPermission(action: "skill" | "mcp", name: string): Promise<void> {
    if (!this.session) return;
    const generation = this.generation;
    let policy = this.knownPolicy();
    if (!policy) {
      policy = await this.current().catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "policy_identity_changed") throw error;
        return null;
      });
      this.identityChanged(generation);
    }
    const rules = policy
      ? agentPermissionRulesOf(policy)
      : agentPermissionRulesOf((await readGlobalRuntimeOpencodeConfig(this.config)).managedPolicy);
    this.identityChanged(generation);
    const denial = agentPermissionDenial(rules, action, [name]);
    if (denial) throw new ApiError(403, "organization_policy_denied", denial);
  }
  private isolationTransition = false;

  projectIsolationTransition(): boolean { return this.isolationTransition; }
  setProjectIsolationTransition(active: boolean): void { this.isolationTransition = active; }

  async assertLegacyHostExecution(): Promise<void> {
    if ((await readSandboxSettings(this.config)).forceSandbox || this.isolationTransition) throw this.sandboxOnly();
    await this.assertHostExecution();
    if ((await readSandboxSettings(this.config)).forceSandbox || (await readAppliedSandboxSettings(this.config)).forceSandbox || this.isolationTransition) throw this.sandboxOnly();
  }

  private sandboxOnly() {
    return new ApiError(403, "sandbox_only", "This action can only run in the sandbox. Use the sandbox tools instead.");
  }

  private sandboxOrgForce = false;
  private sandboxOrgUse = false;
  private sandboxOrgVerified = false;
  private sandboxRulesRestrictive = false;
  private sandboxVerification: SandboxVerification = "checking";
  private sandboxRetryDelayMs = 0;
  private sandboxRetryAt = 0;
  private sandboxDesktopRead: { generation: number; promise: Promise<DesktopConfig> } | undefined;
  private sandboxDesktopSentAt = -Infinity;
  private sandboxRead: { generation: number; revision: number; promise: Promise<SandboxAccess> } | undefined;
  private sandboxFresh: { revision: number; until: number; access: SandboxAccess } | undefined;
  private sandboxSettledAt = -Infinity;

  private resetSandboxAuthority(): void {
    this.sandboxSettledAt = -Infinity;
    this.sandboxOrgForce = false;
    this.sandboxOrgUse = false;
    this.sandboxOrgVerified = false;
    this.sandboxRulesRestrictive = false;
    this.sandboxVerification = "checking";
    this.sandboxRetryDelayMs = 0;
    this.sandboxRetryAt = 0;
    this.sandboxFresh = undefined;
    this.sandboxDesktopSentAt = -Infinity;
  }

  private readSandboxDesktopConfig(session: CloudProviderDenSession, generation: number): Promise<DesktopConfig> {
    if (this.sandboxDesktopRead?.generation === generation) return this.sandboxDesktopRead.promise;
    let sentAt = performance.now();
    const promise = (async () => {
      const policy = desktopConfigSchema.parse(await this.readDenJson(session, "/v1/me/desktop-config", generation, false, () => { sentAt = performance.now(); }));
      this.identityChanged(generation);
      const rules = agentPermissionRulesOf(policy);
      const requirement = resolveSandboxRequirement(rules);
      const restrictive = rules.some(rule => ["shell", "edit", "external_directory"].includes(rule.action) && rule.effect !== "allow");
      if (this.sandboxOrgForce !== requirement.force || this.sandboxOrgUse !== requirement.use
        || this.sandboxRulesRestrictive !== restrictive) this.sandboxFresh = undefined;
      this.sandboxOrgForce = requirement.force;
      this.sandboxOrgUse = requirement.use;
      this.sandboxOrgVerified = true;
      this.sandboxRulesRestrictive = restrictive;
      this.sandboxDesktopSentAt = sentAt;
      await writeSandboxRequirement(this.config, session.baseUrl, session.orgId, requirement.force);
      this.identityChanged(generation);
      return policy;
    })();
    this.sandboxDesktopRead = { generation, promise };
    void promise.finally(() => {
      if (this.sandboxDesktopRead?.promise === promise) this.sandboxDesktopRead = undefined;
    }).catch(() => undefined);
    return promise;
  }

  private sandboxAuthority() {
    return {
      hostDenied: this.sandboxOrgForce,
      hostPolicyVerified: !this.session || this.sandboxOrgVerified,
      useRequired: this.sandboxOrgUse || this.sandboxOrgForce,
    };
  }
  async requiresSandbox(localForceSandbox?: boolean): Promise<boolean> {
    const force = localForceSandbox ?? (await readSandboxSettings(this.config)).forceSandbox;
    const { hostDenied, hostPolicyVerified } = this.sandboxAuthority();
    return force || hostDenied || !hostPolicyVerified;
  }
  private settingsResponse(local: SandboxSettings, applied: SandboxSettings, access: SandboxAccess, verification: SandboxVerification): SandboxSettingsSnapshot {
    const effectiveForceSandbox = this.isolationTransition || applied.forceSandbox || access.hostDenied || !access.hostPolicyVerified;
    return {
      ...local,
      effectiveForceSandbox,
      effectiveUseSandbox: effectiveForceSandbox || (access.enabled && (local.useSandbox || access.useRequired)),
      managedUse: access.useRequired,
      managedForce: access.hostDenied,
      verification,
      allowHostExecution: !local.forceSandbox,
      effectiveAllowHostExecution: !effectiveForceSandbox,
      managed: access.hostDenied,
    };
  }
  async sandboxSettings(): Promise<SandboxSettingsSnapshot> {
    const [local, applied, access] = await Promise.all([readSandboxSettings(this.config), readAppliedSandboxSettings(this.config), this.localSandboxAccess()]);
    return this.settingsResponse(local, applied, access, this.sandboxVerification);
  }
  refreshSandboxSettingsInBackground(): void {
    if (performance.now() < this.sandboxRetryAt || this.settledForSettings()) return;
    void this.localSandboxAccess().catch(() => undefined);
  }
  private settledForSettings(): boolean {
    return this.sandboxVerification === "verified" && this.sandboxFresh?.revision === sandboxSettingsRevision(this.config)
      && performance.now() - this.sandboxSettledAt < this.sandboxFreshnessMs;
  }
  sandboxSettingsSnapshot(local: SandboxSettings, applied: SandboxSettings): SandboxSettingsSnapshot {
    const inFlight = this.sandboxRead?.generation === this.generation;
    const verification: SandboxVerification = this.sandboxVerification === "verified"
      ? (inFlight || !this.settledForSettings() ? "refreshing" : "verified")
      : inFlight ? "checking" : this.sandboxVerification;
    return this.settingsResponse(local, applied, {
      ...this.sandboxAuthority(), scope: "unverified",
      enabled: this.sandboxVerification === "verified" && !this.sandboxRulesRestrictive,
    }, verification);
  }
  private freshSandboxAccess(revision: number): SandboxAccess | undefined {
    const fresh = this.sandboxFresh;
    return fresh && fresh.revision === revision && performance.now() < fresh.until
      && (!this.session || this.desktopFresh()) ? fresh.access : undefined;
  }
  localSandboxAccess(): Promise<SandboxAccess> {
    const generation = this.generation;
    const revision = sandboxSettingsRevision(this.config);
    const fresh = this.freshSandboxAccess(revision);
    if (fresh) return Promise.resolve(fresh);
    const existing = this.sandboxRead;
    if (existing?.generation === generation) {
      return existing.revision === revision ? existing.promise : existing.promise.then(() => this.localSandboxAccess());
    }
    const promise = this.refreshSandboxAccess(this.session, generation, revision);
    this.sandboxRead = { generation, revision, promise };
    void promise.finally(() => {
      if (this.sandboxRead?.promise === promise) this.sandboxRead = undefined;
    }).catch(() => undefined);
    return promise;
  }
  private async refreshSandboxAccess(session: CloudProviderDenSession | null, generation: number, revision: number): Promise<SandboxAccess> {
    try {
      let scope: string;
      let verifiedAt: number;
      if (session) {
        await this.readSandboxDesktopConfig(session, generation);
        this.identityChanged(generation);
        verifiedAt = this.sandboxDesktopSentAt;
        scope = sessionKey(session);
      } else {
        verifiedAt = performance.now();
        scope = `signed-out:${await this.signedOutDenOrigin()}`;
        this.identityChanged(generation);
      }
      const access = { ...this.sandboxAuthority(), enabled: !this.sandboxRulesRestrictive, scope };
      this.sandboxVerification = "verified";
      this.sandboxRetryDelayMs = 0;
      this.sandboxRetryAt = 0;
      this.sandboxFresh = { revision, until: verifiedAt + this.sandboxFreshnessMs, access };
      this.sandboxSettledAt = performance.now();
      return access;
    } catch {
      this.identityChanged(generation);
      this.sandboxVerification = "unavailable";
      this.sandboxRetryDelayMs = Math.min(30_000, this.sandboxRetryDelayMs ? 2 * this.sandboxRetryDelayMs : 2_000);
      this.sandboxRetryAt = performance.now() + this.sandboxRetryDelayMs;
      return { ...this.sandboxAuthority(), enabled: false, scope: "unverified" };
    }
  }
  private async signedOutDenOrigin(): Promise<string> {
    const origin = this.config.trustedDenOrigin ?? await readActivatedEnterpriseDenOrigin() ?? "https://api.openworklabs.com";
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("Untrusted Den origin");
    return url.origin;
  }
  private async readSignedOutFeatures(): Promise<Record<string, unknown>> {
    const origin = await this.signedOutDenOrigin();
    const response = await externalFetch(new URL("/v1/features", origin).href, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(DEN_READ_ATTEMPT_TIMEOUT_MS) });
    if (!response.ok) throw new Error("Feature verification failed");
    const payload: unknown = await response.json();
    const features = isRecord(payload) && isRecord(payload.features) ? payload.features : payload;
    return isRecord(features) ? features : {};
  }
  private desktopFresh(): boolean {
    return performance.now() - this.sandboxDesktopSentAt < this.sandboxFreshnessMs;
  }

  async verifySandboxHostAuthority(): Promise<void> {
    const session = this.session;
    const generation = this.generation;
    if (!session) return;
    if (!this.desktopFresh()) {
      const checkStartedAt = performance.now();
      const current = () => this.sandboxDesktopSentAt >= checkStartedAt || this.desktopFresh();
      let verified = false;
      try {
        await this.readSandboxDesktopConfig(session, generation);
        verified = true;
        if (!current() && this.sandboxFreshnessMs > 0 && !this.sandboxOrgForce) {
          await this.readSandboxDesktopConfig(session, generation);
        }
      } catch { this.identityChanged(generation); }
      this.identityChanged(generation);
      if (!this.sandboxOrgForce && verified && this.sandboxFreshnessMs > 0 && !current()) {
        throw new ApiError(503, "policy_unavailable", "OpenWork couldn't check your permissions. Reconnect and try again. Nothing ran.");
      }
    }
    const access = this.sandboxAuthority();
    if (!access.hostPolicyVerified) throw new ApiError(503, "policy_unavailable", "OpenWork couldn't check your permissions. Reconnect and try again. Nothing ran.");
    if (access.hostDenied) throw new ApiError(403, "sandbox_only", "Your organization requires the sandbox. Use the sandbox tools instead.");
  }

  async assertHostExecution(): Promise<void> {
    const generation = this.generation;
    if (this.isolationTransition || (await readAppliedSandboxSettings(this.config)).forceSandbox || this.isolationTransition) throw this.sandboxOnly();
    this.identityChanged(generation);
    if (!this.session) return;
    await this.verifySandboxHostAuthority();
    if (this.isolationTransition || (await readAppliedSandboxSettings(this.config)).forceSandbox || this.isolationTransition || this.sandboxOrgForce) throw this.sandboxOnly();
    this.identityChanged(generation);
  }

  async systemProxyEnabled(): Promise<boolean | undefined> {
    const session = this.session;
    const generation = this.generation;
    try {
      let features: Record<string, unknown>;
      if (session) {
        const payload = await this.readDenJson(session, "/v1/org", generation);
        features = isRecord(payload) && isRecord(payload.features) ? payload.features : {};
      } else {
        features = await this.readSignedOutFeatures();
      }
      this.identityChanged(generation);
      return features.desktopSystemProxy === true;
    } catch {
      return undefined;
    }
  }

  async remoteComputersEnabled(): Promise<boolean> {
    return this.organizationFeatureEnabled("remoteComputers");
  }

  async browserSecretHandlesEnabled(): Promise<boolean> {
    return this.organizationFeatureEnabled("browserSecretHandles");
  }

  cachedPersonalAgentsEnabled(): boolean {
    return this.lookupPersonalAgentsFeature.cached(this.session);
  }

  async personalAgentsEnabled(): Promise<boolean> {
    const generation = this.generation;
    const enabled = await this.lookupPersonalAgentsFeature.check(this.session);
    return generation === this.generation && enabled;
  }

  async privateValuesEnabled(): Promise<boolean> {
    return this.organizationFeatureEnabled("privateValues");
  }

  async privateValuePolicy(): Promise<{ enabled: boolean; rules: AgentPermissionRule[] }> {
    const session = this.session;
    const generation = this.generation;
    if (!session || !await this.privateValuesEnabled()) return { enabled: false, rules: [] };
    const policy = desktopConfigSchema.parse(await this.readDenJson(session, "/v1/me/desktop-config", generation));
    this.identityChanged(generation);
    return { enabled: true, rules: agentPermissionRulesForActions(agentPermissionRulesOf(policy), AGENT_PRIVATE_VALUE_PERMISSION_ACTIONS) };
  }

  async recordPrivateValueFill(report: PrivateValueFillReport): Promise<{ ok: true; recorded: boolean } | { ok: false; code: string }> {
    const session = this.session;
    const generation = this.generation;
    if (!session) return { ok: false, code: "not_signed_in" };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await delay(100 * attempt);
      if (generation !== this.generation) return { ok: false, code: "policy_identity_changed" };
      try {
        const response = await externalFetch(`${session.baseUrl}${PRIVATE_VALUE_FILLS_ROUTE}`, {
          method: "POST",
          headers: {
            Accept: "application/json", "Content-Type": "application/json",
            Authorization: `Bearer ${session.token}`, "x-openwork-org-id": session.orgId, "x-openwork-legacy-org-id": session.orgId,
          },
          body: JSON.stringify(report),
          redirect: "error",
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          if (response.status >= 500) continue;
          return { ok: false, code: "den_rejected" };
        }
        const result = privateValueFillReportResponseSchema.safeParse(await response.json());
        if (!result.success) return { ok: false, code: "den_invalid_response" };
        return { ok: true, recorded: result.data.recorded };
      } catch (error) {
        if (!transientTransportReason(error)) break;
      }
    }
    return { ok: false, code: "den_unavailable" };
  }

  private async organizationFeatureEnabled(key: "remoteComputers" | "browserSecretHandles" | "privateValues"): Promise<boolean> {
    const session = this.session;
    const generation = this.generation;
    if (!session) return false;
    try {
      const payload = await this.readDenJson(session, "/v1/org", generation);
      this.identityChanged(generation);
      const features = isRecord(payload) && isRecord(payload.features) ? payload.features : {};
      return features[key] === true;
    } catch {
      return false;
    }
  }

  private async agentPermissionRulesFor(actions: readonly AgentPermissionAction[], requireVerified = false): Promise<AgentPermissionRule[]> {
    if (!this.session) return [];
    const fresh = await Promise.race([
      this.current().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    const verified = fresh ?? this.knownPolicy();
    if (!verified && requireVerified) {
      throw new ApiError(403, "policy_unavailable", "Your organization's folder permissions could not be verified. Reconnect and try again, or use the default OpenCode v2 engine.");
    }
    const policy = verified ?? (await readGlobalRuntimeOpencodeConfig(this.config)).managedPolicy;
    return agentPermissionRulesForActions(agentPermissionRulesOf(policy), actions);
  }
  async browserUploadPolicy(): Promise<{
    enabled: boolean;
    scope: { baseUrl: string; organizationId: string; memberId: string } | null;
    rules: AgentPermissionRule[];
  }> {
    const session = this.session;
    const generation = this.generation;
    if (!session) return { enabled: false, scope: null, rules: [] };
    const policy = desktopConfigSchema.parse(await this.readDenJson(session, "/v1/me/desktop-config", generation));
    this.identityChanged(generation);
    const uploads = policy.browserUploadPermissions;
    if (!uploads?.enabled) return { enabled: false, scope: null, rules: [] };
    if (uploads.organizationId !== session.orgId || !uploads.memberId) {
      throw new ApiError(403, "policy_identity_changed", "The signed-in file-sharing account could not be verified.");
    }
    return {
      enabled: true,
      scope: { baseUrl: session.baseUrl, organizationId: uploads.organizationId, memberId: uploads.memberId },
      rules: agentPermissionRulesForActions(agentPermissionRulesOf(policy), ["browser_upload"]),
    };
  }
  private fileSendsSeenOn: string | null = null;
  async fileSendPolicy(): Promise<{
    enabled: boolean;
    scope: { baseUrl: string; organizationId: string; memberId: string } | null;
    rules: AgentPermissionRule[];
  }> {
    const session = this.session;
    const generation = this.generation;
    const off = { enabled: false, scope: null, rules: [] };
    if (!session) return off;
    let policy: DesktopConfig;
    try {
      policy = desktopConfigSchema.parse(await this.readDenJson(session, "/v1/me/desktop-config", generation));
    } catch (error) {
      if (error instanceof ApiError && error.code === "policy_identity_changed") throw error;
      if (this.fileSendsSeenOn === `${session.baseUrl}\n${session.orgId}`) {
        throw new ApiError(503, "policy_unavailable", "Your organization's permissions could not be verified, so nothing was sent. Check your connection and try again.");
      }
      return off;
    }
    this.identityChanged(generation);
    const sends = policy.fileSendPermissions;
    this.fileSendsSeenOn = sends?.enabled ? `${session.baseUrl}\n${session.orgId}` : null;
    if (!sends?.enabled) return off;
    if (sends.organizationId !== session.orgId || !sends.memberId) {
      throw new ApiError(403, "policy_identity_changed", "The signed-in account could not be verified, so nothing was sent.");
    }
    return {
      enabled: true,
      scope: { baseUrl: session.baseUrl, organizationId: sends.organizationId, memberId: sends.memberId },
      rules: agentPermissionRulesForActions(agentPermissionRulesOf(policy), ["file_send"]),
    };
  }
  async websiteRules(): Promise<AgentPermissionRule[]> {
    try { await this.assertHostExecution(); }
    catch { return [{ action: "webfetch", resource: "*", effect: "deny", source: "Sandbox-only mode" }]; }
    return this.agentPermissionRulesFor(["webfetch"]);
  }
  async computerRules(): Promise<AgentPermissionRule[]> {
    try { await this.assertHostExecution(); }
    catch {
      return ["computer", "computer_files", "computer_clipboard", "script"].flatMap(action => {
        const parsed = agentPermissionRulesOf({ agentPermissions: { rules: [{ action, resource: "*", effect: "deny", source: "Sandbox-only mode" }] } });
        return parsed;
      });
    }
    return this.agentPermissionRulesFor(["computer", "computer_files", "computer_clipboard", "script"]);
  }
  known(): DesktopConfig | null {
    return this.knownPolicy();
  }
  private knownPolicy(): DesktopConfig | null {
    const session = this.session;
    if (!session) return null;
    if (this.installed?.generation === this.generation) return this.installed.policy;
    if (!this.fetching) void this.current().catch(() => undefined);
    return this.lastKnown?.key === sessionKey(session) ? this.lastKnown.policy : null;
  }
  private assertModelAccess(action: ManagedPolicyAction, input: Record<string, unknown>): void {
    if (action !== "provider" && action !== "model") return;
    const policy = this.knownPolicy();
    const localAllowed = localModelsAllowed(policy);
    if (policy?.allowCustomProviders !== false && localAllowed) return;
    const ids = Array.isArray(input.providerIDs) ? input.providerIDs.filter((id): id is string => typeof id === "string")
      : typeof input.providerID === "string" ? [input.providerID] : [];
    for (const id of ids) {
      if (id.toLowerCase() === "opencode") continue;
      if (isLocalModelProviderId(id)) {
        if (localAllowed) continue;
        throw action === "model"
          ? new ApiError(403, "organization_local_models_denied", "Your organization has turned off local models. Choose another model.")
          : new ApiError(403, "organization_local_models_denied", "Your organization has turned off local models.");
      }
      if (policy?.allowCustomProviders !== false) continue;
      if (!MANAGED_PROVIDER.test(id)) {
        throw action === "model"
          ? new ApiError(403, "organization_model_denied", "Choose an AI model assigned by your organization.")
          : new ApiError(403, "organization_policy_denied", "Your organization only allows its assigned AI providers.");
      }
    }
  }
  async assert(action: ManagedPolicyAction, input: Record<string, unknown> = {}): Promise<void> {
    if (!DESKTOP_POLICY_ENFORCEMENT_ENABLED) return this.assertModelAccess(action, input);
    const generation = this.generation;
    const policy = await this.installedPolicy(generation);
    this.identityChanged(generation);
    if (!policy) return;
    const denial = policyDenial(policy, action, input);
    if (denial) throw new ApiError(403, "organization_policy_denied", denial);
    if (action === "model" && policy.allowCustomProviders === false && input.providerID !== "opencode") {
      const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
      this.identityChanged(generation);
      const providerID = typeof input.providerID === "string" ? input.providerID : "";
      const modelID = typeof input.id === "string" ? input.id : typeof input.modelID === "string" ? input.modelID : "";
      const provider = runtimeProviderMap(runtime)[providerID];
      const models = provider?.models;
      const session = this.session;
      if (!session) throw new ApiError(403, "policy_unavailable", "Sign in to verify assigned models.");
      let assigned = false;
      try {
        const grants = await Promise.all([
          { path: "/v1/llm-providers?scope=usable", field: "llmProviders", gateway: false },
          { path: "/v1/inference-providers?scope=usable", field: "inferenceProviders", gateway: true },
        ].map(async ({ path, field, gateway }) => {
          const catalog = await this.readDenJson(session, path, generation, gateway);
          if (gateway && catalog === null) return false;
          const items = isRecord(catalog) ? catalog[field] : null;
          if (!Array.isArray(items)) throw new Error("Invalid catalog");
          return items.filter(isRecord).some((item) =>
            (gateway ? /^ipr_/.test(providerID) && item.source === "openwork_gateway" && item.status === "active" && item.id === providerID
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
  private async installedPolicy(generation: number): Promise<DesktopConfig | null> {
    if (this.installed?.generation === generation) return this.installed.policy;
    if (this.session) throw new ApiError(403, "policy_unavailable", "Your organization's policy could not be verified. Try again when connected.");
    const persisted = await readGlobalRuntimeOpencodeConfig(this.config);
    this.identityChanged(generation);
    if (persisted.managedPolicy) throw new ApiError(403, "policy_unavailable", "Sign in to verify your organization's policy before continuing.");
    return null;
  }
}
