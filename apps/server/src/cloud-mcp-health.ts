import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { createOpencodeClient, McpStatus, ToolIds, ToolList } from "@opencode-ai/sdk/v2/client";
import { ApiError } from "./errors.js";
import { diagnoseMcpToolDenies, type McpToolDeny } from "./mcp.js";
import { sanitizeDiagnosticString, sanitizeDiagnosticValue } from "./diagnostic-sanitizer.js";
import { readRuntimeOpencodeConfig, runtimeMcpMap, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { externalFetch } from "./server-fetch.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { validateMcpConfig } from "./validators.js";

export const OPENWORK_CLOUD_MCP_NAME = "openwork-cloud";
export const OPENWORK_CLOUD_EXPECTED_TOOLS = [
  "openwork-cloud_search_capabilities",
  "openwork-cloud_execute_capability",
] satisfies string[];
const OPENWORK_CLOUD_DIRECT_TOOL_NAMES = [
  "search_capabilities",
  "execute_capability",
] satisfies string[];
export const OPENWORK_CLOUD_PLUGIN_CANARIES = [
  "openwork_docs_search",
  "openwork_extension_list_actions",
] satisfies string[];

const POLL_DELAYS_MS = [0, 250, 750, 1500, 3000];
function engineProbeTimeoutMs(): number {
  return Number(process.env.OPENWORK_CLOUD_MCP_PROBE_TIMEOUT_MS ?? "") || 5_000;
}

type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;

export type CloudMcpProviderModelContext = {
  provider: string;
  model: string;
};

export type CloudMcpFailureStage =
  | "prerequisites"
  | "token_mint"
  | "desired_config"
  | "engine_delivery"
  | "transport_auth"
  | "tool_registration"
  | "provider_projection"
  | "plugin_load"
  | "steering";

export type CloudMcpFailureCode =
  | "cloud_mcp_missing"
  | "cloud_mcp_disabled"
  | "cloud_endpoint_invalid"
  | "cloud_token_org_mismatch"
  | "cloud_mcp_needs_auth"
  | "invalid_mcp_token"
  | "mcp_session_revoked"
  | "mcp_membership_revoked"
  | "insufficient_mcp_scope"
  | "wrong_mcp_resource"
  | "opencode_engine_unreachable"
  | "opencode_mcp_sync_failed"
  | "provider_tool_projection_missing"
  | "cloud_steering_stale"
  | "cloud_desired_missing"
  | "workspace_directory_ambiguous"
  | "opencode_unconfigured"
  | "opencode_unreachable"
  | "cloud_status_missing"
  | "cloud_disabled"
  | "openwork_cloud_auth_required"
  | "openwork_cloud_auth_invalid"
  | "openwork_cloud_token_expired"
  | "openwork_cloud_membership_required"
  | "openwork_cloud_scope_missing"
  | "openwork_cloud_resource_forbidden"
  | "openwork_cloud_resource_not_found"
  | "openwork_cloud_client_registration_required"
  | "cloud_connection_failed"
  | "cloud_registration_failed"
  | "cloud_tools_denied"
  | "opencode_tool_ids_unsupported"
  | "opencode_tool_ids_unavailable"
  | "probe_unreachable"
  | "cloud_tools_missing"
  | "provider_projection_unavailable"
  | "provider_projection_missing"
  | "extensions_plugin_missing";

export type CloudMcpHealthPhase =
  | "missing_desired"
  | "workspace_ambiguous"
  | "engine_unconfigured"
  | "engine_unreachable"
  | "engine_missing"
  | "engine_disabled"
  | "engine_needs_auth"
  | "engine_needs_client_registration"
  | "engine_failed"
  | "registration_failed"
  | "denied_by_tools"
  | "tool_ids_unsupported"
  | "cloud_tools_missing"
  | "provider_projection_missing"
  | "extensions_plugin_missing"
  | "ready";

export type CloudMcpFailure = {
  code: CloudMcpFailureCode;
  stage: CloudMcpFailureStage;
  retryable: boolean;
  recommendedAction: string;
  message: string;
  aliases?: string[];
  requestId?: string;
  referenceId?: string;
  details?: unknown;
};

export type CloudMcpRuntimeRegistrationFailure = {
  name: string;
  status?: number;
  body?: unknown;
  message?: string;
};

export type CloudMcpRuntimeRegistrationResult = {
  status: "ok" | "failed" | "skipped";
  syncedNames: string[];
  failures: CloudMcpRuntimeRegistrationFailure[];
};

export type CloudMcpRuntimeRegistrar = (
  config: ServerConfig,
  workspace: WorkspaceInfo,
  onlyNames?: string[],
  options?: { throwOnFailure?: boolean },
) => Promise<CloudMcpRuntimeRegistrationResult>;

export type CloudMcpLiveStatusObserver = (
  config: ServerConfig,
  workspace: WorkspaceInfo,
  name: string,
  mcpConfig: Record<string, unknown>,
  status: string,
) => void;

export type CloudMcpServerMetadata = {
  serverVersion?: string;
  expectedOpencodeVersion?: string;
};

export type CloudMcpCompatibilitySnapshot = {
  openwork: {
    serverVersion: string | null;
    app: Record<string, string | number | boolean | null> | null;
  };
  opencode: {
    expectedVersion: string | null;
    actualVersion: string | null;
    probe: "ok" | "unavailable" | "not_checked";
    error?: unknown;
  };
  pluginFileHashes: Array<{
    name: string;
    sha256: string | null;
    error?: string;
  }>;
  supportedFeatures: {
    dynamicMcp: boolean;
    directoryScoping: boolean;
    toolIds: boolean;
    providerToolProjection: boolean;
    pluginCanaries: boolean;
  };
  experimentalToolIds: CloudMcpExperimentalToolIdsSnapshot;
  experimentalProviderTools: CloudMcpExperimentalProviderToolsSnapshot;
};

export type CloudMcpExperimentalToolIdsSnapshot = {
  checked: boolean;
  expected: string[];
  present: string[];
  missing: string[];
  includesMcpTools: boolean | null;
  limitation?: string;
  error?: unknown;
};

export type CloudMcpExperimentalProviderToolsSnapshot = {
  checked: boolean;
  provider?: string;
  model?: string;
  expected: string[];
  present: string[];
  missing: string[];
  includesMcpTools: boolean | null;
  limitation?: string;
  error?: unknown;
};

export type CloudMcpHealth = {
  schemaVersion: 1;
  phase: CloudMcpHealthPhase;
  usable: boolean;
  usableByCurrentModel: boolean | null;
  connectCatalogEnabled: boolean;
  workspace: {
    id: string;
    type: WorkspaceInfo["workspaceType"];
    directory: string | null;
    path: string;
  };
  desired: {
    present: boolean;
    name: typeof OPENWORK_CLOUD_MCP_NAME;
    revision: string | null;
    config: RedactedCloudMcpConfig | null;
    token: CloudMcpTokenHealth;
    org?: Record<string, string | number | boolean | null>;
    app?: Record<string, string | number | boolean | null>;
    updatedAt?: number;
  };
  delivery: CloudMcpDeliverySnapshot;
  engine: {
    status: "not_checked" | "missing" | "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration" | "unreachable" | "unknown";
    error?: unknown;
  };
  engineInspection: CloudMcpEngineInspection;
  tools: {
    expected: string[];
    present: string[];
    missing: string[];
    direct: {
      checked: boolean;
      source: "mcp_tools_list";
      expected: string[];
      present: string[];
      missing: string[];
      trace?: CloudMcpProbeTrace;
      error?: unknown;
      failure?: CloudMcpFailure;
    };
    providerProjection: {
      checked: boolean;
      provider?: string;
      model?: string;
      source?: "experimental_tool" | "provider_capability";
      limitation?: string;
      modelExists?: boolean;
      toolCalling?: boolean | null;
      present: string[];
      missing: string[];
      error?: unknown;
    };
  };
  pluginCanaries: {
    expected: string[];
    present: string[];
    missing: string[];
  };
  compatibility: CloudMcpCompatibilitySnapshot;
  toolDenies: McpToolDeny[];
  firstFailure: CloudMcpFailure | null;
  checkedAt: string;
  durationMs: number;
};

type RedactedCloudMcpConfig = {
  type: "remote";
  url: string;
  enabled?: boolean;
  oauth?: false | true | "configured";
  timeout?: number;
  headers?: {
    keys: string[];
    authorizationPresent: boolean;
  };
};

type CloudMcpTokenHealth = {
  present: boolean;
  metadata: Record<string, string | number | boolean | null>;
};

type CloudMcpDesiredMetadata = {
  token: CloudMcpTokenHealth;
  org?: Record<string, string | number | boolean | null>;
  app?: Record<string, string | number | boolean | null>;
  connectCatalogEnabled: boolean;
  trigger?: string;
  updatedAt: number;
};

type CloudMcpDeliveryStateName = "not_desired" | "pending" | "registering" | "ready" | "failed" | "stale";

export type CloudMcpDeliverySnapshot = {
  state: CloudMcpDeliveryStateName;
  desiredRevision: string | null;
  appliedRevision: string | null;
  updatedAt: number | null;
  appliedAt: number | null;
  lastAttemptAt: number | null;
  trigger?: string;
  failure?: CloudMcpFailure;
};

type CloudMcpDeliveryEntry = {
  workspaceId: string;
  directory: string | null;
  desiredRevision: string;
  metadata: CloudMcpDesiredMetadata;
  state: CloudMcpDeliveryStateName;
  updatedAt: number;
  appliedRevision?: string;
  appliedAt?: number;
  lastAttemptAt?: number;
  trigger?: string;
  failure?: CloudMcpFailure;
};

type CloudMcpDesiredState = {
  present: boolean;
  revision: string | null;
  config: Record<string, unknown> | null;
  redactedConfig: RedactedCloudMcpConfig | null;
  metadata: CloudMcpDesiredMetadata;
  validationProblem?: CloudMcpValidationProblem;
};

type CloudMcpValidationProblem = {
  code: CloudMcpFailureCode;
  stage: "desired_config";
  retryable: boolean;
  recommendedAction: string;
  message: string;
  aliases?: string[];
  details?: unknown;
};

type ToolSnapshot = {
  expected: string[];
  present: string[];
  missing: string[];
};

export type CloudMcpEngineServerStatus = {
  name: string;
  status: string;
  error?: string;
};

/**
 * The engine's own view of every MCP server it tracks, read over the OpenCode
 * SDK. Support triage needs the siblings: "everything failed" points at the
 * engine host's network path, "only openwork-cloud failed" points at the Cloud
 * endpoint or token, and an absent entry means the dynamic registration was
 * lost (e.g. after an engine state rebuild) and must be re-applied.
 */
export type CloudMcpEngineInspection = {
  checked: boolean;
  cloudPresent?: boolean;
  serverCount?: number;
  servers?: CloudMcpEngineServerStatus[];
};

export type CloudMcpProbeStepName = "initialize" | "initialized_notice" | "tools_list";

export type CloudMcpProbeStep = {
  step: CloudMcpProbeStepName;
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  error?: unknown;
};

export type CloudMcpProbeTrace = {
  endpoint: string | null;
  startedAt: string;
  latencyMs: number;
  protocolVersion: string | null;
  serverInfo: { name: string | null; version: string | null } | null;
  steps: CloudMcpProbeStep[];
};

type DirectCloudToolsSnapshot = {
  checked: boolean;
  source: "mcp_tools_list";
  expected: string[];
  present: string[];
  missing: string[];
  trace?: CloudMcpProbeTrace;
  error?: unknown;
  failure?: CloudMcpFailure;
};

type ProviderProjectionSnapshot = {
  checked: boolean;
  provider?: string;
  model?: string;
  source?: "experimental_tool" | "provider_capability";
  limitation?: string;
  modelExists?: boolean;
  toolCalling?: boolean | null;
  present: string[];
  missing: string[];
  error?: unknown;
  failure?: CloudMcpFailure;
};

type Inspection = {
  engine: CloudMcpHealth["engine"];
  engineInspection: CloudMcpEngineInspection;
  tools: ToolSnapshot;
  directTools: DirectCloudToolsSnapshot;
  providerProjection: ProviderProjectionSnapshot;
  pluginCanaries: ToolSnapshot;
  experimentalToolIds: CloudMcpExperimentalToolIdsSnapshot;
  experimentalProviderTools: CloudMcpExperimentalProviderToolsSnapshot;
  opencodeVersion: CloudMcpCompatibilitySnapshot["opencode"];
  failures: CloudMcpFailure[];
};

export class CloudMcpDeliveryStateStore {
  private entries = new Map<string, CloudMcpDeliveryEntry>();

  snapshot(workspace: WorkspaceInfo, directory: string | null, desiredRevision: string | null): CloudMcpDeliverySnapshot {
    if (!desiredRevision) {
      return {
        state: "not_desired",
        desiredRevision: null,
        appliedRevision: null,
        updatedAt: null,
        appliedAt: null,
        lastAttemptAt: null,
      };
    }
    const entry = this.entries.get(this.key(workspace.id, directory));
    if (!entry || entry.desiredRevision !== desiredRevision) {
      return {
        state: "pending",
        desiredRevision,
        appliedRevision: null,
        updatedAt: entry?.updatedAt ?? null,
        appliedAt: null,
        lastAttemptAt: entry?.lastAttemptAt ?? null,
        ...(entry?.trigger ? { trigger: entry.trigger } : {}),
      };
    }
    return this.entrySnapshot(entry);
  }

  metadata(workspace: WorkspaceInfo, directory: string | null, desiredRevision: string | null): CloudMcpDesiredMetadata | null {
    if (!desiredRevision) return null;
    const entry = this.entries.get(this.key(workspace.id, directory));
    if (!entry || entry.desiredRevision !== desiredRevision) return null;
    return entry.metadata;
  }

  latestMetadata(workspace: WorkspaceInfo, directory: string | null): CloudMcpDesiredMetadata | null {
    return this.entries.get(this.key(workspace.id, directory))?.metadata ?? null;
  }

  markDesired(
    workspace: WorkspaceInfo,
    directory: string | null,
    desiredRevision: string,
    metadata: CloudMcpDesiredMetadata,
  ): CloudMcpDeliverySnapshot {
    const now = Date.now();
    const key = this.key(workspace.id, directory);
    const existing = this.entries.get(key);
    const entry: CloudMcpDeliveryEntry = {
      workspaceId: workspace.id,
      directory,
      desiredRevision,
      metadata,
      state: existing?.appliedRevision === desiredRevision ? "ready" : "pending",
      updatedAt: now,
      appliedRevision: existing?.appliedRevision === desiredRevision ? existing.appliedRevision : undefined,
      appliedAt: existing?.appliedRevision === desiredRevision ? existing.appliedAt : undefined,
      lastAttemptAt: existing?.lastAttemptAt,
      trigger: metadata.trigger,
    };
    this.entries.set(key, entry);
    return this.entrySnapshot(entry);
  }

  markRegistering(workspace: WorkspaceInfo, directory: string | null, desiredRevision: string): void {
    this.update(workspace.id, directory, desiredRevision, (entry) => ({
      ...entry,
      state: "registering",
      lastAttemptAt: Date.now(),
      failure: undefined,
    }));
  }

  markReady(workspace: WorkspaceInfo, directory: string | null, desiredRevision: string): void {
    const now = Date.now();
    this.update(workspace.id, directory, desiredRevision, (entry) => ({
      ...entry,
      state: "ready",
      appliedRevision: desiredRevision,
      appliedAt: now,
      updatedAt: now,
      failure: undefined,
    }));
  }

  markFailed(workspace: WorkspaceInfo, directory: string | null, desiredRevision: string, failure: CloudMcpFailure): void {
    const now = Date.now();
    this.update(workspace.id, directory, desiredRevision, (entry) => ({
      ...entry,
      state: "failed",
      updatedAt: now,
      lastAttemptAt: now,
      failure,
      appliedRevision: entry.appliedRevision === desiredRevision ? entry.appliedRevision : undefined,
      appliedAt: entry.appliedRevision === desiredRevision ? entry.appliedAt : undefined,
    }));
  }

  markWorkspaceStale(workspace: WorkspaceInfo, directory: string | null): void {
    const entry = this.entries.get(this.key(workspace.id, directory));
    if (!entry) return;
    this.entries.set(this.key(workspace.id, directory), {
      ...entry,
      state: "stale",
      appliedRevision: undefined,
      appliedAt: undefined,
      updatedAt: Date.now(),
    });
  }

  clear(): void {
    this.entries.clear();
  }

  private key(workspaceId: string, directory: string | null): string {
    return `${workspaceId}\0${directory ?? ""}`;
  }

  private update(
    workspaceId: string,
    directory: string | null,
    desiredRevision: string,
    updater: (entry: CloudMcpDeliveryEntry) => CloudMcpDeliveryEntry,
  ): void {
    const key = this.key(workspaceId, directory);
    const entry = this.entries.get(key);
    if (!entry || entry.desiredRevision !== desiredRevision) return;
    this.entries.set(key, updater(entry));
  }

  private entrySnapshot(entry: CloudMcpDeliveryEntry): CloudMcpDeliverySnapshot {
    return {
      state: entry.state,
      desiredRevision: entry.desiredRevision,
      appliedRevision: entry.appliedRevision ?? null,
      updatedAt: entry.updatedAt,
      appliedAt: entry.appliedAt ?? null,
      lastAttemptAt: entry.lastAttemptAt ?? null,
      ...(entry.trigger ? { trigger: entry.trigger } : {}),
      ...(entry.failure ? { failure: entry.failure } : {}),
    };
  }
}

export const cloudMcpDeliveryState = new CloudMcpDeliveryStateStore();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeMetadataRecord(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string") output[key] = sanitizeDiagnosticString(nested);
    else if (typeof nested === "number" || typeof nested === "boolean" || nested === null) output[key] = nested;
  }
  return Object.keys(output).length ? output : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, string> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string") output[key] = nested;
  }
  return Object.keys(output).length ? output : undefined;
}

