import {
  type DenMcpToken,
  type DenMcpTokenMintContext,
  resolveCloudMcpResourceUrl,
} from "../../../app/lib/den";
import type {
  OpenworkCloudMcpFailure,
  OpenworkCloudMcpHealth,
  OpenworkCloudMcpProviderModelContext,
  OpenworkCloudMcpReconcilePayload,
} from "../../../app/lib/openwork-server";
import {
  CLOUD_MCP_SERVER_NAME,
  clearCloudMcpScopedMetadata,
  clearCloudMcpUserState,
  getCloudMcpScopeKey,
  isCloudMcpSyncMarkerFresh,
  normalizeCloudMcpScope,
  readCloudMcpSyncMarker,
  readCloudMcpUserState,
  writeCloudMcpSyncMarker,
  writeCloudMcpUserState,
  type CloudMcpScope,
  type CloudMcpUserState,
} from "./cloud-mcp-user-state";

export const OPENWORK_CLOUD_EXPECTED_TOOLS = [
  "openwork-cloud_search_capabilities",
  "openwork-cloud_execute_capability",
];

export type CloudMcpClient = {
  baseUrl: string;
  getOpenworkCloudMcpHealth: (
    workspaceId: string,
    providerModel?: OpenworkCloudMcpProviderModelContext,
  ) => Promise<OpenworkCloudMcpHealth>;
  reconcileOpenworkCloudMcp: (
    workspaceId: string,
    payload: OpenworkCloudMcpReconcilePayload,
  ) => Promise<OpenworkCloudMcpHealth>;
};

export type CloudMcpOperationContext = CloudMcpScope & {
  denAuthToken: string | null;
  orgSlug?: string | null;
  orgName?: string | null;
  fallbackUrl?: string | null;
  providerModel?: OpenworkCloudMcpProviderModelContext;
  connectCatalogEnabled?: boolean;
  trigger?: string;
};

export type CloudMcpOperationMode = "health" | "repair";

export type CloudMcpOperationResult = {
  status: "checked" | "ready" | "repaired" | "unchanged" | "skipped" | "failed";
  health: OpenworkCloudMcpHealth | null;
  skippedReason?: "signed_out" | "missing_org" | "missing_workspace" | "disabled" | "deduped" | "mint_failed";
  attempts: number;
  markerWritten: boolean;
  reminted: boolean;
};

export type CloudMcpMainStatus = "ready" | "connecting" | "disabled" | "degraded" | "signed_out";

export type CloudMcpDisplaySummary = {
  status: CloudMcpMainStatus;
  statusLabel: "Ready" | "Connecting" | "Disabled" | "Degraded" | "Signed out";
  tone: "ready" | "warning" | "neutral" | "error";
  stageLabel: string;
  recommendedAction: string;
};

type MintCloudMcpToken = (context: DenMcpTokenMintContext) => Promise<DenMcpToken | null>;

type CloudMcpReconcilerInput = {
  mode: CloudMcpOperationMode;
  client: CloudMcpClient;
  context: CloudMcpOperationContext;
  mintToken: MintCloudMcpToken;
  force?: boolean;
  refreshMarginMs: number;
  now?: number;
  configuredEnabled?: boolean | null;
};

type OpenCodeDisconnectClient = {
  mcp: {
    disconnect: (input: { directory: string; name: string }) => Promise<unknown>;
  };
};

type CleanupClient = {
  baseUrl: string;
  removeMcp: (workspaceId: string, name: string) => Promise<unknown>;
};

const repairInFlight = new Map<string, Promise<CloudMcpOperationResult>>();

const APP_VERSION = String(import.meta.env.VITE_OPENWORK_APP_VERSION ?? "").trim();
const APP_BUILD_SHA = String(import.meta.env.VITE_OPENWORK_BUILD_SHA ?? import.meta.env.VITE_OPENWORK_GIT_SHA ?? "").trim();

function normalizeCode(code: string | null | undefined): string {
  return code?.trim().toLowerCase().replace(/[-.]/g, "_") ?? "";
}

