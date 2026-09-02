import type { Message, Part, Session, Todo } from "@opencode-ai/sdk/v2/client";
import {
  agentContextDiagnosticsReportSchema,
  agentContextDiagnosticsRequestSchema,
  type AgentContextDiagnosticsReport,
  type AgentContextDiagnosticsRequest,
} from "@openwork/types/agent-context-diagnostics";
import { normalizeBaseUrl } from "@openwork/types/url";
import {
  AGENT_CONTEXT_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
  requestAgentContextDiagnosticsPayload,
} from "./agent-context-diagnostics-transport";
import { desktopFetch, desktopFetchAgentContextDiagnostics, desktopUploadMultipart, electronLocalPathForFile } from "./desktop";
import { isOpenworkGatewayRuntime } from "./gateway-runtime";
import { isDesktopRuntime } from "./runtime-env";
import type { ExecResult, OpencodeConfigFile, WorkspaceInfo, WorkspaceList } from "./desktop";
import type { DenOrgMarketplace, DenOrgPluginResolved, DenResourceSnapshot } from "./den-types";
import type { CloudImportedMarketplace, CloudImportedPlugin, CloudImportedProvider } from "../cloud/import-state";

export type OpenworkServerCapabilities = {
  skills: { read: boolean; write: boolean; source: "openwork" | "opencode" };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
  engine?: { rollover: boolean };
  providerSync?: boolean;
  sandbox?: { enabled: boolean; backend: "none" | "docker" | "container" };
  proxy?: { opencode: boolean };
  toolProviders?: {
    browser?: {
      enabled: boolean;
      placement: "in-sandbox" | "host-machine" | "client-machine" | "external";
      mode: "none" | "headless" | "interactive";
    };
    files?: {
      injection: boolean;
      outbox: boolean;
      inboxPath: string;
      outboxPath: string;
      maxBytes: number;
    };
  };
};

export type OpenworkCloudProviderSyncRun = {
  status: "applied" | "noop" | "failed" | "no_session";
  message?: string;
};

export type OpenworkCloudProviderSyncSkippedProvider = {
  cloudProviderId: string;
  providerId: string;
  name: string;
  /** Machine-readable skip reason, e.g. "missing_credentials". */
  reason: string;
};

export type OpenworkCloudProviderSyncStatus = {
  hasSession: boolean;
  lastRun: { at: string | number; status: OpenworkCloudProviderSyncRun["status"]; message?: string } | null;
  providers: CloudImportedProvider[];
  /** A managed engine reload is still owed: materialized providers are not served yet. */
  reloadPending: boolean;
  /** Den-granted providers the server sync skipped, each with a reason. */
  skippedProviders: OpenworkCloudProviderSyncSkippedProvider[];
};

function parseCloudProviderSyncRun(value: unknown): OpenworkCloudProviderSyncRun {
  if (!value || typeof value !== "object" || !("status" in value)) throw new Error("Invalid cloud provider sync response.");
  const status = value.status;
  if (status !== "applied" && status !== "noop" && status !== "failed" && status !== "no_session") {
    throw new Error("Invalid cloud provider sync status.");
  }
  const message = "message" in value && typeof value.message === "string" ? value.message : undefined;
  return { status, message };
}

function parseCloudImportedProvider(value: unknown): CloudImportedProvider | null {
  if (!value || typeof value !== "object") return null;
  if (
    !("cloudProviderId" in value) || typeof value.cloudProviderId !== "string" ||
    !("providerId" in value) || typeof value.providerId !== "string" ||
    !("sourceProviderId" in value) || typeof value.sourceProviderId !== "string" ||
    !("name" in value) || typeof value.name !== "string" ||
    !("modelIds" in value) || !Array.isArray(value.modelIds) || !value.modelIds.every((item) => typeof item === "string")
  ) return null;
  return {
    cloudProviderId: value.cloudProviderId,
    providerId: value.providerId,
    sourceProviderId: value.sourceProviderId,
    name: value.name,
    source: "source" in value && typeof value.source === "string" ? value.source : null,
    updatedAt: "updatedAt" in value && typeof value.updatedAt === "string" ? value.updatedAt : null,
    modelIds: value.modelIds,
    importedAt: "importedAt" in value && typeof value.importedAt === "number" ? value.importedAt : null,
  };
}

function parseCloudProviderSyncStatus(value: unknown): OpenworkCloudProviderSyncStatus {
  if (!value || typeof value !== "object" || !("hasSession" in value) || typeof value.hasSession !== "boolean" || !("providers" in value) || !Array.isArray(value.providers)) {
    throw new Error("Invalid cloud provider sync status response.");
  }
  const providers: CloudImportedProvider[] = [];
  for (const rawProvider of value.providers) {
    const provider = parseCloudImportedProvider(rawProvider);
    if (!provider) throw new Error("Invalid cloud provider sync provider response.");
    providers.push(provider);
  }
  let lastRun: OpenworkCloudProviderSyncStatus["lastRun"] = null;
  if ("lastRun" in value && value.lastRun !== null) {
    if (!value.lastRun || typeof value.lastRun !== "object" || !("at" in value.lastRun) || (typeof value.lastRun.at !== "string" && typeof value.lastRun.at !== "number")) {
      throw new Error("Invalid cloud provider sync last-run response.");
    }
    const run = parseCloudProviderSyncRun(value.lastRun);
    lastRun = { at: value.lastRun.at, status: run.status, message: run.message };
  }
  // Additive fields (older servers omit them): tolerate absence and malformed
  // entries instead of failing the whole status read.
  const reloadPending = "reloadPending" in value && value.reloadPending === true;
  const skippedProviders: OpenworkCloudProviderSyncSkippedProvider[] = [];
  if ("skippedProviders" in value && Array.isArray(value.skippedProviders)) {
    for (const raw of value.skippedProviders) {
      if (!raw || typeof raw !== "object") continue;
      if (
        !("cloudProviderId" in raw) || typeof raw.cloudProviderId !== "string" ||
        !("providerId" in raw) || typeof raw.providerId !== "string" ||
        !("name" in raw) || typeof raw.name !== "string" ||
        !("reason" in raw) || typeof raw.reason !== "string"
      ) continue;
      skippedProviders.push({
        cloudProviderId: raw.cloudProviderId,
        providerId: raw.providerId,
        name: raw.name,
        reason: raw.reason,
      });
    }
  }
  return { hasSession: value.hasSession, lastRun, providers, reloadPending, skippedProviders };
}

export type OpenworkServerStatus = "connected" | "disconnected" | "limited";

export type OpenworkServerDiagnostics = {
  ok: boolean;
  version: string;
  uptimeMs: number;
  readOnly: boolean;
  approval: { mode: "manual" | "auto"; timeoutMs: number };
  corsOrigins: string[];
  workspaceCount: number;
  activeWorkspaceId?: string | null;
  selectedWorkspaceId?: string | null;
  workspace: OpenworkWorkspaceInfo | null;
  authorizedRoots: string[];
  server: { host: string; port: number; configPath?: string | null };
  tokenSource: { client: string; host: string };
};

export type OpenworkRuntimeServiceName = "openwork-server" | "opencode";

export type OpenworkRuntimeServiceSnapshot = {
  name: OpenworkRuntimeServiceName;
  enabled: boolean;
  running: boolean;
  targetVersion: string | null;
  actualVersion: string | null;
  upgradeAvailable: boolean;
};

export type OpenworkRuntimeSnapshot = {
  ok: boolean;
  worker?: {
    workspace: string;
    sandboxMode: string;
  };
  upgrade?: {
    status: "idle" | "running" | "failed";
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
    operationId: string | null;
    services: OpenworkRuntimeServiceName[];
  };
  services: OpenworkRuntimeServiceSnapshot[];
};

export type OpenworkServerSettings = {
  urlOverride?: string;
  portOverride?: number;
  token?: string;
  hostToken?: string;
  remoteAccessEnabled?: boolean;
};

// The shared WorkspaceWire contract now carries the opencode block; keep the
// historical name as an alias for the many existing imports.
export type OpenworkWorkspaceInfo = WorkspaceInfo;

export type OpenworkWorkspaceList = {
  items: OpenworkWorkspaceInfo[];
  workspaces?: WorkspaceInfo[];
  activeId?: string | null;
};