function authorizationHeader(config: Record<string, unknown>): string | null {
  const headers = isRecord(config.headers) ? config.headers : null;
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization" && typeof value === "string") return value;
  }
  return null;
}

function tokenHealthFromConfig(config: Record<string, unknown> | null, metadata?: Record<string, string | number | boolean | null>): CloudMcpTokenHealth {
  const authorization = config ? authorizationHeader(config) : null;
  const tokenMetadata: Record<string, string | number | boolean | null> = { ...(metadata ?? {}) };
  if (authorization) tokenMetadata.authorizationHash = hashString(authorization);
  return {
    present: Boolean(authorization) || Object.keys(tokenMetadata).length > 0,
    metadata: tokenMetadata,
  };
}

function extractDesiredMetadata(body: Record<string, unknown>, config: Record<string, unknown>): CloudMcpDesiredMetadata {
  const tokenMetadata = safeMetadataRecord(body.tokenMetadata) ?? safeMetadataRecord(body.token);
  const org = safeMetadataRecord(body.org) ?? safeMetadataRecord(body.organization);
  const app = safeMetadataRecord(body.app) ?? safeMetadataRecord({
    version: body.appVersion,
    buildSha: body.buildSha ?? body.buildSHA,
  });
  const trigger = readString(body.trigger);
  const connectCatalogEnabled = readBoolean(body.connectCatalogEnabled) ?? true;
  return {
    token: tokenHealthFromConfig(config, tokenMetadata),
    ...(org ? { org } : {}),
    ...(app ? { app } : {}),
    connectCatalogEnabled,
    ...(trigger ? { trigger } : {}),
    updatedAt: Date.now(),
  };
}

function defaultDesiredMetadata(config: Record<string, unknown> | null, connectCatalogEnabled: boolean): CloudMcpDesiredMetadata {
  return {
    token: tokenHealthFromConfig(config),
    connectCatalogEnabled,
    updatedAt: Date.now(),
  };
}

function normalizeCloudEndpointUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.search || url.hash) return null;
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (!normalizedPath.endsWith("/mcp/agent")) return null;
    url.pathname = normalizedPath;
    return url.toString();
  } catch {
    return null;
  }
}

function canonicalizeCloudMcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  const url = readString(config.url);
  const normalizedUrl = url ? normalizeCloudEndpointUrl(url) : null;
  return normalizedUrl ? { ...config, url: normalizedUrl } : config;
}

function normalizeCloudMcpConfig(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new ApiError(400, "invalid_payload", "config is required");
  }
  const type = input.type ?? "remote";
  const url = readString(input.url);
  const output: Record<string, unknown> = { type };
  if (url) output.url = normalizeCloudEndpointUrl(url) ?? url;
  const enabled = readBoolean(input.enabled);
  if (enabled !== undefined) output.enabled = enabled;
  const headers = normalizeStringRecord(input.headers);
  if (headers) output.headers = headers;
  if (input.oauth === false) output.oauth = false;
  else if (input.oauth === true) output.oauth = {};
  else if (isRecord(input.oauth)) output.oauth = input.oauth;
  const timeout = readNumber(input.timeout);
  if (timeout !== undefined) output.timeout = timeout;
  return output;
}