function normalizedContextScope(context: CloudMcpOperationContext): CloudMcpScope | null {
  return normalizeCloudMcpScope({
    denBaseUrl: context.denBaseUrl,
    serverBaseUrl: context.serverBaseUrl,
    orgId: context.orgId,
    workspaceId: context.workspaceId,
  });
}

function tokenMetadata(token: DenMcpToken): Record<string, string | number | boolean | null> {
  return {
    organizationId: token.organizationId,
    expiresAt: token.expiresAt,
    resource: token.resource,
    scopes: token.scopes.join(" "),
  };
}

function orgMetadata(context: CloudMcpOperationContext): Record<string, string | number | boolean | null> {
  return {
    id: context.orgId.trim(),
    slug: context.orgSlug?.trim() || null,
    name: context.orgName?.trim() || null,
  };
}

function appMetadata(): Record<string, string | number | boolean | null> | undefined {
  const metadata: Record<string, string | number | boolean | null> = {};
  if (APP_VERSION) metadata.version = APP_VERSION;
  if (APP_BUILD_SHA) metadata.buildSha = APP_BUILD_SHA;
  return Object.keys(metadata).length ? metadata : undefined;
}

function resolveMcpUrl(token: DenMcpToken, fallbackUrl?: string | null): string | null {
  const healedResource = resolveCloudMcpResourceUrl(token.resource);
  if (healedResource) return `${healedResource}/agent`;
  const fallback = fallbackUrl?.trim() ?? "";
  return fallback || null;
}

export function buildOpenworkCloudMcpReconcilePayload(input: {
  context: CloudMcpOperationContext;
  token: DenMcpToken;
}): OpenworkCloudMcpReconcilePayload | null {
  const workspaceId = input.context.workspaceId.trim();
  const url = resolveMcpUrl(input.token, input.context.fallbackUrl);
  if (!workspaceId || !url) return null;
  const app = appMetadata();
  return {
    workspaceId,
    name: CLOUD_MCP_SERVER_NAME,
    config: {
      type: "remote",
      enabled: true,
      url,
      headers: { Authorization: `Bearer ${input.token.token}` },
      oauth: false,
    },
    tokenMetadata: tokenMetadata(input.token),
    org: orgMetadata(input.context),
    ...(app ? { app, appVersion: typeof app.version === "string" ? app.version : undefined, buildSha: typeof app.buildSha === "string" ? app.buildSha : undefined } : {}),
    connectCatalogEnabled: input.context.connectCatalogEnabled ?? true,
    trigger: input.context.trigger ?? "desktop-repair",
    ...(input.context.providerModel ? {
      provider: input.context.providerModel.provider,
      model: input.context.providerModel.model,
    } : {}),
  };
}

export function isCloudMcpAuthTokenFailureCode(code: string | null | undefined): boolean {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  if (
    normalized.includes("membership") ||
    normalized.includes("scope") ||
    normalized.includes("policy") ||
    normalized.includes("forbidden") ||
    normalized.includes("resource") ||
    normalized.includes("not_found") ||
    normalized.includes("client_registration")
  ) {
    return false;
  }
  return normalized === "openwork_cloud_auth_required" ||
    normalized === "openwork_cloud_auth_invalid" ||
    normalized === "openwork_cloud_token_expired" ||
    // The Den rejects an expired/missing first-party bearer with exactly these
    // codes; the `_mcp_` infix means the `invalid_token` substring below never
    // matches them (field incident: token sat expired for 7 days because the
    // remint retry never fired).
    normalized === "invalid_mcp_token" ||
    normalized === "missing_mcp_token" ||
    normalized.includes("invalid_token") ||
    normalized.includes("unauthorized") ||
    normalized.includes("expired") ||
    normalized.includes("auth");
}

/**
 * Health failures carry the primary `code` plus optional `aliases` (e.g. the
 * direct-probe 401 reports code `invalid_mcp_token` with alias
 * `openwork_cloud_token_expired`). Remint decisions must consider both.
 */
export function isCloudMcpAuthTokenFailure(failure: Pick<OpenworkCloudMcpFailure, "code" | "aliases"> | null | undefined): boolean {
  if (!failure) return false;
  if (isCloudMcpAuthTokenFailureCode(failure.code)) return true;
  return (failure.aliases ?? []).some((alias) => isCloudMcpAuthTokenFailureCode(alias));
}

