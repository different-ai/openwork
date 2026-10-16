import { createV2SessionHomes, nativeSession, nativeSessionDirectory } from "./opencode-v2-session-home.js";
import { createCloudMcpRegistrar, createNativeCloudMcpResolver } from "./cloud-mcp-v2.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { createTaskRecovery, setTaskRecovery } from "./task-recovery.js";
import { managedPolicyActionSchema } from "./managed-policy-rules.js";
import { readFile, realpath, writeFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveGlobalOpencodeConfigPath } from "@openwork/paths";
import type { ApprovalRequest, Capabilities, ServerConfig, WorkspaceInfo, Actor, ReloadReason, ReloadTrigger, TokenScope } from "./types.js";
import { agentContextDiagnosticsRequestSchema } from "./agent-context-diagnostics-schema.js";
import { ApprovalService } from "./approvals.js";
import { BoundedSseFrameBuffer, isEngineConnectionFailure } from "./engine-proxy.js";
import { addPlugin, listPlugins, normalizePluginSpec, removePlugin } from "./plugins.js";
import { sanitizePortableOpencodeConfig } from "./portable-opencode.js";
import { addMcp, listMcp, removeMcp, setMcpEnabled } from "./mcp.js";
import { buildOpenWorkV2Instructions, OPENWORK_V2_INSTRUCTION_KEY } from "./opencode-v2-instructions.js";
import {
  callMcpAppTool,
  listMcpAppCatalog,
  McpAppHostError,
  resolveConnectMcpAppResource,
  resolveMcpAppResource,
  resolveSameServerMcpAppResource,
  releaseMcpAppLaunch,
  type McpAppLaunchContext,
} from "./mcp-app-host.js";
import {
  buildMcpAppSandboxCsp,
  MCP_APP_SANDBOX_PROXY_CSS,
  MCP_APP_SANDBOX_PROXY_HTML,
  MCP_APP_SANDBOX_PROXY_SCRIPT,
  parseMcpAppSandboxCsp,
} from "./mcp-app-sandbox.js";
import { deleteSkill, listSkills, renderSkillContentForResponse, upsertSkill } from "./skills.js";
import { deleteCommand, listCommands, repairCommands, upsertCommand } from "./commands.js";
import { ApiError, formatError } from "./errors.js";
import { readJsoncFile, updateJsoncTopLevel, writeJsoncFile } from "./jsonc.js";
import { recordAudit, readAuditEntries, readLastAudit } from "./audit.js";
import { ReloadEventStore } from "./events.js";
import { computeReloadFingerprint } from "./reload-fingerprint.js";
import { startReloadWatchers } from "./reload-watcher.js";
import {
  redactLogAttributes,
  redactServerLogFileRecord,
  resolveServerLogFileSink,
  type ServerLogFileSink,
} from "./server-log-file.js";
import { opencodeConfigPath, openworkConfigPath, projectCommandsDir, projectSkillsDir } from "./workspace-files.js";
import { ensureDir, exists, hashToken, shortId } from "./utils.js";
import { defaultWorkspaceOpenworkConfig, ensureWorkspaceFiles, readRawOpencodeConfig } from "./workspace-init.js";
import { sanitizeCommandName, validateMcpName, validateUserMcpName } from "./validators.js";
import { TokenService } from "./tokens.js";
import { EnvService } from "./env-file.js";
import {
  normalizeResourceSnapshot,
  readDesktopCloudSyncState,
  readWorkspaceCloudImports,
  syncDesktopCloudResources,
} from "./desktop-cloud-sync.js";
import { readInstalledCloudPlugins, removeCloudPlugin } from "./cloud-plugins.js";
import { AnonymousInferenceService } from "./anonymous-inference.js";
import { listPortableFiles } from "./portable-files.js";
import {
  collectWorkspaceExportWarnings,
  sanitizeOpenworkTemplateConfig,
  stripSensitiveWorkspaceExportData,
  type WorkspaceExportSensitiveMode,
} from "./workspace-export-safety.js";
import { serve, type ServeResult } from "./serve-node.js";
import { serveStaticUi } from "./static-ui.js";
import { externalFetch, loopbackFetch, transferResponseBody } from "./server-fetch.js";
import { registerCoreRoutes } from "./routes/core.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerOperationRoutes } from "./routes/operations.js";
import { addRoute, matchRoute, type AuthMode, type RequestContext, type Route } from "./routes/registry.js";
import { registerSessionGroupRoutes } from "./routes/session-groups.js";
import { registerWorkspaceDefaultModelRoutes } from "./routes/workspace-default-model.js";
import { registerUiControlRoutes } from "./routes/ui-control.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerCloudMcpRoutes } from "./routes/cloud-mcp.js";
import { UiControlMailbox } from "./ui-control.js";
import { captureServerException, isExpectedRequestCancellation } from "./telemetry.js";
import {
  completeLocalManagedMcpAuthorization,
  createLocalManagedMcpConnection,
  deleteLocalManagedMcp,
  disconnectLocalManagedMcp,
  getLocalManagedMcpConnection,
  handleLocalManagedMcpGateway,
  listLocalManagedMcpConnectionsSafe,
  reconcileLocalManagedMcpRuntimeEntries,
  setLocalManagedMcpEnabled,
  startLocalManagedMcpAuthorization,
} from "./local-managed-mcp.js";
import { OPENWORK_CLOUD_MCP_NAME, removeOpenworkCloudMcpDesiredConfig } from "./cloud-mcp-health.js";
import { runAgentContextDiagnostics } from "./agent-context-diagnostics.js";
import { sanitizeDiagnosticString } from "./diagnostic-sanitizer.js";
import {
  mergeOpencodeConfigs,
  mergeRuntimeProviderUpdate,
  readEffectiveRuntimeOpencodeConfig,
  readGlobalRuntimeOpencodeConfig,
  readRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeProviderMap,
  runtimeMcpMap,
  type RuntimeOpencodeConfig,
  writeGlobalRuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import {
  hasOpenworkWorkspaceConfig,
  mergeOpenworkWorkspaceConfigs,
  readOpenworkWorkspaceConfig,
  seedOpenworkWorkspaceConfigIfEmpty,
  writeOpenworkWorkspaceConfig,
} from "./openwork-workspace-config-store.js";
import { CloudProviderSync, parseCloudProviderDenSession } from "./cloud-provider-sync.js";
import { createEngineV2Preview, type EngineV2Preview, type EngineV2PreviewStatus } from "./engine-v2-preview.js";
import pkg from "../package.json" with { type: "json" };
import constants from "../../../constants.json" with { type: "json" };

export {
  isSupportedWorkspaceTextFilePath,
  normalizeWorkspaceRelativePath,
  resolveWorkspaceArtifactTargets,
} from "./routes/files.js";

const SERVER_VERSION = pkg.version;
const OPENCODE_VERSION = constants.opencodeV2Version.trim().replace(/^v/, "");

let desktopCloudSyncQueue: Promise<void> = Promise.resolve();
/** Open client event streams per server, reported by the runtime activity probe. */
const engineEventClientsByConfig = new WeakMap<ServerConfig, number>();
const agentDiagnosticsLastRunByServer = new WeakMap<ServerConfig, Map<string, number>>();
const agentDiagnosticsInFlightByServer = new WeakMap<ServerConfig, Set<string>>();
const AGENT_DIAGNOSTICS_RATE_LIMIT_CAPACITY = 1_000;
const AGENT_DIAGNOSTICS_MAX_IN_FLIGHT_PER_SERVER = 16;
const AGENT_DIAGNOSTICS_MAX_REQUEST_BYTES = 256 * 1024;
const AGENT_DIAGNOSTICS_DEFAULT_BODY_DEADLINE_MS = 2_000;
const AGENT_DIAGNOSTICS_ERROR_FLUSH_MS = 25;

function rethrowMcpAppHostError(error: unknown): never {
  if (!(error instanceof McpAppHostError)) throw error;
  const status = error.code === "mcp_auth_required"
    ? 401
    : error.code === "mcp_access_denied"
      ? 403
      : error.code === "invalid_tool_name" || error.code.startsWith("invalid_resource")
    ? 400
    : error.code === "tool_not_found" || error.code === "server_unavailable"
      ? 404
      : error.code === "mcp_unreachable"
        ? 502
        : 422;
  throw new ApiError(status, error.code, error.message);
}

function agentDiagnosticsActorWorkspaceKey(actor: Actor | undefined, workspaceId: string): string {
  const actorKey = actor?.tokenHash ?? actor?.clientId ?? actor?.type ?? "unknown";
  return hashToken(actorKey + "\0" + workspaceId);
}

function requireAgentDiagnosticsRateLimit(config: ServerConfig, actor: Actor | undefined, workspaceId: string): void {
  const now = Date.now();
  const configured = Number(process.env.OPENWORK_AGENT_DIAGNOSTICS_COOLDOWN_MS ?? "3000");
  const cooldownMs = Number.isFinite(configured) && configured >= 0 ? configured : 3_000;
  const key = agentDiagnosticsActorWorkspaceKey(actor, workspaceId);
  const agentDiagnosticsLastRun = agentDiagnosticsLastRunByServer.get(config) ?? new Map<string, number>();
  agentDiagnosticsLastRunByServer.set(config, agentDiagnosticsLastRun);
  const previous = agentDiagnosticsLastRun.get(key);
  if (previous !== undefined && now - previous < cooldownMs) {
    throw new ApiError(429, "agent_diagnostics_rate_limited", "Agent diagnostics were run too recently");
  }
  for (const [candidate, at] of agentDiagnosticsLastRun) {
    if (now - at > Math.max(cooldownMs, 60_000)) agentDiagnosticsLastRun.delete(candidate);
  }
  if (agentDiagnosticsLastRun.size >= AGENT_DIAGNOSTICS_RATE_LIMIT_CAPACITY) {
    const oldest = agentDiagnosticsLastRun.keys().next().value;
    if (oldest) agentDiagnosticsLastRun.delete(oldest);
  }
  agentDiagnosticsLastRun.set(key, now);
}

function reserveAgentDiagnosticsRun(
  config: ServerConfig,
  actor: Actor | undefined,
  workspaceId: string,
): () => void {
  const key = agentDiagnosticsActorWorkspaceKey(actor, workspaceId);
  const inFlight = agentDiagnosticsInFlightByServer.get(config) ?? new Set<string>();
  agentDiagnosticsInFlightByServer.set(config, inFlight);
  // Preserve the existing cooldown response for ordinary repeated attempts.
  // A zero/expired cooldown still cannot bypass the in-flight reservation.
  requireAgentDiagnosticsRateLimit(config, actor, workspaceId);
  if (inFlight.has(key)) {
    throw new ApiError(429, "agent_diagnostics_in_progress", "Agent diagnostics are already in progress");
  }
  if (inFlight.size >= AGENT_DIAGNOSTICS_MAX_IN_FLIGHT_PER_SERVER) {
    throw new ApiError(429, "agent_diagnostics_busy", "Agent diagnostics are temporarily busy");
  }

  // The cooldown charge and reservation are synchronous, so no second request
  // for this actor/workspace can slip in between them.
  inFlight.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight.delete(key);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeConfigKeys(config: RuntimeOpencodeConfig): string[] {
  const keys: string[] = [];
  if (config.default_agent) keys.push("default_agent");
  if (Array.isArray(config.plugin) && config.plugin.length) keys.push("plugin");
  if (Array.isArray(config.disabled_providers) && config.disabled_providers.length) keys.push("disabled_providers");
  if (isRecord(config.mcp) && Object.keys(config.mcp).length) keys.push("mcp");
  const permission = isRecord(config.permission) ? config.permission : null;
  if (permission && isRecord(permission.external_directory) && Object.keys(permission.external_directory).length) {
    keys.push("permission");
  }
  if (isRecord(config.provider) && Object.keys(config.provider).length) keys.push("provider");
  return keys;
}

function parseDisabledProvidersPayload(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError(400, "invalid_payload", "providers must be an array of non-empty strings");
  }
  const providers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new ApiError(400, "invalid_payload", "providers must be an array of non-empty strings");
    }
    const provider = entry.trim();
    if (!providers.includes(provider)) providers.push(provider);
  }
  return providers;
}

function parseRuntimeProviderPatchPayload(body: Record<string, unknown>): Record<string, unknown> {
  const provider = body.provider;
  if (!isRecord(provider)) {
    throw new ApiError(400, "invalid_payload", "provider must be an object");
  }
  for (const [providerId, value] of Object.entries(provider)) {
    if (!providerId.trim()) {
      throw new ApiError(400, "invalid_payload", "provider keys must be non-empty strings");
    }
    if (value !== null && !isRecord(value)) {
      throw new ApiError(400, "invalid_payload", "provider values must be objects or null");
    }
  }
  return provider;
}

function userOpencodeConfigKeys(config: Record<string, unknown>): string[] {
  return Object.keys(config).filter((key) => key !== "$schema").sort();
}

function enqueueDesktopCloudSync<T>(operation: () => Promise<T>): Promise<T> {
  const run = desktopCloudSyncQueue.then(operation);
  desktopCloudSyncQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const reloadBaselineRefreshers = new WeakMap<
  ServerConfig,
  (workspaceId: string, reasons?: ReloadReason[]) => Promise<void>
>();

type LogLevel = "info" | "warn" | "error";

type LogAttributes = Record<string, unknown>;

type ServerLogger = {
  log: (level: LogLevel, message: string, attributes?: LogAttributes) => void;
};

type ServerLogWriter = (line: string) => void;

/** Adapt the server logger to the warn/error shape helpers expect. */
function toManagedProviderAuthLogger(logger: ServerLogger) {
  return {
    warn: (message: string, attributes?: Record<string, unknown>) =>
      logger.log("warn", message, attributes as LogAttributes | undefined),
    error: (message: string, attributes?: Record<string, unknown>) =>
      logger.log("error", message, attributes as LogAttributes | undefined),
  };
}

const LOG_LEVEL_NUMBERS: Record<LogLevel, number> = {
  info: 9,
  warn: 13,
  error: 17,
};

function toUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function isUnavailableLogOutputError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  // Redirected stdout can run out of space just like the optional file sink.
  // Logging must not turn an otherwise successful request into a server crash.
  return error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED"
    || error.code === "ENOSPC" || error.code === "EDQUOT" || error.code === "EIO";
}

let stdoutLogWritesDisabled = false;
let stdoutErrorHandlerInstalled = false;

function ensureStdoutErrorHandler() {
  if (stdoutErrorHandlerInstalled) return;
  stdoutErrorHandlerInstalled = true;
  process.stdout.on("error", (error: unknown) => {
    if (isUnavailableLogOutputError(error)) {
      stdoutLogWritesDisabled = true;
      return;
    }
    process.nextTick(() => {
      throw error;
    });
  });
}

function writeStdoutLogLine(line: string) {
  ensureStdoutErrorHandler();
  if (stdoutLogWritesDisabled) return;
  process.stdout.write(`${line}\n`);
}

export function createServerLogger(
  config: ServerConfig,
  writeLine: ServerLogWriter = writeStdoutLogLine,
  fileSink: ServerLogFileSink | null = resolveServerLogFileSink(),
): ServerLogger {
  const runId = process.env.OPENWORK_RUN_ID ?? shortId();
  const host = hostname().trim();
  const resource: Record<string, string> = {
    "service.name": "openwork-server",
    "service.version": SERVER_VERSION,
    "service.instance.id": runId,
  };
  if (host) {
    resource["host.name"] = host;
  }
  const baseAttributes: LogAttributes = {
    "run.id": runId,
    "process.pid": process.pid,
  };
  let logWritesDisabled = false;

  const writeLogLine = (line: string) => {
    if (logWritesDisabled) return;
    try {
      writeLine(line);
    } catch (error) {
      if (isUnavailableLogOutputError(error)) {
        logWritesDisabled = true;
        if (writeLine === writeStdoutLogLine) {
          stdoutLogWritesDisabled = true;
        }
        return;
      }
      throw error;
    }
  };

  const emit = (level: LogLevel, message: string, attributes?: LogAttributes) => {
    const merged = redactLogAttributes({ ...baseAttributes, ...(attributes ?? {}) });
    const record = {
      timeUnixNano: toUnixNano(),
      severityText: level.toUpperCase(),
      severityNumber: LOG_LEVEL_NUMBERS[level],
      body: message,
      attributes: merged,
      resource,
    };
    // The file sink is structured regardless of the stdout format: it exists
    // so reload triggers and engine errors survive a packaged app.
    if (fileSink) {
      const secrets = [config.token, config.hostToken];
      fileSink.write(JSON.stringify(redactServerLogFileRecord(record, secrets)));
    }
    writeLogLine(config.logFormat === "json" ? JSON.stringify(record) : message);
  };

  return { log: emit };
}