function strictCloudMcpDesiredConfigProblem(config: Record<string, unknown>, metadata: CloudMcpDesiredMetadata): CloudMcpValidationProblem | null {
  if (config.type !== "remote") {
    return {
      code: "cloud_endpoint_invalid",
      stage: "desired_config",
      retryable: false,
      recommendedAction: "Reconnect OpenWork Cloud",
      message: "openwork-cloud must be configured as a remote MCP endpoint.",
      details: { type: typeof config.type === "string" ? config.type : null },
    };
  }

  if (config.enabled !== true) {
    return {
      code: "cloud_mcp_disabled",
      stage: "desired_config",
      retryable: false,
      recommendedAction: "Enable Agent access in Settings → Connect",
      message: "openwork-cloud desired config is disabled.",
      aliases: ["cloud_disabled"],
      details: { enabled: config.enabled ?? null },
    };
  }

  const url = readString(config.url);
  const normalizedUrl = url ? normalizeCloudEndpointUrl(url) : null;
  if (!url || !normalizedUrl) {
    return {
      code: "cloud_endpoint_invalid",
      stage: "desired_config",
      retryable: false,
      recommendedAction: "Reconnect OpenWork Cloud",
      message: "openwork-cloud URL must be a valid http(s) endpoint at /mcp/agent.",
      details: { url: typeof config.url === "string" ? sanitizeDiagnosticString(config.url) : null },
    };
  }

  const authorization = authorizationHeader(config)?.trim();
  if (!authorization) {
    return {
      code: "invalid_mcp_token",
      stage: "desired_config",
      retryable: false,
      recommendedAction: "Reconnect OpenWork Cloud",
      message: "openwork-cloud desired config is missing an Authorization header.",
      aliases: ["openwork_cloud_auth_required"],
    };
  }

  if (config.oauth !== false) {
    return {
      code: "invalid_mcp_token",
      stage: "desired_config",
      retryable: false,
      recommendedAction: "Reconnect OpenWork Cloud",
      message: "openwork-cloud desired config must use the minted bearer token, not OAuth.",
      aliases: ["openwork_cloud_auth_invalid"],
      details: { oauth: config.oauth === undefined ? "missing" : "configured" },
    };
  }

  const tokenOrganizationId = typeof metadata.token.metadata.organizationId === "string" ? metadata.token.metadata.organizationId.trim() : "";
  const activeOrganizationId = typeof metadata.org?.id === "string" ? metadata.org.id.trim() : "";
  if (tokenOrganizationId && activeOrganizationId && tokenOrganizationId !== activeOrganizationId) {
    return {
      code: "cloud_token_org_mismatch",
      stage: "desired_config",
      retryable: false,
      recommendedAction: "Choose the matching organization, then Repair and test",
      message: "openwork-cloud token organization does not match the active organization.",
      details: { tokenOrganizationId, activeOrganizationId },
    };
  }

  try {
    validateMcpConfig(canonicalizeCloudMcpConfig(config));
  } catch (error) {
    return {
      code: "cloud_endpoint_invalid",
      stage: "desired_config",
      retryable: false,
      recommendedAction: "Reconnect OpenWork Cloud",
      message: "openwork-cloud desired config is not a valid remote MCP config.",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }

  return null;
}

function redactedConfig(config: Record<string, unknown>): RedactedCloudMcpConfig {
  const headers = isRecord(config.headers) ? config.headers : null;
  const headerKeys = headers ? Object.keys(headers).sort() : [];
  const oauth = config.oauth === false
    ? false
    : config.oauth === true
      ? true
      : isRecord(config.oauth)
        ? "configured"
        : undefined;
  return {
    type: "remote",
    url: typeof config.url === "string" ? sanitizeDiagnosticString(config.url) : "",
    ...(typeof config.enabled === "boolean" ? { enabled: config.enabled } : {}),
    ...(oauth !== undefined ? { oauth } : {}),
    ...(typeof config.timeout === "number" ? { timeout: config.timeout } : {}),
    ...(headers
      ? {
          headers: {
            keys: headerKeys.map((key) => sanitizeDiagnosticString(key)),
            authorizationPresent: headerKeys.some((key) => key.toLowerCase() === "authorization"),
          },
        }
      : {}),
  };
}

function revisionValue(value: unknown, key?: string): unknown {
  if (key && ["authorization", "token", "secret", "password", "cookie", "api_key", "api-key", "apikey", "client_secret"].includes(key.toLowerCase())) {
    if (typeof value === "string") return { redacted: true, sha256: hashString(value) };
    if (!isRecord(value) && !Array.isArray(value)) return "[REDACTED]";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => revisionValue(item));
  if (!isRecord(value)) return null;
  const output: Record<string, unknown> = {};
  for (const nestedKey of Object.keys(value).sort()) {
    const nested = value[nestedKey];
    if (nested !== undefined) output[nestedKey] = revisionValue(nested, nestedKey);
  }
  return output;
}

export function calculateCloudMcpDesiredRevision(config: Record<string, unknown>, metadata: CloudMcpDesiredMetadata): string {
  return hashString(JSON.stringify(revisionValue({
    config,
    metadata: {
      token: metadata.token,
      org: metadata.org,
      connectCatalogEnabled: metadata.connectCatalogEnabled,
    },
  })));
}

async function readDesiredState(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  directory: string | null;
  connectCatalogEnabled?: boolean;
}): Promise<CloudMcpDesiredState> {
  const runtimeConfig = await readRuntimeOpencodeConfig(input.config, input.workspace.id);
  const entry = runtimeMcpMap(runtimeConfig)[OPENWORK_CLOUD_MCP_NAME];
  if (!entry) {
    const metadata = defaultDesiredMetadata(null, input.connectCatalogEnabled ?? false);
    return { present: false, revision: null, config: null, redactedConfig: null, metadata };
  }
  const config = canonicalizeCloudMcpConfig(entry);
  const storedMetadata = cloudMcpDeliveryState.latestMetadata(input.workspace, input.directory);
  const metadata = storedMetadata ?? defaultDesiredMetadata(config, input.connectCatalogEnabled ?? true);
  const validationProblem = strictCloudMcpDesiredConfigProblem(config, metadata) ?? undefined;
  const revision = calculateCloudMcpDesiredRevision(config, metadata);
  const revisionMetadata = cloudMcpDeliveryState.metadata(input.workspace, input.directory, revision) ?? metadata;
  return {
    present: true,
    revision,
    config,
    redactedConfig: redactedConfig(config),
    metadata: revisionMetadata,
    ...(validationProblem ? { validationProblem } : {}),
  };
}

function locationParams(directory: string | null): { directory?: string } {
  return directory ? { directory } : {};
}

function expectedTools(): string[] {
  return [...OPENWORK_CLOUD_EXPECTED_TOOLS];
}

function expectedDirectToolNames(): string[] {
  return [...OPENWORK_CLOUD_DIRECT_TOOL_NAMES];
}

function prefixedCloudToolId(name: string): string {
  return `${OPENWORK_CLOUD_MCP_NAME}_${name}`;
}

function expectedCanaries(): string[] {
  return [...OPENWORK_CLOUD_PLUGIN_CANARIES];
}

function splitPresentMissing(ids: string[], expected: string[]): ToolSnapshot {
  return {
    expected,
    present: expected.filter((id) => ids.includes(id)),
    missing: expected.filter((id) => !ids.includes(id)),
  };
}

function failure(input: {
  code: CloudMcpFailureCode;
  stage: CloudMcpFailureStage;
  retryable: boolean;
  recommendedAction: string;
  message: string;
  aliases?: string[];
  details?: unknown;
}): CloudMcpFailure {
  const ids = extractDiagnosticIds(input.details);
  return {
    code: input.code,
    stage: input.stage,
    retryable: input.retryable,
    recommendedAction: input.recommendedAction,
    message: input.message,
    ...(input.aliases?.length ? { aliases: input.aliases.map(sanitizeDiagnosticString) } : {}),
    ...(ids.requestId ? { requestId: ids.requestId } : {}),
    ...(ids.referenceId ? { referenceId: ids.referenceId } : {}),
    ...(input.details !== undefined ? { details: sanitizeDiagnosticValue(input.details) } : {}),
  };
}

function failureFromValidationProblem(problem: CloudMcpValidationProblem): CloudMcpFailure {
  return failure(problem);
}

function extractDiagnosticIds(value: unknown): { requestId?: string; referenceId?: string } {
  const found: { requestId?: string; referenceId?: string } = {};
  const visit = (nested: unknown): void => {
    if (typeof nested === "string") {
      const requestMatch = nested.match(/(?:x-request-id|request[_ -]?id)[=: ]+([A-Za-z0-9._:-]+)/i);
      const referenceMatch = nested.match(/(?:reference[_ -]?id)[=: ]+([A-Za-z0-9._:-]+)/i);
      if (requestMatch?.[1] && !found.requestId) found.requestId = sanitizeDiagnosticString(requestMatch[1]);
      if (referenceMatch?.[1] && !found.referenceId) found.referenceId = sanitizeDiagnosticString(referenceMatch[1]);
      return;
    }
    if (Array.isArray(nested)) {
      for (const item of nested) visit(item);
      return;
    }
    if (!isRecord(nested)) return;
    for (const [key, item] of Object.entries(nested)) {
      const normalized = key.toLowerCase().replace(/[-_]/g, "");
      if ((normalized === "requestid" || normalized === "xrequestid") && typeof item === "string" && !found.requestId) {
        found.requestId = sanitizeDiagnosticString(item);
      }
      if (normalized === "referenceid" && typeof item === "string" && !found.referenceId) {
        found.referenceId = sanitizeDiagnosticString(item);
      }
      visit(item);
    }
  };
  visit(value);
  return found;
}

function opencodeRequestFailure(stage: CloudMcpFailureStage, path: string, response: Response, error: unknown): CloudMcpFailure {
  if (stage === "engine_delivery") {
    return failure({
      code: response.status >= 500 ? "opencode_engine_unreachable" : "opencode_mcp_sync_failed",
      stage,
      retryable: response.status >= 500,
      recommendedAction: response.status >= 500 ? "Restart OpenCode or retry when the engine is reachable" : "Check OpenCode MCP status support",
      message: "OpenCode request failed while checking MCP status.",
      aliases: response.status >= 500 ? ["opencode_unreachable"] : ["cloud_connection_failed"],
      details: { path, status: response.status, error },
    });
  }
  if (stage === "tool_registration" && (response.status === 404 || response.status === 405)) {
    return failure({
      code: "opencode_tool_ids_unsupported",
      stage,
      retryable: false,
      recommendedAction: "Update OpenWork",
      message: "OpenCode does not support listing tool IDs.",
      details: { path, status: response.status, error },
    });
  }
  return failure({
    code: stage === "provider_projection" ? "provider_tool_projection_missing" : "opencode_tool_ids_unavailable",
    stage,
    retryable: response.status >= 500,
    recommendedAction: response.status >= 500 ? "Retry after OpenCode is healthy" : "Update OpenWork",
    message: "OpenCode request failed while checking openwork-cloud MCP readiness.",
    aliases: stage === "provider_projection" ? ["provider_projection_unavailable"] : undefined,
    details: { path, status: response.status, error },
  });
}

function thrownOpencodeFailure(stage: CloudMcpFailureStage, path: string, error: unknown): CloudMcpFailure {
  return failure({
    code: "opencode_engine_unreachable",
    stage,
    retryable: true,
    recommendedAction: "Restart OpenCode or retry when the engine is reachable",
    message: "OpenCode engine is not reachable.",
    aliases: ["opencode_unreachable"],
    details: { path, error: error instanceof Error ? error.message : String(error) },
  });
}