function shouldSkipForPrerequisite(input: CloudMcpReconcilerInput, scope: CloudMcpScope): CloudMcpOperationResult | null {
  if (!scope.workspaceId) return { status: "skipped", health: null, skippedReason: "missing_workspace", attempts: 0, markerWritten: false, reminted: false };
  if (input.mode === "health") return null;
  if (!input.context.denAuthToken?.trim()) return { status: "skipped", health: null, skippedReason: "signed_out", attempts: 0, markerWritten: false, reminted: false };
  if (!scope.orgId) return { status: "skipped", health: null, skippedReason: "missing_org", attempts: 0, markerWritten: false, reminted: false };
  if (input.configuredEnabled === false) {
    return { status: "skipped", health: null, skippedReason: "disabled", attempts: 0, markerWritten: false, reminted: false };
  }
  // Recorded user intent only blocks provisioning (entry absent/unknown). A
  // known-enabled entry must keep its token fresh even when a stale
  // disabled/removed intent is still recorded.
  if (input.configuredEnabled !== true && readCloudMcpUserState(scope) !== null) {
    return { status: "skipped", health: null, skippedReason: "disabled", attempts: 0, markerWritten: false, reminted: false };
  }
  return null;
}

function writeUsableMarker(input: {
  health: OpenworkCloudMcpHealth | null;
  scope: CloudMcpScope;
  expiresAt: string | null;
}): boolean {
  if (!input.health?.usable || !input.expiresAt) return false;
  writeCloudMcpSyncMarker({ ...input.scope, expiresAt: input.expiresAt });
  return true;
}

async function probeHealth(input: CloudMcpReconcilerInput, scope: CloudMcpScope, options?: { writeFreshnessMarker?: boolean }): Promise<CloudMcpOperationResult> {
  const health = await input.client.getOpenworkCloudMcpHealth(scope.workspaceId, input.context.providerModel);
  const marker = options?.writeFreshnessMarker ? readCloudMcpSyncMarker(scope) : null;
  const markerWritten = options?.writeFreshnessMarker === true
    ? writeUsableMarker({ health, scope, expiresAt: marker?.expiresAt ?? null })
    : false;
  return {
    status: health.usable ? "ready" : "checked",
    health,
    attempts: 0,
    markerWritten,
    reminted: false,
  };
}

async function mintAndPost(input: CloudMcpReconcilerInput, scope: CloudMcpScope): Promise<{ health: OpenworkCloudMcpHealth | null; token: DenMcpToken | null }> {
  const token = await input.mintToken({
    baseUrl: scope.denBaseUrl,
    authToken: input.context.denAuthToken,
    orgId: scope.orgId,
  });
  if (!token) return { health: null, token: null };
  const payload = buildOpenworkCloudMcpReconcilePayload({ context: { ...input.context, ...scope }, token });
  if (!payload) return { health: null, token };
  return {
    health: await input.client.reconcileOpenworkCloudMcp(scope.workspaceId, payload),
    token,
  };
}

async function repairCloudMcp(input: CloudMcpReconcilerInput, scope: CloudMcpScope): Promise<CloudMcpOperationResult> {
  if (!input.force) {
    const healthResult = await probeHealth(input, scope, { writeFreshnessMarker: true });
    if (healthResult.health?.usable) return { ...healthResult, status: "unchanged" };
  }

  const marker = readCloudMcpSyncMarker(scope);
  if (!input.force && marker && isCloudMcpSyncMarkerFresh({
    expiresAt: marker.expiresAt,
    now: input.now ?? Date.now(),
    refreshMarginMs: input.refreshMarginMs,
  })) {
    const health = await input.client.getOpenworkCloudMcpHealth(scope.workspaceId, input.context.providerModel);
    if (health.usable) return { status: "unchanged", health, attempts: 0, markerWritten: false, reminted: false };
  }

  const first = await mintAndPost(input, scope);
  if (!first.token) {
    return { status: "skipped", health: null, skippedReason: "mint_failed", attempts: 1, markerWritten: false, reminted: false };
  }

  let attempts = 1;
  let health = first.health;
  let token = first.token;
  let reminted = false;
  if (isCloudMcpAuthTokenFailure(health?.firstFailure)) {
    const second = await mintAndPost(input, scope);
    attempts += 1;
    reminted = true;
    if (second.token) token = second.token;
    if (second.health) health = second.health;
  }

  const markerWritten = writeUsableMarker({ health, scope, expiresAt: token.expiresAt });
  return {
    status: health?.usable ? "repaired" : "failed",
    health,
    attempts,
    markerWritten,
    reminted,
  };
}