function logRequest(input: {
  logger: ServerLogger;
  request: Request;
  response: Response;
  durationMs: number;
  authMode: AuthMode;
  proxyService?: "opencode";
  proxyBaseUrl?: string;
  error?: string;
  errorCode?: string;
  errorPath?: string;
  errorCause?: string;
}) {
  const {
    logger,
    request,
    response,
    durationMs,
    authMode,
    proxyService,
    proxyBaseUrl,
    error,
    errorCode,
    errorPath,
    errorCause,
  } = input;
  const status = response.status;
  const level: LogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const proxyLabel = proxyBaseUrl ? ` (${proxyService ?? "proxy"})` : "";
  const message = `${method} ${url.pathname} ${status} ${durationMs}ms${proxyLabel}`;
  const attributes: LogAttributes = {
    method,
    path: url.pathname,
    status,
    durationMs,
    auth: authMode,
  };
  if (proxyBaseUrl) {
    attributes["proxy.base_url"] = proxyBaseUrl;
    if (proxyService) attributes["proxy.service"] = proxyService;
  }
  if (error) {
    attributes.error = error;
  }
  if (errorCode) attributes["error.code"] = errorCode;
  if (errorPath) attributes["error.path"] = errorPath;
  if (errorCause) attributes["error.cause"] = errorCause;
  logger.log(level, message, attributes);
}

function parseWorkspaceMount(pathname: string): { workspaceId: string; restPath: string } | null {
  if (!pathname.startsWith("/w/")) return null;
  const remainder = pathname.slice(3);
  if (!remainder) return null;
  const slash = remainder.indexOf("/");
  if (slash === -1) {
    return { workspaceId: decodeURIComponent(remainder), restPath: "/" };
  }
  const workspaceId = remainder.slice(0, slash);
  const restPath = remainder.slice(slash) || "/";
  if (!workspaceId.trim()) return null;
  return { workspaceId: decodeURIComponent(workspaceId), restPath };
}

function parseWorkspaceOpencodeV2Mount(pathname: string): { workspaceId: string; restPath: string } | null {
  if (!pathname.startsWith("/workspace/")) return null;
  const remainder = pathname.slice("/workspace/".length);
  if (!remainder) return null;
  const slash = remainder.indexOf("/");
  if (slash === -1) return null;
  const workspaceId = remainder.slice(0, slash);
  const restPath = remainder.slice(slash) || "/";
  if (!workspaceId.trim()) return null;
  if (restPath !== "/opencode2" && !restPath.startsWith("/opencode2/")) return null;
  return { workspaceId: decodeURIComponent(workspaceId), restPath };
}

/** Requests that read or select from the provider catalog. Other requests never wait on upkeep. */
function needsV2ProviderCatalog(method: string, restPath: string): boolean {
  let path = restPath;
  try { path = decodeURIComponent(restPath); } catch { /* Malformed paths reach the engine unchanged. */ }
  if (method === "GET" || method === "HEAD") return /^\/opencode2\/api\/(?:model|provider)(?:\/|$)/.test(path);
  return method === "POST" && /^\/opencode2\/api\/session\/[^/]+\/model\/?$/.test(path);
}

// Viewer tokens are read-only, which also keeps them from answering permission
// requests. Collaborators must be allowed: the SPA's only credential is the
// collaborator-scoped client token (OPENWORK_TOKEN), so an owner-only gate
// left every interactive permission dialog un-answerable (#1918).
export function assertOpencodeProxyAllowed(actor: Actor, method: string) {
  const m = method.toUpperCase();
  const scope = actor.scope ?? "viewer";

  if (scope === "viewer" && m !== "GET" && m !== "HEAD") {
    throw new ApiError(403, "forbidden", "Viewer tokens are read-only");
  }
}

/** Provider credential writes through the engine's native integrations API (MCP server sign-ins are `mcp_…`). */
function isEngineCredentialWrite(method: string, restPath: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  let path = restPath;
  try { path = decodeURIComponent(restPath); } catch { /* Malformed paths reach the engine unchanged. */ }
  return /^\/opencode2\/api\/(?:integration\/(?!mcp_)[^/]+\/connect|credential)(?:\/|$)/.test(path);
}