async function withEngineProbeTimeout<T>(task: () => Promise<T>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeoutMs = engineProbeTimeoutMs();
    const handle = setTimeout(() => {
      reject(new Error(`OpenCode health probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    task()
      .then(resolve, reject)
      .finally(() => clearTimeout(handle));
  });
}

async function withCloudEndpointProbeTimeout(task: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = engineProbeTimeoutMs();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(handle);
  }
}

function parseJsonOrText(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return sanitizeDiagnosticString(raw);
  }
}

function parseSsePayload(raw: string): unknown {
  const frames: string[] = [];
  let dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") {
      if (dataLines.length) frames.push(dataLines.join("\n"));
      dataLines = [];
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length) frames.push(dataLines.join("\n"));
  for (const frame of frames) {
    const parsed = parseJsonOrText(frame);
    if (isRecord(parsed) && (parsed.result !== undefined || parsed.error !== undefined || parsed.id !== undefined)) return parsed;
  }
  return frames[0] ? parseJsonOrText(frames[0]) : null;
}

async function readMcpJsonRpcPayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream") || raw.split(/\r?\n/).some((line) => line.startsWith("data:"))) {
    return parseSsePayload(raw);
  }
  return raw.trim() ? parseJsonOrText(raw) : null;
}

function jsonRpcRecord(payload: unknown): Record<string, unknown> | null {
  if (isRecord(payload)) return payload;
  if (!Array.isArray(payload)) return null;
  for (const item of payload) {
    if (isRecord(item) && (item.result !== undefined || item.error !== undefined)) return item;
  }
  return null;
}

function toolNamesFromMcpPayload(payload: unknown): { names?: string[]; error?: unknown } {
  const record = jsonRpcRecord(payload);
  if (!record) return { error: { message: "MCP tools/list response was not a JSON-RPC object", payload } };
  if (record.error !== undefined) return { error: record.error };
  const result = isRecord(record.result) ? record.result : null;
  if (!result || !Array.isArray(result.tools)) return { error: { message: "MCP tools/list result did not include a tools array", payload: record } };
  const names: string[] = [];
  for (const tool of result.tools) {
    if (isRecord(tool) && typeof tool.name === "string") names.push(tool.name);
  }
  return { names };
}

function directCloudToolsFailure(input: {
  message: string;
  retryable: boolean;
  details?: unknown;
}): CloudMcpFailure {
  return failure({
    code: "cloud_tools_missing",
    stage: "tool_registration",
    retryable: input.retryable,
    recommendedAction: "Reconnect OpenWork Cloud or contact OpenWork support",
    message: input.message,
    details: input.details,
  });
}

function directCloudAuthFailure(response: Response, payload: unknown, endpoint: string): CloudMcpFailure | null {
  if (response.status === 401) {
    return failure({
      code: "invalid_mcp_token",
      stage: "transport_auth",
      retryable: false,
      recommendedAction: "Reconnect OpenWork Cloud",
      message: "The OpenWork Cloud MCP endpoint rejected the persisted Authorization header.",
      aliases: ["openwork_cloud_auth_invalid"],
      details: { endpoint, status: response.status, response: payload },
    });
  }
  if (response.status === 403) {
    return failure({
      code: "wrong_mcp_resource",
      stage: "transport_auth",
      retryable: false,
      recommendedAction: "Check organization policy and resource access",
      message: "The OpenWork Cloud MCP endpoint denied access to this resource.",
      aliases: ["openwork_cloud_resource_forbidden"],
      details: { endpoint, status: response.status, response: payload },
    });
  }
  return null;
}

async function mcpJsonRpcPost(input: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}): Promise<{ response: Response; payload: unknown }> {
  const response = await withCloudEndpointProbeTimeout((signal) => externalFetch(input.url, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify(input.body),
    signal,
  }));
  return { response, payload: await readMcpJsonRpcPayload(response) };
}

function directToolsFromNames(names: string[]): DirectCloudToolsSnapshot {
  const split = splitPresentMissing(names, expectedDirectToolNames());
  const failureResult = split.missing.length
    ? directCloudToolsFailure({
        retryable: false,
        message: "The OpenWork Cloud MCP endpoint tools/list is missing required unprefixed tools.",
        details: { expected: split.expected, present: split.present, missing: split.missing },
      })
    : undefined;
  return {
    checked: true,
    source: "mcp_tools_list",
    expected: split.expected,
    present: split.present,
    missing: split.missing,
    ...(failureResult ? { failure: failureResult } : {}),
  };
}

function directToolsNotChecked(): DirectCloudToolsSnapshot {
  return {
    checked: false,
    source: "mcp_tools_list",
    expected: expectedDirectToolNames(),
    present: [],
    missing: [],
  };
}

function toolsFromDirectCloudTools(directTools: DirectCloudToolsSnapshot): ToolSnapshot {
  if (!directTools.checked) return { expected: expectedTools(), present: [], missing: [] };
  if (directTools.missing.length === 0) {
    return splitPresentMissing(directTools.present.map(prefixedCloudToolId), expectedTools());
  }
  return splitPresentMissing([], expectedTools());
}

function toolsFromEngineAttestation(): ToolSnapshot {
  const expected = expectedTools();
  return { expected, present: [...expected], missing: [] };
}

// OpenCode collapses a failed remote connect to `Error.message` (often the bare
// "fetch failed"), so the probe preserves the cause chain (code/errno/syscall)
// — it is the only place the network-level cause survives for support.
function describeTransportError(error: unknown): Record<string, unknown> {
  const chain: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (!(current instanceof Error)) {
      chain.push({ message: sanitizeDiagnosticString(String(current)) });
      break;
    }
    const entry: Record<string, unknown> = { message: sanitizeDiagnosticString(current.message) };
    if (current.name && current.name !== "Error") entry.name = sanitizeDiagnosticString(current.name);
    const withCode = current as Error & { code?: unknown; errno?: unknown; syscall?: unknown };
    if (typeof withCode.code === "string") entry.code = sanitizeDiagnosticString(withCode.code);
    if (typeof withCode.errno === "number") entry.errno = withCode.errno;
    if (typeof withCode.syscall === "string") entry.syscall = sanitizeDiagnosticString(withCode.syscall);
    chain.push(entry);
    current = current.cause;
  }
  const first = chain[0] ?? { message: "unknown transport error" };
  return { ...first, ...(chain.length > 1 ? { causes: chain.slice(1) } : {}) };
}

async function readDirectCloudTools(config: Record<string, unknown>): Promise<DirectCloudToolsSnapshot> {
  const url = readString(config.url);
  const authorization = authorizationHeader(config);
  const endpoint = url ? sanitizeDiagnosticString(url) : null;
  const startedAtMs = Date.now();
  const steps: CloudMcpProbeStep[] = [];
  let protocolVersionSeen: string | null = null;
  let serverInfo: CloudMcpProbeTrace["serverInfo"] = null;
  const trace = (): CloudMcpProbeTrace => ({
    endpoint,
    startedAt: new Date(startedAtMs).toISOString(),
    latencyMs: Date.now() - startedAtMs,
    protocolVersion: protocolVersionSeen,
    serverInfo,
    steps,
  });
  const timed = async <T>(input: {
    step: CloudMcpProbeStepName;
    task: () => Promise<T>;
    httpStatus?: (value: T) => number;
    ok?: (value: T) => boolean;
  }): Promise<T> => {
    const stepStarted = Date.now();
    try {
      const value = await input.task();
      const httpStatus = input.httpStatus?.(value);
      steps.push({
        step: input.step,
        ok: input.ok ? input.ok(value) : true,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        latencyMs: Date.now() - stepStarted,
      });
      return value;
    } catch (error) {
      steps.push({ step: input.step, ok: false, latencyMs: Date.now() - stepStarted, error: describeTransportError(error) });
      throw error;
    }
  };
  if (!url || !authorization) {
    const failureResult = directCloudToolsFailure({
      retryable: false,
      message: "The persisted OpenWork Cloud MCP config cannot be used for direct tools/list verification.",
      details: { endpoint, authorizationPresent: Boolean(authorization) },
    });
    return { ...directToolsNotChecked(), checked: true, missing: expectedDirectToolNames(), trace: trace(), error: failureResult.details, failure: failureResult };
  }

  const baseHeaders: Record<string, string> = {
    accept: "application/json, text/event-stream",
    authorization,
    "content-type": "application/json",
  };
  try {
    const initialized = await timed({
      step: "initialize",
      task: () => mcpJsonRpcPost({
        url,
        headers: baseHeaders,
        body: {
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "openwork-server-cloud-mcp-health", version: "1.0.0" },
            protocolVersion: "2025-06-18",
          },
        },
      }),
      httpStatus: (value) => value.response.status,
      ok: (value) => value.response.ok,
    });
    if (!initialized.response.ok) {
      const authFailure = directCloudAuthFailure(initialized.response, initialized.payload, endpoint ?? "unknown");
      const failureResult = authFailure ?? directCloudToolsFailure({
        retryable: initialized.response.status >= 500,
        message: "The OpenWork Cloud MCP endpoint initialize request failed during direct verification.",
        details: { endpoint, status: initialized.response.status, response: initialized.payload },
      });
      return { ...directToolsNotChecked(), checked: true, missing: expectedDirectToolNames(), trace: trace(), error: failureResult.details, failure: failureResult };
    }

    const initRecord = jsonRpcRecord(initialized.payload);
    const initResult = initRecord && isRecord(initRecord.result) ? initRecord.result : null;
    const serverInfoRecord = initResult && isRecord(initResult.serverInfo) ? initResult.serverInfo : null;
    if (serverInfoRecord) {
      serverInfo = {
        name: typeof serverInfoRecord.name === "string" ? sanitizeDiagnosticString(serverInfoRecord.name) : null,
        version: typeof serverInfoRecord.version === "string" ? sanitizeDiagnosticString(serverInfoRecord.version) : null,
      };
    }

    const sessionId = initialized.response.headers.get("mcp-session-id");
    const protocolVersion = initialized.response.headers.get("mcp-protocol-version");
    protocolVersionSeen = protocolVersion
      ?? (initResult && typeof initResult.protocolVersion === "string" ? sanitizeDiagnosticString(initResult.protocolVersion) : null);
    const sessionHeaders: Record<string, string> = {
      ...baseHeaders,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    };
    await timed({
      step: "initialized_notice",
      task: () => withCloudEndpointProbeTimeout((signal) => externalFetch(url, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        signal,
      })),
      httpStatus: (value) => value.status,
      ok: (value) => value.ok,
    });
    const listed = await timed({
      step: "tools_list",
      task: () => mcpJsonRpcPost({
        url,
        headers: sessionHeaders,
        body: { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      }),
      httpStatus: (value) => value.response.status,
      ok: (value) => value.response.ok,
    });
    if (!listed.response.ok) {
      const authFailure = directCloudAuthFailure(listed.response, listed.payload, endpoint ?? "unknown");
      const failureResult = authFailure ?? directCloudToolsFailure({
        retryable: listed.response.status >= 500,
        message: "The OpenWork Cloud MCP endpoint tools/list request failed during direct verification.",
        details: { endpoint, status: listed.response.status, response: listed.payload },
      });
      return { ...directToolsNotChecked(), checked: true, missing: expectedDirectToolNames(), trace: trace(), error: failureResult.details, failure: failureResult };
    }
    const toolNames = toolNamesFromMcpPayload(listed.payload);
    if (!toolNames.names) {
      const failureResult = directCloudToolsFailure({
        retryable: false,
        message: "The OpenWork Cloud MCP endpoint tools/list response could not be parsed.",
        details: { endpoint, error: toolNames.error },
      });
      return { ...directToolsNotChecked(), checked: true, missing: expectedDirectToolNames(), trace: trace(), error: failureResult.details, failure: failureResult };
    }
    return { ...directToolsFromNames(toolNames.names), trace: trace() };
  } catch (error) {
    // Field incident (corporate Windows, TLS interception): a probe transport
    // failure must never be reported as missing tools — the engine's own MCP
    // connection uses a different network stack and is authoritative.
    const failureResult = failure({
      code: "probe_unreachable",
      stage: "tool_registration",
      retryable: true,
      recommendedAction: "Check this machine's network path (proxy/TLS trust) to the Cloud MCP endpoint. The engine's own MCP connection is authoritative.",
      message: "The OpenWork server could not reach the Cloud MCP endpoint for direct verification (transport error before any HTTP response). This does not indicate missing tools.",
      details: { endpoint, error: error instanceof Error ? error.message : String(error), transport: describeTransportError(error) },
    });
    return { ...directToolsNotChecked(), checked: false, missing: [], trace: trace(), error: failureResult.details, failure: failureResult };
  }
}

async function readMcpStatus(
  opencode: WorkspaceOpencodeClient,
  directory: string | null,
): Promise<{ data?: Record<string, McpStatus>; failure?: CloudMcpFailure }> {
  try {
    const result = await withEngineProbeTimeout(() => opencode.mcp.status(locationParams(directory)));
    if (result.data) return { data: result.data };
    return { failure: opencodeRequestFailure("engine_delivery", "/mcp", result.response, result.error) };
  } catch (error) {
    return { failure: thrownOpencodeFailure("engine_delivery", "/mcp", error) };
  }
}

async function readToolIds(
  opencode: WorkspaceOpencodeClient,
  directory: string | null,
): Promise<{ data?: ToolIds; failure?: CloudMcpFailure }> {
  try {
    const result = await withEngineProbeTimeout(() => opencode.tool.ids(locationParams(directory)));
    if (result.data) return { data: result.data };
    return { failure: opencodeRequestFailure("tool_registration", "/experimental/tool/ids", result.response, result.error) };
  } catch (error) {
    return { failure: thrownOpencodeFailure("tool_registration", "/experimental/tool/ids", error) };
  }
}

async function readProviderProjection(input: {
  opencode: WorkspaceOpencodeClient;
  directory: string | null;
  providerModel: CloudMcpProviderModelContext;
  experimentalToolIdsIncludeMcpTools: boolean | null;
}): Promise<ProviderProjectionSnapshot> {
  let experimentalSplit: ToolSnapshot | null = null;
  let experimentalError: unknown;
  try {
    const result = await withEngineProbeTimeout(() => input.opencode.tool.list({
      ...locationParams(input.directory),
      provider: input.providerModel.provider,
      model: input.providerModel.model,
    }));
    if (!result.data) {
      experimentalError = opencodeRequestFailure("provider_projection", "/experimental/tool", result.response, result.error).details;
    } else {
      experimentalSplit = splitPresentMissing(toolListIds(result.data), expectedTools());
      if (experimentalSplit.missing.length === 0) {
        return {
          checked: true,
          provider: input.providerModel.provider,
          model: input.providerModel.model,
          source: "experimental_tool",
          present: experimentalSplit.present,
          missing: experimentalSplit.missing,
        };
      }
    }
  } catch (error) {
    experimentalError = thrownOpencodeFailure("provider_projection", "/experimental/tool", error).details;
  }

  if (input.experimentalToolIdsIncludeMcpTools === true) {
    const split = experimentalSplit ?? splitPresentMissing([], expectedTools());
    const projectionFailure = failure({
      code: "provider_tool_projection_missing",
      stage: "provider_projection",
      retryable: false,
      recommendedAction: "Choose a model that can use OpenWork Cloud tools",
      message: "The current provider/model projection is missing openwork-cloud tools.",
      aliases: ["provider_projection_missing"],
      details: { provider: input.providerModel.provider, model: input.providerModel.model, missing: split.missing, source: "experimental_tool" },
    });
    return {
      checked: true,
      provider: input.providerModel.provider,
      model: input.providerModel.model,
      source: "experimental_tool",
      present: split.present,
      missing: split.missing,
      ...(experimentalError ? { error: experimentalError } : {}),
      failure: projectionFailure,
    };
  }

  return readProviderCapability({
    opencode: input.opencode,
    directory: input.directory,
    providerModel: input.providerModel,
    experimentalSplit,
    experimentalError,
  });
}

async function readProviderCapability(input: {
  opencode: WorkspaceOpencodeClient;
  directory: string | null;
  providerModel: CloudMcpProviderModelContext;
  experimentalSplit: ToolSnapshot | null;
  experimentalError: unknown;
}): Promise<ProviderProjectionSnapshot> {
  try {
    const result = await withEngineProbeTimeout(() => input.opencode.provider.list(locationParams(input.directory)));
    if (!result.data) {
      const projectionFailure = opencodeRequestFailure("provider_projection", "/provider", result.response, result.error);
      return {
        checked: true,
        provider: input.providerModel.provider,
        model: input.providerModel.model,
        source: "provider_capability",
        limitation: "Experimental OpenCode tool projection did not enumerate MCP tools; provider catalog capability could not be read.",
        present: input.experimentalSplit?.present ?? [],
        missing: input.experimentalSplit?.missing ?? expectedTools(),
        error: projectionFailure.details,
        failure: projectionFailure,
      };
    }

    const provider = result.data.all.find((item) => item.id === input.providerModel.provider);
    const model = provider?.models[input.providerModel.model];
    const modelExists = Boolean(model);
    const toolCalling = model ? model.capabilities.toolcall === true : null;
    const limitation = "OpenCode experimental tool APIs do not enumerate MCP tools on this engine; using provider/model tool-call capability from /provider.";
    const projectionFailure = toolCalling
      ? undefined
      : failure({
          code: "provider_tool_projection_missing",
          stage: "provider_projection",
          retryable: false,
          recommendedAction: "Choose a model that can use OpenWork Cloud tools",
          message: modelExists ? "The selected provider/model does not support tool calling." : "The selected provider/model was not found in OpenCode provider catalog.",
          aliases: ["provider_projection_missing"],
          details: {
            provider: input.providerModel.provider,
            model: input.providerModel.model,
            source: "provider_capability",
            modelExists,
            toolCalling,
          },
        });
    return {
      checked: true,
      provider: input.providerModel.provider,
      model: input.providerModel.model,
      source: "provider_capability",
      limitation,
      modelExists,
      toolCalling,
      present: input.experimentalSplit?.present ?? [],
      missing: input.experimentalSplit?.missing ?? expectedTools(),
      ...(input.experimentalError ? { error: input.experimentalError } : {}),
      ...(projectionFailure ? { failure: projectionFailure } : {}),
    };
  } catch (error) {
    const projectionFailure = thrownOpencodeFailure("provider_projection", "/provider", error);
    return {
      checked: true,
      provider: input.providerModel.provider,
      model: input.providerModel.model,
      source: "provider_capability",
      limitation: "Experimental OpenCode tool projection did not enumerate MCP tools; provider catalog capability could not be read.",
      present: input.experimentalSplit?.present ?? [],
      missing: input.experimentalSplit?.missing ?? expectedTools(),
      error: projectionFailure.details,
      failure: projectionFailure,
    };
  }
}

function toolListIds(list: ToolList): string[] {
  return list.map((tool) => tool.id).filter((id) => typeof id === "string");
}

function statusFailure(status: McpStatus | undefined): CloudMcpFailure {
  if (!status) {
    return failure({
      code: "cloud_mcp_missing",
      stage: "engine_delivery",
      retryable: true,
      recommendedAction: "Run reconcile to register openwork-cloud with OpenCode",
      message: "OpenCode does not report an openwork-cloud MCP status.",
      aliases: ["cloud_status_missing"],
    });
  }
  if (status.status === "disabled") {
    return failure({
      code: "cloud_mcp_disabled",
      stage: "engine_delivery",
      retryable: false,
      recommendedAction: "Enable the openwork-cloud MCP entry",
      message: "openwork-cloud MCP is disabled.",
      aliases: ["cloud_disabled"],
    });
  }
  if (status.status === "needs_auth") {
    return failure({
      code: "cloud_mcp_needs_auth",
      stage: "transport_auth",
      retryable: false,
      recommendedAction: "Reconnect OpenWork Cloud",
      message: "openwork-cloud MCP needs authentication.",
      aliases: ["openwork_cloud_auth_required"],
    });
  }
  if (status.status === "needs_client_registration") {
    return failure({
      code: "opencode_mcp_sync_failed",
      stage: "engine_delivery",
      retryable: false,
      recommendedAction: "Reconnect OpenWork Cloud or update OpenWork",
      message: "openwork-cloud MCP needs OAuth client registration.",
      aliases: ["openwork_cloud_client_registration_required"],
      details: { error: status.error },
    });
  }
  if (status.status === "failed") {
    return inferFailedStatus(status.error);
  }
  return failure({
    code: "opencode_mcp_sync_failed",
    stage: "engine_delivery",
    retryable: true,
    recommendedAction: "Retry reconcile",
    message: "openwork-cloud MCP is not connected.",
    aliases: ["cloud_connection_failed"],
  });
}

function inferFailedStatus(error: string): CloudMcpFailure {
  const lower = error.toLowerCase();
  // Engines that preserve transport cause chains produce strings like
  // "fetch failed; caused by: certificate has expired (CERT_HAS_EXPIRED)".
  // Certificate/TLS wording ("expired", "authority", "revoked") must never be
  // classified as a token or session problem — reconnecting cannot repair a
  // broken transport, and richer engine errors must not change the verdict
  // for what is still a connection-level failure.
  const certTransport =
    lower.includes("certificat") ||
    lower.includes("cert_") ||
    lower.includes("tls") ||
    lower.includes("ssl") ||
    lower.includes("self signed") ||
    lower.includes("self-signed");
  if (!certTransport && lower.includes("expired")) {
    return failure({ code: "invalid_mcp_token", stage: "transport_auth", retryable: false, recommendedAction: "Reconnect OpenWork Cloud", message: "openwork-cloud token is expired.", aliases: ["openwork_cloud_token_expired"], details: { error } });
  }
  if (!certTransport && (lower.includes("invalid_token") || lower.includes("unauthorized") || lower.includes("401") || lower.includes("auth"))) {
    return failure({ code: "invalid_mcp_token", stage: "transport_auth", retryable: false, recommendedAction: "Reconnect OpenWork Cloud", message: "openwork-cloud authentication failed.", aliases: ["openwork_cloud_auth_invalid"], details: { error } });
  }
  if (!certTransport && (lower.includes("invalid_grant") || lower.includes("session") || lower.includes("revoked"))) {
    return failure({ code: "mcp_session_revoked", stage: "transport_auth", retryable: false, recommendedAction: "Reconnect OpenWork Cloud", message: "openwork-cloud session was revoked.", details: { error } });
  }
  if (lower.includes("membership") || lower.includes("member")) {
    return failure({ code: "mcp_membership_revoked", stage: "transport_auth", retryable: false, recommendedAction: "Ask an organization admin to grant access", message: "OpenWork Cloud membership is required.", aliases: ["openwork_cloud_membership_required"], details: { error } });
  }
  if (lower.includes("insufficient_scope") || lower.includes("scope")) {
    return failure({ code: "insufficient_mcp_scope", stage: "transport_auth", retryable: false, recommendedAction: "Reconnect OpenWork Cloud with the required scopes", message: "openwork-cloud token is missing required scopes.", aliases: ["openwork_cloud_scope_missing"], details: { error } });
  }
  if (lower.includes("forbidden") || lower.includes("403") || lower.includes("policy")) {
    return failure({ code: "wrong_mcp_resource", stage: "transport_auth", retryable: false, recommendedAction: "Check organization policy and resource access", message: "OpenWork Cloud denied access to this resource.", aliases: ["openwork_cloud_resource_forbidden"], details: { error } });
  }
  if (lower.includes("not found") || lower.includes("404") || lower.includes("resource")) {
    return failure({ code: "wrong_mcp_resource", stage: "transport_auth", retryable: false, recommendedAction: "Reconnect OpenWork Cloud or choose an accessible organization", message: "OpenWork Cloud resource was not found.", aliases: ["openwork_cloud_resource_not_found"], details: { error } });
  }
  if (lower.includes("client registration")) {
    return failure({ code: "opencode_mcp_sync_failed", stage: "engine_delivery", retryable: false, recommendedAction: "Reconnect OpenWork Cloud or update OpenWork", message: "openwork-cloud needs client registration.", aliases: ["openwork_cloud_client_registration_required"], details: { error } });
  }
  return failure({
    code: "opencode_mcp_sync_failed",
    stage: "engine_delivery",
    retryable: true,
    recommendedAction: "Retry reconcile or reconnect OpenWork Cloud",
    message: "openwork-cloud MCP connection failed.",
    aliases: ["cloud_connection_failed"],
    details: { error },
  });
}

function engineStatusFromMcpStatus(status: McpStatus | undefined): CloudMcpHealth["engine"] {
  if (!status) return { status: "missing" };
  if (status.status === "failed" || status.status === "needs_client_registration") {
    return { status: status.status, error: sanitizeDiagnosticValue(status.error) };
  }
  return { status: status.status };
}

function engineInspectionNotChecked(): CloudMcpEngineInspection {
  return { checked: false };
}

function engineInspectionFromStatuses(statuses: Record<string, McpStatus>): CloudMcpEngineInspection {
  const servers = Object.entries(statuses)
    .map(([name, status]) => ({
      name: sanitizeDiagnosticString(name),
      status: status.status,
      ...(("error" in status) && typeof status.error === "string" ? { error: sanitizeDiagnosticString(status.error) } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 50);
  return {
    checked: true,
    cloudPresent: Boolean(statuses[OPENWORK_CLOUD_MCP_NAME]),
    serverCount: Object.keys(statuses).length,
    servers,
  };
}

function readVersionFromHealthPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return typeof payload.version === "string" ? sanitizeDiagnosticString(payload.version) : null;
}

async function readOpencodeVersion(opencode: WorkspaceOpencodeClient): Promise<CloudMcpCompatibilitySnapshot["opencode"]> {
  try {
    const result = await withEngineProbeTimeout(() => opencode.global.health());
    if (result.data) {
      return { expectedVersion: null, actualVersion: readVersionFromHealthPayload(result.data), probe: "ok" };
    }
    return {
      expectedVersion: null,
      actualVersion: null,
      probe: "unavailable",
      error: sanitizeDiagnosticValue({ status: result.response.status, error: result.error }),
    };
  } catch (error) {
    return {
      expectedVersion: null,
      actualVersion: null,
      probe: "unavailable",
      error: sanitizeDiagnosticValue(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function inspectOpenworkCloud(input: {
  opencode: WorkspaceOpencodeClient;
  config: ServerConfig;
  workspace: WorkspaceInfo;
  directory: string | null;
  desiredConfig: Record<string, unknown>;
  providerModel?: CloudMcpProviderModelContext;
  probe: boolean;
  refreshRegistrationFromLiveStatus?: CloudMcpLiveStatusObserver;
}): Promise<Inspection> {
  const failures: CloudMcpFailure[] = [];
  const emptyTools = splitPresentMissing([], expectedTools());
  const emptyDirectTools = directToolsNotChecked();
  const emptyCanaries = splitPresentMissing([], expectedCanaries());
  const uncheckedExperimentalToolIds = experimentalToolIdsNotChecked();
  const uncheckedExperimentalProviderTools = experimentalProviderToolsFromProjection(providerProjectionNotChecked(input.providerModel));
  const opencodeVersion = await readOpencodeVersion(input.opencode);
  const statusResult = await readMcpStatus(input.opencode, input.directory);
  if (statusResult.failure) {
    failures.push(statusResult.failure);
    return {
      engine: { status: statusResult.failure.code === "opencode_engine_unreachable" ? "unreachable" : "unknown", error: statusResult.failure.details },
      engineInspection: engineInspectionNotChecked(),
      tools: emptyTools,
      directTools: emptyDirectTools,
      providerProjection: providerProjectionNotChecked(input.providerModel),
      pluginCanaries: emptyCanaries,
      experimentalToolIds: uncheckedExperimentalToolIds,
      experimentalProviderTools: uncheckedExperimentalProviderTools,
      opencodeVersion,
      failures,
    };
  }

  const engineInspection = engineInspectionFromStatuses(statusResult.data ?? {});
  const cloudStatus = statusResult.data?.[OPENWORK_CLOUD_MCP_NAME];
  if (cloudStatus) {
    input.refreshRegistrationFromLiveStatus?.(
      input.config,
      input.workspace,
      OPENWORK_CLOUD_MCP_NAME,
      input.desiredConfig,
      cloudStatus.status,
    );
  }
  const engine = engineStatusFromMcpStatus(cloudStatus);
  if (cloudStatus?.status !== "connected") {
    failures.push(statusFailure(cloudStatus));
    return {
      engine,
      engineInspection,
      tools: emptyTools,
      directTools: emptyDirectTools,
      providerProjection: providerProjectionNotChecked(input.providerModel),
      pluginCanaries: emptyCanaries,
      experimentalToolIds: uncheckedExperimentalToolIds,
      experimentalProviderTools: uncheckedExperimentalProviderTools,
      opencodeVersion,
      failures,
    };
  }

  const idsResult = await readToolIds(input.opencode, input.directory);
  if (idsResult.failure) {
    failures.push(idsResult.failure);
    return {
      engine,
      engineInspection,
      tools: emptyTools,
      directTools: emptyDirectTools,
      providerProjection: providerProjectionNotChecked(input.providerModel),
      pluginCanaries: emptyCanaries,
      experimentalToolIds: experimentalToolIdsFromFailure(idsResult.failure),
      experimentalProviderTools: uncheckedExperimentalProviderTools,
      opencodeVersion,
      failures,
    };
  }
  const ids = idsResult.data ?? [];
  const experimentalToolIds = experimentalToolIdsFromSplit(splitPresentMissing(ids, expectedTools()));
  const pluginCanaries = splitPresentMissing(ids, expectedCanaries());
  const directTools = input.probe ? await readDirectCloudTools(input.desiredConfig) : emptyDirectTools;
  if (input.probe) {
    // The engine is authoritative; a probe-only transport failure must stay diagnostic and not veto steering/delivery.
    if (directTools.failure && directTools.failure.code !== "probe_unreachable") {
      failures.push(directTools.failure);
    }
  }
  // OpenCode >=1.17 reports MCP "connected" only after initial tools/list succeeds;
  // the engine is the single source of truth unless an on-demand probe is requested.
  const tools = input.probe ? toolsFromDirectCloudTools(directTools) : toolsFromEngineAttestation();

  const providerProjection = input.providerModel
    ? await readProviderProjection({
        opencode: input.opencode,
        directory: input.directory,
        providerModel: input.providerModel,
        experimentalToolIdsIncludeMcpTools: experimentalToolIds.includesMcpTools,
      })
    : providerProjectionNotChecked(input.providerModel);
  const experimentalProviderTools = experimentalProviderToolsFromProjection(providerProjection);
  if (providerProjection.failure) failures.push(providerProjection.failure);

  if (pluginCanaries.missing.length) {
    failures.push(failure({
      code: "extensions_plugin_missing",
      stage: "plugin_load",
      retryable: true,
      recommendedAction: "Reload the OpenCode engine so OpenWork extensions are loaded",
      message: "OpenWork extension plugin canary tools are missing.",
      details: { missing: pluginCanaries.missing },
    }));
  }

  return { engine, engineInspection, tools, directTools, providerProjection, pluginCanaries, experimentalToolIds, experimentalProviderTools, opencodeVersion, failures };
}

function providerProjectionNotChecked(providerModel?: CloudMcpProviderModelContext): ProviderProjectionSnapshot {
  return {
    checked: false,
    ...(providerModel ? { provider: providerModel.provider, model: providerModel.model } : {}),
    present: [],
    missing: [],
  };
}

function experimentalToolIdsNotChecked(): CloudMcpExperimentalToolIdsSnapshot {
  return {
    checked: false,
    expected: expectedTools(),
    present: [],
    missing: [],
    includesMcpTools: null,
  };
}

function experimentalToolIdsFromSplit(split: ToolSnapshot): CloudMcpExperimentalToolIdsSnapshot {
  const includesMcpTools = split.missing.length === 0;
  return {
    checked: true,
    expected: split.expected,
    present: split.present,
    missing: split.missing,
    includesMcpTools,
    ...(includesMcpTools ? {} : { limitation: "This OpenCode engine's /experimental/tool/ids endpoint does not enumerate MCP tools; direct MCP tools/list is authoritative for Cloud readiness." }),
  };
}

function experimentalToolIdsFromFailure(failureResult: CloudMcpFailure): CloudMcpExperimentalToolIdsSnapshot {
  return {
    checked: true,
    expected: expectedTools(),
    present: [],
    missing: expectedTools(),
    includesMcpTools: null,
    error: failureResult.details,
  };
}

function experimentalProviderToolsFromProjection(projection: ProviderProjectionSnapshot): CloudMcpExperimentalProviderToolsSnapshot {
  if (!projection.checked) {
    return {
      checked: false,
      ...(projection.provider ? { provider: projection.provider } : {}),
      ...(projection.model ? { model: projection.model } : {}),
      expected: expectedTools(),
      present: [],
      missing: [],
      includesMcpTools: null,
    };
  }
  const includesMcpTools = projection.source === "experimental_tool" && projection.missing.length === 0;
  return {
    checked: true,
    ...(projection.provider ? { provider: projection.provider } : {}),
    ...(projection.model ? { model: projection.model } : {}),
    expected: expectedTools(),
    present: projection.present,
    missing: projection.missing,
    includesMcpTools,
    ...(includesMcpTools ? {} : { limitation: projection.limitation ?? "This OpenCode engine's /experimental/tool endpoint does not enumerate MCP tools for the selected provider/model." }),
    ...(projection.error ? { error: projection.error } : {}),
  };
}

function phaseFromFailure(firstFailure: CloudMcpFailure | null): CloudMcpHealthPhase {
  if (!firstFailure) return "ready";
  if (firstFailure.code === "cloud_mcp_missing" && firstFailure.stage === "engine_delivery") return "engine_missing";
  if (firstFailure.code === "cloud_mcp_missing" || firstFailure.code === "cloud_desired_missing") return "missing_desired";
  if (firstFailure.code === "cloud_endpoint_invalid" || firstFailure.code === "cloud_token_org_mismatch") return "missing_desired";
  if (firstFailure.code === "workspace_directory_ambiguous") return "workspace_ambiguous";
  if (firstFailure.code === "opencode_unconfigured") return "engine_unconfigured";
  if (firstFailure.code === "opencode_engine_unreachable" || firstFailure.code === "opencode_unreachable") return "engine_unreachable";
  if (firstFailure.code === "cloud_status_missing") return "engine_missing";
  if (firstFailure.code === "cloud_mcp_disabled" || firstFailure.code === "cloud_disabled") return "engine_disabled";
  if (
    firstFailure.code === "cloud_mcp_needs_auth" ||
    firstFailure.code === "invalid_mcp_token" ||
    firstFailure.code === "mcp_session_revoked" ||
    firstFailure.code === "mcp_membership_revoked" ||
    firstFailure.code === "insufficient_mcp_scope" ||
    firstFailure.code === "wrong_mcp_resource" ||
    firstFailure.code === "openwork_cloud_auth_required" ||
    firstFailure.code === "openwork_cloud_auth_invalid" ||
    firstFailure.code === "openwork_cloud_token_expired"
  ) return "engine_needs_auth";
  if (firstFailure.code === "openwork_cloud_client_registration_required") return "engine_needs_client_registration";
  if (firstFailure.code === "opencode_mcp_sync_failed" || firstFailure.code === "cloud_registration_failed") return "registration_failed";
  if (firstFailure.code === "cloud_tools_denied") return "denied_by_tools";
  if (firstFailure.code === "opencode_tool_ids_unsupported") return "tool_ids_unsupported";
  if (firstFailure.code === "cloud_tools_missing") return "cloud_tools_missing";
  if (firstFailure.code === "provider_tool_projection_missing" || firstFailure.code === "provider_projection_missing" || firstFailure.code === "provider_projection_unavailable") return "provider_projection_missing";
  if (firstFailure.code === "extensions_plugin_missing") return "extensions_plugin_missing";
  return "engine_failed";
}

function firstFailureFromDenies(denies: McpToolDeny[]): CloudMcpFailure | null {
  if (!denies.length) return null;
  return failure({
    code: "cloud_tools_denied",
    stage: "prerequisites",
    retryable: false,
    recommendedAction: "Remove project/global OpenCode tool denies for openwork-cloud tools",
    message: "OpenCode configuration denies one or more openwork-cloud tools.",
    details: { denies },
  });
}

function chooseFirstFailure(failures: CloudMcpFailure[]): CloudMcpFailure | null {
  return failures[0] ?? null;
}

function usableByModel(providerProjection: ProviderProjectionSnapshot, firstFailure: CloudMcpFailure | null): boolean | null {
  if (!providerProjection.checked) return null;
  if (firstFailure?.stage === "provider_projection") return false;
  if (providerProjection.source === "provider_capability") return providerProjection.modelExists === true && providerProjection.toolCalling === true;
  return providerProjection.missing.length === 0;
}

function baseUrlConfigured(config: ServerConfig, workspace: WorkspaceInfo): boolean {
  return Boolean(workspace.baseUrl?.trim() || config.opencodeBaseUrl?.trim());
}

async function pluginFileHashes(): Promise<CloudMcpCompatibilitySnapshot["pluginFileHashes"]> {
  const here = dirname(fileURLToPath(import.meta.url));
  const names = ["openwork-extensions-preview", "openwork-capabilities-knowledge"];
  return Promise.all(names.map(async (name) => {
    let lastError = "not found";
    for (const extension of ["ts", "js"]) {
      try {
        return { name, sha256: hashString(await readFile(join(here, "opencode-plugins", `${name}.${extension}`), "utf8")) };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return { name, sha256: null, error: sanitizeDiagnosticString(lastError) };
  }));
}

async function compatibilitySnapshot(input: {
  serverMetadata?: CloudMcpServerMetadata;
  appMetadata?: Record<string, string | number | boolean | null>;
  directory: string | null;
  inspection: Inspection;
}): Promise<CloudMcpCompatibilitySnapshot> {
  const opencode = {
    ...input.inspection.opencodeVersion,
    expectedVersion: input.serverMetadata?.expectedOpencodeVersion ?? null,
  };
  return {
    openwork: {
      serverVersion: input.serverMetadata?.serverVersion ?? null,
      app: input.appMetadata ?? null,
    },
    opencode,
    pluginFileHashes: await pluginFileHashes(),
    supportedFeatures: {
      dynamicMcp: true,
      directoryScoping: input.directory !== null,
      toolIds: !input.inspection.failures.some((item) => item.code === "opencode_tool_ids_unsupported" || item.code === "opencode_tool_ids_unavailable"),
      providerToolProjection: input.inspection.providerProjection.checked && !input.inspection.failures.some((item) => item.stage === "provider_projection" && item.code !== "provider_tool_projection_missing"),
      pluginCanaries: input.inspection.pluginCanaries.expected.length > 0,
    },
    experimentalToolIds: input.inspection.experimentalToolIds,
    experimentalProviderTools: input.inspection.experimentalProviderTools,
  };
}

export async function readOpenworkCloudMcpHealth(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  directory: string | null;
  providerModel?: CloudMcpProviderModelContext;
  serverMetadata?: CloudMcpServerMetadata;
  probe?: boolean;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  refreshRegistrationFromLiveStatus?: CloudMcpLiveStatusObserver;
}): Promise<CloudMcpHealth> {
  const checkedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const desired = await readDesiredState({ config: input.config, workspace: input.workspace, directory: input.directory });
  let delivery = cloudMcpDeliveryState.snapshot(input.workspace, input.directory, desired.revision);
  const toolDenies = desired.present
    ? await diagnoseMcpToolDenies(input.workspace.path, OPENWORK_CLOUD_MCP_NAME, expectedTools())
    : [];
  const failures: CloudMcpFailure[] = [];

  if (!desired.present) {
    failures.push(failure({
      code: "cloud_mcp_missing",
      stage: "desired_config",
      retryable: false,
      recommendedAction: "Connect OpenWork Cloud",
      message: "No openwork-cloud MCP desired config is persisted for this workspace.",
      aliases: ["cloud_desired_missing"],
    }));
  }
  if (desired.validationProblem) {
    failures.push(failureFromValidationProblem(desired.validationProblem));
  }
  if (desired.present && !input.directory) {
    failures.push(failure({
      code: "workspace_directory_ambiguous",
      stage: "prerequisites",
      retryable: false,
      recommendedAction: "Set an explicit OpenCode directory for this remote workspace",
      message: "Remote workspace has no exact OpenCode directory, so Cloud MCP readiness cannot be claimed.",
    }));
  }
  if (desired.present && input.directory && !baseUrlConfigured(input.config, input.workspace)) {
    failures.push(failure({
      code: "opencode_unconfigured",
      stage: "prerequisites",
      retryable: false,
      recommendedAction: "Start or attach an OpenCode engine for this workspace",
      message: "OpenCode base URL is missing for this workspace.",
    }));
  }
  const denyFailure = firstFailureFromDenies(toolDenies);
  if (denyFailure) failures.push(denyFailure);

  let inspection: Inspection = {
    engine: { status: "not_checked" },
    engineInspection: engineInspectionNotChecked(),
    tools: splitPresentMissing([], expectedTools()),
    directTools: directToolsNotChecked(),
    providerProjection: providerProjectionNotChecked(input.providerModel),
    pluginCanaries: splitPresentMissing([], expectedCanaries()),
    experimentalToolIds: experimentalToolIdsNotChecked(),
    experimentalProviderTools: experimentalProviderToolsFromProjection(providerProjectionNotChecked(input.providerModel)),
    opencodeVersion: { expectedVersion: input.serverMetadata?.expectedOpencodeVersion ?? null, actualVersion: null, probe: "not_checked" },
    failures: [],
  };
  if (desired.present && desired.config && !desired.validationProblem && input.directory && baseUrlConfigured(input.config, input.workspace)) {
    inspection = await inspectOpenworkCloud({
      opencode: input.createWorkspaceOpencodeClient(input.config, input.workspace),
      config: input.config,
      workspace: input.workspace,
      directory: input.directory,
      desiredConfig: desired.config,
      providerModel: input.providerModel,
      probe: input.probe === true,
      refreshRegistrationFromLiveStatus: input.refreshRegistrationFromLiveStatus,
    });
    failures.push(...inspection.failures);
  }

  if (desired.present && desired.revision && failures.length === 0 && delivery.appliedRevision !== desired.revision) {
    cloudMcpDeliveryState.markDesired(input.workspace, input.directory, desired.revision, desired.metadata);
    cloudMcpDeliveryState.markReady(input.workspace, input.directory, desired.revision);
    delivery = cloudMcpDeliveryState.snapshot(input.workspace, input.directory, desired.revision);
  }

  const firstFailure = chooseFirstFailure(failures);
  const compatibility = await compatibilitySnapshot({
    serverMetadata: input.serverMetadata,
    appMetadata: desired.metadata.app,
    directory: input.directory,
    inspection,
  });
  return {
    schemaVersion: 1,
    phase: phaseFromFailure(firstFailure),
    usable: firstFailure === null,
    usableByCurrentModel: usableByModel(inspection.providerProjection, firstFailure),
    connectCatalogEnabled: desired.metadata.connectCatalogEnabled,
    workspace: {
      id: input.workspace.id,
      type: input.workspace.workspaceType,
      directory: input.directory,
      path: input.workspace.path,
    },
    desired: {
      present: desired.present,
      name: OPENWORK_CLOUD_MCP_NAME,
      revision: desired.revision,
      config: desired.redactedConfig,
      token: desired.metadata.token,
      ...(desired.metadata.org ? { org: desired.metadata.org } : {}),
      ...(desired.metadata.app ? { app: desired.metadata.app } : {}),
      updatedAt: desired.metadata.updatedAt,
    },
    delivery,
    engine: inspection.engine,
    engineInspection: inspection.engineInspection,
    tools: {
      expected: inspection.tools.expected,
      present: inspection.tools.present,
      missing: inspection.tools.missing,
      direct: {
        checked: inspection.directTools.checked,
        source: inspection.directTools.source,
        expected: inspection.directTools.expected,
        present: inspection.directTools.present,
        missing: inspection.directTools.missing,
        ...(inspection.directTools.trace ? { trace: inspection.directTools.trace } : {}),
        ...(inspection.directTools.error ? { error: inspection.directTools.error } : {}),
        ...(inspection.directTools.failure ? { failure: inspection.directTools.failure } : {}),
      },
      providerProjection: {
        checked: inspection.providerProjection.checked,
        ...(inspection.providerProjection.provider ? { provider: inspection.providerProjection.provider } : {}),
        ...(inspection.providerProjection.model ? { model: inspection.providerProjection.model } : {}),
        ...(inspection.providerProjection.source ? { source: inspection.providerProjection.source } : {}),
        ...(inspection.providerProjection.limitation ? { limitation: inspection.providerProjection.limitation } : {}),
        ...(inspection.providerProjection.modelExists !== undefined ? { modelExists: inspection.providerProjection.modelExists } : {}),
        ...(inspection.providerProjection.toolCalling !== undefined ? { toolCalling: inspection.providerProjection.toolCalling } : {}),
        present: inspection.providerProjection.present,
        missing: inspection.providerProjection.missing,
        ...(inspection.providerProjection.error ? { error: inspection.providerProjection.error } : {}),
      },
    },
    pluginCanaries: inspection.pluginCanaries,
    compatibility,
    toolDenies,
    firstFailure,
    checkedAt,
    durationMs: Date.now() - startedAtMs,
  };
}

async function persistDesiredConfig(config: ServerConfig, workspaceId: string, desiredConfig: Record<string, unknown>): Promise<void> {
  await writeRuntimeOpencodeConfig(config, workspaceId, (current) => ({
    ...current,
    mcp: {
      ...runtimeMcpMap(current),
      [OPENWORK_CLOUD_MCP_NAME]: desiredConfig,
    },
  }));
}

function registrationFailure(failures: CloudMcpRuntimeRegistrationFailure[]): CloudMcpFailure {
  return failure({
    code: "opencode_mcp_sync_failed",
    stage: "engine_delivery",
    retryable: failures.some((item) => item.status === undefined || item.status >= 500),
    recommendedAction: "Retry reconcile after OpenCode is reachable",
    message: "Failed to dynamically register openwork-cloud with OpenCode.",
    aliases: ["cloud_registration_failed"],
    details: { failures },
  });
}

async function wait(ms: number): Promise<void> {
  if (ms === 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollConnected(input: {
  opencode: WorkspaceOpencodeClient;
  config: ServerConfig;
  workspace: WorkspaceInfo;
  directory: string | null;
  desiredConfig: Record<string, unknown>;
  refreshRegistrationFromLiveStatus?: CloudMcpLiveStatusObserver;
}): Promise<CloudMcpFailure | null> {
  let lastFailure: CloudMcpFailure | null = null;
  for (const delay of POLL_DELAYS_MS) {
    await wait(delay);
    const statusResult = await readMcpStatus(input.opencode, input.directory);
    if (statusResult.failure) {
      lastFailure = statusResult.failure;
      continue;
    }
    const cloudStatus = statusResult.data?.[OPENWORK_CLOUD_MCP_NAME];
    if (cloudStatus) {
      input.refreshRegistrationFromLiveStatus?.(
        input.config,
        input.workspace,
        OPENWORK_CLOUD_MCP_NAME,
        input.desiredConfig,
        cloudStatus.status,
      );
    }
    if (cloudStatus?.status === "connected") return null;
    lastFailure = statusFailure(cloudStatus);
    if (cloudStatus?.status === "disabled" || cloudStatus?.status === "needs_auth" || cloudStatus?.status === "needs_client_registration" || cloudStatus?.status === "failed") {
      return lastFailure;
    }
  }
  return lastFailure;
}

function healthWithFailure(health: CloudMcpHealth, firstFailure: CloudMcpFailure): CloudMcpHealth {
  return {
    ...health,
    phase: phaseFromFailure(firstFailure),
    usable: false,
    usableByCurrentModel: health.tools.providerProjection.checked ? false : health.usableByCurrentModel,
    firstFailure,
  };
}

export async function reconcileOpenworkCloudMcp(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  directory: string | null;
  body: Record<string, unknown>;
  providerModel?: CloudMcpProviderModelContext;
  serverMetadata?: CloudMcpServerMetadata;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  registerRuntimeMcp: CloudMcpRuntimeRegistrar;
  refreshRegistrationFromLiveStatus?: CloudMcpLiveStatusObserver;
}): Promise<CloudMcpHealth> {
  const readHealth = () => readOpenworkCloudMcpHealth({
    config: input.config,
    workspace: input.workspace,
    directory: input.directory,
    providerModel: input.providerModel,
    serverMetadata: input.serverMetadata,
    createWorkspaceOpencodeClient: input.createWorkspaceOpencodeClient,
    probe: true,
    refreshRegistrationFromLiveStatus: input.refreshRegistrationFromLiveStatus,
  });
  const configBody = input.body.config ?? input.body;
  const desiredConfig = canonicalizeCloudMcpConfig(normalizeCloudMcpConfig(configBody));
  const metadata = extractDesiredMetadata(input.body, desiredConfig);
  const validationProblem = strictCloudMcpDesiredConfigProblem(desiredConfig, metadata);
  if (validationProblem) {
    const validationFailure = failureFromValidationProblem(validationProblem);
    return healthWithFailure(await readHealth(), validationFailure);
  }
  const desiredRevision = calculateCloudMcpDesiredRevision(desiredConfig, metadata);
  await persistDesiredConfig(input.config, input.workspace.id, desiredConfig);
  cloudMcpDeliveryState.markDesired(input.workspace, input.directory, desiredRevision, metadata);

  if (!input.directory) {
    const directoryFailure = failure({
      code: "workspace_directory_ambiguous",
      stage: "prerequisites",
      retryable: false,
      recommendedAction: "Set an explicit OpenCode directory for this remote workspace",
      message: "Remote workspace has no exact OpenCode directory, so Cloud MCP readiness cannot be claimed.",
    });
    cloudMcpDeliveryState.markFailed(input.workspace, input.directory, desiredRevision, directoryFailure);
    return healthWithFailure(await readHealth(), directoryFailure);
  }

  if (!baseUrlConfigured(input.config, input.workspace)) {
    const unconfiguredFailure = failure({
      code: "opencode_unconfigured",
      stage: "prerequisites",
      retryable: false,
      recommendedAction: "Start or attach an OpenCode engine for this workspace",
      message: "OpenCode base URL is missing for this workspace.",
    });
    cloudMcpDeliveryState.markFailed(input.workspace, input.directory, desiredRevision, unconfiguredFailure);
    return healthWithFailure(await readHealth(), unconfiguredFailure);
  }

  cloudMcpDeliveryState.markRegistering(input.workspace, input.directory, desiredRevision);
  const registration = await input.registerRuntimeMcp(input.config, input.workspace, [OPENWORK_CLOUD_MCP_NAME], { throwOnFailure: false });
  if (registration.failures.length > 0) {
    const registrationError = registrationFailure(registration.failures);
    cloudMcpDeliveryState.markFailed(input.workspace, input.directory, desiredRevision, registrationError);
    return healthWithFailure(await readHealth(), registrationError);
  }

  const opencode = input.createWorkspaceOpencodeClient(input.config, input.workspace);
  const connectedFailure = await pollConnected({
    opencode,
    config: input.config,
    workspace: input.workspace,
    directory: input.directory,
    desiredConfig,
    refreshRegistrationFromLiveStatus: input.refreshRegistrationFromLiveStatus,
  });
  if (connectedFailure) {
    cloudMcpDeliveryState.markFailed(input.workspace, input.directory, desiredRevision, connectedFailure);
    return healthWithFailure(await readHealth(), connectedFailure);
  }

  const health = await readHealth();

  if (health.firstFailure) {
    cloudMcpDeliveryState.markFailed(input.workspace, input.directory, desiredRevision, health.firstFailure);
    return healthWithFailure(await readHealth(), health.firstFailure);
  }

  cloudMcpDeliveryState.markReady(input.workspace, input.directory, desiredRevision);
  return readHealth();
}

export async function reconcilePersistedOpenworkCloudMcp(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  directory: string | null;
  providerModel?: CloudMcpProviderModelContext;
  serverMetadata?: CloudMcpServerMetadata;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  registerRuntimeMcp: CloudMcpRuntimeRegistrar;
  refreshRegistrationFromLiveStatus?: CloudMcpLiveStatusObserver;
  trigger?: string;
}): Promise<CloudMcpHealth> {
  const runtimeConfig = await readRuntimeOpencodeConfig(input.config, input.workspace.id);
  const desiredConfig = runtimeMcpMap(runtimeConfig)[OPENWORK_CLOUD_MCP_NAME];
  if (!desiredConfig) {
    return readOpenworkCloudMcpHealth(input);
  }
  return reconcileOpenworkCloudMcp({
    ...input,
    body: {
      config: desiredConfig,
      ...(input.trigger ? { trigger: input.trigger } : {}),
    },
  });
}

export function markOpenworkCloudMcpStale(workspace: WorkspaceInfo, directory: string | null): void {
  cloudMcpDeliveryState.markWorkspaceStale(workspace, directory);
}

export type CloudMcpEngineRefreshStep = {
  step: "engine_disconnect" | "reapply";
  ok: boolean;
  latencyMs: number;
  detail?: unknown;
};

export type CloudMcpEngineRefresh = {
  performed: boolean;
  reason?: "desired_missing";
  trigger: string;
  startedAt: string;
  finishedAt: string;
  steps: CloudMcpEngineRefreshStep[];
};

export type CloudMcpEngineRefreshResult = {
  refresh: CloudMcpEngineRefresh;
  health: CloudMcpHealth;
};

// OpenCode never retries a failed MCP connection on its own: a remote connect
// failure is stored as {status:"failed"} and the client is dropped until
// something external re-drives it. This refresh closes any wedged client
// first (disconnect), then re-runs the persisted reconcile, which re-POSTs
// /mcp — an unconditional fresh connect attempt on the engine side.
export async function refreshOpenworkCloudMcpEngine(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  directory: string | null;
  providerModel?: CloudMcpProviderModelContext;
  serverMetadata?: CloudMcpServerMetadata;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  registerRuntimeMcp: CloudMcpRuntimeRegistrar;
  refreshRegistrationFromLiveStatus?: CloudMcpLiveStatusObserver;
  trigger?: string;
}): Promise<CloudMcpEngineRefreshResult> {
  const trigger = input.trigger?.trim() || "engine-refresh";
  const startedAt = new Date().toISOString();
  const steps: CloudMcpEngineRefreshStep[] = [];
  const finish = (performed: boolean, health: CloudMcpHealth, reason?: "desired_missing"): CloudMcpEngineRefreshResult => ({
    refresh: {
      performed,
      ...(reason ? { reason } : {}),
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps,
    },
    health,
  });

  const runtimeConfig = await readRuntimeOpencodeConfig(input.config, input.workspace.id);
  const desiredConfig = runtimeMcpMap(runtimeConfig)[OPENWORK_CLOUD_MCP_NAME];
  if (!desiredConfig) {
    return finish(false, await readOpenworkCloudMcpHealth({ ...input, probe: true }), "desired_missing");
  }

  const disconnectStarted = Date.now();
  try {
    const opencode = input.createWorkspaceOpencodeClient(input.config, input.workspace);
    const result = await withEngineProbeTimeout(() => opencode.mcp.disconnect({
      name: OPENWORK_CLOUD_MCP_NAME,
      ...locationParams(input.directory),
    }));
    steps.push({
      step: "engine_disconnect",
      ok: result.error === undefined,
      latencyMs: Date.now() - disconnectStarted,
      ...(result.error !== undefined
        ? { detail: sanitizeDiagnosticValue({ status: result.response.status, error: result.error }) }
        : {}),
    });
  } catch (error) {
    // A dynamically-registered entry can be gone after an engine state
    // rebuild, and the engine itself can be down; the reapply below is the
    // authoritative step either way.
    steps.push({
      step: "engine_disconnect",
      ok: false,
      latencyMs: Date.now() - disconnectStarted,
      detail: sanitizeDiagnosticValue(describeTransportError(error)),
    });
  }

  const reapplyStarted = Date.now();
  const health = await reconcilePersistedOpenworkCloudMcp({
    config: input.config,
    workspace: input.workspace,
    directory: input.directory,
    providerModel: input.providerModel,
    serverMetadata: input.serverMetadata,
    createWorkspaceOpencodeClient: input.createWorkspaceOpencodeClient,
    registerRuntimeMcp: input.registerRuntimeMcp,
    refreshRegistrationFromLiveStatus: input.refreshRegistrationFromLiveStatus,
    trigger,
  });
  steps.push({
    step: "reapply",
    ok: health.firstFailure === null,
    latencyMs: Date.now() - reapplyStarted,
    ...(health.firstFailure ? { detail: { code: health.firstFailure.code, stage: health.firstFailure.stage } } : {}),
  });
  return finish(true, health);
}