export type OpenworkSessionMessage = {
  info: Message;
  parts: Part[];
};

export type OpenworkSessionSnapshot = {
  session: Session;
  messages: OpenworkSessionMessage[];
  todos: Todo[];
  status:
    | { type: "idle" }
    | { type: "busy" }
    | { type: "retry"; attempt: number; message: string; next: number };
};

export type OpenworkPluginItem = {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  path?: string;
};

export type OpenworkSkillItem = {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  trigger?: string;
  error?: string;
};

export type OpenworkSkillContent = {
  item: OpenworkSkillItem;
  content: string;
};

export type OpenworkWorkspaceFileContent = {
  path: string;
  content: string;
  bytes: number;
  updatedAt: number;
};

export type OpenworkWorkspaceFileWriteResult = {
  ok: boolean;
  path: string;
  bytes: number;
  updatedAt: number;
  revision?: string;
};

export type OpenworkWorkspaceFileDeleteResult = {
  ok: boolean;
  path: string;
  code?: string;
};

export type OpenworkWorkspaceCatalogEntry = {
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  revision: string;
};

export type OpenworkWorkspaceCatalog = {
  items: OpenworkWorkspaceCatalogEntry[];
  total: number;
  truncated: boolean;
};

export type OpenworkAuthorizedFoldersResponse = {
  folders: string[];
  hiddenCount: number;
  workspaceRoot: string;
};

export type OpenworkPermissionAction = "allow" | "ask" | "deny";
export type OpenworkPermissionSource = "engine" | "global" | "openwork" | "workspace";
export type OpenworkEffectivePermissionKey =
  | "shell"
  | "edit"
  | "web"
  | "mcp"
  | "outside_folders"
  | "env_files"
  | "doom_loop";

export type OpenworkEffectivePermissionRow = {
  key: OpenworkEffectivePermissionKey;
  permission: string;
  action: OpenworkPermissionAction;
  rule: { permission: string; pattern: string; action: OpenworkPermissionAction } | null;
  source: OpenworkPermissionSource | null;
  exceptions: number;
};

export type OpenworkEffectivePermissionsResponse = {
  agent: string;
  rows: OpenworkEffectivePermissionRow[];
  files: { workspace: string; global: string };
};

export type OpenworkWorkspacePermissionRule = {
  permission: string;
  pattern: string;
  action: OpenworkPermissionAction;
};

export type OpenworkWorkspacePermissionRulesResponse = {
  rules: OpenworkWorkspacePermissionRule[];
  path: string;
};

export type OpenworkWorkspacePermissionRulesUpdateResponse = OpenworkWorkspacePermissionRulesResponse & {
  changed: boolean;
};

export type OpenworkAuthorizedFoldersUpdateResponse = {
  folders: string[];
  hiddenCount: number;
  updatedAt: number;
};

export type OpenworkRuntimeDisabledProvidersResult = {
  ok: true;
  disabledProviders: string[];
};

export type OpenworkRuntimeConfigStatus = {
  runtime: Record<string, unknown>;
  runtimeKeys: string[];
  effectiveRuntime: Record<string, unknown>;
  managedFilePath: string;
  managedFileRebuiltAt: number | null;
  managedFileContentRedacted: string | null;
  sources?: {
    projectOpencode: { path: string; exists: boolean; keys: string[]; config: Record<string, unknown> };
    globalOpencode: { path: string; exists: boolean; keys: string[]; config: Record<string, unknown> };
    runtimeDatabase: { keys: string[]; config: Record<string, unknown> };
    injected: { keys: string[]; config: Record<string, unknown> };
  };
  userOpencode: {
    path: string;
    exists: boolean;
    keys: string[];
  };
};

export type OpenworkDesktopCloudSyncChange = {
  id: string;
  kind: "new" | "modified" | "removed";
  resourceKind: "llmProvider" | "marketplace" | "plugin" | "configItem";
  marketplaceId?: string;
  pluginId?: string;
  previousLastUpdatedAt: string | null;
  nextLastUpdatedAt: string | null;
  queuedAt: number;
};

export type OpenworkDesktopCloudSyncState = {
  entries: Record<string, unknown>;
  updatedAt: number;
  version: 1;
};

export type OpenworkDesktopCloudSyncResult = {
  changes: OpenworkDesktopCloudSyncChange[];
  state: OpenworkDesktopCloudSyncState;
};

export type OpenworkCloudPluginInstallResult = {
  item: CloudImportedPlugin;
  warnings: string[];
};

export type OpenworkCloudPluginsResult = {
  marketplaces: Record<string, CloudImportedMarketplace>;
  plugins: Record<string, CloudImportedPlugin>;
};

export type OpenworkClaudePluginComponent = {
  type: "mcp" | "skill" | "command" | "agent";
  name: string;
  description: string | null;
};

export type OpenworkClaudePluginPreview = {
  pluginId: string;
  name: string;
  description: string | null;
  version: string | null;
  source: { owner: string; repo: string; ref: string; dir: string | null };
  components: OpenworkClaudePluginComponent[];
  warnings: string[];
};

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export type OpenworkCommandItem = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
};

export type OpenworkMcpItem = {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
  managedOAuth?: OpenworkManagedMcpConnection | null;
};

export type OpenworkMcpAppResource = {
  serverName: string;
  toolName: string;
  resourceUri: string;
  html: string;
  csp: {
    connectDomains: string[];
    resourceDomains: string[];
    frameDomains: string[];
    baseUriDomains: string[];
  };
  prefersBorder: boolean;
};

export type OpenworkMcpAppLaunchReference = {
  connectionId?: string;
  toolName: string;
  resourceUri: string;
  arguments: Record<string, unknown>;
};

export type OpenworkMcpAppCatalogApp = {
  serverName: string;
  /** Present for Connect app-host apps: launch them through this connection reference. */
  connectionId?: string;
  toolName: string;
  projectedToolName: string;
  resourceUri: string;
  title: string | null;
  description: string | null;
  /** True when the launch tool declares required input, so a host cannot start it with empty arguments. */
  requiresInput: boolean;
  /** True when calling the launch tool needs user approval (not explicitly read-only, or destructive). */
  requiresApproval: boolean;
};

export type OpenworkMcpAppCatalogServer = {
  serverName: string;
  /** Human-readable provider name for Connect app-host servers. */
  displayName?: string;
  connectionId?: string;
  reachable: boolean;
  error?: string;
  apps: OpenworkMcpAppCatalogApp[];
};