export async function startServer(
  config: ServerConfig,
): Promise<ServeResult & { engineStatus: () => EngineV2PreviewStatus }> {
  let taskRecovery: Awaited<ReturnType<typeof createTaskRecovery>> | undefined;
  const approvals = new ApprovalService(config.approval);
  const uiControl = new UiControlMailbox();
  const reloadEvents = new ReloadEventStore();
  const tokens = new TokenService(config);
  const env = new EnvService();
  const logger = createServerLogger(config);
  try {
    await reconcileLocalManagedMcpRuntimeEntries(config);
  } catch (error) {
    logger.log("warn", "Failed to reconcile OpenWork-managed MCP connections during startup.", {
      error: error instanceof Error ? error.message : "unknown",
    });
  }
  let watcherHandle = startReloadWatchers({ config, reloadEvents, logger });
  const refreshWorkspaceReloadBaseline = (workspaceId: string, reasons?: ReloadReason[]) =>
    watcherHandle.refreshWorkspace(workspaceId, reasons);
  reloadBaselineRefreshers.set(config, refreshWorkspaceReloadBaseline);
  const restartReloadWatchers = () => {
    watcherHandle.close();
    watcherHandle = startReloadWatchers({ config, reloadEvents, logger });
  };
  const engineV2Preview = createEngineV2Preview({ config, env, deferStart: true,
    hostReadRequest: async (path, init) => {
      // Internal dispatch retains the host credential in this process. The
      // native plugin receives only the context bridge's restricted token.
      const response = await serverOptions.fetch(new Request(`http://127.0.0.1${path}`, {
        ...init, headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      }));
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(`OpenWork read failed (${response.status})`);
      return payload;
    },
  });
  const cloudProviderSync = new CloudProviderSync({
    config,
    env,
    reloadEngine: () => engineV2Preview.refreshProviders(),
    logger: toManagedProviderAuthLogger(logger),
  });
  const anonymousInference = new AnonymousInferenceService(config, logger);
  anonymousInference.onEngineConfigChanged = () => cloudProviderSync.markReloadPending();
  managedDesktopPolicy(config).onChange = () => {
    void anonymousInference.initialize(config.port).then((changed) => {
      if (changed) cloudProviderSync.markReloadPending();
    }).catch(() => undefined);
    cloudProviderSync.markReloadPending();
  };
  const routes = createRoutes(
    config,
    approvals,
    tokens,
    env,
    restartReloadWatchers,
    cloudProviderSync,
    engineV2Preview,
    anonymousInference,
  );

  const serverOptions: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  } = {
    hostname: config.host,
    port: config.port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const startedAt = Date.now();
      let authMode: AuthMode = "none";
      let proxyService: "opencode" | undefined;
      let proxyBaseUrl: string | undefined;
      let errorMessage: string | undefined;
      let errorCode: string | undefined;
      let errorPath: string | undefined;
      let errorCause: string | undefined;

      const recordApiError = (apiError: ApiError) => {
        errorMessage = apiError.message;
        errorCode = apiError.code;
        if (!isRecord(apiError.details)) return;
        const path = apiError.details.path;
        if (typeof path === "string") errorPath = path;
        const cause = apiError.details.cause;
        if (typeof cause === "string") errorCause = cause;
      };

      const recordUnhandledErrorCause = (error: unknown) => {
        errorCause = error instanceof Error ? error.message : String(error);
      };

      const finalize = (response: Response) => {
        const wrapped = withCors(response, request, config);
        if (config.logRequests) {
            logRequest({
              logger,
              request,
              response: wrapped,
              durationMs: Date.now() - startedAt,
              authMode,
              proxyService,
              proxyBaseUrl,
              error: errorMessage,
              errorCode,
              errorPath,
              errorCause,
            });
        }
        return wrapped;
      };

      const finalizeProxyResponse = (response: Response) => {
        // A read can be cancelled while asynchronous ownership checks finish.
        // Do not rewrap its cancelled body in withCors, or turn it into a 500.
        // Writes retain their existing admission/completion semantics.
        if (request.method === "GET" || request.method === "HEAD") {
          request.signal.throwIfAborted();
        }
        return finalize(response);
      };

      const proxyWorkspaceOpencodeV2Mount = async (mount: { workspaceId: string; restPath: string }) => {
        authMode = "client";
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method);
          await validateEngineRequestBody(request);
          await managedDesktopPolicy(config).assertRequest(request, mount.restPath, true);
          await anonymousInference.assertTaskAccess(request, mount.restPath);
          const workspace = await resolveWorkspaceWithoutBootstrap(config, mount.workspaceId);
          const connection = engineV2Preview.connection();
          if (!connection) {
            const status = engineV2Preview.status();
            return finalize(jsonResponse(status.v1HistoryAvailable || status.migration.state === "running"
              ? { error: "history_migration_required", message: "Import your earlier chats into OpenCode v2 before continuing." }
              : { error: "engine_v2_preview_not_running" }, 503));
          }
          proxyService = "opencode";
          proxyBaseUrl = connection.url;
          // Requests go straight to the engine: OpenWork upkeep (provider
          // mirroring, MCP registration) runs when configuration changes, and
          // never holds reads. A folder's upkeep starts in the background the
          // first time it is seen.
          engineV2Preview.warmWorkspace(workspace.id, workspace.path);
          if (needsV2ProviderCatalog(request.method, mount.restPath)) {
            // For ~200 ms a folder the engine has not loaded omits configured
            // providers from its catalog. Bounded and never fails the request.
            await engineV2Preview.ensureWorkspaceReady(workspace.path);
          }
          const send = () => proxyOpencodeV2Request({
            config,
            request,
            url,
            workspace,
            proxyPath: mount.restPath,
            connection,
            // A turn uses the connections that are ready; MCP upkeep runs in
            // the background and the engine adds tools as connections finish.
            prepareExecution: async (directory) => {
              engineV2Preview.warmWorkspace(workspace.id, directory);
              await engineV2Preview.ensureWorkspaceReady(directory);
            },
            // The desktop's silent re-auth sends `POST /mcp/:name/connect`;
            // restart that one connection through the folder's reconciler.
            reconnectMcp: (directory, name) => engineV2Preview.syncWorkspaceMcp(workspace.id, directory, { reconnect: [name] }),
            actor,
            recoverySignal: taskRecovery?.owns(request) ? request.signal : undefined,
          });
          const response = taskRecovery ? await taskRecovery.forward(workspace, mount.restPath, request, send) : await send();
          if (response.ok && isEngineCredentialWrite(request.method, mount.restPath)) {
            // A provider credential changes what the catalog lists. Join its
            // reconciliation before reporting the save complete.
            await engineV2Preview.refreshProviders();
          }
          return finalizeProxyResponse(response);
        } catch (error) {
          const requestCanceled = isExpectedRequestCancellation(error, request.signal);
          if (!(error instanceof ApiError) && !requestCanceled) {
            recordUnhandledErrorCause(error);
            captureServerException(error, { method: request.method, route: "/workspace/:id/opencode2/*", requestSignal: request.signal });
          }
          const apiError = error instanceof ApiError
            ? error
            : requestCanceled
              ? new ApiError(499, "request_aborted", "Request was canceled")
              : new ApiError(500, "internal_error", "Unexpected server error");
          recordApiError(apiError);
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      };

      if (request.method === "OPTIONS") {
        return finalize(new Response(null, { status: 204 }));
      }

      const canonicalOpencodeV2Mount = parseWorkspaceOpencodeV2Mount(url.pathname);
      if (canonicalOpencodeV2Mount) {
        return proxyWorkspaceOpencodeV2Mount(canonicalOpencodeV2Mount);
      }

      // Allow clients to use a mounted base URL (e.g. http://host:8787/w/<id>) while
      // still calling the existing /workspace/:id/* API surface.
      // Example: baseUrl + "/workspace/<id>/plugins" => "/w/<id>/workspace/<id>/plugins".
      // We strip the mount prefix and route-match on the rest path.
      //
      // Important: when using a mounted base URL, enforce that the nested /workspace/:id
      // matches the mount workspace id to preserve the "single-workspace" mental model.
      const mount = parseWorkspaceMount(url.pathname);
      if (mount && mount.restPath.startsWith("/workspace/")) {
        const match = mount.restPath.match(/^\/workspace\/([^/]+)/);
        const nestedId = match?.[1] ? decodeURIComponent(match[1]) : null;
        if (nestedId && nestedId !== mount.workspaceId) {
          errorMessage = "not_found";
          return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
        }
        url.pathname = mount.restPath;
      }

      const route = matchRoute(routes, request.method, url.pathname);
      if (!route) {
        const staticUiResponse = await serveStaticUi(request, config);
        if (staticUiResponse) return finalize(staticUiResponse);
        errorMessage = "not_found";
        return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
      }

      authMode = route.auth;
      try {
        const actor =
          route.auth === "host-token"
            ? requireHostToken(request, config)
            : route.auth === "host"
              ? await requireHost(request, config, tokens)
              : route.auth === "client" || (route.auth === "policy" && !managedDesktopPolicy(config).authenticatesEvaluation(request))
                ? await requireClient(request, config, tokens)
                : undefined;
        await managedDesktopPolicy(config).assertRequest(request, url.pathname);
        const response = await route.handler({
          request,
          url,
          params: route.params,
          config,
          approvals,
          uiControl,
          reloadEvents,
          tokens,
          actor,
        });
        return finalize(response);
      } catch (error) {
        const requestCanceled = isExpectedRequestCancellation(error, request.signal);
        if (!(error instanceof ApiError) && !requestCanceled) {
          captureServerException(error, { method: request.method, route: url.pathname, requestSignal: request.signal });
          console.error("[openwork-server] Unhandled error:", error);
        }
        const apiError = error instanceof ApiError
          ? error
          : requestCanceled
            ? new ApiError(499, "request_aborted", "Request was canceled")
            : new ApiError(500, "internal_error", "Unexpected server error");
        recordApiError(apiError);
        const response = jsonResponse(formatError(apiError), apiError.status);
        const isAgentDiagnosticsRequest =
          request.method === "POST" && /^\/workspace\/[^/]+\/diagnostics\/agent-context$/.test(url.pathname);
        if (isAgentDiagnosticsRequest) {
          // Every diagnostics error closes the connection because failures such
          // as cooldown or in-flight rejection happen before body consumption.
          // Abort after a short flush window so the stable JSON error reaches the
          // client before unread bytes and drip streams are actively terminated.
          response.headers.set("Connection", "close");
          const requestBody = request.body;
          if (requestBody) {
            setTimeout(() => {
              void requestBody.cancel(new Error("Agent diagnostics request was rejected")).catch(() => undefined);
            }, AGENT_DIAGNOSTICS_ERROR_FLUSH_MS);
          }
        }
        return finalize(response);
      }
    },
  };

  let server: ServeResult;
  try {
    if (config.resumeInterruptedTasks && !config.readOnly) {
      taskRecovery = await createTaskRecovery(config, async (request) => serverOptions.fetch(request),
        () => managedDesktopPolicy(config).assert("sync"),
        { engineAvailable: () => engineV2Preview.connection() !== undefined });
      setTaskRecovery(config, taskRecovery);
    }
    server = await serve({
      ...serverOptions,
      idleTimeout: 120,
    });
  } catch (error) {
    await taskRecovery?.stop().catch(() => undefined);
    captureServerException(error, { method: "START", route: "startServer" });
    anonymousInference.stop();
    cloudProviderSync.stop();
    await engineV2Preview.stop().catch(() => undefined);
    watcherHandle.close();
    reloadBaselineRefreshers.delete(config);
    throw error;
  }

  if (config.port !== server.port) {
    config.port = server.port;
    try {
      await reconcileLocalManagedMcpRuntimeEntries(config);
    } catch (error) {
      logger.log("warn", "Failed to update OpenWork-managed MCP loopback routes after binding the server port.", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  try {
    await anonymousInference.initialize(server.port);
  } catch {
    anonymousInference.stop();
    logger.log("warn", "Desktop free access could not be initialized.");
  }
  // Policy hooks must receive the listener that actually bound, including
  // ephemeral ports and retries after a port collision.
  engineV2Preview.start();

  return {
    ...server,
    engineStatus: () => engineV2Preview.status(),
    stop: async () => {
      let recoveryError: unknown;
      try { await taskRecovery?.stop(); } catch (error) { recoveryError = error; }
      managedDesktopPolicy(config).onChange = undefined;
      anonymousInference.stop();
      cloudProviderSync.stop();
      await engineV2Preview.stop().catch(() => undefined);
      watcherHandle.close();
      reloadBaselineRefreshers.delete(config);
      await server.stop();
      if (recoveryError) throw recoveryError;
    },
  };
}

/** The folder a v2 conversation currently runs in, when it belongs to this
 * workspace. A conversation can move into a worktree, so the files it writes
 * live under that folder instead of the workspace root. Same ownership check
 * as the native proxy: the persistent home must be this workspace. */
async function resolveV2SessionExecutionDirectory(
  config: ServerConfig,
  engineV2Preview: EngineV2Preview,
  workspace: WorkspaceInfo,
  sessionId: string,
): Promise<string | null> {
  if (!sessionId.startsWith("ses_")) return null;
  const connection = engineV2Preview.connection();
  if (!connection) return null;
  const authorization = `Basic ${Buffer.from(`opencode:${connection.password}`).toString("base64")}`;
  const readNative = async (path: string): Promise<unknown> => {
    const url = new URL(path, connection.url);
    url.searchParams.set("location[directory]", workspace.path);
    const result = await loopbackFetch(url.toString(), { headers: { authorization }, signal: AbortSignal.timeout(10_000) });
    if (!result.ok) throw new ApiError(result.status, "session_unavailable", "Conversation could not be read");
    return result.json();
  };
  try {
    const homes = createV2SessionHomes(config, readNative);
    const session = await readNative(`/api/session/${encodeURIComponent(sessionId)}`);
    if (await homes.resolve(session) !== await homes.canonical(workspace.path)) return null;
    return nativeSessionDirectory(session);
  } catch {
    return null;
  }
}

export async function proxyOpencodeV2Request(input: {
  actor: Actor;
  config: ServerConfig;
  request: Request;
  url: URL;
  workspace: WorkspaceInfo;
  proxyPath: string;
  connection: { url: string; username: string; password: string };
  /** Bounded upkeep for the folder a prompt runs in; throws only when execution must not proceed. */
  prepareExecution?: (directory: string) => Promise<void>;
  /** Restart one connection that is not healthy (the desktop's `POST /mcp/:name/connect`). */
  reconnectMcp?: (directory: string, name: string) => Promise<void>;
  /** Why v2 has no such chat when it is a v1 chat not copied yet. */
  describeUncopiedChat?: (sessionId: string) => Promise<string | null>;
  recoverySignal?: AbortSignal;
}): Promise<Response> {
  const method = input.request.method.toUpperCase();
  const readRequest = method === "GET" || method === "HEAD";
  const signal = readRequest
    ? input.recoverySignal ? AbortSignal.any([input.request.signal, input.recoverySignal]) : input.request.signal
    : input.recoverySignal;
  if (readRequest) signal?.throwIfAborted();
  if (method !== "GET" && method !== "HEAD") ensureWritable(input.config);

  const withoutPrefix = input.proxyPath.slice("/opencode2".length);
  const forwardedPath = withoutPrefix || "/";
  // Runtime provider configuration contains server-owned credentials. The
  // renderer uses the catalog/status APIs; it must not read or mutate this file.
  if (/^\/api\/(?:experimental\/)?config(?:\/|$)/.test(decodeURIComponent(forwardedPath))) {
    throw new ApiError(403, "engine_config_private", "Engine configuration is private");
  }
  if (method !== "GET" && method !== "HEAD" && /^\/api\/(?:experimental\/)?mcp(?:\/|$)/.test(decodeURIComponent(forwardedPath))) {
    throw new ApiError(403, "engine_mcp_managed", "Manage connections through OpenWork");
  }
  const reconnect = method === "POST" ? /^\/mcp\/([^/]+)\/connect$/.exec(forwardedPath) : null;
  if (reconnect?.[1] && input.reconnectMcp) {
    // The engine has no such route; OpenWork owns connection restarts.
    await input.reconnectMcp(input.workspace.path, decodeURIComponent(reconnect[1]));
    return Response.json(true);
  }
  const target = new URL(input.connection.url);
  target.pathname = forwardedPath;
  target.search = input.url.search;
  if (forwardedPath.startsWith("/api/")) {
    for (const key of [...target.searchParams.keys()]) {
      if (key === "location" || key.startsWith("location[")) target.searchParams.delete(key);
    }
    target.searchParams.set("location[directory]", input.workspace.path);
  }

  const headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("x-openwork-host-token");
  headers.delete("x-openwork-client-id");
  headers.delete("host");
  headers.delete("origin");
  headers.set("authorization", `Basic ${Buffer.from(`opencode:${input.connection.password}`).toString("base64")}`);

  // An engine that is down or restarting is an expected 502, not an
  // unhandled server exception.
  const engineFetch = async (...args: Parameters<typeof loopbackFetch>): Promise<Response> => {
    try {
      return await loopbackFetch(...args);
    } catch (error) {
      if (isExpectedRequestCancellation(error, signal)) throw error;
      if (isEngineConnectionFailure(error)) throw opencodeUnreachableError(error, input.proxyPath);
      throw error;
    }
  };

  const readNative = async (path: string): Promise<unknown> => {
    const url = new URL(path, input.connection.url);
    url.searchParams.set("location[directory]", input.workspace.path);
    const result = await engineFetch(url.toString(), {
      headers: { authorization: headers.get("authorization") ?? "" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!result.ok) throw new ApiError(result.status, "session_unavailable", "Conversation could not be read");
    return result.json();
  };
  const homes = createV2SessionHomes(input.config, readNative);
  const expectedHome = await homes.canonical(input.workspace.path);
  const sessionMatch = forwardedPath.match(/^\/api\/(?:experimental\/)?session\/([^/]+)(?:\/|$)/);
  const sessionId = sessionMatch?.[1] ? decodeURIComponent(sessionMatch[1]) : null;
  let executionDirectory = input.workspace.path;
  // Authorization follows the persistent home, not the agent's mutable CWD.
  // The actual native location still controls execution and tool discovery.
  if (sessionId?.startsWith("ses_")) {
    const session = await readNative(`/api/session/${encodeURIComponent(sessionId)}`).catch(async (error: unknown) => {
      // A v1 chat v2 has not copied yet: say so instead of a bare "could not be read".
      const reason = error instanceof ApiError && error.status === 404 ? await input.describeUncopiedChat?.(sessionId) : null;
      throw reason ? new ApiError(404, "engine_chat_not_copied", reason) : error;
    });
    if (await homes.resolve(session) !== expectedHome) {
      throw new ApiError(404, "session_not_found", "Session not found");
    }
    executionDirectory = nativeSessionDirectory(session) ?? input.workspace.path;
    target.searchParams.set("location[directory]", executionDirectory);
  }

  if (method !== "GET" && method !== "HEAD"
    && decodeURIComponent(forwardedPath).endsWith(`/instructions/entries/${OPENWORK_V2_INSTRUCTION_KEY}`)) {
    throw new ApiError(403, "engine_instructions_managed", "OpenWork instructions are managed by the server");
  }

  if (method === "POST" && sessionId && /^\/api\/session\/[^/]+\/(?:prompt|command|generate)$/.test(forwardedPath)) {
    await input.prepareExecution?.(executionDirectory);
    // Session ownership was verified above. Replace one native instruction
    // entry immediately before admission; never append to conversation text.
    const mcpUrl = new URL(target);
    mcpUrl.pathname = "/api/mcp";
    const internalHeaders = new Headers({ authorization: headers.get("authorization") ?? "", "content-type": "application/json" });
    const mcpResponse = await engineFetch(mcpUrl.toString(), { headers: internalHeaders, signal: AbortSignal.timeout(10_000) });
    const mcpPayload: unknown = mcpResponse.ok ? await mcpResponse.json() : null;
    const connectReady = isRecord(mcpPayload) && Array.isArray(mcpPayload.data) && mcpPayload.data.some((entry) =>
      isRecord(entry) && entry.name === "openwork-cloud" && isRecord(entry.status) && entry.status.status === "connected");
    // Keep organization skill discovery on demand through Connect. The full
    // catalog can exceed the engine's instruction-entry request limit.
    const value = buildOpenWorkV2Instructions(connectReady);
    const instructionUrl = new URL(target);
    instructionUrl.pathname = `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${OPENWORK_V2_INSTRUCTION_KEY}`;
    const synced = await engineFetch(instructionUrl.toString(), {
      method: "PUT", headers: internalHeaders, body: JSON.stringify({ value }), signal: AbortSignal.timeout(15_000),
    });
    if (!synced.ok) throw new ApiError(502, "engine_instruction_sync_failed", "OpenWork instructions could not be updated");
  }

  const requestBody = method === "GET" || method === "HEAD"
    ? undefined
    : await input.request.arrayBuffer().then((buffer) => buffer.byteLength > 0 ? buffer : undefined);
  let body: string | ArrayBuffer | undefined = requestBody;
  if (method === "POST" && forwardedPath === "/api/session") {
    let sessionInput: unknown = {};
    if (requestBody) {
      try {
        sessionInput = JSON.parse(new TextDecoder().decode(requestBody));
      } catch {
        throw new ApiError(400, "invalid_body", "Expected a JSON object");
      }
    }
    if (!isRecord(sessionInput)) throw new ApiError(400, "invalid_body", "Expected a JSON object");
    // Unlike reads, v2 session creation binds its location from the body.
    body = JSON.stringify({ ...sessionInput, location: { directory: input.workspace.path } });
    headers.delete("content-length");
    headers.set("content-type", "application/json");
  }
  const response = await engineFetch(target.toString(), { method, headers, body, signal });
  if (method === "GET" && /^\/api\/skill(?:\/|$)/.test(decodeURIComponent(forwardedPath))
    && input.actor.scope !== "owner" && response.ok) {
    // A shared client token is not authorization to bulk-read the owner's Cloud
    // instructions. Keep metadata for selection, just like the Connect catalog;
    // bodies and private materialization paths stay on the owner/engine side.
    // Internal watcher/admission reads above deliberately do not use this projection.
    const payload: unknown = await response.json();
    const raw = isRecord(payload) && "data" in payload ? payload.data : payload;
    const publicSkill = (value: unknown) => {
      if (!isRecord(value) || typeof value.id !== "string") {
        throw new ApiError(502, "invalid_engine_response", "Invalid skill metadata");
      }
      if (!value.id.startsWith("openwork-cloud-")) return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => ["id", "name", "description", "slash"].includes(key)));
    };
    return jsonResponse({ data: Array.isArray(raw) ? raw.map(publicSkill) : publicSkill(raw) });
  }
  if (method === "GET" && /^\/api\/provider(?:\/|$)/.test(decodeURIComponent(forwardedPath)) && response.ok) {
    // Provider.Info includes request settings/headers, which may contain the
    // mirrored server-owned key. Clients only need public catalog metadata.
    const payload: unknown = await response.json();
    const raw = isRecord(payload) && "data" in payload ? payload.data : payload;
    const publicProvider = (value: unknown) => {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
        throw new ApiError(502, "invalid_engine_response", "Invalid provider metadata");
      }
      return { id: value.id, name: value.name };
    };
    const data = Array.isArray(raw) ? raw.map(publicProvider) : publicProvider(raw);
    return jsonResponse({ data });
  }
  if (method === "GET" && /^\/api\/model(?:\/|$)/.test(decodeURIComponent(forwardedPath)) && response.ok) {
    // Model overrides and variants can carry credentials too. Keep only the
    // metadata needed for selection; request settings remain inside the engine.
    const payload: unknown = await response.json();
    const raw = isRecord(payload) && "data" in payload ? payload.data : payload;
    const publicModel = (value: unknown) => {
      if (value === null) return null;
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.providerID !== "string") {
        throw new ApiError(502, "invalid_engine_response", "Invalid model metadata");
      }
      const metadata = Object.fromEntries(Object.entries(value).filter(([key]) => [
        "id", "modelID", "providerID", "canonical", "family", "name", "package",
        "capabilities", "time", "cost", "status", "enabled", "limit",
      ].includes(key)));
      // The picker needs opaque variant IDs, never their provider settings.
      const variants = (Array.isArray(value.variants) ? value.variants : []).flatMap((variant) =>
        isRecord(variant) && typeof variant.id === "string" ? [{ id: variant.id }] : []);
      return { ...metadata, variants };
    };
    return jsonResponse({ data: Array.isArray(raw) ? raw.map(publicModel) : publicModel(raw) });
  }
  if (method === "GET" && /^\/api\/event\/*$/.test(decodeURIComponent(forwardedPath)) && response.ok && response.body) {
    const frames = new BoundedSseFrameBuffer();
    const encoder = new TextEncoder();
    // Counted for the host's activity probe while the client stays connected.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      engineEventClientsByConfig.set(input.config, Math.max(0, (engineEventClientsByConfig.get(input.config) ?? 1) - 1));
    };
    engineEventClientsByConfig.set(input.config, (engineEventClientsByConfig.get(input.config) ?? 0) + 1);
    input.request.signal.addEventListener("abort", release, { once: true });
    const scopedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
      flush: release,
      async transform(chunk, controller) {
        const parsed = frames.push(chunk);
        if (parsed.overflow) throw new Error("OpenCode v2 event frame exceeded the size limit");
        for (const frame of parsed.frames) {
          let scopedFrame = frame;
          let payload = parseSsePayload(frame);
          if (typeof payload === "string") {
            try { payload = JSON.parse(payload); } catch { continue; }
          }
          const eventData = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
          // Native form.created carries ownership inside the form, unlike
          // form.replied/cancelled and the ordinary session events.
          const eventOwner = isRecord(payload) && payload.type === "form.created" && isRecord(eventData?.form)
            ? eventData.form : eventData;
          const eventSessionId = eventOwner && typeof eventOwner.sessionID === "string" ? eventOwner.sessionID : null;
          if (isRecord(payload) && eventSessionId?.startsWith("ses_")) {
            let home = await homes.stored(eventSessionId);
            if (payload.type === "session.created" && eventData && isRecord(eventData.location)
              && typeof eventData.location.directory === "string") {
              const parent = typeof eventData.parentID === "string"
                ? await homes.resolve(await readNative(`/api/session/${encodeURIComponent(eventData.parentID)}`)) : null;
              home = await homes.created(eventSessionId, parent ?? eventData.location.directory);
            }
            if (!home && payload.type !== "session.deleted") {
              try { home = await homes.resolve(await readNative(`/api/session/${encodeURIComponent(eventSessionId)}`)); }
              catch (error) {
                // A late event for an already-deleted unknown session must not
                // disconnect all other conversations in this workspace.
                if (error instanceof ApiError && error.status === 404) continue;
                throw error;
              }
            }
            if (home !== expectedHome) continue;
            // The compatibility stream is scoped to the UI home. Preserve the
            // native directory separately; the move's data remains untouched.
            payload = { ...payload, data: { ...eventData, openworkHomeDirectory: home },
              openworkWorkingLocation: payload.location,
              location: { directory: input.workspace.path } };
            scopedFrame = `data: ${JSON.stringify(payload)}`;
          } else {
            const location = isRecord(payload) && isRecord(payload.location) ? payload.location : null;
            const directory = location && typeof location.directory === "string" ? location.directory : null;
            if (!directory || await homes.canonical(directory) !== expectedHome) continue;
          }
          controller.enqueue(encoder.encode(`${scopedFrame}\n\n`));
        }
      },
    }));
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    return sanitizeProxyResponse(new Response(scopedBody, { status: response.status, headers: responseHeaders }));
  }
  const pendingKind = /^\/api\/form\/?$/.test(forwardedPath) ? "form"
    : /^\/api\/permission\/request\/?$/.test(forwardedPath) ? "permission" : undefined;
  if (method === "GET" && pendingKind && response.ok) {
    // Native pending lists belong to an execution location. The sidebar belongs
    // to conversation homes, so include moved sessions through their native
    // session-scoped lists and exclude other homes now working in this folder.
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new ApiError(502, "invalid_engine_response", "Invalid pending request list");
    }
    const owned = new Set<string>();
    const moved = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
      const page = await readNative(`/api/session?${query}`);
      if (!isRecord(page) || !Array.isArray(page.data)) {
        throw new ApiError(502, "invalid_engine_response", "Invalid session list response");
      }
      for (const value of page.data) {
        const session = nativeSession(value);
        if (typeof session?.id !== "string") continue;
        let home: string | null;
        try { home = await homes.resolve(value); }
        catch (error) {
          // One unreadable conversation must not hide every other pending request.
          if (signal?.aborted) throw error;
          continue;
        }
        if (home !== expectedHome) continue;
        owned.add(session.id);
        const directory = nativeSessionDirectory(value);
        if (directory && await homes.canonical(directory) !== expectedHome) moved.add(session.id);
      }
      const next = isRecord(page.cursor) ? page.cursor.next : undefined;
      if (!page.data.length || next === undefined || next === null) break;
      if (typeof next !== "string" || cursors.has(next)) {
        throw new ApiError(502, "invalid_engine_response", "Invalid session list cursor");
      }
      cursors.add(next);
      cursor = next;
    } while (cursor);
    const pending = new Map<string, unknown>();
    const include = (items: unknown[], sessionId?: string) => {
      for (const item of items) {
        if (!isRecord(item) || typeof item.id !== "string" || typeof item.sessionID !== "string") continue;
        if (sessionId ? item.sessionID !== sessionId : item.sessionID !== "global" && !owned.has(item.sessionID)) continue;
        pending.set(item.id, item);
      }
    };
    include(payload.data);
    for (const id of moved) {
      let result: unknown;
      try { result = await readNative(`/api/session/${encodeURIComponent(id)}/${pendingKind}`); }
      catch (error) {
        // Deleted while listing, or moved into a folder that no longer exists
        // (the engine answers 500 for it). Either way it has nothing to answer,
        // and failing here returned 500 for the whole workspace on every poll.
        if (signal?.aborted) throw error;
        if (error instanceof ApiError) continue;
        throw error;
      }
      if (!isRecord(result) || !Array.isArray(result.data)) {
        throw new ApiError(502, "invalid_engine_response", "Invalid session pending requests");
      }
      include(result.data, id);
    }
    return jsonResponse({ ...payload, data: [...pending.values()] });
  }
  if (method === "GET" && forwardedPath === "/api/session" && response.ok) {
    const payload: unknown = await response.json();
    const data = isRecord(payload) && "data" in payload ? payload.data : payload;
    const items = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.items) ? data.items : null;
    if (!items) throw new ApiError(502, "invalid_engine_response", "Invalid session list response");
    const scoped = (await Promise.all(items.map(async (item: unknown) =>
      await homes.resolve(item) === expectedHome ? homes.project(item) : null,
    ))).filter((item) => item !== null);
    signal?.throwIfAborted();
    const scopedData = isRecord(data) ? { ...data, items: scoped } : scoped;
    const scopedPayload = isRecord(payload) && "data" in payload ? { ...payload, data: scopedData } : scopedData;
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    return sanitizeProxyResponse(new Response(JSON.stringify(scopedPayload), { status: response.status, headers: responseHeaders }));
  }
  if (response.ok && method === "GET" && forwardedPath === "/api/session/active") {
    const payload: unknown = await response.json();
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};
    const entries = await Promise.all(Object.entries(data).map(async ([id, status]) => {
      const home = await homes.stored(id) ?? await homes.resolve(await readNative(`/api/session/${encodeURIComponent(id)}`));
      return home === expectedHome ? [id, status] : null;
    }));
    return jsonResponse({ data: Object.fromEntries(entries.filter(entry => entry !== null)) });
  }
  if (response.ok && ((method === "GET" && forwardedPath === `/api/session/${sessionId}`)
    || (method === "POST" && (forwardedPath === "/api/session" || forwardedPath.endsWith("/fork"))))) {
    const payload: unknown = await response.json();
    const session = nativeSession(payload);
    if (method === "POST" && typeof session?.id === "string") await homes.created(session.id, expectedHome);
    const data = isRecord(payload) && "data" in payload ? payload.data : payload;
    return jsonResponse({ data: await homes.project(data) });
  }
  // Keep the home after deletion so a delayed session.deleted event still
  // reaches its subscribers. Successful creation replaces a reused ID's home.
  return sanitizeProxyResponse(response);
}

function opencodeUnreachableError(error: unknown, path: string): ApiError {
  return new ApiError(502, "opencode_unreachable", "OpenCode engine is unavailable", {
    path,
    cause: error instanceof Error ? error.message : String(error),
  });
}

/** One native engine request in a workspace's location; throws unless the engine answers 2xx. */
async function requestEngine(
  engine: Pick<EngineV2Preview, "connection">,
  directory: string,
  path: string,
  method = "GET",
): Promise<unknown> {
  const connection = engine.connection();
  if (!connection) throw new ApiError(503, "engine_v2_preview_not_running", "OpenCode is not running yet. Retry shortly.");
  const url = new URL(path, connection.url);
  url.searchParams.set("location[directory]", directory);
  let response: Response;
  try {
    response = await loopbackFetch(url.toString(), {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw opencodeUnreachableError(error, path);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", { status: response.status, path });
  }
  return response.status === 204 ? null : response.json();
}

function agentDiagnosticsTimeoutMs(): number {
  const configured = Number(process.env.OPENWORK_AGENT_DIAGNOSTICS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 24_000;
}

async function validateEngineRequestBody(request: Request): Promise<void> {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method) || !request.body) return;
  const text = await request.clone().text();
  if (!text.trim()) return;
  try { JSON.parse(text); }
  catch { throw new ApiError(400, "invalid_request", "Expected a JSON request body."); }
}

function parseSsePayload(frame: string): unknown {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Strip hop-by-hop and transport-level headers that Bun's native fetch keeps
 * in the upstream response even after it has already decoded the body for us.
 * Without this the browser sees `content-encoding: gzip` on a plain-text
 * payload and bails out with ERR_CONTENT_DECODING_FAILED, breaking any UI
 * code that reaches through /opencode/* (including session.create).
 */
function sanitizeProxyResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.delete("content-length");
  return new Response(transferResponseBody(response), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(response: Response, request: Request, config: ServerConfig) {
  const origin = request.headers.get("origin");
  const allowedOrigins = config.corsOrigins;
  let allowOrigin: string | null = null;
  if (allowedOrigins.includes("*")) {
    allowOrigin = "*";
  } else if (origin && allowedOrigins.includes(origin)) {
    allowOrigin = origin;
  }

  if (!allowOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-OpenWork-Host-Token, X-OpenWork-Client-Id, X-OpenCode-Directory, X-Opencode-Directory, x-opencode-directory",
  );
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  const exposed = headers.get("Access-Control-Expose-Headers");
  headers.set("Access-Control-Expose-Headers", [exposed, "X-Next-Cursor", "Link"].filter(Boolean).join(", "));
  headers.set("Vary", "Origin");
  return new Response(transferResponseBody(response), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function requireClient(request: Request, config: ServerConfig, tokens: TokenService): Promise<Actor> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];
  if (!token) {
    throw new ApiError(401, "unauthorized", "Invalid bearer token");
  }
  const scope = await tokens.scopeForToken(token);
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Invalid bearer token");
  }
  const clientId = request.headers.get("x-openwork-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(token), scope };
}

function requireHostToken(request: Request, config: ServerConfig): Actor {
  const hostToken = request.headers.get("x-openwork-host-token");
  if (hostToken && hostToken === config.hostToken) {
    return { type: "host", tokenHash: hashToken(hostToken), scope: "owner" };
  }
  throw new ApiError(401, "unauthorized", "Invalid host token");
}

async function requireHost(request: Request, config: ServerConfig, tokens: TokenService): Promise<Actor> {
  const hostToken = request.headers.get("x-openwork-host-token");
  if (hostToken && hostToken === config.hostToken) {
    return { type: "host", tokenHash: hashToken(hostToken), scope: "owner" };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1];
  if (!bearer) {
    throw new ApiError(401, "unauthorized", "Invalid host token");
  }
  const scope = await tokens.scopeForToken(bearer);
  if (scope !== "owner") {
    throw new ApiError(401, "unauthorized", "Invalid host token");
  }
  const clientId = request.headers.get("x-openwork-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(bearer), scope };
}

function buildCapabilities(config: ServerConfig): Capabilities {
  const writeEnabled = !config.readOnly;
  const schemaVersion = 1;
  const sandboxBackend = resolveSandboxBackend();
  const sandboxEnabled = resolveSandboxEnabled(sandboxBackend);
  const inboxEnabled = resolveInboxEnabled();
  const outboxEnabled = resolveOutboxEnabled();
  const maxBytes = resolveInboxMaxBytes();
  const browserProvider = resolveBrowserProvider();
  return {
    schemaVersion,
    serverVersion: SERVER_VERSION,
    opencodeVersion: OPENCODE_VERSION,
    providerSync: true,
    skills: { read: true, write: writeEnabled, source: "openwork" },
    plugins: { read: true, write: writeEnabled },
    mcp: { read: true, write: writeEnabled },
    commands: { read: true, write: writeEnabled },
    config: { read: true, write: writeEnabled },

    approvals: { mode: config.approval.mode, timeoutMs: config.approval.timeoutMs },
    sandbox: { enabled: sandboxEnabled, backend: sandboxBackend },
    tokens: { scoped: true, scopes: ["owner", "collaborator", "viewer"] },
    toolProviders: {
      browser: browserProvider,
      files: {
        injection: writeEnabled && inboxEnabled,
        outbox: outboxEnabled,
        inboxPath: ".opencode/openwork/inbox/",
        outboxPath: ".opencode/openwork/outbox/",
        maxBytes,
      },
    },
  };
}

function resolveSandboxBackend(): Capabilities["sandbox"]["backend"] {
  const raw = (process.env.OPENWORK_SANDBOX_BACKEND ?? "").trim().toLowerCase();
  if (raw === "docker") return "docker";
  if (raw === "container") return "container";
  return "none";
}

function resolveSandboxEnabled(backend: Capabilities["sandbox"]["backend"]): boolean {
  const raw = (process.env.OPENWORK_SANDBOX_ENABLED ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return backend !== "none";
}

function resolveInboxEnabled(): boolean {
  const raw = (process.env.OPENWORK_INBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveOutboxEnabled(): boolean {
  const raw = (process.env.OPENWORK_OUTBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveInboxMaxBytes(): number {
  const raw = (process.env.OPENWORK_INBOX_MAX_BYTES ?? "").trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.trunc(parsed);
  }
  // Generous default: the composer no longer caps attachment sizes, so large
  // uploads should be bounded here (memory: formData buffers the body) and by
  // downstream provider/tool limits rather than an arbitrary small cap.
  return 250_000_000;
}

// Dev-only log sink target. When OPENWORK_DEV_LOG_FILE is set to a path, the
// /dev/log endpoint accepts JSON payloads and appends them to that file so an
// operator can `tail -f` the file to see live browser activity. Returning null
// disables the endpoint entirely.
function resolveDevLogPath(): string | null {
  const raw = (process.env.OPENWORK_DEV_LOG_FILE ?? "").trim();
  return raw.length > 0 ? raw : null;
}

function resolveBrowserProvider(): Capabilities["toolProviders"]["browser"] {
  const raw = (process.env.OPENWORK_BROWSER_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "sandbox-headless") {
    return { enabled: true, placement: "in-sandbox", mode: "headless" };
  }
  if (raw === "host-interactive") {
    return { enabled: true, placement: "host-machine", mode: "interactive" };
  }
  if (raw === "client-interactive") {
    return { enabled: true, placement: "client-machine", mode: "interactive" };
  }
  return { enabled: false, placement: "external", mode: "none" };
}

function emitReloadEvent(
  reloadEvents: ReloadEventStore,
  workspace: WorkspaceInfo,
  reason: ReloadReason,
  trigger?: ReloadTrigger,
) {
  reloadEvents.recordDebounced(workspace.id, reason, trigger);
}

function buildConfigTrigger(path: string): ReloadTrigger {
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return {
    type: "config",
    name: name || "opencode.json",
    action: "updated",
    path,
  };
}

export type AuthorizedFoldersResponse = {
  folders: string[];
  hiddenCount: number;
  workspaceRoot: string;
};

export type AuthorizedFoldersUpdateResponse = {
  folders: string[];
  hiddenCount: number;
  updatedAt: number;
};

type AuthorizedFoldersConfig = {
  folders: string[];
  hiddenEntries: Record<string, unknown>;
};

export function normalizeAuthorizedFolderPath(input: string | null | undefined): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "/*") return "/";
  const withoutWildcard = trimmed.replace(/[\\/]\*+$/, "");
  const withoutVerbatim = /^\\\\\?\\UNC\\/i.test(withoutWildcard)
    ? `\\${withoutWildcard.slice(7)}`
    : /^\\\\\?\\[a-zA-Z]:[\\/]/.test(withoutWildcard)
      ? withoutWildcard.slice(4)
      : withoutWildcard;
  const unified = withoutVerbatim.replace(/\\/g, "/");
  let end = unified.length;
  while (end > 0 && unified[end - 1] === "/") end -= 1;
  const withoutTrailing = end === unified.length ? unified : unified.slice(0, end);
  return withoutTrailing || "/";
}

function externalDirectoryKeyToAuthorizedFolder(key: string, value: unknown): string | null {
  if (value !== "allow") return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (trimmed === "/*") return "/";
  if (!trimmed.endsWith("/*")) return null;
  return normalizeAuthorizedFolderPath(trimmed.slice(0, -2));
}

function authorizedFolderToExternalDirectoryKey(folder: string): string {
  return folder === "/" ? "/*" : `${folder}/*`;
}

function hasOwnKey(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readAuthorizedFoldersFromOpencodeConfig(
  opencodeConfig: Record<string, unknown>,
  workspaceRoot: string,
): AuthorizedFoldersConfig {
  const workspaceRootFolder = normalizeAuthorizedFolderPath(workspaceRoot);
  const permission = ensurePlainObject(opencodeConfig.permission);
  const externalDirectory = ensurePlainObject(permission.external_directory);
  const folders: string[] = [];
  const hiddenEntries: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(externalDirectory)) {
    const folder = externalDirectoryKeyToAuthorizedFolder(key, value);
    if (!folder) {
      hiddenEntries[key] = value;
      continue;
    }
    if (folder === workspaceRootFolder || seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
  }

  return { folders, hiddenEntries };
}

function parseAuthorizedFoldersPayload(input: unknown, workspaceRoot: string): string[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "folders must be an array");
  }

  const workspaceRootFolder = normalizeAuthorizedFolderPath(workspaceRoot);
  const folders: string[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    if (typeof item !== "string") {
      throw new ApiError(400, "invalid_payload", "folders must be an array of strings");
    }
    const folder = normalizeAuthorizedFolderPath(item);
    if (!folder || folder === workspaceRootFolder || seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
  }

  return folders;
}

function mergeAuthorizedFoldersIntoExternalDirectory(
  folders: string[],
  hiddenEntries: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...hiddenEntries };
  for (const folder of folders) {
    next[authorizedFolderToExternalDirectoryKey(folder)] = "allow";
  }
  return Object.keys(next).length ? next : undefined;
}

function buildAuthorizedFoldersResponse(workspace: WorkspaceInfo, config: AuthorizedFoldersConfig): AuthorizedFoldersResponse {
  return {
    folders: config.folders,
    hiddenCount: Object.keys(config.hiddenEntries).length,
    workspaceRoot: normalizeAuthorizedFolderPath(workspace.path),
  };
}

function serializeWorkspace(workspace: ServerConfig["workspaces"][number]) {
  return { ...workspace };
}

function createRoutes(
  config: ServerConfig,
  approvals: ApprovalService,
  tokens: TokenService,
  env: EnvService,
  onWorkspacesChanged: () => void,
  cloudProviderSync: CloudProviderSync,
  engineV2Preview: EngineV2Preview,
  anonymousInference: AnonymousInferenceService,
): Route[] {
  const routes: Route[] = [];
  addRoute(routes, "GET", "/anonymous-inference/status", "client", async () =>
    jsonResponse(await anonymousInference.status()));
  for (const action of ["preflight", "refresh"]) {
    addRoute(routes, "POST", `/anonymous-inference/${action}`, "client", async (ctx) => {
      requireClientScope(ctx, "collaborator");
      return jsonResponse(await anonymousInference.preflight());
    });
  }
  addRoute(routes, "GET", "/anonymous-inference/v1/models", "none", (ctx) =>
    anonymousInference.handle(ctx.request, "models"));
  addRoute(routes, "POST", "/anonymous-inference/v1/chat/completions", "none", (ctx) =>
    anonymousInference.handle(ctx.request, "chat/completions"));
  addRoute(routes, "POST", "/anonymous-inference/v1/responses", "none", (ctx) =>
    anonymousInference.handle(ctx.request, "responses"));
  // Provider changes reach the engine through its provider mirror. One that
  // cannot land now stays owed and is retried in the background.
  const refreshEngineProviders = async (): Promise<"reloaded" | "deferred"> => {
    try {
      await engineV2Preview.refreshProviders();
      return "reloaded";
    } catch {
      cloudProviderSync.markReloadPending();
      return "deferred";
    }
  };
  const privateProviderResponse = (value: unknown) => {
    const response = jsonResponse(value);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  addRoute(routes, "GET", "/anonymous-inference/preferences", "host-token", async () =>
    privateProviderResponse(await anonymousInference.preferences()));
  addRoute(routes, "PUT", "/anonymous-inference/preferences", "host-token", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    if (typeof body.enabled !== "boolean" || Object.keys(body).some((key) => key !== "enabled")) {
      throw new ApiError(400, "invalid_payload", "Only enabled is accepted.");
    }
    const preferences = await anonymousInference.setEnabled(body.enabled);
    const refresh = await refreshEngineProviders();
    return jsonResponse({ ...preferences, refresh });
  });
  const nativeEngineForWorkspace = createNativeCloudMcpResolver(engineV2Preview);
  registerCoreRoutes({
    nativeEngineForWorkspace,
    routes,
    config,
    tokens,
    env,
    serverVersion: SERVER_VERSION,
    opencodeVersion: OPENCODE_VERSION,
    engineVersion: () => engineV2Preview.status().version,
    jsonResponse,
    readJsonBody,
    readOptionalJsonBody,
    parseOptionalBoolean,
    ensureWritable,
    buildCapabilities,
    fetchRuntimeControl,
    resolveWorkspace,
    resolveOpencodeDirectory,
    serializeWorkspace,
    resolveDevLogPath,
    onProviderCredentialsChanged: async () => {
      await refreshEngineProviders();
    },
  });

  registerWorkspaceRoutes({
    routes,
    config,
    onWorkspacesChanged,
    jsonResponse,
    readJsonBody,
    readOptionalJsonBody,
    parseOptionalBoolean,
    ensureWritable,
    resolveWorkspace,
    serializeWorkspace,
    syncWorkspaceRuntimeMcp: (_routeConfig, workspace) => engineV2Preview.syncWorkspaceMcp(workspace.id, workspace.path),
  });

  registerSessionGroupRoutes({
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    resolveWorkspaceWithoutBootstrap,
  });

  registerWorkspaceDefaultModelRoutes({
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspaceWithoutBootstrap,
  });

  registerCloudMcpRoutes({
    nativeEngineForWorkspace,
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    resolveOpencodeDirectory,
    registerRuntimeMcp: createCloudMcpRegistrar(engineV2Preview),
    serverMetadata: { serverVersion: SERVER_VERSION, expectedOpencodeVersion: OPENCODE_VERSION },
  });

  addRoute(routes, "POST", "/workspace/:id/diagnostics/agent-context", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceForInspection(config, ctx.params.id);
    // Reserve before consuming untrusted bytes and hold the reservation through
    // report completion. The cooldown remains charged for invalid, oversized,
    // timed-out, and otherwise unsuccessful attempts.
    const releaseReservation = reserveAgentDiagnosticsRun(config, ctx.actor, workspace.id);
    try {
      const parsed = agentContextDiagnosticsRequestSchema.safeParse(await readAgentDiagnosticsJsonBody(ctx.request));
      if (!parsed.success) {
        throw new ApiError(400, "invalid_agent_diagnostics_request", "Agent diagnostics request is invalid");
      }
      const timeoutSignal = AbortSignal.timeout(agentDiagnosticsTimeoutMs());
      const diagnosticsSignal = AbortSignal.any([ctx.request.signal, timeoutSignal]);
      let response: Response;
      try {
        response = jsonResponse(await runAgentContextDiagnostics({
          config,
          workspace,
          request: parsed.data,
          // Reading native MCP status may initialize untrusted workspace MCPs.
          // Diagnostics must not activate connectors or start the engine.
          inspectRegistration: (name) => engineV2Preview.inspectMcpRegistration(workspace.path, name),
          engineReachable: false,
          dependencies: { signal: diagnosticsSignal },
        }));
      } catch (error) {
        if (timeoutSignal.aborted && !ctx.request.signal.aborted) {
          throw new ApiError(504, "agent_diagnostics_timeout", "Agent diagnostics timed out");
        }
        throw error;
      }
      response.headers.set("Cache-Control", "no-store");
      return response;
    } finally {
      releaseReservation();
    }
  });

  addRoute(routes, "GET", "/workspace/:id/config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const openwork = await readOpenworkConfigForWorkspace(config, workspace);
    // Effective runtime view (ENGINE_GLOBAL ⊕ workspace row): providers,
    // plugins, and authorized folders live in the global row now, and the UI
    // must keep seeing them after migration.
    const opencode = mergeOpencodeConfigs(
      await readOpencodeConfig(workspace.path),
      await readEffectiveRuntimeOpencodeConfig(config, workspace.id),
    );
    const lastAudit = await readLastAudit(workspace.path, workspace.id);
    return jsonResponse({ opencode, openwork, updatedAt: lastAudit?.timestamp ?? null });
  });

  addRoute(routes, "GET", "/workspace/:id/desktop-cloud-sync", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const openwork = await readOpenworkConfigForWorkspace(config, workspace);
    return jsonResponse(readDesktopCloudSyncState(openwork));
  });

  addRoute(routes, "POST", "/workspace/:id/desktop-cloud-sync", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const snapshot = normalizeResourceSnapshot(body.snapshot);
    if (!snapshot) {
      throw new ApiError(400, "invalid_payload", "snapshot is required");
    }

    const result = await enqueueDesktopCloudSync(async () => {
      const openwork = await readOpenworkConfigForWorkspace(config, workspace);
      const installed = await readInstalledCloudPlugins(config, workspace.id);
      const cloudImports = {
        ...installed,
        providers: readWorkspaceCloudImports(openwork).providers,
      };
      const next = syncDesktopCloudResources({ openwork: { ...openwork, cloudImports }, snapshot });
      // The plugin DB owns plugins/marketplaces, but provider import baselines live in
      // the workspace config. Writing the merged cloudImports back erased providers
      // and drove the provider-sync dispose/create loop.
      await writeOpenworkWorkspaceConfig(config, workspace.id, (current) => ({
        ...current,
        desktopCloudSync: next.state,
      }));
      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "remote" },
        action: "desktop_cloud_sync.update",
        target: openworkConfigPath(workspace.path),
        summary: "Updated desktop cloud sync state",
        timestamp: Date.now(),
      });
      return next;
    });
    return jsonResponse({ changes: result.changes, state: result.state });
  });

  addRoute(routes, "GET", "/workspace/:id/cloud-plugins", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const cloudImports = await readInstalledCloudPlugins(config, workspace.id);
    return jsonResponse({ marketplaces: cloudImports.marketplaces, plugins: cloudImports.plugins });
  });

  addRoute(routes, "DELETE", "/workspace/:id/cloud-plugins/:pluginId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const pluginId = ctx.params.pluginId ?? "";

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "cloud_plugins.remove",
      summary: `Remove cloud plugin ${pluginId}`,
      paths: [openworkConfigPath(workspace.path), join(workspace.path, ".opencode")],
    });

    const removed = await removeCloudPlugin({
      serverConfig: config,
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      pluginId,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "cloud_plugins.remove",
      target: openworkConfigPath(workspace.path),
      summary: `Removed cloud plugin ${removed.name}`,
      timestamp: Date.now(),
    });

    for (const file of removed.files) {
      emitReloadEvent(ctx.reloadEvents, workspace, file.objectType === "mcp" ? "mcp" : file.objectType === "skill" ? "skills" : file.objectType === "agent" ? "agents" : file.objectType === "command" ? "commands" : "config", {
        type: file.objectType === "skill" || file.objectType === "agent" || file.objectType === "command" || file.objectType === "mcp" ? file.objectType : "config",
        name: file.title,
        action: "removed",
      });
    }
    if (removed.files.some((file) => file.objectType === "skill")) {
      await engineV2Preview.settleWorkspaceSkills(workspace.path);
    }

    return jsonResponse({ item: removed, warnings: [] });
  });

  addRoute(routes, "GET", "/workspace/:id/authorized-folders", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const opencode = mergeOpencodeConfigs(
      await readOpencodeConfig(workspace.path),
      // Global-first: authorized folders live in the ENGINE_GLOBAL row; the
      // effective read also surfaces legacy per-workspace entries until the
      // startup migration folds them in.
      await readEffectiveRuntimeOpencodeConfig(config, workspace.id),
    );
    const foldersConfig = readAuthorizedFoldersFromOpencodeConfig(opencode, workspace.path);
    return jsonResponse(buildAuthorizedFoldersResponse(workspace, foldersConfig));
  });

  addRoute(routes, "PUT", "/workspace/:id/authorized-folders", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const folders = parseAuthorizedFoldersPayload(body.folders, workspace.path);
    const configPath = openworkConfigPath(workspace.path);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.authorized_folders.write",
      summary: "Update authorized folders",
      paths: [configPath],
    });

    const persistedOpencode = await readOpencodeConfig(workspace.path);
    const runtimeOpencode = await readEffectiveRuntimeOpencodeConfig(config, workspace.id);
    const existingOpencode = mergeOpencodeConfigs(persistedOpencode, runtimeOpencode);
    const existingFoldersConfig = readAuthorizedFoldersFromOpencodeConfig(existingOpencode, workspace.path);
    const nextExternalDirectory = mergeAuthorizedFoldersIntoExternalDirectory(
      folders,
      existingFoldersConfig.hiddenEntries,
    );

    // Authorized folders are engine-global: the injected engine config file is
    // rendered from the ENGINE_GLOBAL row only. Any legacy per-workspace
    // entries were folded into the effective read above, so clear them from
    // the workspace row or removals could never take effect.
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      permission: {
        ...(ensurePlainObject(current.permission)),
        external_directory: nextExternalDirectory ?? {},
      },
    }));
    await writeRuntimeOpencodeConfig(config, workspace.id, (current) => {
      const { permission, ...rest } = current;
      // Strip only the migrated external_directory; other permission keys stay.
      const { external_directory: _legacyExternalDirectory, ...permissionRest } = ensurePlainObject(permission);
      return {
        ...rest,
        ...(Object.keys(permissionRest).length ? { permission: permissionRest } : {}),
      };
    });

    const updatedAt = Date.now();
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.authorized_folders.write",
      target: configPath,
      summary: "Updated authorized folders",
      timestamp: updatedAt,
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(configPath));

    const updatedFoldersConfig = readAuthorizedFoldersFromOpencodeConfig({
      permission: { external_directory: nextExternalDirectory ?? {} },
    }, workspace.path);

    const response: AuthorizedFoldersUpdateResponse = {
      folders: updatedFoldersConfig.folders,
      hiddenCount: Object.keys(updatedFoldersConfig.hiddenEntries).length,
      updatedAt,
    };
    return jsonResponse(response);
  });

  // OpenCode v2 keeps its engine config private, so clients read the shared
  // disabled list here (ids only) to offer "Enable" for hidden providers.
  addRoute(routes, "GET", "/workspace/:id/runtime-config/disabled-providers", "client", async (ctx) => {
    await resolveWorkspace(config, ctx.params.id);
    const runtime = await readGlobalRuntimeOpencodeConfig(config);
    return jsonResponse({ ok: true, disabledProviders: runtimeDisabledProviderList(runtime) });
  });

  addRoute(routes, "POST", "/workspace/:id/runtime-config/disabled-providers", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const providers = parseDisabledProvidersPayload(body.providers);
    // Disabled providers are engine-global: the injected engine config file is
    // rendered from the ENGINE_GLOBAL row only.
    const result = await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      disabled_providers: providers,
    }));

    if (result.changed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(openworkConfigPath(workspace.path)));
    }

    return jsonResponse({
      ok: true,
      disabledProviders: runtimeDisabledProviderList(result.config),
    });
  });

  addRoute(routes, "GET", "/runtime-config/providers", "host-token", async () => {
    const runtime = await readGlobalRuntimeOpencodeConfig(config);
    return jsonResponse({ provider: runtimeProviderMap(runtime) });
  });

  // The host that owns this instance's lifecycle asks before stopping or
  // restarting it. Counts only; no session content leaves the instance.
  addRoute(routes, "GET", "/runtime/activity", "host-token", async () => {
    const response = jsonResponse(await describeRuntimeActivity(config, engineV2Preview));
    response.headers.set("Cache-Control", "no-store");
    return response;
  });

  addRoute(routes, "PUT", "/den-session/identity", "host-token", async (ctx) => {
    ensureWritable(config);
    const session = parseCloudProviderDenSession(await readJsonBody(ctx.request));
    if (!session) throw new ApiError(400, "invalid_payload", "baseUrl, token, and orgId are required");
    anonymousInference.setMemberSession(session);
    const suspended = cloudProviderSync.suspend();
    try {
      await managedDesktopPolicy(config).setSession(session);
    } finally {
      await suspended;
    }
    return new Response(null, { status: 204 });
  });

  addRoute(routes, "PUT", "/den-session", "host-token", async (ctx) => {
    ensureWritable(config);
    const session = parseCloudProviderDenSession(await readJsonBody(ctx.request));
    if (!session) throw new ApiError(400, "invalid_payload", "baseUrl, token, and orgId are required");
    anonymousInference.setMemberSession(session);
    await managedDesktopPolicy(config).setSession(session);
    await cloudProviderSync.setSession(session);
    return new Response(null, { status: 204 });
  });

  addRoute(routes, "DELETE", "/den-session", "host-token", async () => {
    ensureWritable(config);
    anonymousInference.setMemberSession(null);
    await managedDesktopPolicy(config).clearSession();
    await cloudProviderSync.clearSession();
    await anonymousInference.initialize(config.port);
    return new Response(null, { status: 204 });
  });

  addRoute(routes, "POST", "/cloud-provider-sync/run", "host-token", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    if (body.reason !== undefined && typeof body.reason !== "string") {
      throw new ApiError(400, "invalid_payload", "reason must be a string");
    }
    return jsonResponse(await cloudProviderSync.run(typeof body.reason === "string" ? body.reason : undefined));
  });

  addRoute(routes, "POST", "/cloud-provider-sync/providers/:id/oauth/start", "host-token", async (ctx) => {
    ensureWritable(config);
    const origin = ctx.request.headers.get("origin");
    if (origin && origin !== new URL(ctx.request.url).origin && !config.corsOrigins.includes("*") && !config.corsOrigins.includes(origin)) {
      throw new ApiError(403, "invalid_origin", "This origin cannot start provider authorization");
    }
    if (ctx.request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
      throw new ApiError(415, "invalid_content_type", "A JSON request is required");
    }
    const body = await readJsonBody(ctx.request);
    if (typeof body.orgId !== "string" || (body.credentialSetId !== undefined && typeof body.credentialSetId !== "string") || Object.keys(body).some((key) => key !== "orgId" && key !== "credentialSetId")) {
      throw new ApiError(400, "invalid_payload", "Only the active orgId and optional credentialSetId are accepted");
    }
    return jsonResponse(await cloudProviderSync.startProviderOAuth(ctx.params.id, body.orgId, body.credentialSetId));
  });

  addRoute(routes, "GET", "/managed-policy", "client", async () =>
    jsonResponse({ policy: await managedDesktopPolicy(config).current() }));
  // The desktop process reads the built-in browser's website rules here itself.
  addRoute(routes, "GET", "/managed-policy/website-rules", "client", async () =>
    jsonResponse({ rules: await managedDesktopPolicy(config).websiteRules() }));
  addRoute(routes, "POST", "/managed-policy/evaluate", "policy", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const action = managedPolicyActionSchema.safeParse(body.action);
    if (!action.success || !isRecord(body.input)) throw new ApiError(400, "invalid_payload", "A supported policy action and input are required");
    await managedDesktopPolicy(config).assert(action.data, body.input);
    return jsonResponse({ allowed: true });
  });

  addRoute(routes, "GET", "/cloud-provider-sync/status", "client", async () => {
    return jsonResponse(cloudProviderSync.status());
  });

  addRoute(routes, "GET", "/engine/status", "client", async () => {
    return jsonResponse(engineV2Preview.status());
  });

  // One-time copy of OpenCode v1 chat history into the engine. Progress is
  // reported by /engine/status.
  addRoute(routes, "POST", "/engine/v1-history/import", "host-token", async (ctx) => {
    ensureWritable(config);
    await readOptionalJsonBody(ctx.request);
    return jsonResponse(engineV2Preview.migrateHistory());
  });

  addRoute(routes, "PATCH", "/runtime-config/providers", "host-token", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    const providerPatch = parseRuntimeProviderPatchPayload(body);
    const result = await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      provider: mergeRuntimeProviderUpdate(current.provider, providerPatch),
    }));
    // The engine mirrors provider config and its stored credentials; a
    // credential-only rotation reaches it through PUT /env.
    const reload = result.changed ? await refreshEngineProviders() : "skipped";
    return jsonResponse({
      ok: true,
      changed: result.changed,
      provider: runtimeProviderMap(result.config),
      reload,
    });
  });

  addRoute(routes, "GET", "/workspace/:id/runtime-config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const runtime = await readRuntimeOpencodeConfig(config, workspace.id);
    const rawOpencode = await readRawOpencodeConfig(opencodeConfigPath(workspace.path));
    const persistedOpencode = await readOpencodeConfig(workspace.path);
    const globalOpencodePath = resolveOpencodeConfigFilePath("global", workspace.path);
    const rawGlobalOpencode = await readRawOpencodeConfig(globalOpencodePath);
    const emptyGlobalOpencode: Record<string, unknown> = {};
    const globalOpencode = (await readJsoncFile(globalOpencodePath, emptyGlobalOpencode, { allowInvalid: true })).data;

    return jsonResponse({
      runtime,
      runtimeKeys: runtimeConfigKeys(runtime),
      sources: {
        projectOpencode: {
          path: opencodeConfigPath(workspace.path),
          exists: rawOpencode.exists,
          keys: userOpencodeConfigKeys(persistedOpencode),
          config: persistedOpencode,
        },
        globalOpencode: {
          path: globalOpencodePath,
          exists: rawGlobalOpencode.exists,
          keys: userOpencodeConfigKeys(globalOpencode),
          config: globalOpencode,
        },
        runtimeDatabase: {
          keys: runtimeConfigKeys(runtime),
          config: runtime,
        },
      },
      userOpencode: {
        path: opencodeConfigPath(workspace.path),
        exists: rawOpencode.exists,
        keys: userOpencodeConfigKeys(persistedOpencode),
      },
    });
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const scope = normalizeOpencodeScope(ctx.url.searchParams.get("scope"));
    const configPath = resolveOpencodeConfigFilePath(scope, workspace.path);
    const result = await readRawOpencodeConfig(configPath);
    return jsonResponse({ path: configPath, exists: result.exists, content: result.content });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-config", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const scope = normalizeOpencodeScope(typeof body.scope === "string" ? body.scope : null);
    const content = typeof body.content === "string" ? body.content : null;
    if (content === null) {
      throw new ApiError(400, "invalid_payload", "content must be a string");
    }

    const configPath = resolveOpencodeConfigFilePath(scope, workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: scope === "global" ? "config.global.write" : "config.write",
      summary: `Write ${scope} OpenCode config`,
      paths: [configPath],
    });

    const nextContent = content.endsWith("\n") ? content : `${content}\n`;
    const current = await readRawOpencodeConfig(configPath);
    const changed = !current.exists || current.content !== nextContent;
    if (changed) {
      await ensureDir(dirname(configPath));
      await writeFile(configPath, nextContent, "utf8");
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: scope === "global" ? "config.global.write" : "config.write",
      target: configPath,
      summary: `Updated ${scope} OpenCode config`,
      timestamp: Date.now(),
    });

    if (scope === "project" && changed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(configPath));
    }

    return jsonResponse({
      ok: true,
      status: 0,
      stdout: `Wrote ${configPath}`,
      stderr: "",
    });
  });

  addRoute(routes, "GET", "/workspace/:id/audit", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const limitParam = ctx.url.searchParams.get("limit");
    const parsed = limitParam ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    const items = await readAuditEntries(workspace.path, workspace.id, limit);
    return jsonResponse({ items });
  });

  addRoute(routes, "PATCH", "/workspace/:id/config", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const opencode = body.opencode as Record<string, unknown> | undefined;
    const openwork = body.openwork as Record<string, unknown> | undefined;
    let runtimeChanged = false;

    if (!opencode && !openwork) {
      throw new ApiError(400, "invalid_payload", "opencode or openwork updates required");
    }
    // Adding or changing an MCP server here is the same as through /mcp: names
    // OpenWork reserves for the organization's servers are refused, and so is
    // a local server the member's agent permissions block.
    if (isRecord(opencode?.mcp)) {
      const saved = runtimeMcpMap(await readRuntimeOpencodeConfig(config, workspace.id));
      for (const [name, server] of Object.entries(opencode.mcp)) {
        if (server === null || JSON.stringify(server) === JSON.stringify(saved[name])) continue;
        validateUserMcpName(name);
        await managedDesktopPolicy(config).assertAgentPermission("mcp", name);
      }
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.patch",
      summary: "Patch workspace config",
      paths: [opencode || openwork ? openworkConfigPath(workspace.path) : null].filter(Boolean) as string[],
    });

    if (opencode) {
      const configPath = openworkConfigPath(workspace.path);
      const nextOpencode = ensurePlainObject(opencode);
      const { permission, provider, ...topLevelUpdates } = nextOpencode;
      const logicalUpdates: Record<string, unknown> = { ...topLevelUpdates };

      // Per-provider merge: record values upsert, explicit `null` deletes
      // (mergeRuntimeProviderUpdate) — so clients can remove runtime-managed
      // providers (e.g. cloud imports) without read-modify-write races.
      // Providers are engine-global: the injected engine config file is
      // rendered from the ENGINE_GLOBAL row only, so a workspace-row write
      // would never reach the engine.
      const providerUpdate = isRecord(provider) ? provider : {};
      // Opt-in per provider: add the patch's models to the ones already saved instead of replacing them.
      const mergeProviderModels = new Set(Array.isArray(body.mergeProviderModels)
        ? body.mergeProviderModels.filter((id): id is string => typeof id === "string")
        : []);
      // Removing a provider is always allowed; adding or changing one must fit the organization's model access.
      if (Object.keys(providerUpdate).length) await managedDesktopPolicy(config).assert("provider", {
        providerIDs: Object.entries(providerUpdate).filter(([, value]) => value !== null).map(([id]) => id),
      });
      if (Object.keys(providerUpdate).length) {
        const providerResult = await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
          ...current,
          provider: mergeRuntimeProviderUpdate(current.provider, providerUpdate, mergeProviderModels),
        }));
        runtimeChanged = providerResult.changed || runtimeChanged;
      }

      const permissionUpdate = ensurePlainObject(permission);
      if (Object.prototype.hasOwnProperty.call(permissionUpdate, "external_directory")) {
        // Authorized folders are engine-global for the same reason as providers.
        const nextExternalDirectory = permissionUpdate.external_directory;
        const permissionResult = await writeGlobalRuntimeOpencodeConfig(config, (current) => {
          const existingPermission = ensurePlainObject(current.permission);
          const existingPermissionKeys = Object.keys(existingPermission);
          const removePermissionParent =
            typeof nextExternalDirectory === "undefined" &&
              (existingPermissionKeys.length === 0 ||
              (existingPermissionKeys.length === 1 && Object.prototype.hasOwnProperty.call(existingPermission, "external_directory")));
          if (removePermissionParent) {
            const { permission: _removed, ...rest } = current;
            return rest;
          }
          return {
            ...current,
            permission: {
              ...existingPermission,
              external_directory: ensurePlainObject(nextExternalDirectory),
            },
          };
        });
        runtimeChanged = permissionResult.changed || runtimeChanged;
      }

      if (Object.keys(logicalUpdates).length) {
        const result = await writeRuntimeOpencodeConfig(config, workspace.id, (current) => ({
          ...current,
          ...logicalUpdates,
        }));
        runtimeChanged = result.changed || runtimeChanged;
      }
    }
    if (openwork) {
      await writeOpenworkWorkspaceConfig(config, workspace.id, (current) => ({
        ...current,
        ...openwork,
      }));
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.patch",
      target: openworkConfigPath(workspace.path),
      summary: "Patched workspace config",
      timestamp: Date.now(),
    });

    // A no-op provider patch (for example cloud sync reconciling an identical
    // block) must not force an engine reload; that caused a dispose/create loop.
    if (opencode && runtimeChanged) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(openworkConfigPath(workspace.path)));
    }

    return jsonResponse({ updatedAt: Date.now() });
  });

  registerOperationRoutes({
    routes,
    config,
    jsonResponse,
    readJsonBody,
    requireClientScope,
    resolveWorkspace,
    // Explicit reloads re-push providers, including credential writes the
    // background mirror may not have picked up yet.
    refreshEngine: () => engineV2Preview.refreshProviders(),
  });

  registerUiControlRoutes({ routes, jsonResponse, readJsonBody, requireClientScope });

  registerFileRoutes({
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireApproval,
    requireClientScope,
    resolveWorkspace,
    resolveInboxEnabled,
    resolveOutboxEnabled,
    resolveInboxMaxBytes,
    scopeRank,
    resolveSessionDirectory: (workspace, sessionId) => resolveV2SessionExecutionDirectory(config, engineV2Preview, workspace, sessionId),
  });

  addRoute(routes, "GET", "/workspace/:id/plugins", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const result = await listPlugins(config, workspace.id, workspace.path, includeGlobal);
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/plugins", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const spec = String(body.spec ?? "");
    const normalized = normalizePluginSpec(spec);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.add",
      summary: `Add plugin ${spec}`,
      paths: [openworkConfigPath(workspace.path)],
    });
    const changed = await addPlugin(config, spec);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.add",
      target: openworkConfigPath(workspace.path),
      summary: `Added ${spec}`,
      timestamp: Date.now(),
    });
    if (changed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "added",
      });
    }
    const result = await listPlugins(config, workspace.id, workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/workspace/:id/plugins/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const normalized = normalizePluginSpec(name);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.remove",
      summary: `Remove plugin ${name}`,
      paths: [openworkConfigPath(workspace.path)],
    });
    const removed = await removePlugin(config, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.remove",
      target: openworkConfigPath(workspace.path),
      summary: `Removed ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "removed",
      });
    }
    const result = await listPlugins(config, workspace.id, workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/skills", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const items = await listSkills(workspace.path, includeGlobal);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/skills/:name", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const items = await listSkills(workspace.path, includeGlobal);
    const item = items.find((skill) => skill.name === name);
    if (!item) {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
    }
    const rawContent = await readFile(item.path, "utf8");
    const content = renderSkillContentForResponse(item, rawContent);
    return jsonResponse({ item, content });
  });

  addRoute(routes, "POST", "/workspace/:id/skills", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    await managedDesktopPolicy(config).assertAgentPermission("skill", name);
    const content = String(body.content ?? "");
    const description = body.description ? String(body.description) : undefined;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.upsert",
      summary: `Upsert skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name, "SKILL.md")],
    });
    const result = await upsertSkill(workspace.path, { name, content, description });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.upsert",
      target: result.path,
      summary: `Upserted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });
    // The next v2 turn should see a skill OpenWork just wrote; the engine's
    // own watcher normally catches up within ~200 ms.
    await engineV2Preview.settleWorkspaceSkills(workspace.path);
    return jsonResponse({ name, path: result.path, description: description ?? "", scope: "project" });
  });

  addRoute(routes, "DELETE", "/workspace/:id/skills/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.delete",
      summary: `Delete skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });
    const result = await deleteSkill(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.delete",
      target: result.path,
      summary: `Deleted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: "removed",
      path: result.path,
    });
    await engineV2Preview.settleWorkspaceSkills(workspace.path);
    return jsonResponse({ ok: true, name, path: result.path });
  });

  addRoute(routes, "GET", "/workspace/:id/mcp", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listMcp(config, workspace.id, workspace.path);
    const managedState = await listLocalManagedMcpConnectionsSafe(config, workspace.id);
    const managed = new Map(managedState.connections.map((connection) => [connection.name, connection]));
    return jsonResponse({
      items: items.map((item) => ({ ...item, managedOAuth: managed.get(item.name) ?? null })),
      managedOAuthState: { available: managedState.available, recovery: managedState.recovery },
    });
  });

  addRoute(routes, "GET", "/mcp-apps/sandbox.html", "none", async (ctx) => new Response(MCP_APP_SANDBOX_PROXY_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": buildMcpAppSandboxCsp(parseMcpAppSandboxCsp(ctx.url.searchParams.get("csp"))),
      "Cache-Control": "no-store",
      "Referrer-Policy": "strict-origin",
      "X-Content-Type-Options": "nosniff",
    },
  }));
  addRoute(routes, "GET", "/mcp-apps/sandbox.js", "none", async () => new Response(MCP_APP_SANDBOX_PROXY_SCRIPT, {
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  }));
  addRoute(routes, "GET", "/mcp-apps/sandbox.css", "none", async () => new Response(MCP_APP_SANDBOX_PROXY_CSS, {
    headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  }));

  addRoute(routes, "GET", "/workspace/:id/mcp-apps/list", "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    try {
      const servers = await listMcpAppCatalog({
        serverConfig: config,
        workspaceId: workspace.id,
        workspaceRoot: workspace.path,
      });
      return jsonResponse({ servers });
    } catch (error) {
      rethrowMcpAppHostError(error);
    }
  });

  addRoute(routes, "POST", "/workspace/:id/mcp-apps/resolve", "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    let context: McpAppLaunchContext | undefined;
    if (body.context !== undefined) {
      const parsed = body.context;
      if (!parsed || typeof parsed !== "object" || !("sessionId" in parsed) || !("readOnly" in parsed)
        || (parsed.sessionId !== null && (typeof parsed.sessionId !== "string" || !parsed.sessionId.trim()))
        || typeof parsed.readOnly !== "boolean") {
        throw new ApiError(400, "invalid_launch_context", "App context requires a sessionId (null for dashboard views) and readOnly flag.");
      }
      context = { sessionId: parsed.sessionId, readOnly: parsed.readOnly };
    }
    const projectedToolName = typeof body.projectedToolName === "string" ? body.projectedToolName.trim() : "";
    const launch = body.launch && typeof body.launch === "object" && !Array.isArray(body.launch)
      ? body.launch as Record<string, unknown>
      : null;
    try {
      const app = launch && typeof launch.connectionId === "string"
        ? await resolveConnectMcpAppResource({
            serverConfig: config,
            context,
            workspaceId: workspace.id,
            workspaceRoot: workspace.path,
            launch: {
              connectionId: typeof launch.connectionId === "string" ? launch.connectionId : "",
              toolName: typeof launch.toolName === "string" ? launch.toolName : "",
              resourceUri: typeof launch.resourceUri === "string" ? launch.resourceUri : "",
            },
          })
        : launch
          ? await resolveSameServerMcpAppResource({
              serverConfig: config,
              context,
              workspaceId: workspace.id,
              workspaceRoot: workspace.path,
              projectedToolName,
              launch: {
                toolName: typeof launch.toolName === "string" ? launch.toolName : "",
                resourceUri: typeof launch.resourceUri === "string" ? launch.resourceUri : "",
                arguments: isRecord(launch.arguments) ? launch.arguments : undefined,
              },
            })
        : await resolveMcpAppResource({
            serverConfig: config,
            context,
            workspaceId: workspace.id,
            workspaceRoot: workspace.path,
            projectedToolName,
          });
      return jsonResponse({ app });
    } catch (error) {
      rethrowMcpAppHostError(error);
    }
  });

  addRoute(routes, "POST", "/workspace/:id/mcp-apps/call", "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const serverName = typeof body.serverName === "string" ? body.serverName.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const resourceUri = typeof body.resourceUri === "string" ? body.resourceUri.trim() : "";
    const expectedResourceDigest = body.expectedResourceDigest;
    if (expectedResourceDigest !== undefined && typeof expectedResourceDigest !== "string") {
      throw new ApiError(400, "invalid_resource_digest", "expectedResourceDigest must be a SHA-256 hex digest.");
    }
    const args = body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
      ? body.arguments as Record<string, unknown>
      : {};
    const approved = body.approved === true;
    // A cached read asks only whether this call is allowed now; it never runs the tool.
    const checkOnly = body.checkOnly === true;
    if (checkOnly && approved) throw new ApiError(400, "invalid_payload", "A check-only call cannot be approved.");
    const launchId = typeof body.launchId === "string" ? body.launchId : undefined;
    const sessionId = typeof body.sessionId === "string" || body.sessionId === null ? body.sessionId : undefined;
    if (!serverName || !name) throw new ApiError(400, "invalid_payload", "serverName and name are required");
    if (approved) requireClientScope(ctx, "collaborator");
    try {
      return jsonResponse(await callMcpAppTool({
        serverConfig: config,
        launchId,
        sessionId,
        workspaceId: workspace.id,
        workspaceRoot: workspace.path,
        serverName,
        name,
        resourceUri,
        expectedResourceDigest,
        arguments: args,
        approved,
        checkOnly,
        assertSessionActive: async () => {
          if (!sessionId) return;
          const connection = engineV2Preview.connection();
          if (!connection) throw new McpAppHostError("inactive_session", "The original conversation engine is unavailable. Reopen it before using App actions.");
          const url = new URL(`/api/session/${encodeURIComponent(sessionId)}`, connection.url);
          url.searchParams.set("location[directory]", workspace.path);
          const response = await loopbackFetch(url.toString(), {
            headers: { authorization: `Basic ${Buffer.from(`opencode:${connection.password}`).toString("base64")}` },
            signal: AbortSignal.timeout(10_000),
          });
          const payload: unknown = response.ok ? await response.json() : null;
          const data = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
          const session = isRecord(data) && isRecord(data.info) ? data.info : data;
          const location = isRecord(session) && isRecord(session.location) ? session.location : null;
          const directory = location && typeof location.directory === "string" ? location.directory : null;
          const [expected, actual] = await Promise.all([
            realpath(workspace.path).catch(() => workspace.path),
            directory ? realpath(directory).catch(() => directory) : null,
          ]);
          if (!isRecord(session) || (session.id ?? session.sessionID) !== sessionId || !actual || actual !== expected || (isRecord(session.time) && session.time.archived)) {
            throw new McpAppHostError("inactive_session", "The original conversation is archived or unavailable. Reopen it before using App actions.");
          }
        },
      }));
    } catch (error) {
      rethrowMcpAppHostError(error);
    }
  });

  addRoute(routes, "POST", "/workspace/:id/mcp-apps/release", "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    return jsonResponse({ released: typeof body.launchId === "string" && releaseMcpAppLaunch(config, workspace.id, body.launchId) });
  });

  addRoute(routes, "POST", "/workspace/:id/mcp/managed", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "").trim();
    validateUserMcpName(name);
    await managedDesktopPolicy(config).assertAgentPermission("mcp", name);
    const serverUrl = typeof body.url === "string" ? body.url.trim() : "";
    const oauth = body.oauth && typeof body.oauth === "object" && !Array.isArray(body.oauth)
      ? body.oauth as Record<string, unknown>
      : {};
    if (!serverUrl) throw new ApiError(400, "invalid_payload", "Managed MCP URL is required");
    const requestedScopes = Array.isArray(oauth.requestedScopes)
      ? oauth.requestedScopes.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0)
      : [];
    if ((await listMcp(config, workspace.id, workspace.path)).some((item) => item.name === name)) {
      throw new ApiError(409, "mcp_exists", `MCP ${name} already exists in this workspace`);
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.add",
      summary: `Add OpenWork-managed MCP ${name}`,
      paths: [openworkConfigPath(workspace.path)],
    });
    await createLocalManagedMcpConnection(config, {
      workspaceId: workspace.id,
      name,
      serverUrl,
      oauth: {
        applicationType: oauth.applicationType === "web" ? "web" : "native",
        requestedScopes,
        ...(typeof oauth.authorizationServerIssuer === "string" && oauth.authorizationServerIssuer.trim()
          ? { authorizationServerIssuer: oauth.authorizationServerIssuer.trim() }
          : {}),
        ...(typeof oauth.clientId === "string" && oauth.clientId.trim() ? { clientId: oauth.clientId.trim() } : {}),
        ...(typeof oauth.clientSecret === "string" && oauth.clientSecret.trim() ? { clientSecret: oauth.clientSecret.trim() } : {}),
      },
    });
    const result = await (async () => {
      try {
        return await startLocalManagedMcpAuthorization(config, workspace.id, name);
      } catch (error) {
        // Creation writes the encrypted connection and runtime facade before
        // OAuth discovery starts. If that first handshake fails, roll both back
        // so the failed Add request cannot leave a ghost connection behind.
        await deleteLocalManagedMcp(config, workspace.id, name).catch(() => undefined);
        if (error instanceof ApiError) throw error;
        const cause = (error instanceof Error ? error.message : String(error)).trim().slice(0, 300);
        throw new ApiError(
          502,
          "managed_mcp_connection_failed",
          `OpenWork could not start sign-in with this MCP server. Check the server URL, OAuth settings, and network connection, then try again.${cause ? ` (${cause})` : ""}`,
          cause ? { cause } : undefined,
        );
      }
    })();
    await engineV2Preview.syncWorkspaceMcp(workspace.id, workspace.path, { reconnect: [name] }).catch(() => undefined);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.add",
      target: openworkConfigPath(workspace.path),
      summary: `Added OpenWork-managed MCP ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", { type: "mcp", name, action: "added" });
    return jsonResponse(result, 201);
  });

  addRoute(routes, "GET", "/workspace/:id/mcp/:name/managed", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse(await getLocalManagedMcpConnection(config, workspace.id, ctx.params.name ?? ""));
  });

  addRoute(routes, "POST", "/workspace/:id/mcp/:name/managed/connect", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    validateMcpName(name);
    const result = await startLocalManagedMcpAuthorization(config, workspace.id, name);
    await engineV2Preview.syncWorkspaceMcp(workspace.id, workspace.path, { reconnect: [name] }).catch(() => undefined);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/mcp/oauth/callback", "none", async (ctx) => {
    const state = ctx.url.searchParams.get("state") ?? "";
    const code = ctx.url.searchParams.get("code") ?? "";
    if (!state || !code) throw new ApiError(400, "managed_mcp_oauth_callback_invalid", "OAuth callback is missing code or state");
    const { connection, workspaceId } = await completeLocalManagedMcpAuthorization(config, state, code, ctx.url.searchParams.get("iss") ?? undefined);
    const workspace = config.workspaces.find((item) => item.id === workspaceId);
    if (workspace) {
      await engineV2Preview.syncWorkspaceMcp(workspace.id, workspace.path, { reconnect: [connection.name] }).catch(() => undefined);
    }
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Connected</title><main style="font:16px system-ui;padding:40px;max-width:560px"><h1>Connected</h1><p>${connection.name} is ready in OpenWork. You can close this window.</p><script>setTimeout(()=>window.close(),1200)</script></main>`,
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  });

  const managedGatewayHandler = async (ctx: RequestContext) => handleLocalManagedMcpGateway(
    config,
    ctx.request,
    ctx.params.workspaceId ?? "",
    ctx.params.name ?? "",
  );
  addRoute(routes, "POST", "/mcp/managed/:workspaceId/:name", "none", managedGatewayHandler);
  addRoute(routes, "GET", "/mcp/managed/:workspaceId/:name", "none", managedGatewayHandler);
  addRoute(routes, "DELETE", "/mcp/managed/:workspaceId/:name", "none", managedGatewayHandler);

  addRoute(routes, "POST", "/workspace/:id/mcp", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    validateUserMcpName(name);
    await managedDesktopPolicy(config).assertAgentPermission("mcp", name);
    const configPayload = body.config as Record<string, unknown> | undefined;
    if (!configPayload) {
      throw new ApiError(400, "invalid_payload", "MCP config is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.add",
      summary: `Add MCP ${name}`,
      paths: [openworkConfigPath(workspace.path)],
    });
    const result = await addMcp(config, workspace.id, name, configPayload);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.add",
      target: openworkConfigPath(workspace.path),
      summary: `Added MCP ${name}`,
      timestamp: Date.now(),
    });
    await engineV2Preview.settleWorkspaceMcp(workspace.id, workspace.path, name);
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name,
      action: result.action,
    });
    const items = await listMcp(config, workspace.id, workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.remove",
      summary: `Remove MCP ${name}`,
      paths: [openworkConfigPath(workspace.path)],
    });
    const managedRemoved = name === OPENWORK_CLOUD_MCP_NAME
      ? false
      : await deleteLocalManagedMcp(config, workspace.id, name);
    const cloudRemoval = name === OPENWORK_CLOUD_MCP_NAME
      ? await removeOpenworkCloudMcpDesiredConfig(config)
      : null;
    const removed = cloudRemoval
      ? cloudRemoval.changed
      : managedRemoved || await removeMcp(config, workspace.id, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.remove",
      target: openworkConfigPath(workspace.path),
      summary: `Removed MCP ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      const affectedWorkspaces = cloudRemoval ? config.workspaces : [workspace];
      const removedNames = cloudRemoval ? cloudRemoval.removedNames : [name];
      await Promise.all(affectedWorkspaces.map(async (affectedWorkspace) => {
        for (const removedName of removedNames) {
          await engineV2Preview.settleWorkspaceMcp(affectedWorkspace.id, affectedWorkspace.path, removedName);
        }
      }));
      emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
        type: "mcp",
        name,
        action: "removed",
      });
    }
    const items = await listMcp(config, workspace.id, workspace.path);
    return jsonResponse({ items });
  });

  // Toggle `enabled` on a workspace MCP. Strict body validation — `Boolean(body.enabled)`
  // would silently disable on `{}` or coerce `"false"` to true.
  addRoute(routes, "POST", "/workspace/:id/mcp/:name/enabled", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const body = await readJsonBody(ctx.request);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
      throw new ApiError(400, "invalid_payload", "enabled must be a boolean");
    }
    const enabled = body.enabled;
    const action = enabled ? "mcp.enable" : "mcp.disable";
    const summary = `${enabled ? "Enable" : "Disable"} MCP ${name}`;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action,
      summary,
      paths: [openworkConfigPath(workspace.path)],
    });
    const managedUpdated = await setLocalManagedMcpEnabled(config, workspace.id, name, enabled);
    const updated = managedUpdated || await setMcpEnabled(config, workspace.id, name, enabled);
    if (!updated) {
      throw new ApiError(404, "mcp_not_found", `MCP ${name} not found in workspace config`);
    }
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action,
      target: openworkConfigPath(workspace.path),
      summary: `${enabled ? "Enabled" : "Disabled"} MCP ${name}`,
      timestamp: Date.now(),
    });
    await engineV2Preview.settleWorkspaceMcp(workspace.id, workspace.path, name);
    // ReloadTrigger.action only allows added/removed/updated, so toggle => "updated".
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name,
      action: "updated",
    });
    const items = await listMcp(config, workspace.id, workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name/auth", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    validateMcpName(name);

    if (await disconnectLocalManagedMcp(config, workspace.id, name)) {
      await requestEngine(engineV2Preview, workspace.path, `/api/experimental/mcp/${encodeURIComponent(name)}/disconnect`, "POST").catch(() => undefined);
      await engineV2Preview.syncWorkspaceMcp(workspace.id, workspace.path, { reconnect: [name] }).catch(() => undefined);
      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "remote" },
        action: "mcp.auth.remove",
        target: openworkConfigPath(workspace.path),
        summary: `Logged out OpenWork-managed MCP ${name}`,
        timestamp: Date.now(),
      });
      return jsonResponse({ ok: true });
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.auth.remove",
      summary: `Logout MCP ${name}`,
      paths: [],
    });

    // The engine stores an MCP server's sign-in as credentials of that
    // server's integration. Removing them is idempotent.
    const servers = await requestEngine(engineV2Preview, workspace.path, "/api/mcp");
    const server = isRecord(servers) && Array.isArray(servers.data)
      ? servers.data.find((entry) => isRecord(entry) && entry.name === name)
      : undefined;
    const integrationID = isRecord(server) && typeof server.integrationID === "string" ? server.integrationID : undefined;
    if (integrationID) {
      const integration = await requestEngine(engineV2Preview, workspace.path, `/api/integration/${encodeURIComponent(integrationID)}`);
      const info = isRecord(integration) && isRecord(integration.data) ? integration.data : integration;
      const connections = isRecord(info) && Array.isArray(info.connections) ? info.connections : [];
      for (const connection of connections) {
        if (!isRecord(connection) || connection.type !== "credential" || typeof connection.id !== "string") continue;
        await requestEngine(engineV2Preview, workspace.path, `/api/credential/${encodeURIComponent(connection.id)}`, "DELETE");
      }
    }
    // Best-effort disconnect so any active connection is torn down.
    await requestEngine(engineV2Preview, workspace.path, `/api/experimental/mcp/${encodeURIComponent(name)}/disconnect`, "POST").catch(() => undefined);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.auth.remove",
      target: openworkConfigPath(workspace.path),
      summary: `Logged out MCP ${name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/commands", "client", async (ctx) => {
    const scope = ctx.url.searchParams.get("scope") === "global" ? "global" : "workspace";
    if (scope === "global") {
      await requireHost(ctx.request, config, tokens);
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listCommands(workspace.path, scope);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/commands", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const template = String(body.template ?? "");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.upsert",
      summary: `Upsert command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    const path = await upsertCommand(workspace.path, {
      name,
      description: body.description ? String(body.description) : undefined,
      template,
      agent: body.agent ? String(body.agent) : undefined,
      model: body.model ? String(body.model) : undefined,
      subtask: typeof body.subtask === "boolean" ? body.subtask : undefined,
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.upsert",
      target: path,
      summary: `Upserted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "updated",
      path,
    });
    const items = await listCommands(workspace.path, "workspace");
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/commands/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.delete",
      summary: `Delete command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    await deleteCommand(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.delete",
      target: join(workspace.path, ".opencode", "commands"),
      summary: `Deleted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "removed",
      path: join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`),
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/export", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sensitiveMode = parseWorkspaceExportSensitiveMode(ctx.url.searchParams.get("sensitive"));
    const exportPayload = await exportWorkspace(config, workspace, { sensitiveMode });
    return jsonResponse(exportPayload);
  });

  return routes;
}