export async function runOpenworkCloudMcpReconciler(input: CloudMcpReconcilerInput): Promise<CloudMcpOperationResult> {
  const scope = normalizedContextScope(input.context);
  if (!scope) return { status: "skipped", health: null, skippedReason: "missing_workspace", attempts: 0, markerWritten: false, reminted: false };
  const prerequisite = shouldSkipForPrerequisite(input, scope);
  if (prerequisite) return prerequisite;

  if (input.mode === "health") return probeHealth(input, scope);

  const scopeKey = getCloudMcpScopeKey(scope);
  if (!scopeKey) return { status: "skipped", health: null, skippedReason: "missing_workspace", attempts: 0, markerWritten: false, reminted: false };
  const existing = repairInFlight.get(scopeKey);
  if (existing) return existing;
  const task = repairCloudMcp(input, scope).finally(() => {
    repairInFlight.delete(scopeKey);
  });
  repairInFlight.set(scopeKey, task);
  return task;
}

export function cloudMcpFailureStageLabel(input: {
  signedIn: boolean;
  orgSelected: boolean;
  userState?: CloudMcpUserState | null;
  health?: OpenworkCloudMcpHealth | null;
}): string {
  if (!input.signedIn) return "Sign in required";
  if (!input.orgSelected) return "Select an organization";
  if (input.userState) return "Agent access disabled";
  const code = normalizeCode(input.health?.firstFailure?.code);
  if (!code) return input.health?.usableByCurrentModel === null ? "Current model access not checked" : "Agent access ready";
  if (code === "cloud_mcp_disabled" || code === "cloud_disabled") return "Agent access disabled";
  if (code === "cloud_desired_missing" || code === "cloud_mcp_missing") return "Couldn’t apply Cloud access to this workspace";
  if (code.includes("auth") || code.includes("token") || code.includes("unauthorized")) return "Cloud authentication expired";
  if (code === "cloud_tools_missing") return "Cloud endpoint tools are missing";
  if (code === "cloud_status_missing" || code === "cloud_registration_failed") return "Cloud tools weren’t registered";
  if (code.includes("provider_projection")) return "Current model can’t use Cloud tools";
  if (code.includes("tool_ids") || code.includes("client_registration")) return "OpenWork components need updating";
  if (code === "extensions_plugin_missing") return "Agent instructions are out of date";
  if (code.includes("unreachable") || code.includes("connection") || code.includes("status_missing")) return "Cloud connection unavailable";
  return "Couldn’t apply Cloud access to this workspace";
}