export type OpenworkMcpAppToolResult = {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export type OpenworkMcpAppSandbox = {
  url: string;
  expectedOrigin: string;
};

export function normalizeMcpAppHostOrigin(hostOrigin: string): string {
  return hostOrigin === "file://" ? "null" : hostOrigin;
}

export type OpenworkManagedMcpConnection = {
  name: string;
  serverUrl: string;
  enabled: boolean;
  status: "needs_auth" | "connecting" | "connected" | "reconnect_required";
  lastError: string | null;
  hasCredential: boolean;
  updatedAt: number;
};

export type OpenworkManagedOAuthState = {
  available: boolean;
  recovery: { at: number; reason: string; quarantinedTo: string } | null;
};

export type OpenworkManagedMcpStartResult =
  | { status: "connected" }
  | { status: "needs_auth"; authorizeUrl: string };

export type OpenworkMcpEngineSync = {
  status: "ok" | "failed";
  at: number;
  failures: Array<{ name: string; status?: number; message?: string }>;
};

export type OpenworkCloudMcpProviderModelContext = {
  provider: string;
  model: string;
};

export type OpenworkCloudMcpFailureStage =
  | "prerequisites"
  | "token_mint"
  | "desired_config"
  | "engine_delivery"
  | "transport_auth"
  | "tool_registration"
  | "provider_projection"
  | "plugin_load"
  | "steering"
  | "desired"
  | "workspace"
  | "configuration"
  | "registration"
  | "engine_status"
  | "tool_ids"
  | "plugin_canary";

export type OpenworkCloudMcpFailureCode =
  | "cloud_desired_missing"
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
  | "workspace_directory_ambiguous"
  | "opencode_unconfigured"
  | "opencode_engine_unreachable"
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
  | "cloud_tools_missing"
  | "provider_projection_unavailable"
  | "provider_projection_missing"
  | "extensions_plugin_missing"
  | string;

export type OpenworkCloudMcpFailure = {
  code: OpenworkCloudMcpFailureCode;
  stage: OpenworkCloudMcpFailureStage | string;
  retryable: boolean;
  recommendedAction: string;
  message: string;
  aliases?: string[];
  requestId?: string;
  referenceId?: string;
  details?: unknown;
};

export type OpenworkCloudMcpCompatibility = {
  openwork: {
    serverVersion: string | null;
    app: Record<string, string | number | boolean | null> | null;
  };
  opencode: {
    expectedVersion: string | null;
    actualVersion: string | null;
    probe: "ok" | "unavailable" | "not_checked" | string;
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
  experimentalToolIds: {
    checked: boolean;
    expected: string[];
    present: string[];
    missing: string[];
    includesMcpTools: boolean | null;
    limitation?: string;
    error?: unknown;
  };
  experimentalProviderTools: {
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
};

export type OpenworkCloudMcpHealthPhase =
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
  | "ready"
  | string;

export type OpenworkCloudMcpDeliverySnapshot = {
  state: "not_desired" | "pending" | "registering" | "ready" | "failed" | "stale" | string;
  desiredRevision: string | null;
  appliedRevision: string | null;
  updatedAt: number | null;
  appliedAt: number | null;
  lastAttemptAt: number | null;
  trigger?: string;
  failure?: OpenworkCloudMcpFailure;
};

export type OpenworkCloudMcpProbeStep = {
  step: "initialize" | "initialized_notice" | "tools_list" | string;
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  error?: unknown;
};

export type OpenworkCloudMcpProbeTrace = {
  endpoint: string | null;
  startedAt: string;
  latencyMs: number;
  protocolVersion: string | null;
  serverInfo: { name: string | null; version: string | null } | null;
  steps: OpenworkCloudMcpProbeStep[];
};

export type OpenworkCloudMcpEngineRefreshStep = {
  step: "engine_disconnect" | "reapply" | string;
  ok: boolean;
  latencyMs: number;
  detail?: unknown;
};

export type OpenworkCloudMcpEngineRefresh = {
  performed: boolean;
  reason?: "desired_missing" | string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  steps: OpenworkCloudMcpEngineRefreshStep[];
};

export type OpenworkCloudMcpEngineRefreshResult = {
  refresh: OpenworkCloudMcpEngineRefresh;
  health: OpenworkCloudMcpHealth;
};

export type OpenworkCloudMcpHealth = {
  schemaVersion: 1;
  phase: OpenworkCloudMcpHealthPhase;
  usable: boolean;
  usableByCurrentModel: boolean | null;
  connectCatalogEnabled: boolean;
  workspace: {
    id: string;
    type: string;
    directory: string | null;
    path: string;
  };
  desired: {
    present: boolean;
    name: "openwork-cloud";
    revision: string | null;
    config: Record<string, unknown> | null;
    token: {
      present: boolean;
      metadata: Record<string, string | number | boolean | null>;
    };
    org?: Record<string, string | number | boolean | null>;
    app?: Record<string, string | number | boolean | null>;
    updatedAt?: number;
  };
  delivery: OpenworkCloudMcpDeliverySnapshot;
  engine: {
    status: "not_checked" | "missing" | "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration" | "unreachable" | "unknown" | string;
    error?: unknown;
  };
  /** The engine's own view of every MCP server it tracks (older servers omit this). */
  engineInspection?: {
    checked: boolean;
    cloudPresent?: boolean;
    serverCount?: number;
    servers?: Array<{ name: string; status: string; error?: string }>;
  };
  tools: {
    expected: string[];
    present: string[];
    missing: string[];
    direct: {
      checked: boolean;
      source: "mcp_tools_list" | string;
      expected: string[];
      present: string[];
      missing: string[];
      trace?: OpenworkCloudMcpProbeTrace;
      error?: unknown;
      failure?: OpenworkCloudMcpFailure;
    };
    providerProjection: {
      checked: boolean;
      provider?: string;
      model?: string;
      source?: "experimental_tool" | "provider_capability" | string;
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
  compatibility: OpenworkCloudMcpCompatibility;
  toolDenies: unknown[];
  firstFailure: OpenworkCloudMcpFailure | null;
  checkedAt: string;
  durationMs?: number;
};

export type OpenworkCloudMcpReconcilePayload = {
  workspaceId: string;
  name: "openwork-cloud";
  config: Record<string, unknown>;
  /** Desktop-private credential; the local server must never project it into OpenCode. */
  appHostAuthorization?: string;
  tokenMetadata?: Record<string, string | number | boolean | null>;
  org?: Record<string, string | number | boolean | null>;
  app?: Record<string, string | number | boolean | null>;
  appVersion?: string;
  buildSha?: string;
  connectCatalogEnabled?: boolean;
  trigger?: string;
  provider?: string;
  model?: string;
};

export type OpenworkWorkspaceExport = {
  workspaceId: string;
  exportedAt: number;
  opencode?: Record<string, unknown>;
  openwork?: Record<string, unknown>;
  skills?: Array<{ name: string; description?: string; trigger?: string; content: string }>;
  commands?: Array<{ name: string; description?: string; template?: string }>;
  files?: Array<{ path: string; content: string }>;
};

export type OpenworkWorkspaceExportSensitiveMode = "auto" | "include" | "exclude";

export type OpenworkWorkspaceExportWarning = {
  id: string;
  label: string;
  detail: string;
};

export type OpenworkArtifactItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  createdAt?: number;
  updatedAt?: number;
  mime?: string;
};

export type OpenworkArtifactList = {
  items: OpenworkArtifactItem[];
};

export type OpenworkConnectState = {
  ok: true;
  schemaVersion: 1;
  status: "available" | "missing" | "invalid" | "unreadable";
  connectEnabled: boolean;
  cloudMcpPresent: boolean;
  googleWorkspace: { legacyConfigured: boolean };
};

export type OpenworkExtensionActionCall = {
  extensionId: string;
  action: string;
  args?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type OpenworkExtensionActionResult =
  | {
    ok: true;
    extensionId: string;
    action: string;
    result: unknown;
    context?: Record<string, unknown>;
  }
  | {
    ok: false;
    error: string;
    message: string;
  };

export type OpenworkResolvedArtifactTarget = {
  id: string;
  kind: "file" | "url";
  value: string;
  name: string;
  preview: "browser" | "markdown" | "code" | "sheet" | "slides" | "document" | "image" | "pdf" | "html" | "text" | "external";
  confidence: number;
  reason: string;
  exists?: boolean;
  size?: number;
  updatedAt?: number;
  contentType?: string;
};

export type OpenworkWorkspaceFileStat = {
  ok: boolean;
  path: string;
  exists: boolean;
  kind?: "file" | "dir" | "other";
  size?: number;
  updatedAt?: number;
};

export type OpenworkInboxItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  updatedAt?: number;
};

export type OpenworkInboxList = {
  items: OpenworkInboxItem[];
};

export type OpenworkInboxUploadResult = {
  ok: boolean;
  path: string;
  bytes: number;
};

export type OpenworkUserEnvItem = {
  key: string;
  updatedAt: number;
  hasValue: boolean;
  value?: string;
};

export type OpenworkActor = {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
};

export type OpenworkAuditEntry = {
  id: string;
  workspaceId: string;
  actor: OpenworkActor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
};

export type OpenworkReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export type OpenworkReloadEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  reason: "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";
  trigger?: OpenworkReloadTrigger;
  timestamp: number;
};

export type OpenworkUiControlRequest = {
  id: string;
  kind: "context" | "query" | "command";
  input: unknown;
  createdAt: number;
};

export type OpenworkSessionGroupDefinition = {
  id: string;
  label: string;
};

export type OpenworkSessionGroupState = {
  groups: OpenworkSessionGroupDefinition[];
  assignments: Record<string, string>;
};

export type OpenworkSessionGroupEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  type: "session_groups.updated";
  action: "created" | "updated" | "deleted" | "assigned" | "reordered" | "imported";
  groupId?: string;
  sessionId?: string;
  timestamp: number;
};

// Fallback for explicit server-mode URL derivation. Desktop local workers replace this
// with the persisted runtime-discovered port once the host reports it.
export const DEFAULT_OPENWORK_SERVER_PORT = 8787;

const STORAGE_URL_OVERRIDE = "openwork.server.urlOverride";
const STORAGE_PORT_OVERRIDE = "openwork.server.port";
const STORAGE_TOKEN = "openwork.server.token";
const STORAGE_HOST_AUTH_KEY = "openwork.server.hostToken";
const STORAGE_REMOTE_ACCESS = "openwork.server.remoteAccessEnabled";

type OpenworkBootstrap = {
  token?: string;
};

declare global {
  interface Window {
    __OPENWORK_BOOTSTRAP__?: OpenworkBootstrap;
  }
}

export function normalizeOpenworkServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return normalizeBaseUrl(withProtocol);
}

export function isLoopbackOpenworkServerUrl(input: string) {
  const normalized = normalizeOpenworkServerUrl(input) ?? "";
  if (!normalized) return false;
  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function parseOpenworkWorkspaceIdFromUrl(input: string) {
  const normalized = normalizeOpenworkServerUrl(input) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const legacyIndex = segments.indexOf("w");
    if (legacyIndex >= 0 && segments[legacyIndex + 1]) {
      return decodeURIComponent(segments[legacyIndex + 1]);
    }
    const workspaceIndex = segments.indexOf("workspace");
    if (workspaceIndex >= 0 && segments[workspaceIndex + 1]) {
      return decodeURIComponent(segments[workspaceIndex + 1]);
    }
    return null;
  } catch {
    const match = normalized.match(/\/(?:w|workspace)\/([^/?#]+)/);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

export function buildOpenworkWorkspaceBaseUrl(hostUrl: string, workspaceId?: string | null) {
  const normalized = normalizeOpenworkServerUrl(hostUrl) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    if (mountIndex >= 0 && segments[mountIndex + 1]) {
      const prefix = segments.slice(0, mountIndex).join("/");
      url.pathname = `${prefix ? `/${prefix}` : ""}/workspace/${encodeURIComponent(
        decodeURIComponent(segments[mountIndex + 1]),
      )}`;
      return url.toString().replace(/\/+$/, "");
    }

    const id = (workspaceId ?? "").trim();
    if (!id) return url.toString().replace(/\/+$/, "");

    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/workspace/${encodeURIComponent(id)}`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    const id = (workspaceId ?? "").trim();
    if (!id) return normalized;
    return `${normalized.replace(/\/+$/, "")}/workspace/${encodeURIComponent(id)}`;
  }
}

const OPENWORK_INVITE_PARAM_URL = "ow_url";
const OPENWORK_INVITE_PARAM_TOKEN = "ow_token";
const OPENWORK_INVITE_PARAM_STARTUP = "ow_startup";
const OPENWORK_INVITE_PARAM_AUTO_CONNECT = "ow_auto_connect";

export type OpenworkConnectInvite = {
  url: string;
  token?: string;
  startup?: "server";
  autoConnect?: boolean;
};

export function readOpenworkConnectInviteFromSearch(input: string | URLSearchParams) {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  const rawUrl = search.get(OPENWORK_INVITE_PARAM_URL)?.trim() ?? "";
  const url = normalizeOpenworkServerUrl(rawUrl);
  if (!url) return null;

  const token = search.get(OPENWORK_INVITE_PARAM_TOKEN)?.trim() ?? "";
  const startupRaw = search.get(OPENWORK_INVITE_PARAM_STARTUP)?.trim() ?? "";
  const startup = startupRaw === "server" ? "server" : undefined;
  const autoConnect = search.get(OPENWORK_INVITE_PARAM_AUTO_CONNECT)?.trim() === "1";

  return {
    url,
    token: token || undefined,
    startup,
    autoConnect: autoConnect || undefined,
  } satisfies OpenworkConnectInvite;
}

export function stripOpenworkConnectInviteFromUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_URL);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_TOKEN);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_STARTUP);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_AUTO_CONNECT);
    return url.toString();
  } catch {
    return input;
  }
}

export function readOpenworkServerSettings(): OpenworkServerSettings {
  if (typeof window === "undefined") return {};
  try {
    const urlOverride = normalizeOpenworkServerUrl(
      window.localStorage.getItem(STORAGE_URL_OVERRIDE) ?? "",
    );
    const portRaw = window.localStorage.getItem(STORAGE_PORT_OVERRIDE) ?? "";
    const portOverride = portRaw ? Number(portRaw) : undefined;
    const token = window.localStorage.getItem(STORAGE_TOKEN) ?? undefined;
    const hostToken = window.localStorage.getItem(STORAGE_HOST_AUTH_KEY) ?? undefined;
    const remoteAccessRaw = window.localStorage.getItem(STORAGE_REMOTE_ACCESS) ?? "";
    return {
      urlOverride: urlOverride ?? undefined,
      portOverride: Number.isNaN(portOverride) ? undefined : portOverride,
      token: token?.trim() || undefined,
      hostToken: hostToken?.trim() || undefined,
      remoteAccessEnabled: remoteAccessRaw === "1",
    };
  } catch {
    return {};
  }
}

export function writeOpenworkServerSettings(next: OpenworkServerSettings): OpenworkServerSettings {
  if (typeof window === "undefined") return next;
  try {
    const urlOverride = normalizeOpenworkServerUrl(next.urlOverride ?? "");
    const portOverride = typeof next.portOverride === "number" ? next.portOverride : undefined;
    const token = next.token?.trim() || undefined;
    const hostToken = next.hostToken?.trim() || undefined;
    const remoteAccessEnabled = next.remoteAccessEnabled === true;

    if (urlOverride) {
      window.localStorage.setItem(STORAGE_URL_OVERRIDE, urlOverride);
    } else {
      window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    }

    if (typeof portOverride === "number" && !Number.isNaN(portOverride)) {
      window.localStorage.setItem(STORAGE_PORT_OVERRIDE, String(portOverride));
    } else {
      window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    }

    if (token) {
      window.localStorage.setItem(STORAGE_TOKEN, token);
    } else {
      window.localStorage.removeItem(STORAGE_TOKEN);
    }

    if (hostToken) {
      window.localStorage.setItem(STORAGE_HOST_AUTH_KEY, hostToken);
    } else {
      window.localStorage.removeItem(STORAGE_HOST_AUTH_KEY);
    }

    if (remoteAccessEnabled) {
      window.localStorage.setItem(STORAGE_REMOTE_ACCESS, "1");
    } else {
      window.localStorage.removeItem(STORAGE_REMOTE_ACCESS);
    }

    return readOpenworkServerSettings();
  } catch {
    return next;
  }
}

function readForceEnvSettingsFlag(): boolean {
  const raw =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_OPENWORK_FORCE_ENV_SETTINGS === "string"
      ? import.meta.env.VITE_OPENWORK_FORCE_ENV_SETTINGS.trim()
      : "";
  return /^(1|true|yes|on)$/i.test(raw);
}

export function hydrateOpenworkServerSettingsFromEnv() {
  if (typeof window === "undefined") return;
  if (isOpenworkGatewayRuntime()) return;

  const envUrl = typeof import.meta.env?.VITE_OPENWORK_URL === "string"
    ? import.meta.env.VITE_OPENWORK_URL.trim()
    : "";
  const envPort = typeof import.meta.env?.VITE_OPENWORK_PORT === "string"
    ? import.meta.env.VITE_OPENWORK_PORT.trim()
    : "";
  const envToken = typeof import.meta.env?.VITE_OPENWORK_TOKEN === "string"
    ? import.meta.env.VITE_OPENWORK_TOKEN.trim()
    : "";
  const envHostToken = typeof import.meta.env?.VITE_OPENWORK_HOST_TOKEN === "string"
    ? import.meta.env.VITE_OPENWORK_HOST_TOKEN.trim()
    : "";
  const bootstrapToken = typeof window.__OPENWORK_BOOTSTRAP__?.token === "string"
    ? window.__OPENWORK_BOOTSTRAP__.token.trim()
    : "";
  const forceEnvSettings = readForceEnvSettingsFlag();

  if (!envUrl && !envPort && !envToken && !envHostToken && !bootstrapToken) return;

  try {
    const current = readOpenworkServerSettings();
    const next: OpenworkServerSettings = { ...current };
    let changed = false;

    if (envUrl && (forceEnvSettings || !current.urlOverride)) {
      const normalized = normalizeOpenworkServerUrl(envUrl);
      if (normalized && normalized !== current.urlOverride) {
        next.urlOverride = normalized;
        changed = true;
      }
    }

    if (envPort && (forceEnvSettings || !current.portOverride)) {
      const parsed = Number(envPort);
      if (Number.isFinite(parsed) && parsed > 0 && parsed !== current.portOverride) {
        next.portOverride = parsed;
        changed = true;
      }
    }

    if (bootstrapToken && current.token !== bootstrapToken) {
      next.token = bootstrapToken;
      changed = true;
    } else if (envToken && (forceEnvSettings || !current.token) && current.token !== envToken) {
      next.token = envToken;
      changed = true;
    }

    if (envHostToken && (forceEnvSettings || !current.hostToken) && current.hostToken !== envHostToken) {
      next.hostToken = envHostToken;
      changed = true;
    } else if (forceEnvSettings && !envHostToken && current.hostToken) {
      // Headless web does not inject the host token into the Vite bundle.
      // Drop a leftover value from an earlier desktop/dev session so it
      // cannot keep authorizing host-token routes from the browser.
      next.hostToken = undefined;
      changed = true;
    }

    if (changed) {
      writeOpenworkServerSettings(next);
    }
  } catch {
    // ignore
  }
}

export function clearOpenworkServerSettings() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    window.localStorage.removeItem(STORAGE_TOKEN);
    window.localStorage.removeItem(STORAGE_HOST_AUTH_KEY);
    window.localStorage.removeItem(STORAGE_REMOTE_ACCESS);
  } catch {
    // ignore
  }
}

export class OpenworkServerError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function buildHeaders(
  token?: string,
  hostToken?: string,
  extra?: Record<string, string>,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-OpenWork-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

function buildAuthHeaders(token?: string, hostToken?: string, extra?: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-OpenWork-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

// Use Tauri's fetch when running in the desktop app to avoid CORS issues.
// Stream URLs (SSE) bypass the plugin because its `fetch_read_body` IPC call
// blocks until the body closes — that freezes the webview for infinite bodies.
const OPENWORK_STREAM_URL_RE = /\/events(\b|\?)|\/event-stream\b|\/stream\b/;

function isStreamUrl(url: string): boolean {
  return OPENWORK_STREAM_URL_RE.test(url);
}

function isLoopbackUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

const resolveFetch = (url?: string) => {
  if (!isDesktopRuntime()) return globalThis.fetch;
  if (url && isStreamUrl(url)) {
    return typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch;
  }
  return desktopFetch;
};

const DEFAULT_OPENWORK_SERVER_TIMEOUT_MS = 10_000;
const ENGINE_RELOAD_TIMEOUT_MS = 60_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal
    ? { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal }
    : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(url, initWithSignal), timeoutPromise]);
  } catch (error) {
    const name = (error && typeof error === "object" && "name" in error ? (error as any).name : "") as string;
    if (name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      signal: options.signal,
      headers: buildHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new OpenworkServerError(response.status, code, message, json?.details);
  }

  return json as T;
}

async function requestAgentContextDiagnosticsJson(
  baseUrl: string,
  path: string,
  options: {
    token?: string;
    hostToken?: string;
    body: AgentContextDiagnosticsRequest;
    timeoutMs: number;
  },
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const result = await requestAgentContextDiagnosticsPayload({
    url,
    init: {
      method: "POST",
      headers: buildHeaders(options.token, options.hostToken),
      body: JSON.stringify(options.body),
    },
    timeoutMs: options.timeoutMs,
    fetchImpl: (input, init, deadlineAtMs) => isDesktopRuntime()
      ? desktopFetchAgentContextDiagnostics(input, init, deadlineAtMs)
      : globalThis.fetch(input, init),
  });

  if (!result.response.ok) {
    const payload = result.payload;
    const code = payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string"
      ? payload.code
      : "request_failed";
    const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
      ? payload.message
      : result.response.statusText;
    const details = payload && typeof payload === "object" && "details" in payload
      ? payload.details
      : undefined;
    throw new OpenworkServerError(result.response.status, code, message, details);
  }

  return result.payload;
}

async function requestMultipartRaw(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: FormData; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "POST",
      headers: buildAuthHeaders(options.token, options.hostToken),
      body: options.body,
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
  );
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function requestBinary(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; timeoutMs?: number } = {},
): Promise<{ data: ArrayBuffer; contentType: string | null; filename: string | null }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildAuthHeaders(options.token, options.hostToken),
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new OpenworkServerError(response.status, code, message, json?.details);
  }

  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filenameRaw = filenameMatch?.[1] ?? filenameMatch?.[2] ?? null;
  const filename = filenameRaw ? decodeURIComponent(filenameRaw) : null;
  const data = await response.arrayBuffer();
  return { data, contentType, filename };
}

export function createOpenworkServerClient(options: { baseUrl: string; token?: string; hostToken?: string }) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;
  const hostToken = options.hostToken;

  const timeouts = {
    health: 3_000,
    capabilities: 6_000,
    listWorkspaces: 8_000,
    activateWorkspace: 10_000,
    deleteWorkspace: 10_000,
    sessionRead: 12_000,
    status: 6_000,
    diagnostics: AGENT_CONTEXT_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    config: 10_000,
    cloudMcpHealth: 12_000,
    cloudMcpProbeHealth: 30_000,
    cloudMcpReconcile: 60_000,
    workspaceExport: 30_000,
    binary: 60_000,
  };

  return {
    baseUrl,
    token,
    health: () =>
      requestJson<{ ok: boolean; version: string; uptimeMs: number }>(baseUrl, "/health", { token, hostToken, timeoutMs: timeouts.health }),
    runtimeVersions: () =>
      requestJson<OpenworkRuntimeSnapshot>(baseUrl, "/runtime/versions", { token, hostToken, timeoutMs: timeouts.status }),
    status: () => requestJson<OpenworkServerDiagnostics>(baseUrl, "/status", { token, hostToken, timeoutMs: timeouts.status }),
    capabilities: () => requestJson<OpenworkServerCapabilities>(baseUrl, "/capabilities", { token, hostToken, timeoutMs: timeouts.capabilities }),
    getConnectState: (workspaceId?: string | null) => {
      const query = new URLSearchParams();
      if (workspaceId?.trim()) query.set("workspaceId", workspaceId.trim());
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<OpenworkConnectState>(baseUrl, `/experimental/connect/state${suffix}`, { token, hostToken, timeoutMs: timeouts.config });
    },
    putDenSession: async (body: { baseUrl: string; token: string; orgId: string }) => {
      await requestJson<unknown>(baseUrl, "/den-session", { hostToken, method: "PUT", body, timeoutMs: timeouts.config });
    },
    deleteDenSession: async () => {
      await requestJson<unknown>(baseUrl, "/den-session", { hostToken, method: "DELETE", timeoutMs: timeouts.config });
    },
    runCloudProviderSyncNow: async (reason?: string) =>
      parseCloudProviderSyncRun(await requestJson<unknown>(baseUrl, "/cloud-provider-sync/run", {
        hostToken,
        method: "POST",
        body: reason ? { reason } : {},
        timeoutMs: timeouts.cloudMcpReconcile,
      })),
    getCloudProviderSyncStatus: async () =>
      parseCloudProviderSyncStatus(await requestJson<unknown>(baseUrl, "/cloud-provider-sync/status", {
        token,
        timeoutMs: timeouts.config,
      })),
    setConnectState: (connectEnabled: boolean) => requestJson<OpenworkConnectState>(baseUrl, "/experimental/connect/state", { token, hostToken, method: "PUT", body: { connectEnabled }, timeoutMs: timeouts.config }),
    callExtensionAction: (payload: OpenworkExtensionActionCall) =>
      requestJson<OpenworkExtensionActionResult>(baseUrl, "/experimental/extensions/call", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.binary,
      }),
    listWorkspaces: () => requestJson<OpenworkWorkspaceList>(baseUrl, "/workspaces", { token, hostToken, timeoutMs: timeouts.listWorkspaces }),
    createLocalWorkspace: (payload: { folderPath: string; name: string; preset: string }) =>
      requestJson<WorkspaceList>(baseUrl, "/workspaces/local", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.activateWorkspace,
      }),
    createRemoteWorkspace: (payload: {
      baseUrl: string;
      openworkHostUrl?: string | null;
      openworkToken?: string | null;
      openworkWorkspaceId?: string | null;
      openworkWorkspaceName?: string | null;
      displayName?: string | null;
      directory?: string | null;
      remoteType?: "openwork" | "opencode";
      sandboxBackend?: string | null;
      sandboxRunId?: string | null;
      sandboxContainerName?: string | null;
    }) =>
      requestJson<WorkspaceList>(baseUrl, "/workspaces/remote", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.activateWorkspace,
      }),
    updateWorkspaceDisplayName: (workspaceId: string, displayName: string | null) =>
      requestJson<WorkspaceList>(baseUrl, `/workspaces/${encodeURIComponent(workspaceId)}/display-name`, {
        token,
        hostToken,
        method: "PATCH",
        body: { displayName },
        timeoutMs: timeouts.activateWorkspace,
      }),
    activateWorkspace: (workspaceId: string, options?: { persist?: boolean }) => {
      const query = options?.persist ? "?persist=true" : "";
      return requestJson<{ activeId: string; workspace: OpenworkWorkspaceInfo; persisted: boolean }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}/activate${query}`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace },
      );
    },
    deleteWorkspace: (workspaceId: string) =>
      requestJson<{ ok: boolean; deleted: boolean; persisted: boolean; activeId: string | null; items: OpenworkWorkspaceInfo[]; workspaces?: WorkspaceInfo[] }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteWorkspace },
      ),
    getSessionGroups: (workspaceId: string) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number | null }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      ),
    putSessionGroups: (workspaceId: string, state: OpenworkSessionGroupState) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, method: "PUT", body: { state }, timeoutMs: timeouts.config },
      ),
    createSessionGroup: (workspaceId: string, input: { id?: string; label: string }) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.config },
      ),
    reorderSessionGroups: (workspaceId: string, groupIds: string[]) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/reorder`,
        { token, hostToken, method: "PATCH", body: { groupIds }, timeoutMs: timeouts.config },
      ),
    assignSessionGroup: (workspaceId: string, sessionId: string, groupId: string | null) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/assignments/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "PATCH", body: { groupId }, timeoutMs: timeouts.config },
      ),
    renameSessionGroup: (workspaceId: string, groupId: string, label: string) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}`,
        { token, hostToken, method: "PATCH", body: { label }, timeoutMs: timeouts.config },
      ),
    removeSessionGroup: (workspaceId: string, groupId: string, destinationGroupId: string | null = null) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}${destinationGroupId ? `?destinationGroupId=${encodeURIComponent(destinationGroupId)}` : ""}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.config },
      ),
    listSessionGroupEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: OpenworkSessionGroupEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/events${query}`,
        { token, hostToken },
      );
    },
    exportWorkspace: (
      workspaceId: string,
      options?: { sensitiveMode?: OpenworkWorkspaceExportSensitiveMode },
    ) => {
      const query = new URLSearchParams();
      if (options?.sensitiveMode) {
        query.set("sensitive", options.sensitiveMode);
      }
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<OpenworkWorkspaceExport>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/export${suffix}`, {
        token,
        hostToken,
        timeoutMs: timeouts.workspaceExport,
      });
    },
    getConfig: (workspaceId: string) =>
      requestJson<{ opencode: Record<string, unknown>; openwork: Record<string, unknown>; updatedAt?: number | null }>(
        baseUrl,
        `/workspace/${workspaceId}/config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    getEffectivePermissions: (workspaceId: string) =>
      requestJson<OpenworkEffectivePermissionsResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/permissions/effective`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    listWorkspacePermissionRules: (workspaceId: string) =>
      requestJson<OpenworkWorkspacePermissionRulesResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/permissions/rules`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    addWorkspacePermissionRule: (workspaceId: string, rule: OpenworkWorkspacePermissionRule) =>
      requestJson<OpenworkWorkspacePermissionRulesUpdateResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/permissions/rules`,
        { token, hostToken, method: "POST", body: rule, timeoutMs: timeouts.config },
      ),
    removeWorkspacePermissionRule: (workspaceId: string, rule: Pick<OpenworkWorkspacePermissionRule, "permission" | "pattern">) =>
      requestJson<OpenworkWorkspacePermissionRulesUpdateResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/permissions/rules`,
        { token, hostToken, method: "DELETE", body: rule, timeoutMs: timeouts.config },
      ),
    listAuthorizedFolders: (workspaceId: string) =>
      requestJson<OpenworkAuthorizedFoldersResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/authorized-folders`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    setAuthorizedFolders: (workspaceId: string, folders: string[]) =>
      requestJson<OpenworkAuthorizedFoldersUpdateResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/authorized-folders`,
        {
          token,
          hostToken,
          method: "PUT",
          body: { folders },
          timeoutMs: timeouts.config,
        },
      ),
    setRuntimeDisabledProviders: (workspaceId: string, providers: string[]) =>
      requestJson<OpenworkRuntimeDisabledProvidersResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/runtime-config/disabled-providers`,
        {
          token,
          hostToken,
          method: "POST",
          body: { providers },
          timeoutMs: timeouts.config,
        },
      ),
    getRuntimeConfigStatus: (workspaceId: string) =>
      requestJson<OpenworkRuntimeConfigStatus>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/runtime-config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    patchConfig: (workspaceId: string, payload: { opencode?: Record<string, unknown>; openwork?: Record<string, unknown> }) =>
      requestJson<{ updatedAt?: number | null }>(baseUrl, `/workspace/${workspaceId}/config`, {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),
    getDesktopCloudSync: (workspaceId: string) =>
      requestJson<OpenworkDesktopCloudSyncState>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/desktop-cloud-sync`, {
        token,
        hostToken,
        timeoutMs: timeouts.config,
      }),
    syncDesktopCloud: (workspaceId: string, snapshot: DenResourceSnapshot) =>
      requestJson<OpenworkDesktopCloudSyncResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/desktop-cloud-sync`, {
        token,
        hostToken,
        method: "POST",
        body: { snapshot },
        timeoutMs: timeouts.config,
      }),
    listCloudPlugins: (workspaceId: string) =>
      requestJson<OpenworkCloudPluginsResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins`, {
        token,
        hostToken,
        timeoutMs: timeouts.config,
      }),
    installCloudPlugin: (workspaceId: string, payload: { marketplaceId: string | null; marketplace?: DenOrgMarketplace | null; resolved: DenOrgPluginResolved }) =>
      requestJson<OpenworkCloudPluginInstallResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.config,
      }),
    removeCloudPlugin: (workspaceId: string, pluginId: string) =>
      requestJson<OpenworkCloudPluginInstallResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins/${encodeURIComponent(pluginId)}`, {
        token,
        hostToken,
        method: "DELETE",
        timeoutMs: timeouts.config,
      }),
    previewClaudePlugin: (workspaceId: string, payload: { url: string; ref?: string }) =>
      requestJson<{ preview: OpenworkClaudePluginPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/claude-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: { ...payload, dryRun: true },
        timeoutMs: timeouts.config,
      }),
    installClaudePlugin: (workspaceId: string, payload: { url: string; ref?: string }) =>
      requestJson<OpenworkCloudPluginInstallResult & { preview: OpenworkClaudePluginPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/claude-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.config,
      }),
    readOpencodeConfigFile: (workspaceId: string, scope: "project" | "global" = "project") => {
      const query = `?scope=${scope}`;
      return requestJson<OpencodeConfigFile>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/opencode-config${query}`, {
        token,
        hostToken,
      });
    },
    writeOpencodeConfigFile: (workspaceId: string, scope: "project" | "global", content: string) =>
      requestJson<ExecResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/opencode-config`, {
        token,
        hostToken,
        method: "POST",
        body: { scope, content },
      }),
    listReloadEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: OpenworkReloadEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${workspaceId}/events${query}`,
        { token, hostToken },
      );
    },
    listUiControlPending: (options?: { wait?: boolean; signal?: AbortSignal }) =>
      requestJson<{ items: OpenworkUiControlRequest[] }>(
        baseUrl,
        `/experimental/ui-control/pending${options?.wait ? "?wait=1" : ""}`,
        { token, hostToken, timeoutMs: 15_000, signal: options?.signal },
      ),
    replyUiControl: (id: string, result: unknown) =>
      requestJson<{ ok: boolean }>(baseUrl, `/experimental/ui-control/${encodeURIComponent(id)}/reply`, {
        token,
        hostToken,
        method: "POST",
        body: { result },
      }),
    reloadEngine: (workspaceId: string) =>
      requestJson<{ ok: boolean; reloadedAt?: number }>(baseUrl, `/workspace/${workspaceId}/engine/reload`, {
        token,
        hostToken,
        method: "POST",
        timeoutMs: ENGINE_RELOAD_TIMEOUT_MS,
      }),
    listPlugins: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins${query}`,
        { token, hostToken },
      );
    },
    addPlugin: (workspaceId: string, spec: string) =>
      requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins`,
        { token, hostToken, method: "POST", body: { spec } },
      ),
    removePlugin: (workspaceId: string, name: string) =>
      requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
    listSkills: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: OpenworkSkillItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/skills${query}`,
        { token, hostToken },
      );
    },
    getSkill: (workspaceId: string, name: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<OpenworkSkillContent>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}${query}`,
        { token, hostToken },
      );
    },
    upsertSkill: (workspaceId: string, payload: { name: string; content: string; description?: string }) =>
      requestJson<OpenworkSkillItem>(baseUrl, `/workspace/${workspaceId}/skills`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteSkill: (workspaceId: string, name: string) =>
      requestJson<{ path: string }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "DELETE",
        },
      ),
    listMcp: (workspaceId: string) =>
      requestJson<{
        items: OpenworkMcpItem[];
        engineSync?: OpenworkMcpEngineSync | null;
        managedOAuthState?: OpenworkManagedOAuthState | null;
      }>(
        baseUrl,
        `/workspace/${workspaceId}/mcp`,
        { token, hostToken },
      ),
    listMcpApps: (workspaceId: string) =>
      requestJson<{ servers: OpenworkMcpAppCatalogServer[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp-apps/list`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),
    resolveMcpApp: (
      workspaceId: string,
      projectedToolName: string,
      launch?: OpenworkMcpAppLaunchReference,
    ) =>
      requestJson<{ app: OpenworkMcpAppResource | null }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp-apps/resolve`,
        {
          token,
          hostToken,
          method: "POST",
          body: { projectedToolName, ...(launch ? { launch } : {}) },
          timeoutMs: timeouts.config,
        },
      ),
    mcpAppSandbox: (app: OpenworkMcpAppResource, hostOrigin: string): OpenworkMcpAppSandbox => {
      const messageOrigin = normalizeMcpAppHostOrigin(hostOrigin);
      const url = new URL(`${baseUrl}/mcp-apps/sandbox.html`);
      if (url.origin === hostOrigin && url.hostname === "localhost") url.hostname = "127.0.0.1";
      else if (url.origin === hostOrigin && url.hostname === "127.0.0.1") url.hostname = "localhost";
      url.searchParams.set("csp", JSON.stringify(app.csp));
      url.searchParams.set("hostOrigin", messageOrigin);
      return { url: url.toString(), expectedOrigin: url.origin };
    },
    callMcpAppTool: (
      workspaceId: string,
      payload: {
        serverName: string;
        name: string;
        resourceUri: string;
        arguments?: Record<string, unknown>;
        approved?: boolean;
      },
    ) => requestJson<OpenworkMcpAppToolResult>(
      baseUrl,
      `/workspace/${encodeURIComponent(workspaceId)}/mcp-apps/call`,
      {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.binary,
      },
    ),
    getOpenworkCloudMcpHealth: (
      workspaceId: string,
      providerModel?: OpenworkCloudMcpProviderModelContext,
      options?: { probe?: boolean },
    ) => {
      const query = new URLSearchParams();
      if (providerModel?.provider.trim() && providerModel.model.trim()) {
        query.set("provider", providerModel.provider.trim());
        query.set("model", providerModel.model.trim());
      }
      // probe=1 verifies the Cloud endpoint directly from the OpenWork server
      // (initialize + tools/list), independent of the engine's own connection.
      if (options?.probe) query.set("probe", "1");
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<OpenworkCloudMcpHealth>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/openwork-cloud/health${suffix}`,
        { token, hostToken, timeoutMs: options?.probe ? timeouts.cloudMcpProbeHealth : timeouts.cloudMcpHealth },
      );
    },
    reconcileOpenworkCloudMcp: (workspaceId: string, payload: OpenworkCloudMcpReconcilePayload) =>
      requestJson<OpenworkCloudMcpHealth>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/openwork-cloud/reconcile`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
          timeoutMs: timeouts.cloudMcpReconcile,
        },
      ),
    refreshOpenworkCloudMcpEngine: (
      workspaceId: string,
      payload?: { provider?: string; model?: string; trigger?: string },
    ) =>
      requestJson<OpenworkCloudMcpEngineRefreshResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/openwork-cloud/engine-refresh`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload ?? {},
          timeoutMs: timeouts.cloudMcpReconcile,
        },
      ),
    runAgentContextDiagnostics: async (
      workspaceId: string,
      input: AgentContextDiagnosticsRequest,
    ): Promise<AgentContextDiagnosticsReport> => {
      const body = agentContextDiagnosticsRequestSchema.parse(input);
      const payload = await requestAgentContextDiagnosticsJson(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/diagnostics/agent-context`,
        {
          token,
          hostToken,
          body,
          timeoutMs: timeouts.diagnostics,
        },
      );
      return agentContextDiagnosticsReportSchema.parse(payload);
    },
    addMcp: (workspaceId: string, payload: { name: string; config: Record<string, unknown> }) =>
      requestJson<{ items: OpenworkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    addManagedMcp: (
      workspaceId: string,
      payload: {
        name: string;
        url: string;
        oauth?: {
          applicationType?: "native" | "web";
          requestedScopes?: string[];
          authorizationServerIssuer?: string;
          clientId?: string;
          clientSecret?: string;
        };
      },
    ) =>
      requestJson<OpenworkManagedMcpStartResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/mcp/managed`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    getManagedMcp: (workspaceId: string, name: string) =>
      requestJson<OpenworkManagedMcpConnection>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}/managed`,
        { token, hostToken },
      ),
    connectManagedMcp: (workspaceId: string, name: string) =>
      requestJson<OpenworkManagedMcpStartResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}/managed/connect`,
        { token, hostToken, method: "POST" },
      ),
    removeMcp: (workspaceId: string, name: string) =>
      requestJson<{ items: OpenworkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    setMcpEnabled: (workspaceId: string, name: string, enabled: boolean) =>
      requestJson<{ items: OpenworkMcpItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/enabled`,
        {
          token,
          hostToken,
          method: "POST",
          body: { enabled },
        },
      ),

    logoutMcpAuth: (workspaceId: string, name: string) =>
      requestJson<{ ok: true }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/auth`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    listCommands: (workspaceId: string, scope: "workspace" | "global" = "workspace") =>
      requestJson<{ items: OpenworkCommandItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/commands?scope=${scope}`,
        { token, hostToken },
      ),
    listAudit: (workspaceId: string, limit = 50) =>
      requestJson<{ items: OpenworkAuditEntry[] }>(
        baseUrl,
        `/workspace/${workspaceId}/audit?limit=${limit}`,
        { token, hostToken },
      ),
    upsertCommand: (
      workspaceId: string,
      payload: { name: string; description?: string; template: string; agent?: string; model?: string | null; subtask?: boolean },
    ) =>
      requestJson<{ items: OpenworkCommandItem[] }>(baseUrl, `/workspace/${workspaceId}/commands`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteCommand: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${workspaceId}/commands/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    uploadInboxPrefersOriginalFile: (file: File) =>
      isDesktopRuntime() && !isLoopbackUrl(baseUrl) && electronLocalPathForFile(file) !== null,
    uploadInbox: async (workspaceId: string, file: File, options?: { path?: string }) => {
      const id = workspaceId.trim();
      if (!id) throw new Error("workspaceId is required");
      if (!file) throw new Error("file is required");
      const uploadPath = `/workspace/${encodeURIComponent(id)}/inbox`;
      let result: { ok: boolean; status: number; text: string };
      if (isDesktopRuntime() && !isLoopbackUrl(baseUrl) && electronLocalPathForFile(file) !== null) {
        const response = await desktopUploadMultipart(file, {
          url: `${baseUrl}${uploadPath}`,
          method: "POST",
          headers: buildAuthHeaders(token, hostToken),
          fields: options?.path?.trim() ? { path: options.path.trim() } : undefined,
          timeoutMs: timeouts.binary,
        });
        result = {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          text: response.body,
        };
      } else {
        const form = new FormData();
        form.append("file", file);
        if (options?.path?.trim()) form.append("path", options.path.trim());
        result = await requestMultipartRaw(baseUrl, uploadPath, {
          token,
          hostToken,
          method: "POST",
          body: form,
          timeoutMs: timeouts.binary,
        });
      }

      if (!result.ok) {
        let message = result.text.trim();
        try {
          const json = message ? JSON.parse(message) : null;
          if (json && typeof json.message === "string") {
            message = json.message;
          }
        } catch {
          // ignore
        }
        throw new OpenworkServerError(
          result.status,
          "request_failed",
          message || "Shared folder upload failed",
        );
      }

      const body = result.text.trim();
      if (body) {
        try {
          const parsed = JSON.parse(body) as Partial<OpenworkInboxUploadResult>;
          if (typeof parsed.path === "string" && parsed.path.trim()) {
            return {
              ok: parsed.ok ?? true,
              path: parsed.path.trim(),
              bytes: typeof parsed.bytes === "number" ? parsed.bytes : file.size,
            } satisfies OpenworkInboxUploadResult;
          }
        } catch {
          // ignore invalid JSON and fall back
        }
      }

      return {
        ok: true,
        path: options?.path?.trim() || file.name,
        bytes: file.size,
      } satisfies OpenworkInboxUploadResult;
    },

    listInbox: (workspaceId: string) =>
      requestJson<OpenworkInboxList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/inbox`, {
        token,
        hostToken,
      }),

    downloadInboxItem: (workspaceId: string, inboxId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(inboxId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    readWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<OpenworkWorkspaceFileContent>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    statWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<OpenworkWorkspaceFileStat>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/stat?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    listWorkspaceFiles: async (workspaceId: string) => {
      const created = await requestJson<{ session: { id: string } }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/sessions`,
        { token, hostToken, method: "POST", body: { write: false } },
      );
      const sessionId = created.session.id;
      try {
        return await requestJson<OpenworkWorkspaceCatalog>(
          baseUrl,
          `/files/sessions/${encodeURIComponent(sessionId)}/catalog/snapshot?includeDirs=true&limit=10000&excludeHeavyDirectories=true`,
          { token, hostToken },
        );
      } finally {
        await requestJson<{ ok: boolean }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}`, {
          token,
          hostToken,
          method: "DELETE",
        }).catch(() => undefined);
      }
    },

    writeWorkspaceFile: (
      workspaceId: string,
      payload: { path: string; content: string; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<OpenworkWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
        },
      ),

    deleteWorkspaceFiles: async (
      workspaceId: string,
      files: Array<{ path: string; recursive?: boolean }>,
    ): Promise<OpenworkWorkspaceFileDeleteResult[]> => {
      if (files.length === 0) return [];
      const created = await requestJson<{ session: { id: string } }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/sessions`,
        { token, hostToken, method: "POST", body: { write: true } },
      );
      const sessionId = created.session.id;
      try {
        const result = await requestJson<{ items: Array<{ ok?: boolean; path?: string; code?: string }> }>(
          baseUrl,
          `/files/sessions/${encodeURIComponent(sessionId)}/ops`,
          {
            token,
            hostToken,
            method: "POST",
            body: {
              operations: files.map((file) => ({
                type: "delete",
                path: file.path,
                recursive: file.recursive === true,
              })),
            },
          },
        );
        return result.items.map((item, index) => ({
          ok: item.ok === true,
          path: typeof item.path === "string" ? item.path : files[index]?.path ?? "",
          ...(typeof item.code === "string" ? { code: item.code } : {}),
        }));
      } finally {
        await requestJson<{ ok: boolean }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}`, {
          token,
          hostToken,
          method: "DELETE",
        }).catch(() => undefined);
      }
    },

    writeWorkspaceBinaryFile: (
      workspaceId: string,
      payload: { path: string; data: ArrayBuffer; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<OpenworkWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/raw`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            path: payload.path,
            dataBase64: arrayBufferToBase64(payload.data),
            baseUpdatedAt: payload.baseUpdatedAt,
            force: payload.force,
          },
        },
      ),

    downloadWorkspaceFile: (workspaceId: string, path: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/raw?path=${encodeURIComponent(path)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    listArtifacts: (workspaceId: string) =>
      requestJson<OpenworkArtifactList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/artifacts`, {
        token,
        hostToken,
      }),

    resolveArtifacts: (
      workspaceId: string,
      targets: Array<{
        kind: "file" | "url";
        value: string;
        name?: string;
        preview?: string;
        confidence?: number;
        reason?: string;
      }>,
    ) =>
      requestJson<{ items: OpenworkResolvedArtifactTarget[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/resolve`,
        { token, hostToken, method: "POST", body: { targets } },
      ),

    downloadArtifact: (workspaceId: string, artifactId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    // User-level env vars (host-auth only — desktop shell is the sole caller).
    // See apps/server/src/env-file.ts and apps/app/pr/environment-variables.md.
    listUserEnvKeys: () =>
      requestJson<{ keys: string[] }>(
        baseUrl,
        "/env/keys",
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    getUserEnvStatus: (runtimeKey?: string | null) => {
      const params = new URLSearchParams();
      if (runtimeKey?.trim()) params.set("runtimeKey", runtimeKey.trim());
      const query = params.size ? `?${params.toString()}` : "";
      return requestJson<{ runtimeKey: string; pendingChanges: boolean }>(
        baseUrl,
        `/env/status${query}`,
        { token, hostToken, timeoutMs: timeouts.config },
      );
    },

    setUserEnvPendingChanges: (pendingChanges: boolean, runtimeKey?: string | null) =>
      requestJson<{ runtimeKey: string; pendingChanges: boolean }>(baseUrl, "/env/status", {
        token,
        hostToken,
        method: "PUT",
        body: { pendingChanges, runtimeKey: runtimeKey?.trim() || undefined },
        timeoutMs: timeouts.config,
      }),

    listUserEnv: () =>
      requestJson<{ items: OpenworkUserEnvItem[] }>(
        baseUrl,
        "/env?includeValues=false",
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    getUserEnv: (key: string) =>
      requestJson<{ item: OpenworkUserEnvItem & { value: string } }>(
        baseUrl,
        `/env/${encodeURIComponent(key)}`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    upsertUserEnv: (entries: Array<{ key: string; value: string }>) =>
      requestJson<{ ok: true; count: number }>(baseUrl, "/env", {
        token,
        hostToken,
        method: "PUT",
        body: { entries },
        timeoutMs: timeouts.config,
      }),

    deleteUserEnv: (key: string) =>
      requestJson<{ ok: true }>(baseUrl, `/env/${encodeURIComponent(key)}`, {
        token,
        hostToken,
        method: "DELETE",
        timeoutMs: timeouts.config,
      }),

    createVoiceRealtimeSession: (payload?: { model?: string; sessionContext?: string }) =>
      requestJson<{
        ok: true;
        clientSecret: string;
        expiresAt: number | null;
        model: string;
        transcriptionModel: string;
        tools: string[];
        source?: string;
      }>(baseUrl, "/voice/realtime/session", {
        token,
        hostToken,
        method: "POST",
        body: payload ?? {},
        timeoutMs: timeouts.config,
      }),
  };
}

export type OpenworkServerClient = ReturnType<typeof createOpenworkServerClient>;