async function resolveWorkspaceForInspection(config: ServerConfig, id: string): Promise<WorkspaceInfo> {
  const workspaceId = id.trim();
  const workspace = config.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
  const resolvedWorkspace = resolve(workspace.path);
  const authorized = await isAuthorizedRoot(resolvedWorkspace, config.authorizedRoots);
  if (!authorized) {
    throw new ApiError(403, "workspace_unauthorized", "Workspace is not authorized");
  }
  return { ...workspace, path: resolvedWorkspace };
}

async function resolveWorkspaceWithoutBootstrap(config: ServerConfig, id: string): Promise<WorkspaceInfo> {
  const workspaceId = id.trim();
  const configuredWorkspace = config.workspaces.find((entry) => entry.id === workspaceId);
  if (!configuredWorkspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
  const resolvedWorkspace = resolve(configuredWorkspace.path);
  const authorized = await isAuthorizedRoot(resolvedWorkspace, config.authorizedRoots);
  if (!authorized) {
    throw new ApiError(403, "workspace_unauthorized", "Workspace is not authorized");
  }
  const workspace = { ...configuredWorkspace, path: resolvedWorkspace };
  return workspace;
}

async function resolveWorkspace(config: ServerConfig, id: string): Promise<WorkspaceInfo> {
  const workspace = await resolveWorkspaceWithoutBootstrap(config, id);
  const resolvedWorkspace = workspace.path;
  if (!config.readOnly) {
    const ensured = await ensureWorkspaceFiles(resolvedWorkspace, workspace.preset ?? "starter");
    const bootstrapReloadReasons = new Set<ReloadReason>(ensured.reloadReasons);
    if (await repairCommands(resolvedWorkspace)) {
      bootstrapReloadReasons.add("commands");
    }
    if (bootstrapReloadReasons.size > 0) {
      await reloadBaselineRefreshers.get(config)?.(workspace.id, Array.from(bootstrapReloadReasons));
    }
  }
  return workspace;
}

async function isAuthorizedRoot(workspacePath: string, roots: string[]): Promise<boolean> {
  const resolvedWorkspace = resolve(workspacePath);
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    if (resolvedWorkspace === resolvedRoot) return true;
    if (resolvedWorkspace.startsWith(resolvedRoot + sep)) return true;
  }
  return false;
}