export function cloudMcpRecommendedAction(input: {
  signedIn: boolean;
  orgSelected: boolean;
  userState?: CloudMcpUserState | null;
  health?: OpenworkCloudMcpHealth | null;
}): string {
  if (!input.signedIn) return "Sign in to OpenWork Cloud.";
  if (!input.orgSelected) return "Choose the organization agents should use.";
  if (input.userState) return "Enable Agent access or use Repair and test when you want agents to use connected services.";
  const code = normalizeCode(input.health?.firstFailure?.code);
  if (!code) {
    if (input.health?.usableByCurrentModel === null) return "Model access was not checked because no current model is selected.";
    return "No action needed.";
  }
  if (code === "cloud_mcp_disabled" || code === "cloud_disabled") return "Enable Agent access or use Repair and test when you want agents to use connected services.";
  if (code === "cloud_desired_missing" || code === "cloud_mcp_missing") return "Use Repair and test to apply agent access for this workspace.";
  if (code.includes("auth") || code.includes("token") || code.includes("unauthorized")) return "Use Repair and test to refresh Cloud authentication.";
  if (code.includes("membership")) return "Ask an organization admin to grant access.";
  if (code.includes("scope")) return "Reconnect OpenWork Cloud with the required permissions.";
  if (code.includes("policy") || code.includes("forbidden") || code.includes("resource")) return "Check organization policy and resource access.";
  if (code.includes("provider_projection")) return "Choose a model that can use OpenWork Cloud tools.";
  if (code.includes("tool_ids") || code.includes("client_registration")) return "Update OpenWork, then retry.";
  if (code === "extensions_plugin_missing") return "Reload the agent so OpenWork instructions are current.";
  if (code === "cloud_tools_missing") return "Reconnect OpenWork Cloud so the endpoint exposes search_capabilities and execute_capability.";
  if (code === "cloud_status_missing" || code === "cloud_registration_failed") return "Use Repair and test to register the Cloud tools.";
  return input.health?.firstFailure?.recommendedAction || "Use Repair and test, then check Advanced Settings if it still fails.";
}

export function cloudMcpDisplaySummary(input: {
  signedIn: boolean;
  orgSelected: boolean;
  connecting: boolean;
  userState?: CloudMcpUserState | null;
  health?: OpenworkCloudMcpHealth | null;
}): CloudMcpDisplaySummary {
  if (input.connecting) {
    return {
      status: "connecting",
      statusLabel: "Connecting",
      tone: "warning",
      stageLabel: "Cloud connection unavailable",
      recommendedAction: "Checking agent access now.",
    };
  }
  if (!input.signedIn) {
    return {
      status: "signed_out",
      statusLabel: "Signed out",
      tone: "neutral",
      stageLabel: cloudMcpFailureStageLabel(input),
      recommendedAction: cloudMcpRecommendedAction(input),
    };
  }
  const code = normalizeCode(input.health?.firstFailure?.code);
  const configEnabled = input.health?.desired.config?.enabled;
  const disabled = input.userState || code === "cloud_mcp_disabled" || code === "cloud_disabled" || configEnabled === false;
  if (disabled) {
    return {
      status: "disabled",
      statusLabel: "Disabled",
      tone: "neutral",
      stageLabel: cloudMcpFailureStageLabel(input),
      recommendedAction: cloudMcpRecommendedAction(input),
    };
  }
  if (input.health?.usable) {
    return {
      status: "ready",
      statusLabel: "Ready",
      tone: "ready",
      stageLabel: cloudMcpFailureStageLabel(input),
      recommendedAction: cloudMcpRecommendedAction(input),
    };
  }
  return {
    status: "degraded",
    statusLabel: "Degraded",
    tone: "error",
    stageLabel: cloudMcpFailureStageLabel(input),
    recommendedAction: cloudMcpRecommendedAction(input),
  };
}

export async function cleanupOpenworkCloudMcpAfterSignOut(input: {
  context: CloudMcpScope;
  openworkClient: CleanupClient | null;
  opencodeClient: OpenCodeDisconnectClient | null;
  directory: string;
}): Promise<void> {
  const scope = normalizeCloudMcpScope(input.context);
  if (scope) clearCloudMcpScopedMetadata(scope);

  await Promise.all([
    input.openworkClient && scope
      ? input.openworkClient.removeMcp(scope.workspaceId, CLOUD_MCP_SERVER_NAME).catch(() => null)
      : Promise.resolve(null),
    input.opencodeClient && input.directory.trim()
      ? input.opencodeClient.mcp.disconnect({ directory: input.directory.trim(), name: CLOUD_MCP_SERVER_NAME }).catch(() => null)
      : Promise.resolve(null),
  ]);
}

export function recordCloudMcpDisabledIntent(scope: CloudMcpScope, state: CloudMcpUserState): void {
  writeCloudMcpUserState(state, scope);
  clearCloudMcpScopedMetadata(scope);
}

export function clearCloudMcpDisabledIntent(scope: CloudMcpScope): void {
  clearCloudMcpUserState(scope);
}