function ensureWritable(config: ServerConfig): void {
  if (config.readOnly) {
    throw new ApiError(403, "read_only", "Server is read-only");
  }
}

function scopeRank(scope: TokenScope): number {
  if (scope === "viewer") return 1;
  if (scope === "collaborator") return 2;
  return 3;
}

function requireClientScope(ctx: RequestContext, required: TokenScope): void {
  const scope = ctx.actor?.scope;
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Missing token scope");
  }
  if (scopeRank(scope) < scopeRank(required)) {
    throw new ApiError(403, "forbidden", "Insufficient token scope", { required, scope });
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const json = await request.json();
    return json as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

async function readAgentDiagnosticsJsonBody(request: Request): Promise<unknown> {
  const tooLarge = () => new ApiError(
    413,
    "agent_diagnostics_request_too_large",
    "Agent diagnostics request body is too large",
  );
  const timedOut = () => new ApiError(
    408,
    "agent_diagnostics_request_timeout",
    "Agent diagnostics request body timed out",
  );
  const configuredDeadlineMs = Number(process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS);
  const deadlineMs = Number.isFinite(configuredDeadlineMs) && configuredDeadlineMs >= 50
    ? Math.min(configuredDeadlineMs, 10_000)
    : AGENT_DIAGNOSTICS_DEFAULT_BODY_DEADLINE_MS;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const declaredBytes = Number(declaredLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > AGENT_DIAGNOSTICS_MAX_REQUEST_BYTES) {
      throw tooLarge();
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let deadlineExpired = false;
  let activeRead: ReturnType<typeof reader.read> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      reject(timedOut());
    }, deadlineMs);
  });
  try {
    while (true) {
      // Race every read against the same promise. Incoming drips do not reset
      // the absolute request-body lifetime.
      activeRead = reader.read();
      const next = await Promise.race([activeRead, deadline]);
      activeRead = undefined;
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > AGENT_DIAGNOSTICS_MAX_REQUEST_BYTES) {
        throw tooLarge();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (deadlineExpired && activeRead) {
      const pendingRead = activeRead;
      let released = false;
      const release = () => {
        if (released) return;
        try {
          reader.releaseLock();
          released = true;
        } catch {
          // Cancellation owns the lock until the adapter finishes settling it.
        }
      };
      // Returning the 408 with Connection: close lets the adapter flush the
      // stable safe error before this active stream cancellation tears down the
      // underlying request socket. The absolute deadline is not extended.
      // Keep the reader locked until cancellation even if another drip settles
      // the specific read that lost the deadline race. Otherwise that drip
      // could leave the remainder of the body unbounded. Wait for both the
      // cancellation and outstanding read before releasing the lock.
      setTimeout(() => {
        void (async () => {
          await reader.cancel(new Error("Agent diagnostics request body timed out")).catch(() => undefined);
          await pendingRead.catch(() => undefined);
          release();
        })();
      }, AGENT_DIAGNOSTICS_ERROR_FLUSH_MS);
    } else {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

async function readOptionalJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return ensurePlainObject(JSON.parse(text));
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

function parseOptionalPositiveInteger(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ApiError(400, "invalid_query", `${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalNonNegativeInteger(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError(400, "invalid_query", `${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalBoolean(value: string | null, name: string): boolean | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ApiError(400, "invalid_query", `${name} must be a boolean`);
}

function ensurePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeOpencodeScope(value: string | null | undefined): "project" | "global" {
  return value?.trim().toLowerCase() === "global" ? "global" : "project";
}

export function resolveOpencodeConfigFilePath(scope: "project" | "global", workspaceRoot: string): string {
  if (scope === "global") return resolveGlobalOpencodeConfigPath();
  return opencodeConfigPath(workspaceRoot);
}

function getRuntimeControlConfig(): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.OPENWORK_CONTROL_BASE_URL?.trim() ?? "";
  const token = process.env.OPENWORK_CONTROL_TOKEN?.trim() ?? "";
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

async function fetchRuntimeControl(path: string, init?: { method?: string; body?: unknown }) {
  const control = getRuntimeControlConfig();
  if (!control) {
    throw new ApiError(501, "runtime_upgrade_unavailable", "Worker runtime control is not configured on this host");
  }
  const response = await externalFetch(`${control.baseUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${control.token}`,
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(response.status, "runtime_upgrade_failed", "Worker runtime control request failed", json);
  }
  return json;
}

async function readOpencodeConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>, { allowInvalid: true });
  return data;
}

async function readOpenworkConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const path = openworkConfigPath(workspaceRoot);
  if (!(await exists(path))) return {};
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse openwork.json");
  }
}

async function readOpenworkConfigForStatus(workspaceRoot: string): Promise<{
  data: Record<string, unknown>;
  error: string | null;
}> {
  try {
    return { data: await readOpenworkConfig(workspaceRoot), error: null };
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_json") {
      return { data: {}, error: error.message };
    }
    throw error;
  }
}

/**
 * Resolve the effective per-workspace openwork config from the runtime DB,
 * migrating a legacy `.opencode/openwork.json` file into the DB on first read.
 *
 * The DB is the source of truth. The file is only consulted to seed the DB
 * once (back-compat for workspaces created before the file->DB migration), and
 * is never written afterwards. Returns the merged view ({...file, ...db}) so a
 * partially-migrated install still surfaces every key.
 */
async function readOpenworkConfigForWorkspace(
  config: ServerConfig,
  workspace: WorkspaceInfo,
): Promise<Record<string, unknown>> {
  const stored = await readOpenworkWorkspaceConfig(config, workspace.id);
  if (Object.keys(stored).length > 0 || (await hasOpenworkWorkspaceConfig(config, workspace.id))) {
    return stored;
  }
  const legacy = await readOpenworkConfigForStatus(workspace.path);
  if (Object.keys(legacy.data).length === 0) {
    if (workspace.path.trim()) {
      return seedOpenworkWorkspaceConfigIfEmpty(
        config,
        workspace.id,
        defaultWorkspaceOpenworkConfig(workspace.path, workspace.preset ?? "starter"),
      );
    }
    return {};
  }
  // Migrate-on-read: copy the legacy file contents into the DB once.
  await seedOpenworkWorkspaceConfigIfEmpty(config, workspace.id, legacy.data);
  return mergeOpenworkWorkspaceConfigs(legacy.data, await readOpenworkWorkspaceConfig(config, workspace.id));
}

/**
 * Persist a full openwork config document for a workspace to the runtime DB.
 * Replaces the legacy file write path; the file is no longer written.
 */
async function writeOpenworkConfigForWorkspace(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  payload: Record<string, unknown>,
  merge: boolean,
): Promise<void> {
  await writeOpenworkWorkspaceConfig(config, workspace.id, (current) =>
    merge ? { ...current, ...payload } : payload,
  );
}

function resolveOpencodeDirectory(workspace: WorkspaceInfo): string | null {
  return workspace.path.trim() ? normalizeOpencodeDirectory(workspace.path) : null;
}

export function normalizeOpencodeDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // OpenCode stores/list-filters Windows sessions by regular drive paths
  // (`C:\Users\...`). Electron can persist local workspaces as extended-length
  // paths (`\\?\C:\Users\...`); passing those through as the directory query
  // makes OpenCode return an empty session list even though the sessions exist.
  if (platform === "win32") {
    return directory.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
  }
  return directory;
}

export type EngineActivityCount = {
  verdict: "idle" | "busy" | "unknown";
  busySessions: number;
  waitingRequests: number;
};

/**
 * Running conversations and unanswered permission or question requests on
 * the engine across this server's workspaces. `unknown` means a probe failed
 * or the engine is not running, so a caller that wants to interrupt the
 * instance must treat it as not idle.
 */
async function describeEngineActivity(
  config: ServerConfig,
  connection: { url: string; username: string; password: string } | undefined,
): Promise<EngineActivityCount> {
  if (config.workspaces.length === 0) return { verdict: "idle", busySessions: 0, waitingRequests: 0 };
  if (!connection) return { verdict: "unknown", busySessions: 0, waitingRequests: 0 };
  const authorization = `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`;
  const read = async (path: string, directory: string): Promise<unknown> => {
    const url = new URL(path, connection.url);
    url.searchParams.set("location[directory]", directory);
    const response = await loopbackFetch(url.toString(), {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Activity probe failed with status ${response.status}`);
    const payload: unknown = await response.json();
    return isRecord(payload) ? payload.data : undefined;
  };
  const running = new Set<string>();
  const waiting = new Set<string>();
  let unknown = false;
  await Promise.all(config.workspaces.map(async (workspace) => {
    try {
      const [active, permissions, forms] = await Promise.all([
        read("/api/session/active", workspace.path),
        read("/api/permission/request", workspace.path),
        read("/api/form", workspace.path),
      ]);
      if (!isRecord(active) || !Array.isArray(permissions) || !Array.isArray(forms)) {
        unknown = true;
        return;
      }
      for (const [id, status] of Object.entries(active)) {
        if (isRecord(status) && ["running", "busy", "retry"].includes(String(status.type))) running.add(id);
      }
      for (const item of [...permissions, ...forms]) {
        if (isRecord(item) && typeof item.id === "string") waiting.add(item.id);
      }
    } catch {
      unknown = true;
    }
  }));
  // A definite busy answer is authoritative even when another probe failed.
  return {
    verdict: running.size > 0 || waiting.size > 0 ? "busy" : unknown ? "unknown" : "idle",
    busySessions: running.size,
    waitingRequests: waiting.size,
  };
}

/**
 * The whole instance's activity, for a host (Den) deciding whether it may stop
 * or restart this sandbox. Busy wins over unknown, unknown wins over idle, so
 * a caller that fails closed never reads a half-answered probe as idle.
 */
export async function describeRuntimeActivity(
  config: ServerConfig,
  engine: Pick<EngineV2Preview, "connection">,
): Promise<{
  ok: true;
  verdict: "idle" | "busy" | "unknown";
  busySessions: number;
  waitingRequests: number;
  connectedClients: number;
  workspaces: number;
  checkedAt: string;
}> {
  const activity = await describeEngineActivity(config, engine.connection());
  return {
    ok: true,
    ...activity,
    connectedClients: engineEventClientsByConfig.get(config) ?? 0,
    workspaces: config.workspaces.length,
    checkedAt: new Date().toISOString(),
  };
}

async function requireApproval(
  ctx: RequestContext,
  input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
): Promise<void> {
  const actor = ctx.actor ?? { type: "remote" };
  const result = await ctx.approvals.requestApproval({ ...input, actor });
  if (!result.allowed) {
    throw new ApiError(403, "write_denied", "Write request denied", {
      requestId: result.id,
      reason: result.reason,
    });
  }
}

async function exportWorkspace(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  options?: { sensitiveMode?: WorkspaceExportSensitiveMode },
) {
  const sensitiveMode = options?.sensitiveMode ?? "auto";
  const rawOpencode = await readOpencodeConfig(workspace.path);
  let opencode = sanitizePortableOpencodeConfig(rawOpencode);
  const openwork = sanitizeOpenworkTemplateConfig(await readOpenworkConfigForWorkspace(config, workspace));
  const skills = await listSkills(workspace.path, false);
  const commands = await listCommands(workspace.path, "workspace");
  let files = await listPortableFiles(workspace.path);
  const warnings = collectWorkspaceExportWarnings({ opencode: rawOpencode, files });
  if (warnings.length && sensitiveMode === "auto") {
    throw new ApiError(
      409,
      "workspace_export_requires_decision",
      "This workspace includes sensitive config. Choose whether to exclude it or include it before exporting.",
      { warnings },
    );
  }
  if (sensitiveMode === "exclude") {
    const sanitized = stripSensitiveWorkspaceExportData({ opencode, files });
    opencode = sanitized.opencode;
    files = sanitized.files;
  }
  const skillContents = await Promise.all(
    skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      content: await readFile(skill.path, "utf8"),
    })),
  );
  const commandContents = await Promise.all(
    commands.map(async (command) => ({
      name: command.name,
      description: command.description,
      template: command.template,
    })),
  );

  return {
    workspaceId: workspace.id,
    exportedAt: Date.now(),
    opencode,
    openwork,
    skills: skillContents,
    commands: commandContents,
    ...(files.length ? { files } : {}),
  };
}

function parseWorkspaceExportSensitiveMode(input: string | null): WorkspaceExportSensitiveMode {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "auto";
  if (trimmed === "auto" || trimmed === "include" || trimmed === "exclude") {
    return trimmed;
  }
  throw new ApiError(400, "invalid_workspace_export_sensitive_mode", `Invalid workspace export sensitive mode: ${trimmed}`);
}
