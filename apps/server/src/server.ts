import { readFile, realpath, writeFile, rm, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { resolveGlobalOpencodeConfigPath } from "@openwork/paths";
import type { ApprovalRequest, Capabilities, ServerConfig, WorkspaceInfo, Actor, ReloadReason, ReloadTrigger, TokenScope } from "./types.js";
import { agentContextDiagnosticsRequestSchema } from "./agent-context-diagnostics-schema.js";
import { ApprovalService } from "./approvals.js";
import {
  BoundedSseFrameBuffer,
  EnginePool,
  enginePoolForConfig,
  isEngineConnectionFailure,
  setEnginePoolForConfig,
  type EnginePoolConnection,
  type EngineEventProxyLease,
  type EngineSpawnTemplate,
} from "./engine-pool.js";
import { withEngineDirectoryFence } from "./engine-directory-fence.js";
import {
  clearEngineInstanceReaperForConfig,
  EngineInstanceReaper,
  engineInstanceReaperForConfig,
  setEngineInstanceReaperForConfig,
  type TrackedEngineInstance,
} from "./engine-instance-reaper.js";
import { shouldDeferInPlaceEngineReload } from "./engine-reload-defer.js";
import { LatestTrailingWorkQueue } from "./latest-trailing-work-queue.js";
import { buildEngineAuthProbeHeader } from "./engine-registry.js";
import { addPlugin, listPlugins, normalizePluginSpec, removePlugin } from "./plugins.js";
import { sanitizePortableOpencodeConfig } from "./portable-opencode.js";
import { addMcp, listMcp, removeMcp, setMcpEnabled } from "./mcp.js";
import {
  callMcpAppTool,
  listMcpAppCatalog,
  McpAppHostError,
  resolveConnectMcpAppResource,
  resolveMcpAppResource,
  resolveSameServerMcpAppResource,
} from "./mcp-app-host.js";
import { CONNECT_MCP_SERVER_NAME_PREFIX } from "./connect-mcp-server-catalog.js";
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
import { opencodeConfigPath, openworkConfigPath, projectCommandsDir, projectSkillsDir } from "./workspace-files.js";
import { ensureDir, exists, hashToken, shortId } from "./utils.js";
import { defaultWorkspaceOpenworkConfig, ensureWorkspaceFiles, readRawOpencodeConfig } from "./workspace-init.js";
import { sanitizeCommandName, validateMcpName, validateUserMcpName } from "./validators.js";
import { TokenService } from "./tokens.js";
import { resetManagedProviderAuthCache, syncManagedProviderAuth } from "./managed-provider-auth.js";
import { EnvService } from "./env-file.js";
import {
  normalizeResourceSnapshot,
  readDesktopCloudSyncState,
  readWorkspaceCloudImports,
  syncDesktopCloudResources,
} from "./desktop-cloud-sync.js";
import { installCloudPlugin, readCloudPluginResolved, readInstalledCloudPlugins, removeCloudPlugin } from "./cloud-plugins.js";
import { resolveClaudePluginBundle } from "./claude-plugin-bundle.js";
import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import { listPortableFiles } from "./portable-files.js";
import {
  collectWorkspaceExportWarnings,
  sanitizeOpenworkTemplateConfig,
  stripSensitiveWorkspaceExportData,
  type WorkspaceExportSensitiveMode,
} from "./workspace-export-safety.js";
import { serve, type ServeResult } from "./serve-node.js";
import { serveStaticUi } from "./static-ui.js";
import { externalFetch, loopbackFetch } from "./server-fetch.js";
import { registerCoreRoutes } from "./routes/core.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerOperationRoutes } from "./routes/operations.js";
import { addRoute, matchRoute, type AuthMode, type RequestContext, type Route } from "./routes/registry.js";
import { registerSessionGroupRoutes } from "./routes/session-groups.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerCloudMcpRoutes } from "./routes/cloud-mcp.js";
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
import {
  markOpenworkCloudMcpStale,
  migrateOpenworkCloudMcpRuntimeConfig,
  OPENWORK_CLOUD_MCP_NAME,
  reconcilePersistedOpenworkCloudMcp,
  removeOpenworkCloudMcpDesiredConfig,
  type CloudMcpHealth,
} from "./cloud-mcp-health.js";
import { runAgentContextDiagnostics } from "./agent-context-diagnostics.js";
import { createAgentDiagnosticsEngineFetch } from "./agent-context-engine-inspection.js";
import { sanitizeDiagnosticString } from "./diagnostic-sanitizer.js";
import {
  mergeOpencodeConfigs,
  mergeRuntimeProviderUpdate,
  migrateWorkspaceRuntimeConfigToEngineGlobal,
  readEffectiveRuntimeOpencodeConfig,
  readGlobalRuntimeOpencodeConfig,
  readRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeMcpMap,
  runtimeProviderMap,
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
import { buildOpenworkRuntimeConfigObject, openworkRuntimeConfigFilePath, writeOpenworkRuntimeConfigFile } from "./openwork-runtime-config.js";
import { findManagedEngineWorkspace } from "./workspaces.js";
import { CloudProviderSync, parseCloudProviderDenSession } from "./cloud-provider-sync.js";
import pkg from "../package.json" with { type: "json" };
import constants from "../../../constants.json" with { type: "json" };

export {
  isSupportedWorkspaceTextFilePath,
  normalizeWorkspaceRelativePath,
  resolveWorkspaceArtifactTargets,
} from "./routes/files.js";

const SERVER_VERSION = pkg.version;
const OPENCODE_VERSION = constants.opencodeVersion.trim().replace(/^v/, "");

const OPENWORK_VOICE_REALTIME_MODEL = "gpt-realtime-2";
const OPENWORK_VOICE_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
let desktopCloudSyncQueue: Promise<void> = Promise.resolve();
const agentDiagnosticsLastRunByServer = new WeakMap<ServerConfig, Map<string, number>>();
const agentDiagnosticsInFlightByServer = new WeakMap<ServerConfig, Set<string>>();
const commandAdmissionsByServer = new WeakMap<ServerConfig, Map<string, { fingerprint: string; admittedAt: number }>>();
const AGENT_DIAGNOSTICS_RATE_LIMIT_CAPACITY = 1_000;
const AGENT_DIAGNOSTICS_MAX_IN_FLIGHT_PER_SERVER = 16;
const AGENT_DIAGNOSTICS_MAX_REQUEST_BYTES = 256 * 1024;
const AGENT_DIAGNOSTICS_DEFAULT_BODY_DEADLINE_MS = 2_000;
const AGENT_DIAGNOSTICS_ERROR_FLUSH_MS = 25;
const COMMAND_ADMISSION_CAPACITY = 10_000;
const COMMAND_ADMISSION_TTL_MS = 24 * 60 * 60 * 1_000;

function rethrowMcpAppHostError(error: unknown): never {
  if (!(error instanceof McpAppHostError)) throw error;
  const status = error.code === "invalid_tool_name" || error.code.startsWith("invalid_resource")
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

const OPENWORK_VOICE_REALTIME_TOOLS = [
  {
    type: "function",
    name: "openwork_snapshot",
    description: "Read the current OpenWork UI control snapshot: route, status, narration, and visible action metadata.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "openwork_list_actions",
    description: "List semantic OpenWork UI actions. Call this before openwork_execute_action when you do not know the exact action id.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "openwork_execute_action",
    description: "Execute a semantic OpenWork UI action by id. Prefer this over screen coordinates or DOM guessing.",
    parameters: {
      type: "object",
      properties: {
        actionId: { type: "string", description: "The action id from openwork_list_actions, such as composer.set_text or composer.send." },
        args: { type: "object", description: "Optional JSON arguments for the action.", additionalProperties: true },
      },
      required: ["actionId"],
      additionalProperties: false,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
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

function resolveEngineRuntimeWorkspace(config: ServerConfig): WorkspaceInfo {
  const workspace = findManagedEngineWorkspace(config.workspaces) ?? config.workspaces[0];
  if (!workspace) {
    throw new ApiError(400, "workspace_missing", "At least one workspace is required for engine runtime config");
  }
  return workspace;
}

function redactBearerTokens(value: string): string {
  return value.replace(/Bearer\s+\S+/g, "Bearer [redacted]");
}

function redactManagedRuntimeValue(value: unknown, path: string[], insideMcpHeaders: boolean): unknown {
  if (typeof value === "string") return insideMcpHeaders ? "[redacted]" : redactBearerTokens(value);
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactManagedRuntimeValue(entry, [...path, String(index)], insideMcpHeaders));
  }
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      const childInsideMcpHeaders = insideMcpHeaders || (path.length === 2 && path[0] === "mcp" && key === "headers");
      return [key, redactManagedRuntimeValue(child, [...path, key], childInsideMcpHeaders)];
    }),
  );
}

function redactManagedRuntimeConfigContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    return JSON.stringify(redactManagedRuntimeValue(parsed, [], false), null, 2);
  } catch {
    return redactBearerTokens(content);
  }
}

async function readManagedRuntimeConfigDebug(config: ServerConfig): Promise<{
  managedFilePath: string;
  managedFileRebuiltAt: number | null;
  managedFileContentRedacted: string | null;
}> {
  const managedFilePath = openworkRuntimeConfigFilePath(config);
  try {
    const [metadata, content] = await Promise.all([
      stat(managedFilePath),
      readFile(managedFilePath, "utf8"),
    ]);
    return {
      managedFilePath,
      managedFileRebuiltAt: metadata.mtimeMs,
      managedFileContentRedacted: redactManagedRuntimeConfigContent(content),
    };
  } catch {
    return { managedFilePath, managedFileRebuiltAt: null, managedFileContentRedacted: null };
  }
}

function userOpencodeConfigKeys(config: Record<string, unknown>): string[] {
  return Object.keys(config).filter((key) => key !== "$schema").sort();
}

async function resolveOpenAiRealtimeApiKey(env: EnvService): Promise<string> {
  const records = await env.list();
  const storedKey =
    records.find((entry) => entry.key === "OPENAI_REALTIME_API_KEY")?.value.trim() ||
    records.find((entry) => entry.key === "OPENAI_API_KEY")?.value.trim() ||
    "";
  if (storedKey) return storedKey;

  return process.env.OPENWORK_OPENAI_REALTIME_API_KEY?.trim() ||
    process.env.OPENAI_REALTIME_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
}

async function resolveOpenWorkModelsVoiceConfig(env: EnvService): Promise<{ baseUrl: string; apiKey: string } | null> {
  const records = await env.list();
  const apiKey =
    records.find((entry) => entry.key === "OPENWORK_API_KEY")?.value.trim() ||
    records.find((entry) => entry.key === "OPENWORK_MODELS_API_KEY")?.value.trim() ||
    process.env.OPENWORK_API_KEY?.trim() ||
    process.env.OPENWORK_MODELS_API_KEY?.trim() ||
    "";
  if (!apiKey) return null;

  const baseUrl =
    records.find((entry) => entry.key === "OPENWORK_INFERENCE_BASE_URL")?.value.trim() ||
    records.find((entry) => entry.key === "OPENWORK_MODELS_BASE_URL")?.value.trim() ||
    process.env.OPENWORK_INFERENCE_BASE_URL?.trim() ||
    process.env.OPENWORK_MODELS_BASE_URL?.trim() ||
    "";
  if (!baseUrl) return null;
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}

function openworkVoiceRealtimeInstructions(sessionContext: string) {
  const trimmedContext = sessionContext.trim();
  const contextSection = trimmedContext
    ? `

# Current Session Context

Use this recent transcript context to answer questions about what was last discussed and to resolve references such as "this" or "that" when continuing the existing session. Do not treat it as a new user request.

${trimmedContext}`
    : "";
  return `# Role and Objective

You are OpenWork Voice Mode, a voice-first control layer inside OpenWork.
Help the user control OpenWork by using the semantic OpenWork UI tools.

# Tool Policy

- Prefer openwork_snapshot, openwork_list_actions, and openwork_execute_action over visual guessing.
- If the user asks to write or draft something, use composer.set_text.
- If the user asks to send or run the current prompt, use composer.send.
- For navigation, settings, session, transcript, and composer work, inspect the action list first if the action id is unknown.
- Do not claim an action completed until the tool succeeds.
- Ask for confirmation before destructive actions such as deleting a session.

# Voice Style

- Be concise, calm, and direct.
- If audio is unclear, ask the user to repeat it instead of guessing.
- Ignore background speech that is not addressed to OpenWork.
- Summarize tool results briefly and offer the next useful step.${contextSection}`;
}

function enqueueDesktopCloudSync<T>(operation: () => Promise<T>): Promise<T> {
  const run = desktopCloudSyncQueue.then(operation);
  desktopCloudSyncQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function readOpenAiClientSecret(payload: unknown): { clientSecret: string; expiresAt: number | null } {
  if (!isRecord(payload)) return { clientSecret: "", expiresAt: null };
  const clientSecret = payload.client_secret;
  if (typeof clientSecret === "string") return { clientSecret, expiresAt: null };
  if (isRecord(clientSecret)) {
    const value = typeof clientSecret.value === "string" ? clientSecret.value : "";
    const expiresAt = typeof clientSecret.expires_at === "number" ? clientSecret.expires_at : null;
    return { clientSecret: value, expiresAt };
  }
  const value = typeof payload.value === "string" ? payload.value : "";
  return { clientSecret: value, expiresAt: null };
}

async function createOpenAiRealtimeVoiceSession(env: EnvService, input: unknown) {
  const managedVoice = await resolveOpenWorkModelsVoiceConfig(env);
  if (managedVoice) {
    try {
      return await createManagedVoiceSession(managedVoice, input);
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        const fallbackKey = await resolveOpenAiRealtimeApiKey(env);
        if (fallbackKey) {
          console.warn("[voice] OpenWork Models broker returned 503 — falling back to direct OpenAI Realtime.");
          return createDirectOpenAiVoiceSession(fallbackKey, input);
        }
        throw new ApiError(
          503,
          "openwork_models_voice_unavailable",
          "OpenWork Models voice is active but the server is not fully configured. Ask your admin to add an OpenAI key, or save your own OPENAI_API_KEY in Environment settings.",
        );
      }
      throw error;
    }
  }

  const apiKey = await resolveOpenAiRealtimeApiKey(env);
  if (!apiKey) {
    throw new ApiError(
      400,
      "openai_api_key_missing",
      "OpenAI API key missing. Save OPENAI_API_KEY in OpenWork Environment Variables or configure the Voice Mode extension.",
    );
  }

  return createDirectOpenAiVoiceSession(apiKey, input);
}

async function createManagedVoiceSession(config: { baseUrl: string; apiKey: string }, input: unknown) {
  const response = await externalFetch(`${config.baseUrl}/voice/realtime/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input ?? {}),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const errorPayload = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const message = typeof errorPayload?.message === "string" ? errorPayload.message : response.statusText;
    throw new ApiError(response.status, "openwork_models_voice_failed", message || "OpenWork Models could not create a voice session");
  }
  if (
    !isRecord(payload) ||
    payload.ok !== true ||
    typeof payload.clientSecret !== "string" ||
    typeof payload.model !== "string" ||
    !Array.isArray(payload.tools) ||
    payload.tools.some((tool) => typeof tool !== "string")
  ) {
    throw new ApiError(502, "openwork_models_voice_invalid_response", "OpenWork Models did not return a usable Realtime session payload");
  }
  return {
    ok: true,
    clientSecret: payload.clientSecret,
    expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : null,
    model: payload.model,
    transcriptionModel: typeof payload.transcriptionModel === "string" ? payload.transcriptionModel : OPENWORK_VOICE_TRANSCRIPTION_MODEL,
    tools: payload.tools,
    ...(typeof payload.source === "string" ? { source: payload.source } : {}),
  };
}

async function createDirectOpenAiVoiceSession(apiKey: string, input: unknown) {
  const model = readStringField(input, "model") || OPENWORK_VOICE_REALTIME_MODEL;
  const sessionContext = readStringField(input, "sessionContext").slice(0, 6_000);
  const response = await externalFetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        output_modalities: ["audio"],
        audio: {
          input: {
            transcription: { model: OPENWORK_VOICE_TRANSCRIPTION_MODEL, language: "en" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.58,
              silence_duration_ms: 320,
              prefix_padding_ms: 300,
              create_response: true,
              interrupt_response: true,
            },
          },
        },
        instructions: openworkVoiceRealtimeInstructions(sessionContext),
        tool_choice: "auto",
        tools: OPENWORK_VOICE_REALTIME_TOOLS,
      },
    }),
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorPayload = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const message = typeof errorPayload?.message === "string" ? errorPayload.message : response.statusText;
    throw new ApiError(response.status, "openai_realtime_failed", message || "Failed to create OpenAI Realtime session");
  }

  const { clientSecret, expiresAt } = readOpenAiClientSecret(payload);
  if (!clientSecret) {
    throw new ApiError(502, "openai_realtime_invalid_response", "OpenAI did not return a usable Realtime client secret");
  }

  return {
    ok: true,
    clientSecret,
    expiresAt,
    model,
    transcriptionModel: OPENWORK_VOICE_TRANSCRIPTION_MODEL,
    tools: OPENWORK_VOICE_REALTIME_TOOLS.map((tool) => tool.name),
  };
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

function isBrokenLogPipeError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED";
}

let stdoutLogWritesDisabled = false;
let stdoutErrorHandlerInstalled = false;

function ensureStdoutErrorHandler() {
  if (stdoutErrorHandlerInstalled) return;
  stdoutErrorHandlerInstalled = true;
  process.stdout.on("error", (error: unknown) => {
    if (isBrokenLogPipeError(error)) {
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

export function createServerLogger(config: ServerConfig, writeLine: ServerLogWriter = writeStdoutLogLine): ServerLogger {
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
      if (isBrokenLogPipeError(error)) {
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
    const merged = { ...baseAttributes, ...(attributes ?? {}) };
    if (config.logFormat === "json") {
      const record = {
        timeUnixNano: toUnixNano(),
        severityText: level.toUpperCase(),
        severityNumber: LOG_LEVEL_NUMBERS[level],
        body: message,
        attributes: merged,
        resource,
      };
      writeLogLine(JSON.stringify(record));
      return;
    }
    writeLogLine(message);
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

function parseWorkspaceOpencodeMount(pathname: string): { workspaceId: string; restPath: string } | null {
  if (!pathname.startsWith("/workspace/")) return null;
  const remainder = pathname.slice("/workspace/".length);
  if (!remainder) return null;
  const slash = remainder.indexOf("/");
  if (slash === -1) return null;
  const workspaceId = remainder.slice(0, slash);
  const restPath = remainder.slice(slash) || "/";
  if (!workspaceId.trim()) return null;
  if (restPath !== "/opencode" && !restPath.startsWith("/opencode/")) return null;
  return { workspaceId: decodeURIComponent(workspaceId), restPath };
}

function normalizeOpencodeProxyPath(proxyPath: string): string {
  const raw = (proxyPath ?? "").trim() || "/";
  const withoutPrefix = raw.startsWith("/opencode") ? raw.slice("/opencode".length) : raw;
  const normalized = (withoutPrefix || "/").replace(/\/+$/, "");
  return normalized || "/";
}

function proxiedSessionReadId(method: string, proxyPath: string): string | null {
  if (method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") return null;
  const match = normalizeOpencodeProxyPath(proxyPath).match(/^\/(?:api\/)?session\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return null;
  let sessionId = match[1];
  try {
    sessionId = decodeURIComponent(sessionId);
  } catch {
    // Let OpenCode answer malformed identifiers without weakening the gate for valid IDs.
  }
  return sessionId === "status" ? null : sessionId;
}

async function assertWorkspaceOwnsProxiedSessionRead(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  method: string,
  proxyPath: string,
): Promise<void> {
  const sessionId = proxiedSessionReadId(method, proxyPath);
  const directory = resolveOpencodeDirectory(workspace);
  if (!sessionId || !directory) return;

  const result = await createWorkspaceOpencodeClient(config, workspace, { sessionId }).session.get({ sessionID: sessionId });
  if (result.error !== undefined) {
    if (result.response?.status === 404) {
      throw new ApiError(404, "session_not_found", "Session not found");
    }
    throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
      ...(result.response ? { status: result.response.status } : {}),
      body: result.error,
      path: `/session/${encodeURIComponent(sessionId)}`,
    });
  }

  const sessionDirectory = result.data?.directory?.trim();
  const [expectedDirectory, actualDirectory] = workspace.workspaceType === "local" && sessionDirectory
    ? await Promise.all([
        realpath(directory).catch(() => directory),
        realpath(sessionDirectory).catch(() => sessionDirectory),
      ])
    : [directory, sessionDirectory];
  if (!actualDirectory || actualDirectory !== expectedDirectory) {
    throw new ApiError(404, "session_not_found", "Session not found");
  }
}

export function assertOpencodeProxyAllowed(actor: Actor, method: string, proxyPath: string) {
  const m = method.toUpperCase();
  const scope = actor.scope ?? "viewer";

  if (scope === "viewer" && m !== "GET" && m !== "HEAD") {
    throw new ApiError(403, "forbidden", "Viewer tokens are read-only");
  }

  // Prevent viewers from self-approving OpenCode permission requests via the
  // proxy. OpenCode uses /permission/:requestId/reply (and historically also
  // a session-scoped variant). Collaborators must be allowed: the SPA's only
  // credential is the collaborator-scoped client token (OPENWORK_TOKEN), so
  // an owner-only gate made every interactive permission dialog un-answerable
  // (403 "Only owner tokens can reply") and left tool calls stuck in
  // "running" forever (#1918).
  if (scope === "viewer" && m !== "GET" && m !== "HEAD") {
    const normalized = normalizeOpencodeProxyPath(proxyPath);
    if (/\/permission\/[^/]+\/reply$/.test(normalized)) {
      throw new ApiError(403, "forbidden", "Viewer tokens cannot reply to permission requests");
    }
  }
}

function isSessionCommandProxyRequest(method: string, proxyPath: string) {
  return method === "POST" && /^\/session\/[^/]+\/command$/.test(normalizeOpencodeProxyPath(proxyPath));
}

function commandAdmissionFromBody(body: ArrayBuffer | undefined): { messageId: string; fingerprint: string } | null {
  if (!body) return null;
  const text = new TextDecoder().decode(body);
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || typeof value.messageID !== "string" || !value.messageID.trim()) return null;
    return { messageId: value.messageID.trim(), fingerprint: hashToken(text) };
  } catch {
    return null;
  }
}

function admitSessionCommand(
  config: ServerConfig,
  scope: string,
  admission: { messageId: string; fingerprint: string },
): "accepted" | "duplicate" | "conflict" {
  const now = Date.now();
  const admissions = commandAdmissionsByServer.get(config) ?? new Map<string, { fingerprint: string; admittedAt: number }>();
  commandAdmissionsByServer.set(config, admissions);
  for (const [key, value] of admissions) {
    if (now - value.admittedAt <= COMMAND_ADMISSION_TTL_MS) break;
    admissions.delete(key);
  }

  const key = hashToken(`${scope}\0${admission.messageId}`);
  const existing = admissions.get(key);
  if (existing) return existing.fingerprint === admission.fingerprint ? "duplicate" : "conflict";

  if (admissions.size >= COMMAND_ADMISSION_CAPACITY) {
    const oldest = admissions.keys().next().value;
    if (oldest) admissions.delete(oldest);
  }
  admissions.set(key, { fingerprint: admission.fingerprint, admittedAt: now });
  return "accepted";
}

function isPromptAsyncProxyRequest(method: string, proxyPath: string) {
  return method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(normalizeOpencodeProxyPath(proxyPath));
}

export async function startServer(config: ServerConfig): Promise<ServeResult> {
  const approvals = new ApprovalService(config.approval);
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
  const engineMcpServerState = beginEngineMcpServerState(config);
  const engineInstanceReaper = new EngineInstanceReaper({
    // Only the managed engine is swept: the pool exists exactly when this
    // server owns the engine process. An attached engine may serve other
    // clients, so its per-directory instances are not ours to trim.
    engineBaseUrl: () => enginePoolForConfig(config)?.primaryUrl() ?? null,
    activeDirectory: () => {
      const active = config.workspaces[0];
      return active ? resolveOpencodeDirectory(active) : null;
    },
    directoryBusy: (instance) => engineInstanceHasActiveSessions(config, instance),
    dispose: (instance) => disposeIdleEngineInstance(config, engineMcpServerState, instance),
    logger,
  });
  setEngineInstanceReaperForConfig(config, engineInstanceReaper);
  const cloudProviderSync = new CloudProviderSync({
    config,
    env,
    reloadEngine: () => reloadOpencodeEngine(
      config,
      resolveEngineRuntimeWorkspace(config),
      engineMcpServerState,
      { forceStandby: true },
    ),
    engineBusy: () => enginePoolForConfig(config)
      ? Promise.resolve(false)
      : engineHasActiveSessions(config, resolveEngineRuntimeWorkspace(config)),
    logger: toManagedProviderAuthLogger(logger),
  });
  const routes = createRoutes(
    config,
    approvals,
    tokens,
    env,
    restartReloadWatchers,
    engineMcpServerState,
    logger,
    cloudProviderSync,
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

      const proxyWorkspaceOpencodeMount = async (mount: { workspaceId: string; restPath: string }) => {
        authMode = "client";
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method, mount.restPath);
          const workspace = await resolveWorkspaceWithoutBootstrap(config, mount.workspaceId);
          await assertWorkspaceOwnsProxiedSessionRead(config, workspace, request.method, mount.restPath);
          proxyService = "opencode";
          proxyBaseUrl = workspace.baseUrl?.trim() || undefined;
          const response = await proxyOpencodeRequest({ config, request, url, workspace, proxyPath: mount.restPath });
          return finalize(response);
        } catch (error) {
          const requestCanceled = isExpectedRequestCancellation(error, request.signal);
          if (!(error instanceof ApiError) && !requestCanceled) {
            captureServerException(error, { method: request.method, route: "/workspace/:id/opencode/*", requestSignal: request.signal });
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

      const canonicalOpencodeMount = parseWorkspaceOpencodeMount(url.pathname);
      if (canonicalOpencodeMount) {
        return proxyWorkspaceOpencodeMount(canonicalOpencodeMount);
      }

      const mount = parseWorkspaceMount(url.pathname);
      if (mount && (mount.restPath === "/opencode" || mount.restPath.startsWith("/opencode/"))) {
        return proxyWorkspaceOpencodeMount(mount);
      }

      // Allow clients to use a mounted base URL (e.g. http://host:8787/w/<id>) while
      // still calling the existing /workspace/:id/* API surface.
      // Example: baseUrl + "/workspace/<id>/plugins" => "/w/<id>/workspace/<id>/plugins".
      // We strip the mount prefix and route-match on the rest path.
      //
      // Important: when using a mounted base URL, enforce that the nested /workspace/:id
      // matches the mount workspace id to preserve the "single-workspace" mental model.
      if (mount && mount.restPath.startsWith("/workspace/")) {
        const match = mount.restPath.match(/^\/workspace\/([^/]+)/);
        const nestedId = match?.[1] ? decodeURIComponent(match[1]) : null;
        if (nestedId && nestedId !== mount.workspaceId) {
          errorMessage = "not_found";
          return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
        }
        url.pathname = mount.restPath;
      }

      if (url.pathname === "/opencode" || url.pathname.startsWith("/opencode/")) {
        authMode = "client";
        proxyBaseUrl = config.workspaces[0]?.baseUrl?.trim() || undefined;
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method, url.pathname);
          proxyService = "opencode";
          const workspace = config.workspaces[0];
          if (workspace) {
            await assertWorkspaceOwnsProxiedSessionRead(config, workspace, request.method, url.pathname);
          }
          const response = await proxyOpencodeRequest({ config, request, url, workspace });
          return finalize(response);
        } catch (error) {
          const requestCanceled = isExpectedRequestCancellation(error, request.signal);
          if (!(error instanceof ApiError) && !requestCanceled) {
            captureServerException(error, { method: request.method, route: "/opencode/*", requestSignal: request.signal });
          }
          const apiError = error instanceof ApiError
            ? error
            : requestCanceled
              ? new ApiError(499, "request_aborted", "Request was canceled")
              : new ApiError(500, "internal_error", "Unexpected server error");
          recordApiError(apiError);
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
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
              : route.auth === "client"
                ? await requireClient(request, config, tokens)
                : undefined;
        const response = await route.handler({
          request,
          url,
          params: route.params,
          config,
          approvals,
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
    server = await serve({
      ...serverOptions,
      idleTimeout: 120,
    });
  } catch (error) {
    captureServerException(error, { method: "START", route: "startServer" });
    cloudProviderSync.stop();
    engineInstanceReaper.close();
    clearEngineInstanceReaperForConfig(config);
    invalidateEngineMcpServerState(config, engineMcpServerState);
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

  // Deliver server-managed provider credentials to the engine on startup. The
  // engine process receives a fixed env allowlist, so credentials materialized
  // into the env store only reach it through the engine's auth API. A delivered
  // credential also invalidates any SDK client the engine cached before auth
  // arrived; the sync coordinator lands that reload without interrupting a
  // live session.
  resetManagedProviderAuthCache();
  void syncManagedProviderAuth({ config, env, logger: toManagedProviderAuthLogger(logger) })
    .then((result) => {
      if (result.delivered.length > 0 || result.removed.length > 0) {
        cloudProviderSync.markReloadPending();
      }
    })
    .catch(() => undefined);

  engineInstanceReaper.start();

  return {
    ...server,
    stop: async () => {
      cloudProviderSync.stop();
      engineInstanceReaper.close();
      clearEngineInstanceReaperForConfig(config);
      invalidateEngineMcpServerState(config, engineMcpServerState);
      watcherHandle.close();
      reloadBaselineRefreshers.delete(config);
      await server.stop();
    },
  };
}

function buildOpencodeProxyUrl(baseUrl: string, path: string, search: string) {
  const target = new URL(baseUrl);
  const trimmedPath = path.replace(/^\/opencode/, "");
  target.pathname = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  target.search = search;
  return target.toString();
}

function opencodeUnreachableError(error: unknown, path: string): ApiError {
  return new ApiError(502, "opencode_unreachable", "OpenCode engine is unavailable", {
    path,
    cause: error instanceof Error ? error.message : String(error),
  });
}

function agentDiagnosticsTimeoutMs(): number {
  const configured = Number(process.env.OPENWORK_AGENT_DIAGNOSTICS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 24_000;
}

function buildOpencodeDirectoryHeader(directory: string) {
  return /[^\x00-\x7F]/.test(directory) ? encodeURIComponent(directory) : directory;
}

export function scopeWorkspaceOpencodeRequest(
  headers: Headers,
  search: string,
  directory: string | null,
): { headers: Headers; search: string } {
  const scopedHeaders = new Headers(headers);
  scopedHeaders.delete("x-opencode-directory");

  const searchParams = new URLSearchParams(search);
  searchParams.delete("directory");

  if (directory) {
    scopedHeaders.set("x-opencode-directory", buildOpencodeDirectoryHeader(directory));
    searchParams.set("directory", directory);
  }

  const scopedSearch = searchParams.toString();
  return {
    headers: scopedHeaders,
    search: scopedSearch ? `?${scopedSearch}` : "",
  };
}

function createOpencodeDirectoryFetch(directory: string, fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  return Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const headers = new Headers(init?.headers ?? request.headers);
      headers.set("x-opencode-directory", buildOpencodeDirectoryHeader(directory));
      return fetchImpl(new Request(request, { headers }));
    },
    { preconnect: fetchImpl.preconnect },
  );
}

type OpencodeClientResult<T, E> =
  | { data: T | undefined; error: undefined; response: Response }
  | { data: undefined; error: E; response?: Response };

export function createWorkspaceOpencodeClient(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  options?: { boundedDiagnosticsReads?: boolean; sessionId?: string },
) {
  const poolRoute = workspace.workspaceType === "remote" || !options?.sessionId
    ? null
    : enginePoolForConfig(config)?.routeRequest("GET", `/session/${encodeURIComponent(options.sessionId)}`) ?? null;
  const connection = poolRoute
    ? {
        baseUrl: poolRoute.target.baseUrl,
        authHeader: buildEngineAuthProbeHeader(poolRoute.target.username, poolRoute.target.password),
      }
    : resolveWorkspaceOpencodeConnection(config, workspace);
  const baseUrl = connection.baseUrl?.trim();
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace", {
      workspaceId: workspace.id,
      workspaceType: workspace.workspaceType,
    });
  }
  const directory = resolveOpencodeDirectory(workspace);
  touchEngineWorkspaceInstance(config, workspace, baseUrl);
  const baseFetch = directory ? createOpencodeDirectoryFetch(directory) : globalThis.fetch;
  const clientFetch = options?.boundedDiagnosticsReads
    ? createAgentDiagnosticsEngineFetch(baseFetch)
    : directory ? baseFetch : undefined;

  return createOpencodeClient({
    baseUrl,
    ...(directory ? { directory } : {}),
    ...(clientFetch ? { fetch: clientFetch } : {}),
    ...(connection.authHeader ? { headers: { Authorization: connection.authHeader } } : {}),
  });
}

export function unwrapOpencodeResult<T, E>(result: OpencodeClientResult<T, E>, path: string): NonNullable<T> {
  if (result.data != null) {
    return result.data;
  }
  if (result.error === undefined) {
    throw new ApiError(502, "opencode_empty_response", "OpenCode returned an empty response", { path });
  }
  if (!result.response) {
    throw new ApiError(502, "opencode_unreachable", "OpenCode request failed before a response was received", {
      body: result.error,
      path,
    });
  }
  throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
    status: result.response.status,
    body: result.error,
    path,
  });
}

export async function proxyOpencodeRequest(input: {
  config: ServerConfig;
  request: Request;
  url: URL;
  workspace?: WorkspaceInfo;
  proxyPath?: string;
}) {
  const workspace = input.workspace;
  const proxyPath = input.proxyPath ?? input.url.pathname;
  const method = input.request.method.toUpperCase();
  // The wrapper routes enforced the server read-only mode via ensureWritable;
  // native proxy writes must honor the same guard so a read-only server never
  // forwards mutations to the engine.
  if (method !== "GET" && method !== "HEAD") {
    ensureWritable(input.config);
  }
  const pool = workspace?.workspaceType === "remote" ? null : enginePoolForConfig(input.config);
  const route = pool?.routeRequest(method, proxyPath) ?? null;
  const baseUrl = route?.target.baseUrl ??
    (workspace ? resolveWorkspaceOpencodeConnection(input.config, workspace).baseUrl?.trim() ?? "" : "");
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  let headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("x-openwork-host-token");
  headers.delete("x-openwork-client-id");
  headers.delete("host");
  headers.delete("origin");

  const directory = workspace ? resolveOpencodeDirectory(workspace) : null;
  let search = input.url.search;
  if (workspace) {
    const scoped = scopeWorkspaceOpencodeRequest(headers, search, directory);
    headers = scoped.headers;
    search = scoped.search;
  }

  const auth = route
    ? buildEngineAuthProbeHeader(route.target.username, route.target.password)
    : workspace ? resolveWorkspaceOpencodeConnection(input.config, workspace).authHeader ?? null : null;
  if (auth) {
    headers.set("Authorization", auth);
  }

  if (workspace) touchEngineWorkspaceInstance(input.config, workspace, baseUrl);

  // Buffer the request body so it can be forwarded reliably across Node.js
  // stream boundaries (Readable.toWeb streams from the HTTP adapter aren't
  // always accepted directly by Node's global fetch as a body).
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await input.request.arrayBuffer().then((buf) => (buf.byteLength > 0 ? buf : undefined));
  if (pool && method === "GET" && isEngineEventPath(proxyPath)) {
    // An open engine event stream means this workspace is visible somewhere in
    // the UI; hold its instance so the idle reaper leaves it alone until the
    // stream's client goes away.
    const releaseStreamHold = workspace && workspace.workspaceType !== "remote" && directory
      ? engineInstanceReaperForConfig(input.config)?.holdStream({
          directory,
          workspaceId: workspace.id,
          engineBaseUrl: baseUrl,
        }) ?? null
      : null;
    if (releaseStreamHold) {
      if (input.request.signal.aborted) releaseStreamHold();
      else input.request.signal.addEventListener("abort", releaseStreamHold, { once: true });
    }
    try {
      const response = await proxyEngineEventStreams({
        pool,
        connections: pool.connections(),
        proxyPath,
        search,
        headers,
        clientSignal: input.request.signal,
      });
      // A non-stream response completes immediately; holding it would leak
      // across every client retry.
      if (releaseStreamHold && (!response.ok || !response.body)) releaseStreamHold();
      return response;
    } catch (error) {
      releaseStreamHold?.();
      throw error;
    }
  }
  if (pool && method === "GET" && engineAggregateKind(proxyPath)) {
    return proxyEngineAggregateRead({
      pool,
      connections: pool.connections(),
      proxyPath,
      search,
      headers,
      kind: engineAggregateKind(proxyPath) ?? "pending",
    });
  }
  const targetUrl = buildOpencodeProxyUrl(baseUrl, proxyPath, search);
  // Managed OpenCode proxy traffic is loopback/engine I/O; keep streaming on Node fetch.
  if (isSessionCommandProxyRequest(method, proxyPath)) {
    const commandAdmission = commandAdmissionFromBody(body);
    if (commandAdmission) {
      const admissionTarget = workspace ? `workspace\0${workspace.id}` : `engine\0${baseUrl}`;
      const admission = admitSessionCommand(
        input.config,
        `${admissionTarget}\0${normalizeOpencodeProxyPath(proxyPath)}`,
        commandAdmission,
      );
      if (admission === "duplicate") return jsonResponse({ ok: true, accepted: true });
      if (admission === "conflict") {
        return jsonResponse({
          code: "command_admission_conflict",
          message: "This command message ID was already admitted with different input",
        }, 409);
      }
    }
    void loopbackFetch(targetUrl, {
      method,
      headers,
      body,
    }).then(() => {
      enginePoolForConfig(input.config)?.reportRequestSuccess(baseUrl);
    }).catch((error: unknown) => {
      if (workspace) enginePoolForConfig(input.config)?.reportRequestFailure(baseUrl, error, workspace);
      // Command failures are surfaced through the OpenCode event stream.
    });
    return jsonResponse({ ok: true, accepted: true });
  }
  const forward = async () => {
    let response: Response;
    try {
      response = await loopbackFetch(targetUrl, { method, headers, body });
      enginePoolForConfig(input.config)?.reportRequestSuccess(baseUrl);
    } catch (error) {
      if (workspace) enginePoolForConfig(input.config)?.reportRequestFailure(baseUrl, error, workspace);
      if (isEngineConnectionFailure(error)) throw opencodeUnreachableError(error, proxyPath);
      throw error;
    }

    if (response.status === 404 && route?.fallback) {
      const fallbackHeaders = headersForEngineConnection(headers, route.fallback);
      let fallbackResponse: Response;
      try {
        fallbackResponse = await loopbackFetch(
          buildOpencodeProxyUrl(route.fallback.baseUrl, proxyPath, search),
          { method, headers: fallbackHeaders, body },
        );
      } catch (error) {
        if (workspace) enginePoolForConfig(input.config)?.reportRequestFailure(route.fallback.baseUrl, error, workspace);
        if (isEngineConnectionFailure(error)) throw opencodeUnreachableError(error, proxyPath);
        throw error;
      }
      return sanitizeProxyResponse(fallbackResponse);
    }

    return sanitizeProxyResponse(response);
  };

  if (workspace && workspace.workspaceType !== "remote" && !pool && isPromptAsyncProxyRequest(method, proxyPath)) {
    return withEngineDirectoryFence(input.config, workspace, forward);
  }
  return forward();
}

function isEngineEventPath(proxyPath: string): boolean {
  const normalized = normalizeOpencodeProxyPath(proxyPath);
  return normalized === "/event" || normalized === "/global/event" || normalized === "/api/event";
}

function engineAggregateKind(proxyPath: string): "status" | "pending" | null {
  const normalized = normalizeOpencodeProxyPath(proxyPath);
  if (normalized === "/session/status") return "status";
  if (["/permission", "/question", "/api/permission/request", "/api/question/request"].includes(normalized)) {
    return "pending";
  }
  return null;
}

function headersForEngineConnection(headers: Headers, connection: EnginePoolConnection): Headers {
  const next = new Headers(headers);
  next.set("Authorization", buildEngineAuthProbeHeader(connection.username, connection.password));
  return next;
}

function pendingPayloadItems(payload: unknown): { key: string | null; items: unknown[] } {
  if (Array.isArray(payload)) return { key: null, items: payload };
  if (!isRecord(payload)) return { key: null, items: [] };
  for (const key of ["items", "permissions", "questions", "requests"]) {
    const value = payload[key];
    if (Array.isArray(value)) return { key, items: value };
  }
  return { key: null, items: [] };
}

function pendingItemIdentity(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value) ?? String(value);
  for (const key of ["id", "requestID", "requestId", "permissionID", "questionID"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return JSON.stringify(value) ?? String(value);
}

async function proxyEngineAggregateRead(input: {
  pool: EnginePool;
  connections: EnginePoolConnection[];
  proxyPath: string;
  search: string;
  headers: Headers;
  kind: "status" | "pending";
}): Promise<Response> {
  const settled = await Promise.allSettled(input.connections.map(async (connection) => {
    const response = await loopbackFetch(buildOpencodeProxyUrl(connection.baseUrl, input.proxyPath, input.search), {
      method: "GET",
      headers: headersForEngineConnection(input.headers, connection),
      signal: AbortSignal.timeout(5_000),
    });
    const payload = response.ok ? await response.json().catch(() => null) : null;
    return { connection, response, payload };
  }));
  const results = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
  const primary = results.find((entry) => entry.connection.role === "primary");
  if (!primary) throw new ApiError(502, "opencode_unreachable", "No OpenCode engine is available");
  if (!primary.response.ok) return sanitizeProxyResponse(primary.response);

  if (input.kind === "status") {
    const merged: Record<string, unknown> = {};
    for (const result of results.filter((entry) => entry.connection.role === "primary")) {
      if (isRecord(result.payload)) Object.assign(merged, result.payload);
    }
    for (const result of results.filter((entry) => entry.connection.role === "draining")) {
      if (isRecord(result.payload)) Object.assign(merged, result.payload);
    }
    return jsonResponse(merged);
  }

  for (const result of results) {
    input.pool.observePendingRequests(result.connection.generationId, result.payload);
  }
  const seen = new Set<string>();
  const items: unknown[] = [];
  let containerKey: string | null = null;
  for (const result of results) {
    const pending = pendingPayloadItems(result.payload);
    containerKey ??= pending.key;
    for (const item of pending.items) {
      const identity = pendingItemIdentity(item);
      if (seen.has(identity)) continue;
      seen.add(identity);
      items.push(item);
    }
  }
  if (containerKey && isRecord(primary.payload)) {
    return jsonResponse({ ...primary.payload, [containerKey]: items });
  }
  return jsonResponse(items);
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

function mergedEventBody(input: {
  pool: EnginePool;
  streams: Array<{ connection: EnginePoolConnection; body: ReadableStream<Uint8Array> }>;
  lease: EngineEventProxyLease;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const readers = input.streams.map((entry) => ({ connection: entry.connection, reader: entry.body.getReader() }));
  let cancelled = false;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let active = readers.length;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if (pingTimer) clearInterval(pingTimer);
        input.lease.signal.removeEventListener("abort", abort);
        input.lease.release();
        controller.close();
      };
      const abort = () => {
        if (closed || cancelled) return;
        cancelled = true;
        for (const entry of readers) void entry.reader.cancel(input.lease.signal.reason).catch(() => undefined);
        close();
      };
      const finish = () => {
        active -= 1;
        if (active > 0 || closed || cancelled) return;
        close();
      };
      const pump = async (entry: typeof readers[number]) => {
        const frameBuffer = new BoundedSseFrameBuffer();
        try {
          while (!cancelled) {
            const chunk = await entry.reader.read();
            if (chunk.done) break;
            const parsed = frameBuffer.push(chunk.value);
            for (const frame of parsed.frames) {
              if (input.pool.shouldForwardEvent(entry.connection.generationId, parseSsePayload(frame))) {
                controller.enqueue(encoder.encode(`${frame}\n\n`));
              }
            }
            if (parsed.overflow) {
              // A frame that never terminates would buffer without bound;
              // drop this connection and let the client reconnect.
              await entry.reader.cancel(new Error("SSE frame exceeded the size limit")).catch(() => undefined);
              break;
            }
          }
        } catch {
          // A generation flip intentionally aborts these readers. The client
          // reconnects and the next stream fans in every live generation.
        } finally {
          entry.reader.releaseLock();
          finish();
        }
      };
      for (const entry of readers) void pump(entry);
      pingTimer = setInterval(() => {
        if (!closed && !cancelled) controller.enqueue(encoder.encode(": ping\n\n"));
      }, 30_000);
      pingTimer.unref?.();
      input.lease.signal.addEventListener("abort", abort, { once: true });
      if (input.lease.signal.aborted) abort();
    },
    async cancel(reason) {
      cancelled = true;
      if (pingTimer) clearInterval(pingTimer);
      input.lease.release();
      await Promise.all(readers.map((entry) => entry.reader.cancel(reason).catch(() => undefined)));
    },
  });
}

// Read lazily so tests can shrink the deadline at runtime. Matches the 5s
// bound proxyEngineAggregateRead puts on its per-connection fan-out.
function engineEventStreamEstablishTimeoutMs(): number {
  const parsed = Number(process.env.OPENWORK_ENGINE_EVENT_ESTABLISH_TIMEOUT_MS ?? "5000");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000;
}

async function proxyEngineEventStreams(input: {
  pool: EnginePool;
  connections: EnginePoolConnection[];
  proxyPath: string;
  search: string;
  headers: Headers;
  clientSignal: AbortSignal;
}): Promise<Response> {
  const lease = input.pool.openEventProxy(input.clientSignal);
  const settled = await Promise.allSettled(input.connections.map(async (connection) => {
    // Bound establishment (headers) only: a connection that accepts the
    // socket but never answers must not stall the whole fan-out. The timer is
    // cleared as soon as the response resolves so the long-lived body stream
    // itself is never put on a deadline; lease aborts tear the body down
    // through the merged-stream reader cancellation instead.
    const establish = new AbortController();
    const onLeaseAbort = () => establish.abort(lease.signal.reason);
    lease.signal.addEventListener("abort", onLeaseAbort, { once: true });
    if (lease.signal.aborted) onLeaseAbort();
    const timer = setTimeout(
      () => establish.abort(new Error("OpenCode event stream establishment timed out")),
      engineEventStreamEstablishTimeoutMs(),
    );
    timer.unref?.();
    try {
      const response = await loopbackFetch(buildOpencodeProxyUrl(connection.baseUrl, input.proxyPath, input.search), {
        method: "GET",
        headers: headersForEngineConnection(input.headers, connection),
        signal: establish.signal,
      });
      return { connection, response };
    } finally {
      clearTimeout(timer);
      lease.signal.removeEventListener("abort", onLeaseAbort);
    }
  }));
  const successful = settled
    .filter((entry): entry is PromiseFulfilledResult<{ connection: EnginePoolConnection; response: Response }> =>
      entry.status === "fulfilled")
    .map((entry) => entry.value);
  // Established fetches are no longer tied to any abort signal, so bodies the
  // merged stream will not own must be cancelled here instead of leaking.
  const discard = (entries: Array<{ response: Response }>) => {
    for (const entry of entries) void entry.response.body?.cancel().catch(() => undefined);
  };
  const primary = successful.find((entry) => entry.connection.role === "primary");
  if (!primary) {
    lease.release();
    discard(successful);
    throw new ApiError(502, "opencode_unreachable", "The primary OpenCode event stream is unavailable");
  }
  if (!primary.response.ok || !primary.response.body) {
    lease.release();
    discard(successful.filter((entry) => entry !== primary));
    return sanitizeProxyResponse(primary.response);
  }
  const streams = successful
    .flatMap((entry) => entry.response.ok && entry.response.body
      ? [{ connection: entry.connection, body: entry.response.body }]
      : []);
  discard(successful.filter((entry) => entry !== primary && !(entry.response.ok && entry.response.body)));
  const headers = new Headers(primary.response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  return new Response(mergedEventBody({ pool: input.pool, streams, lease }), {
    status: primary.response.status,
    statusText: primary.response.statusText,
    headers,
  });
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
  return new Response(response.body, {
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
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
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
  const opencodeConfigured = config.workspaces.some((workspace) => Boolean(workspace.baseUrl?.trim()));
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
    engine: { rollover: enginePoolForConfig(config) !== null },

    approvals: { mode: config.approval.mode, timeoutMs: config.approval.timeoutMs },
    sandbox: { enabled: sandboxEnabled, backend: sandboxBackend },
    tokens: { scoped: true, scopes: ["owner", "collaborator", "viewer"] },
    proxy: {
      opencode: opencodeConfigured,
    },
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
  const { opencodeUsername, opencodePassword, ...rest } = workspace;
  const opencodeDirectory = resolveOpencodeDirectory(workspace);
  const opencode =
    workspace.baseUrl || opencodeDirectory || opencodeUsername || opencodePassword
      ? {
          baseUrl: workspace.baseUrl,
          directory: opencodeDirectory ?? undefined,
          username: opencodeUsername,
          password: opencodePassword,
        }
      : undefined;
  return {
    ...rest,
    opencode,
  };
}

function createRoutes(
  config: ServerConfig,
  approvals: ApprovalService,
  tokens: TokenService,
  env: EnvService,
  onWorkspacesChanged: () => void,
  engineMcpServerState: EngineMcpServerState,
  logger: ServerLogger,
  cloudProviderSync: CloudProviderSync,
): Route[] {
  const routes: Route[] = [];
  registerCoreRoutes({
    routes,
    config,
    tokens,
    env,
    managedProviderAuthLogger: toManagedProviderAuthLogger(logger),
    serverVersion: SERVER_VERSION,
    opencodeVersion: OPENCODE_VERSION,
    jsonResponse,
    readJsonBody,
    readOptionalJsonBody,
    parseOptionalBoolean,
    ensureWritable,
    buildCapabilities,
    fetchRuntimeControl,
    resolveWorkspace,
    resolveOpencodeDirectory,
    createWorkspaceOpencodeClient,
    refreshRegistrationFromLiveStatus: refreshEngineMcpRegistrationFromLiveStatus,
    serializeWorkspace,
    resolveDevLogPath,
    createOpenAiRealtimeVoiceSession,
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
    syncWorkspaceRuntimeMcp: (routeConfig, workspace) =>
      enqueueWorkspaceMcpRefreshSync({
        config: routeConfig,
        workspace,
        serverState: activeEngineMcpServerState(routeConfig),
        trigger: "workspace_activate",
      }),
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

  registerCloudMcpRoutes({
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    resolveOpencodeDirectory,
    createWorkspaceOpencodeClient,
    refreshRegistrationFromLiveStatus: refreshEngineMcpRegistrationFromLiveStatus,
    registerRuntimeMcp: (routeConfig, workspace, onlyNames, options) =>
      syncRuntimeMcpToOpencodeEngine(
        routeConfig,
        workspace,
        onlyNames,
        options,
        engineMcpServerState,
      ),
    serverMetadata: { serverVersion: SERVER_VERSION, expectedOpencodeVersion: OPENCODE_VERSION },
  });

  addRoute(routes, "POST", "/workspace/:id/diagnostics/agent-context", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceForInspection(config, ctx.params.id);
    if (workspace.workspaceType === "remote") {
      throw new ApiError(
        400,
        "agent_diagnostics_workspace_unsupported",
        "Agent diagnostics must run on the OpenWork server that owns a local workspace",
      );
    }
    // Reserve before consuming untrusted bytes and hold the reservation through
    // report completion. The cooldown remains charged for invalid, oversized,
    // timed-out, and otherwise unsuccessful attempts.
    const releaseReservation = reserveAgentDiagnosticsRun(config, ctx.actor, workspace.id);
    try {
      const parsed = agentContextDiagnosticsRequestSchema.safeParse(await readAgentDiagnosticsJsonBody(ctx.request));
      if (!parsed.success) {
        throw new ApiError(400, "invalid_agent_diagnostics_request", "Agent diagnostics request is invalid");
      }
      const opencode = createWorkspaceOpencodeClient(config, workspace, { boundedDiagnosticsReads: true });
      const timeoutSignal = AbortSignal.timeout(agentDiagnosticsTimeoutMs());
      const diagnosticsSignal = AbortSignal.any([ctx.request.signal, timeoutSignal]);
      let response: Response;
      try {
        response = jsonResponse(await runAgentContextDiagnostics({
          config,
          workspace,
          request: parsed.data,
          inspectRegistration: (name, mcpConfig) =>
            inspectEngineMcpRegistrationInState(
              config,
              engineMcpServerState,
              workspace,
              name,
              mcpConfig,
            ),
          dependencies: {
            signal: diagnosticsSignal,
            inspectEffectiveEngine: async (signal) => {
              const [configResult, agentResult] = await Promise.all([
                opencode.config.get({}, { signal }),
                opencode.app.agents({}, { signal }),
              ]);
              return {
                config: unwrapOpencodeResult(configResult, "/config"),
                agents: unwrapOpencodeResult(agentResult, "/agent"),
              };
            },
          },
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

  addRoute(routes, "POST", "/workspace/:id/cloud-plugins", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const resolved = readCloudPluginResolved(body.resolved);
    const marketplace = body.marketplace && typeof body.marketplace === "object" && !Array.isArray(body.marketplace)
      ? Object.fromEntries(Object.entries(body.marketplace))
      : null;
    const marketplaceId = typeof body.marketplaceId === "string" && body.marketplaceId.trim()
      ? body.marketplaceId.trim()
      : null;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "cloud_plugins.install",
      summary: `Install cloud plugin ${resolved.plugin.name}`,
      paths: [openworkConfigPath(workspace.path), join(workspace.path, ".opencode")],
    });

    const result = await installCloudPlugin({
      serverConfig: config,
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      marketplaceId,
      marketplace: marketplaceId
        ? {
            id: marketplaceId,
            name: typeof marketplace?.name === "string" ? marketplace.name : marketplaceId,
            updatedAt: typeof marketplace?.updatedAt === "string" ? marketplace.updatedAt : null,
          }
        : null,
      resolved,
    });
    const imported = result.item;

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "cloud_plugins.install",
      target: openworkConfigPath(workspace.path),
      summary: `Installed cloud plugin ${resolved.plugin.name}`,
      timestamp: Date.now(),
    });

    for (const file of imported.files) {
      emitReloadEvent(ctx.reloadEvents, workspace, file.objectType === "mcp" ? "mcp" : file.objectType === "skill" ? "skills" : file.objectType === "agent" ? "agents" : file.objectType === "command" ? "commands" : "config", {
        type: file.objectType === "skill" || file.objectType === "agent" || file.objectType === "command" || file.objectType === "mcp" ? file.objectType : "config",
        name: file.title,
        action: "added",
      });
    }

    // Hot-register any bundled MCP servers with the running engine.
    await syncRuntimeMcpToOpencodeEngine(
      config,
      workspace,
      undefined,
      undefined,
      engineMcpServerState,
    ).catch(() => undefined);

    return jsonResponse({ item: imported, warnings: result.warnings });
  });

  // Claude Code plugin bundles (MCP + skills + commands + agents) installed
  // straight from a GitHub repo. `dryRun: true` returns the "Will install"
  // preview without writing anything; install reuses the cloud-plugin
  // machinery, so uninstall goes through DELETE /cloud-plugins/:pluginId.
  addRoute(routes, "POST", "/workspace/:id/claude-plugins", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) throw new ApiError(400, "invalid_payload", "GitHub URL is required");
    const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : undefined;
    const dryRun = body.dryRun === true;

    const bundle = await resolveClaudePluginBundle({ url, ref });
    if (dryRun) {
      return jsonResponse({ preview: bundle.preview });
    }

    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "cloud_plugins.install",
      summary: `Install Claude plugin ${bundle.resolved.plugin.name} from ${bundle.preview.source.owner}/${bundle.preview.source.repo}`,
      paths: [openworkConfigPath(workspace.path), join(workspace.path, ".opencode")],
    });

    const result = await installCloudPlugin({
      serverConfig: config,
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      marketplaceId: null,
      resolved: bundle.resolved,
    });
    const imported = result.item;

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "cloud_plugins.install",
      target: openworkConfigPath(workspace.path),
      summary: `Installed Claude plugin ${bundle.resolved.plugin.name} from ${url}`,
      timestamp: Date.now(),
    });

    for (const file of imported.files) {
      emitReloadEvent(ctx.reloadEvents, workspace, file.objectType === "mcp" ? "mcp" : file.objectType === "skill" ? "skills" : file.objectType === "agent" ? "agents" : file.objectType === "command" ? "commands" : "config", {
        type: file.objectType === "skill" || file.objectType === "agent" || file.objectType === "command" || file.objectType === "mcp" ? file.objectType : "config",
        name: file.title,
        action: "added",
      });
    }

    // Hot-register any bundled MCP servers with the running engine.
    await syncRuntimeMcpToOpencodeEngine(
      config,
      workspace,
      undefined,
      undefined,
      engineMcpServerState,
    ).catch(() => undefined);

    return jsonResponse({ item: imported, preview: bundle.preview, warnings: result.warnings });
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
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(openworkRuntimeConfigFilePath(config)));
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

  addRoute(routes, "PUT", "/den-session", "host-token", async (ctx) => {
    ensureWritable(config);
    const session = parseCloudProviderDenSession(await readJsonBody(ctx.request));
    if (!session) throw new ApiError(400, "invalid_payload", "baseUrl, token, and orgId are required");
    await cloudProviderSync.setSession(session);
    return new Response(null, { status: 204 });
  });

  addRoute(routes, "DELETE", "/den-session", "host-token", async () => {
    ensureWritable(config);
    await cloudProviderSync.clearSession();
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

  addRoute(routes, "GET", "/cloud-provider-sync/status", "client", async () => {
    return jsonResponse(cloudProviderSync.status());
  });

  addRoute(routes, "PATCH", "/runtime-config/providers", "host-token", async (ctx) => {
    ensureWritable(config);
    const workspace = resolveEngineRuntimeWorkspace(config);
    const body = await readJsonBody(ctx.request);
    const providerPatch = parseRuntimeProviderPatchPayload(body);
    const result = await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      provider: mergeRuntimeProviderUpdate(current.provider, providerPatch),
    }));

    const fileResult = await writeOpenworkRuntimeConfigFile(config);
    // Auth must land before the reload so the replacement provider instance is
    // constructed with its credential. This also refreshes SDK clients after
    // a key rotation even when provider config itself did not change.
    const authResult = await syncManagedProviderAuth({
      config,
      env,
      logger: toManagedProviderAuthLogger(logger),
    });
    const shouldReload = result.changed
      || fileResult.changed
      || authResult.delivered.length > 0
      || authResult.removed.length > 0;
    // A rollover-capable pool can apply this immediately without disposing
    // the generation that owns live sessions. Legacy/external engines keep
    // the established busy deferral.
    const reloadDeferred = shouldReload
      && (await shouldDeferInPlaceEngineReload(config, workspace, engineHasActiveSessions));
    if (shouldReload && !reloadDeferred) {
      await reloadOpencodeEngine(config, workspace, engineMcpServerState);
    }
    if (reloadDeferred) {
      cloudProviderSync.markReloadPending();
    }
    return jsonResponse({
      ok: true,
      changed: result.changed,
      provider: runtimeProviderMap(result.config),
      runtimeConfigPath: openworkRuntimeConfigFilePath(config),
      reload: shouldReload ? (reloadDeferred ? "deferred" : "reloaded") : "skipped",
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
    // The injected file is rendered from the ENGINE_GLOBAL row only; the
    // workspace runtime row reaches the engine via the dynamic MCP push.
    const effectiveRuntime = await buildOpenworkRuntimeConfigObject(config);
    const managedFile = await readManagedRuntimeConfigDebug(config);

    return jsonResponse({
      runtime,
      runtimeKeys: runtimeConfigKeys(runtime),
      effectiveRuntime,
      ...managedFile,
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
        injected: {
          keys: runtimeConfigKeys(effectiveRuntime),
          config: effectiveRuntime,
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
      if (Object.keys(providerUpdate).length) {
        const providerResult = await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
          ...current,
          provider: mergeRuntimeProviderUpdate(current.provider, providerUpdate),
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
    reloadOpencodeEngine: (routeConfig, workspace) =>
      reloadOpencodeEngine(routeConfig, workspace, engineMcpServerState),
  });

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
    return jsonResponse({ ok: true, name, path: result.path });
  });

  addRoute(routes, "GET", "/workspace/:id/mcp", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listMcp(config, workspace.id, workspace.path);
    const managedState = await listLocalManagedMcpConnectionsSafe(config, workspace.id);
    const managed = new Map(managedState.connections.map((connection) => [connection.name, connection]));
    return jsonResponse({
      items: items.map((item) => ({ ...item, managedOAuth: managed.get(item.name) ?? null })),
      engineSync: engineMcpSyncStateInState(config, engineMcpServerState, workspace),
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
    const projectedToolName = typeof body.projectedToolName === "string" ? body.projectedToolName.trim() : "";
    const launch = body.launch && typeof body.launch === "object" && !Array.isArray(body.launch)
      ? body.launch as Record<string, unknown>
      : null;
    try {
      const app = launch && typeof launch.connectionId === "string"
        ? await resolveConnectMcpAppResource({
            serverConfig: config,
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
              workspaceId: workspace.id,
              workspaceRoot: workspace.path,
              projectedToolName,
              launch: {
                toolName: typeof launch.toolName === "string" ? launch.toolName : "",
                resourceUri: typeof launch.resourceUri === "string" ? launch.resourceUri : "",
              },
            })
        : await resolveMcpAppResource({
            serverConfig: config,
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
    const args = body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
      ? body.arguments as Record<string, unknown>
      : {};
    const approved = body.approved === true;
    if (!serverName || !name) throw new ApiError(400, "invalid_payload", "serverName and name are required");
    if (approved) requireClientScope(ctx, "collaborator");
    try {
      return jsonResponse(await callMcpAppTool({
        serverConfig: config,
        workspaceId: workspace.id,
        workspaceRoot: workspace.path,
        serverName,
        name,
        resourceUri,
        arguments: args,
        approved,
      }));
    } catch (error) {
      rethrowMcpAppHostError(error);
    }
  });

  addRoute(routes, "POST", "/workspace/:id/mcp/managed", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "").trim();
    validateUserMcpName(name);
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
    await syncRuntimeMcpToOpencodeEngine(config, workspace, [name], undefined, engineMcpServerState).catch(() => undefined);
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
    await syncRuntimeMcpToOpencodeEngine(config, workspace, [name], undefined, engineMcpServerState).catch(() => undefined);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/mcp/oauth/callback", "none", async (ctx) => {
    const state = ctx.url.searchParams.get("state") ?? "";
    const code = ctx.url.searchParams.get("code") ?? "";
    if (!state || !code) throw new ApiError(400, "managed_mcp_oauth_callback_invalid", "OAuth callback is missing code or state");
    const { connection, workspaceId } = await completeLocalManagedMcpAuthorization(config, state, code);
    const workspace = config.workspaces.find((item) => item.id === workspaceId);
    if (workspace) {
      await syncRuntimeMcpToOpencodeEngine(config, workspace, [connection.name], undefined, engineMcpServerState).catch(() => undefined);
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
    // Hot-add into the running engine so connect/auth works immediately,
    // without waiting for an engine instance rebuild.
    await syncRuntimeMcpToOpencodeEngine(
      config,
      workspace,
      [name],
      undefined,
      engineMcpServerState,
    ).catch(() => undefined);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.add",
      target: openworkConfigPath(workspace.path),
      summary: `Added MCP ${name}`,
      timestamp: Date.now(),
    });
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
    const removed = name === OPENWORK_CLOUD_MCP_NAME
      ? await removeOpenworkCloudMcpDesiredConfig(config)
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
      const affectedWorkspaces = name === OPENWORK_CLOUD_MCP_NAME ? config.workspaces : [workspace];
      await Promise.all(affectedWorkspaces.map(async (affectedWorkspace) => {
        deleteEngineMcpRegistration(config, engineMcpServerState, affectedWorkspace, name);
        await disconnectMcpFromOpencodeEngine(config, affectedWorkspace, name).catch(() => undefined);
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
    await syncRuntimeMcpToOpencodeEngine(
      config,
      workspace,
      [name],
      undefined,
      engineMcpServerState,
    ).catch(() => undefined);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action,
      target: openworkConfigPath(workspace.path),
      summary: `${enabled ? "Enabled" : "Disabled"} MCP ${name}`,
      timestamp: Date.now(),
    });
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
      await disconnectMcpFromOpencodeEngine(config, workspace, name).catch(() => undefined);
      await syncRuntimeMcpToOpencodeEngine(config, workspace, [name], undefined, engineMcpServerState).catch(() => undefined);
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

    const authStorePath = join(homedir(), ".config", "opencode", "mcp-auth.json");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.auth.remove",
      summary: `Logout MCP ${name}`,
      paths: [authStorePath],
    });

    // Best-effort disconnect so any active connection is torn down.
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      unwrapOpencodeResult(await opencode.mcp.disconnect({ name }), `/mcp/${encodeURIComponent(name)}/disconnect`);
    } catch {
      // ignore
    }

    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      unwrapOpencodeResult(await opencode.mcp.auth.remove({ name }), `/mcp/${encodeURIComponent(name)}/auth`);
    } catch (error) {
      // Treat missing credentials as a successful logout (idempotent).
      if (
        error instanceof ApiError &&
        error.code === "opencode_request_failed" &&
        error.details &&
        typeof error.details === "object" &&
        "status" in (error.details as Record<string, unknown>) &&
        (error.details as { status?: unknown }).status === 404
      ) {
        // ok
      } else {
        throw error;
      }
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.auth.remove",
      target: authStorePath,
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
  const aliasWorkspaceId = workspaceId.startsWith("rem_") ? workspaceId.slice("rem_".length) : "";
  const workspace =
    config.workspaces.find((entry) => entry.id === workspaceId) ??
    (aliasWorkspaceId ? config.workspaces.find((entry) => entry.id === aliasWorkspaceId) : undefined);
  if (!workspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
  if (workspace.workspaceType === "remote") {
    return { ...workspace };
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
  const aliasWorkspaceId = workspaceId.startsWith("rem_") ? workspaceId.slice("rem_".length) : "";
  const configuredWorkspace =
    config.workspaces.find((entry) => entry.id === workspaceId) ??
    (aliasWorkspaceId ? config.workspaces.find((entry) => entry.id === aliasWorkspaceId) : undefined);
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
      reloadOpencodeEngineAfterInternalBootstrap(config, { ...workspace, path: resolvedWorkspace });
    }
  }
  return workspace;
}

function reloadOpencodeEngineAfterInternalBootstrap(config: ServerConfig, workspace: WorkspaceInfo): void {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  if (!connection.baseUrl?.trim()) return;
  void reloadOpencodeEngine(config, workspace).catch((error) => {
    createServerLogger(config).log("error", `Bootstrap engine reload failed for workspace ${workspace.id}.`, {
      "workspace.id": workspace.id,
      "engine.reload.failure": error instanceof Error ? error.message : String(error),
    });
  });
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
    if (workspace.workspaceType !== "remote" && workspace.path.trim()) {
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
  const explicit = workspace.directory?.trim() ?? "";
  if (explicit) return normalizeOpencodeDirectory(explicit);
  if (workspace.workspaceType === "local") return normalizeOpencodeDirectory(workspace.path);
  return null;
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

function buildOpencodeReloadUrl(baseUrl: string, directory?: string | null): string {
  try {
    const url = new URL(baseUrl);
    url.pathname = "/instance/dispose";
    url.search = "";
    if (directory) {
      url.searchParams.set("directory", directory);
    }
    return url.toString();
  } catch {
    throw new ApiError(400, "opencode_url_invalid", "OpenCode base URL is invalid");
  }
}

function parseOpencodeErrorBody(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

// Bounded so a dispose wedged on live-session teardown can never freeze the
// caller (CloudProviderSync serializes passes on one queue; an unbounded
// dispose froze every later pass and the status it reports). Overridable for
// tests.
function opencodeDisposeTimeoutMs(): number {
  const configured = Number(process.env.OPENWORK_ENGINE_DISPOSE_TIMEOUT_MS ?? "");
  return Number.isFinite(configured) && configured > 0 ? configured : 30_000;
}

/**
 * True when the managed engine reports any non-idle session (subagent child
 * sessions carry their own ids and statuses, so they count too). Unknown
 * activity reports false: a reload against a dead engine fails loudly on its
 * own, and "unknown" must never park reloads forever.
 */
async function engineHasActiveSessions(config: ServerConfig, workspace: WorkspaceInfo): Promise<boolean> {
  try {
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    const statuses = unwrapOpencodeResult(await opencode.session.status(), "/session/status");
    return Object.values(statuses).some((status) => status.type !== "idle");
  } catch {
    return false;
  }
}

function primaryManagedEngineConnection(config: ServerConfig): EnginePoolConnection | null {
  return enginePoolForConfig(config)?.connections().find((entry) => entry.role === "primary") ?? null;
}

/**
 * Whether a tracked engine instance still reports a non-idle session. Probed
 * directly against the managed engine (never through the workspace client) so
 * the reaper's own probe cannot refresh the instance's last-used time.
 * Throws on an unreadable status: unknown activity must never evict.
 */
async function engineInstanceHasActiveSessions(
  config: ServerConfig,
  instance: TrackedEngineInstance,
): Promise<boolean> {
  const primary = primaryManagedEngineConnection(config);
  if (!primary || primary.baseUrl !== instance.engineBaseUrl) return false;
  const url = new URL("/session/status", primary.baseUrl);
  url.searchParams.set("directory", instance.directory);
  const response = await loopbackFetch(url.toString(), {
    headers: { Authorization: buildEngineAuthProbeHeader(primary.username, primary.password) },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`OpenCode session status probe failed with status ${response.status}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) return false;
  return Object.values(payload).some((status) => isRecord(status) && status.type !== "idle");
}

/**
 * Dispose one idle per-directory engine instance without the reload path's
 * post-refresh sync: re-materializing the instance here would defeat the
 * eviction. The workspace's MCP registration evidence is invalidated first so
 * nothing claims the fresh instance already holds the runtime-DB MCPs; the
 * reaper marks the workspace and the next traffic re-attaches that state.
 */
async function disposeIdleEngineInstance(
  config: ServerConfig,
  serverState: EngineMcpServerState,
  instance: TrackedEngineInstance,
): Promise<void> {
  const primary = primaryManagedEngineConnection(config);
  if (!primary || primary.baseUrl !== instance.engineBaseUrl) {
    throw new Error("The managed engine connection is unavailable for the instance dispose");
  }
  const activeState = activeEngineMcpServerState(config, serverState);
  if (activeState) invalidateEngineMcpWorkspace(activeState, instance.workspaceId);
  const response = await loopbackFetch(buildOpencodeReloadUrl(primary.baseUrl, instance.directory), {
    method: "POST",
    headers: { Authorization: buildEngineAuthProbeHeader(primary.username, primary.password) },
    signal: AbortSignal.timeout(opencodeDisposeTimeoutMs()),
  });
  if (!response.ok) throw new Error(`OpenCode instance dispose failed with status ${response.status}`);
}

/**
 * Record engine traffic for a local workspace's directory instance. When this
 * is the first traffic after that instance was evicted, re-attach the state a
 * fresh instance cannot recover from disk (the runtime-DB MCP push), detached
 * from the request that triggered it.
 */
function touchEngineWorkspaceInstance(config: ServerConfig, workspace: WorkspaceInfo, engineBaseUrl: string): void {
  if (workspace.workspaceType === "remote") return;
  const reaper = engineInstanceReaperForConfig(config);
  if (!reaper) return;
  const directory = resolveOpencodeDirectory(workspace);
  if (!directory) return;
  const evicted = reaper.noteUsed({ directory, workspaceId: workspace.id, engineBaseUrl });
  if (!evicted) return;
  void postEngineRefreshSync(config, workspace, activeEngineMcpServerState(config)).catch((error) => {
    createServerLogger(config).log("error", "Post-eviction engine MCP re-sync failed.", {
      "workspace.id": workspace.id,
      "error.message": error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Bring the engine onto current config.
 *
 * Managed engines always reload through the rollover pool: an idle engine
 * still reloads in place, a busy one rolls over to a standby so live runs are
 * not aborted. Attached engines have no pool, so this falls back to the
 * in-place dispose and callers keep their own defer-while-busy handling.
 */
async function reloadOpencodeEngine(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  serverState?: EngineMcpServerState,
  options?: { awaitPostRefreshSync?: boolean; forceStandby?: boolean },
): Promise<void> {
  const pool = enginePoolForConfig(config);
  if (pool) {
    await pool.requestRollover({
      reason: "engine_reload",
      workspace,
      awaitPostRefreshSync: options?.awaitPostRefreshSync,
      forceStandby: options?.forceStandby,
    });
    return;
  }
  await reloadOpencodeEngineInPlace(config, workspace, serverState, options);
}

async function reloadOpencodeEngineInPlace(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  serverState?: EngineMcpServerState,
  options?: { awaitPostRefreshSync?: boolean },
): Promise<void> {
  const activeState = activeEngineMcpServerState(config, serverState);
  if (activeState) invalidateEngineMcpWorkspace(activeState, workspace.id);
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const baseUrl = connection.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const directory = resolveOpencodeDirectory(workspace);
  const targetUrl = buildOpencodeReloadUrl(baseUrl, directory);
  const headers: Record<string, string> = {};
  const auth = connection.authHeader ?? null;
  if (auth) headers.Authorization = auth;

  let response: Response;
  try {
    // OpenCode reload targets the managed loopback engine; CA trust is irrelevant.
    // The engine answers /instance/dispose only AFTER teardown completes, so a
    // dispose wedged on live-session teardown would otherwise hang forever.
    response = await loopbackFetch(targetUrl, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(opencodeDisposeTimeoutMs()),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      // Deliberately NOT opencode_engine_unreachable: the app escalates that
      // code to a full desktop engine restart, which would kill the very
      // sessions the wedged dispose is still tearing down.
      throw new ApiError(
        504,
        "opencode_reload_timeout",
        "OpenCode dispose did not complete in time; the reload stays pending",
        { baseUrl },
      );
    }
    throw new ApiError(
      503,
      "opencode_engine_unreachable",
      "OpenCode engine is not reachable; a full engine restart is required",
      { baseUrl, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!response.ok) {
    const body = parseOpencodeErrorBody(await response.text());
    throw new ApiError(502, "opencode_reload_failed", "OpenCode reload failed", {
      status: response.status,
      body,
    });
  }

  // The reload rebuilt this directory's instance and the post-refresh sync
  // below re-attaches its runtime state, so any pending post-eviction mark is
  // satisfied here rather than by the next request.
  if (directory && workspace.workspaceType !== "remote") {
    engineInstanceReaperForConfig(config)?.noteUsed({ directory, workspaceId: workspace.id, engineBaseUrl: baseUrl });
  }

  const postRefreshSync = postEngineRefreshSync(config, workspace, activeState);
  if (options?.awaitPostRefreshSync === false) {
    void postRefreshSync.catch((error) => {
      logDetachedPostEngineRefreshSyncError({ config, workspace, error });
    });
    return;
  }
  await postRefreshSync;
}

/**
 * Re-attach engine state that a fresh instance cannot recover from disk.
 *
 * Runs after any engine refresh — an in-place dispose or a rollover flip —
 * because both leave the serving engine without the runtime-DB MCPs that only
 * reach it through the dynamic push.
 */
async function postEngineRefreshSync(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  activeState: EngineMcpServerState | undefined,
): Promise<void> {
  const directory = resolveOpencodeDirectory(workspace);
  markOpenworkCloudMcpStale(workspace, directory);
  return enqueueWorkspaceMcpRefreshSync({
    config,
    workspace,
    serverState: activeState,
    trigger: "engine_reload",
  });
}

type WorkspaceMcpRefreshTrigger = "startup" | "engine_reload" | "workspace_activate";

type WorkspaceMcpRefreshRequest = {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  serverState: EngineMcpServerState | undefined;
  trigger: WorkspaceMcpRefreshTrigger;
};

function enqueueWorkspaceMcpRefreshSync(request: WorkspaceMcpRefreshRequest): Promise<void> {
  const state = activeEngineMcpServerState(request.config, request.serverState);
  if (!state) return runWorkspaceMcpRefreshSync(request);
  return state.refreshSyncQueue.enqueue(request.workspace.id, request);
}

async function runWorkspaceMcpRefreshSync(input: WorkspaceMcpRefreshRequest): Promise<void> {
  const { config, workspace, trigger } = input;
  const directory = resolveOpencodeDirectory(workspace);
  // Re-register runtime-DB MCPs: a rebuilt instance reads disk configs
  // (including the server-managed runtime config file for the primary
  // workspace), but other workspaces' runtime MCPs only reach the engine
  // through this dynamic push.
  try {
    await syncRuntimeMcpToOpencodeEngine(
      config,
      workspace,
      undefined,
      undefined,
      input.serverState ?? null,
    );
  } catch (error) {
    logRuntimeMcpSyncError({ config, workspace, trigger, error });
  }
  try {
    const health = await reconcilePersistedOpenworkCloudMcp({
      config,
      workspace,
      directory,
      serverMetadata: { serverVersion: SERVER_VERSION, expectedOpencodeVersion: OPENCODE_VERSION },
      createWorkspaceOpencodeClient,
      refreshRegistrationFromLiveStatus: refreshEngineMcpRegistrationFromLiveStatus,
      registerRuntimeMcp: (routeConfig, routeWorkspace, onlyNames, options) =>
        syncRuntimeMcpToOpencodeEngine(
          routeConfig,
          routeWorkspace,
          onlyNames,
          options,
          input.serverState ?? null,
        ),
      trigger,
    });
    logPersistedCloudMcpReconcileResult({ config, workspace, trigger, health });
  } catch (error) {
    logPersistedCloudMcpReconcileError({ config, workspace, trigger, error });
  }
  // The reconcile above may write the ENGINE_GLOBAL runtime row; refresh the
  // engine-visible file synchronously so the next provider-sync pass compares
  // against post-reload state instead of racing the async fresh-keeper and
  // reporting a phantom "changed" (which would schedule yet another reload).
  try {
    if (trigger === "engine_reload") {
      await writeOpenworkRuntimeConfigFile(config);
    }
  } catch {
    // Best-effort: the fresh-keeper listener still converges eventually.
  }
}

// Push runtime-DB MCP entries into the running OpenCode engine via its dynamic
// add endpoint, so adds/toggles take effect without waiting for an engine
// instance rebuild. Best-effort: callers treat engine sync as advisory and
// swallow failures; outcomes are recorded per workspace (engineMcpSyncState)
// and logged so failures aren't silent.
async function syncRuntimeMcpToOpencodeEngine(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  onlyNames?: string[],
  options?: { throwOnFailure?: boolean; deferred?: boolean },
  serverState?: EngineMcpServerState | null,
): Promise<EngineMcpSyncResult> {
  const activeState = activeEngineMcpServerState(config, serverState);
  const coordinationState = activeEngineMcpServerState(config);
  if (!coordinationState) {
    return runRuntimeMcpSyncToOpencodeEngine(config, workspace, onlyNames, options, serverState);
  }
  if (activeState) {
    reconcileEngineMcpWorkspaceIdentity(
      activeState,
      workspace.id,
      engineMcpConnectionIdentity(config, workspace),
    );
    if (!options?.deferred) cancelDeferredEngineMcpSync(activeState, workspace.id);
  }
  return withEngineMcpRegistrationLock(coordinationState, workspace.id, () =>
    runRuntimeMcpSyncToOpencodeEngine(config, workspace, onlyNames, options, serverState)
  );
}

async function runRuntimeMcpSyncToOpencodeEngine(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  onlyNames?: string[],
  options?: { throwOnFailure?: boolean; deferred?: boolean },
  serverState?: EngineMcpServerState | null,
): Promise<EngineMcpSyncResult> {
  const activeState = activeEngineMcpServerState(config, serverState);
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const baseUrl = connection.baseUrl?.trim() ?? "";
  const connectionIdentity = engineMcpConnectionIdentity(config, workspace);
  const registrationIdentity = engineMcpRegistrationIdentity(config, workspace);
  if (activeState) reconcileEngineMcpWorkspaceIdentity(activeState, workspace.id, connectionIdentity);
  if (activeState && !options?.deferred) cancelDeferredEngineMcpSync(activeState, workspace.id);
  if (!baseUrl || !connectionIdentity) {
    return { status: "skipped", syncedNames: [], failures: [] };
  }

  const runtimeConfig = await readEffectiveRuntimeOpencodeConfig(config, workspace.id);
  const entries = Object.entries(runtimeMcpMap(runtimeConfig)).filter(
    ([name]) => !name.startsWith(CONNECT_MCP_SERVER_NAME_PREFIX)
      && (!onlyNames || onlyNames.includes(name)),
  );
  if (entries.length === 0) {
    if (!onlyNames) {
      recordEngineMcpSyncResult(
        config,
        activeState ?? null,
        workspace,
        connectionIdentity,
        registrationIdentity,
        {
          entries: [],
          failures: [],
          replace: true,
        },
      );
    }
    return { status: "skipped", syncedNames: [], failures: [] };
  }

  const url = new URL(baseUrl);
  url.pathname = "/mcp";
  url.search = "";
  const directory = resolveOpencodeDirectory(workspace);
  if (directory) url.searchParams.set("directory", directory);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (connection.authHeader) headers.Authorization = connection.authHeader;

  // Keep going past per-entry failures: one dead or invalid MCP must not
  // block re-registration of every entry after it (e.g. openwork-ui) on
  // each engine reload.
  const failures: EngineMcpSyncFailure[] = [];
  const registrations: EngineMcpRegistrationResult[] = [];
  for (const [name, mcpConfig] of entries) {
    const registration = await postMcpEntryWithRetry(config, workspace, url, headers, name, mcpConfig);
    registrations.push(registration);
    if (registration.failure) failures.push(registration.failure);
  }

  recordEngineMcpSyncResult(
    config,
    activeState ?? null,
    workspace,
    connectionIdentity,
    registrationIdentity,
    {
      entries,
      registrations,
      failures,
      // A full sync covered every runtime entry, so its result replaces any
      // previously recorded failures (e.g. for since-removed MCPs).
      replace: !onlyNames,
    },
  );

  if (failures.length > 0) {
    if (activeState && !options?.deferred && hasRetryableMcpSyncFailure(failures)) {
      scheduleDeferredEngineMcpSync({
        config,
        state: activeState,
        workspace,
        connectionIdentity,
        onlyNames,
      });
    }
    const names = failures.map((failure) => failure.name).join(", ");
    createServerLogger(config).log("warn", `Engine MCP sync failed for workspace ${workspace.id}: ${names}`, {
      "workspace.id": workspace.id,
      "mcp.failed": names,
    });
    if (options?.throwOnFailure !== false) {
      throw new ApiError(502, "opencode_mcp_sync_failed", `Failed to register MCPs with the engine: ${names}`, {
        failures,
      });
    }
  }

  return {
    status: failures.length > 0 ? "failed" : "ok",
    syncedNames: entries.map(([name]) => name),
    failures,
  };
}

async function withEngineMcpRegistrationLock<Result>(
  state: EngineMcpServerState,
  workspaceId: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = state.registrationTailByWorkspace.get(workspaceId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  state.registrationTailByWorkspace.set(workspaceId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (state.registrationTailByWorkspace.get(workspaceId) === tail) {
      state.registrationTailByWorkspace.delete(workspaceId);
    }
  }
}

// POST one MCP entry to the engine, retrying once on 5xx/network errors
// (the engine is often mid-rebuild right after a dispose). 4xx responses
// are not retried — they won't change.
async function postMcpEntryWithRetry(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  url: URL,
  headers: Record<string, string>,
  name: string,
  mcpConfig: Record<string, unknown>,
): Promise<EngineMcpRegistrationResult> {
  let failure: EngineMcpSyncFailure | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, engineMcpSyncRetryDelayMs()));
    try {
      // Runtime MCP registration targets the managed loopback engine.
      const response = await loopbackFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, config: mcpConfig }),
        signal: AbortSignal.timeout(15_000),
      });
      enginePoolForConfig(config)?.reportRequestSuccess(url.origin);
      if (response.ok) {
        // OpenCode's dynamic registration endpoint historically treats every
        // 2xx response as accepted delivery and Cloud readiness verifies the
        // actual state by polling GET /mcp. Parse the response only as optional
        // diagnostics evidence: an absent or malformed status must fail closed
        // to `not-recorded` without turning accepted delivery into a failure.
        const registration = await parseEngineMcpRegistrationStatus(response, name);
        return {
          name,
          status: registration.status,
          source: registration.status ? "engine_status" : null,
          errorSummary: registration.errorSummary,
          failure: null,
        };
      }
      await response.body?.cancel().catch(() => undefined);
      failure = {
        name,
        status: response.status,
        registrationStatus: "failed",
        message: "OpenCode rejected the MCP registration request",
      };
      if (response.status < 500) return { name, status: "failed", source: "transport_failure", errorSummary: null, failure };
    } catch (error) {
      enginePoolForConfig(config)?.reportRequestFailure(url.origin, error, workspace);
      failure = {
        name,
        registrationStatus: "failed",
        message: "OpenCode MCP registration request failed",
      };
    }
  }
  return {
    name,
    status: "failed",
    source: "transport_failure",
    errorSummary: null,
    failure: failure ?? {
      name,
      registrationStatus: "failed",
      message: "OpenCode MCP registration request failed",
    },
  };
}

const ENGINE_MCP_REGISTRATION_RESPONSE_MAX_BYTES = 64 * 1024;

export type EngineMcpRegistrationStatus =
  | "connected"
  | "disabled"
  | "failed"
  | "needs-auth"
  | "needs-client-registration";
export type EngineMcpRegistrationSource = "transport_failure" | "engine_status";

export type EngineMcpRegistrationInspection = {
  status: EngineMcpRegistrationStatus | "not-recorded";
  source: EngineMcpRegistrationSource | null;
  recordAgeMs: number | null;
  errorSummary: string | null;
};

type EngineMcpRegistrationResult = {
  name: string;
  status: EngineMcpRegistrationStatus | null;
  source: EngineMcpRegistrationSource | null;
  errorSummary: string | null;
  failure: EngineMcpSyncFailure | null;
};

type ParsedEngineMcpRegistrationStatus = {
  status: EngineMcpRegistrationStatus | null;
  errorSummary: string | null;
};

type EngineMcpDeferredSync = {
  timer: ReturnType<typeof setTimeout>;
  connectionIdentity: string;
  generation: number;
  onlyNames?: string[];
};

async function parseEngineMcpRegistrationStatus(
  response: Response,
  name: string,
): Promise<ParsedEngineMcpRegistrationStatus> {
  let text: string;
  try {
    text = await readBoundedEngineMcpRegistrationResponse(response);
  } catch {
    return { status: null, errorSummary: null };
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return { status: null, errorSummary: null };
  }
  if (!isRecord(body) || !Object.hasOwn(body, name)) return { status: null, errorSummary: null };
  const entry = body[name];
  if (!isRecord(entry)) return { status: null, errorSummary: null };
  const status = normalizeEngineMcpRegistrationStatus(entry.status);
  return {
    status,
    errorSummary: sanitizeEngineMcpRegistrationErrorSummary(entry.error, status),
  };
}

function sanitizeEngineMcpRegistrationErrorSummary(
  error: unknown,
  status: EngineMcpRegistrationStatus | null,
): string | null {
  if (status !== "failed" && status !== "needs-client-registration") return null;
  if (typeof error !== "string") return null;
  const sanitized = sanitizeDiagnosticString(error).trim().slice(0, 400);
  return sanitized || null;
}

function normalizeEngineMcpRegistrationStatus(status: unknown): EngineMcpRegistrationStatus | null {
  switch (status) {
    case "connected":
    case "disabled":
    case "failed":
      return status;
    case "needs_auth":
      return "needs-auth";
    case "needs_client_registration":
      return "needs-client-registration";
    default:
      return null;
  }
}

async function readBoundedEngineMcpRegistrationResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > ENGINE_MCP_REGISTRATION_RESPONSE_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("OpenCode MCP registration response exceeded the size limit");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > ENGINE_MCP_REGISTRATION_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("OpenCode MCP registration response exceeded the size limit");
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

// Read lazily so tests can shrink the delay at runtime.
function engineMcpSyncRetryDelayMs(): number {
  const parsed = Number(process.env.OPENWORK_MCP_SYNC_RETRY_DELAY_MS ?? "750");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 750;
}

function engineMcpDeferredSyncDelayMs(): number {
  const parsed = Number(process.env.OPENWORK_MCP_SYNC_DEFERRED_DELAY_MS ?? "12000");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 12_000;
}

function hasRetryableMcpSyncFailure(failures: EngineMcpSyncFailure[]): boolean {
  return failures.some((failure) => failure.status === undefined || failure.status >= 500);
}

function cancelDeferredEngineMcpSync(state: EngineMcpServerState, workspaceId: string): void {
  const previous = state.deferredSyncByWorkspace.get(workspaceId);
  if (!previous) return;
  clearTimeout(previous.timer);
  state.deferredSyncByWorkspace.delete(workspaceId);
}

function scheduleDeferredEngineMcpSync(input: {
  config: ServerConfig;
  state: EngineMcpServerState;
  workspace: WorkspaceInfo;
  connectionIdentity: string;
  onlyNames?: string[];
}): void {
  cancelDeferredEngineMcpSync(input.state, input.workspace.id);
  const generation = input.state.generation;
  const onlyNames = input.onlyNames ? [...input.onlyNames] : undefined;
  const timer = setTimeout(() => {
    const state = activeEngineMcpServerState(input.config, input.state);
    if (!state || state.generation !== generation) return;
    const current = state.deferredSyncByWorkspace.get(input.workspace.id);
    if (!current || current.generation !== generation) return;
    state.deferredSyncByWorkspace.delete(input.workspace.id);
    if (engineMcpConnectionIdentity(input.config, input.workspace) !== input.connectionIdentity) return;
    if (state.syncStateByWorkspace.get(input.workspace.id)?.status === "ok") return;
    createServerLogger(input.config).log(
      "info",
      `Running deferred engine MCP sync for workspace ${input.workspace.id}.`,
      { "workspace.id": input.workspace.id },
    );
    void syncRuntimeMcpToOpencodeEngine(
      input.config,
      input.workspace,
      current.onlyNames,
      { throwOnFailure: false, deferred: true },
      state,
    ).catch((error) => {
      createServerLogger(input.config).log(
        "warn",
        `Deferred engine MCP sync failed for workspace ${input.workspace.id}.`,
        {
          "workspace.id": input.workspace.id,
          "mcp.failure.code": "deferred_runtime_mcp_sync_failed",
          "mcp.failure.message": error instanceof Error ? error.message : String(error),
        },
      );
    });
  }, engineMcpDeferredSyncDelayMs());
  input.state.deferredSyncByWorkspace.set(input.workspace.id, {
    timer,
    connectionIdentity: input.connectionIdentity,
    generation,
    ...(onlyNames ? { onlyNames } : {}),
  });
}

export type EngineMcpSyncFailure = {
  name: string;
  status?: number;
  registrationStatus?: EngineMcpRegistrationStatus;
  message?: string;
};
export type EngineMcpSyncResult = {
  status: "ok" | "failed" | "skipped";
  syncedNames: string[];
  failures: EngineMcpSyncFailure[];
};
export type EngineMcpSyncState = { status: "ok" | "failed"; at: number; failures: EngineMcpSyncFailure[] };

type EngineMcpRegistrationRecord = {
  fingerprint: string;
  status: EngineMcpRegistrationStatus;
  source: EngineMcpRegistrationSource;
  errorSummary: string | null;
  registrationIdentity: string;
  generation: number;
  recordedAt: number;
};

type TrustedOpencodeProcessIdentity = {
  endpoint: string;
  identityHash: string;
  generation: number;
  isAlive: () => boolean;
};

type EngineMcpServerState = {
  generation: number;
  syncStateByWorkspace: Map<string, EngineMcpSyncState>;
  refreshSyncQueue: LatestTrailingWorkQueue<string, WorkspaceMcpRefreshRequest>;
  registrationTailByWorkspace: Map<string, Promise<void>>;
  registrationByWorkspace: Map<string, Map<string, EngineMcpRegistrationRecord>>;
  engineIdentityByWorkspace: Map<string, string>;
  deferredSyncByWorkspace: Map<string, EngineMcpDeferredSync>;
};

const ENGINE_MCP_REGISTRATION_MAX_AGE_MS = 15 * 60_000;
// Registration status is point-in-time evidence from a dynamic POST /mcp,
// not a durable statement about a later engine process. Scope it to one
// OpenWork server generation and expire it even when the endpoint is stable.
const engineMcpServerStateByConfig = new WeakMap<ServerConfig, EngineMcpServerState>();
const trustedOpencodeProcessByConfig = new WeakMap<ServerConfig, TrustedOpencodeProcessIdentity>();
let nextEngineMcpServerGeneration = 0;
let nextTrustedOpencodeProcessGeneration = 0;

function normalizedOpencodeProcessEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    url.pathname = "/global/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function clearEngineMcpServerEvidence(state: EngineMcpServerState): void {
  for (const deferred of state.deferredSyncByWorkspace.values()) clearTimeout(deferred.timer);
  state.syncStateByWorkspace.clear();
  state.registrationByWorkspace.clear();
  state.engineIdentityByWorkspace.clear();
  state.deferredSyncByWorkspace.clear();
}

/**
 * Bind diagnostics evidence to one OpenCode process generation owned by this
 * OpenWork server. The opaque identity is hashed immediately and never
 * reported. External engines without a trusted per-boot identity still hot
 * sync normally, but their cached registration result cannot authorize a
 * credentialed diagnostics probe.
 */
export function registerTrustedOpencodeProcess(
  config: ServerConfig,
  input: { baseUrl: string; identity: string; isAlive: () => boolean },
): void {
  const endpoint = normalizedOpencodeProcessEndpoint(input.baseUrl.trim());
  const identity = input.identity.trim();
  if (!endpoint || !identity) {
    clearTrustedOpencodeProcess(config);
    return;
  }
  const previous = trustedOpencodeProcessByConfig.get(config);
  const identityHash = hashToken(identity);
  const next: TrustedOpencodeProcessIdentity = {
    endpoint,
    identityHash,
    generation: previous?.endpoint === endpoint && previous.identityHash === identityHash
      ? previous.generation
      : ++nextTrustedOpencodeProcessGeneration,
    isAlive: input.isAlive,
  };
  if (previous?.endpoint !== next.endpoint || previous.identityHash !== next.identityHash) {
    const state = engineMcpServerStateByConfig.get(config);
    if (state) clearEngineMcpServerEvidence(state);
  }
  trustedOpencodeProcessByConfig.set(config, next);
}

/**
 * Build the engine pool for a config and register it.
 *
 * Lives here so the pool can reuse server-private helpers (in-place reload,
 * busy probe, post-refresh MCP sync) without exporting them; the startup path
 * only supplies what it already knows about the spawn.
 */
export function createEnginePoolForConfig(input: {
  config: ServerConfig;
  template: EngineSpawnTemplate;
  handle: Parameters<EnginePool["adoptPrimary"]>[0]["handle"];
  fingerprint: string;
  registryId: string | null;
  trustedIdentity: string | null;
}): EnginePool {
  const { config } = input;
  const pool = new EnginePool({
    config,
    template: input.template,
    hooks: {
      reloadInPlace: (poolConfig, workspace, options) =>
        reloadOpencodeEngineInPlace(poolConfig, workspace, undefined, options),
      engineBusy: (poolConfig, workspace) => engineHasActiveSessions(poolConfig, workspace),
      postRefreshSync: async (poolConfig, workspace) => {
        await postEngineRefreshSync(poolConfig, workspace, activeEngineMcpServerState(poolConfig));
        await syncAllWorkspacesRuntimeMcpToEngine(poolConfig);
      },
      writeRuntimeConfigFile: (poolConfig) => writeOpenworkRuntimeConfigFile(poolConfig),
      registerTrusted: (poolConfig, generation) => registerTrustedOpencodeProcess(poolConfig, generation),
      clearTrusted: (poolConfig, identity) => clearTrustedOpencodeProcess(poolConfig, identity),
      logger: createServerLogger(config),
    },
  });
  pool.adoptPrimary({
    handle: input.handle,
    fingerprint: input.fingerprint,
    registryId: input.registryId,
    trustedIdentity: input.trustedIdentity,
  });
  setEnginePoolForConfig(config, pool);
  return pool;
}

export function clearTrustedOpencodeProcess(config: ServerConfig, expectedIdentity?: string): void {
  const current = trustedOpencodeProcessByConfig.get(config);
  if (!current) return;
  if (expectedIdentity && current.identityHash !== hashToken(expectedIdentity.trim())) return;
  trustedOpencodeProcessByConfig.delete(config);
  const state = engineMcpServerStateByConfig.get(config);
  if (state) clearEngineMcpServerEvidence(state);
}

function beginEngineMcpServerState(config: ServerConfig): EngineMcpServerState {
  const previous = engineMcpServerStateByConfig.get(config);
  const refreshSyncQueue = previous?.refreshSyncQueue ?? new LatestTrailingWorkQueue(
    runWorkspaceMcpRefreshSync,
    (workspaceId, error) => {
      createServerLogger(config).log("error", `Workspace MCP refresh queue crashed for ${workspaceId}.`, {
        "workspace.id": workspaceId,
        "mcp.failure.code": "workspace_mcp_refresh_queue_exception",
        "mcp.failure.message": error instanceof Error ? error.message : String(error),
      });
    },
  );
  const registrationTailByWorkspace = previous?.registrationTailByWorkspace ?? new Map<string, Promise<void>>();
  if (previous) invalidateEngineMcpServerState(config, previous);
  const state: EngineMcpServerState = {
    generation: ++nextEngineMcpServerGeneration,
    syncStateByWorkspace: new Map(),
    refreshSyncQueue,
    registrationTailByWorkspace,
    registrationByWorkspace: new Map(),
    engineIdentityByWorkspace: new Map(),
    deferredSyncByWorkspace: new Map(),
  };
  engineMcpServerStateByConfig.set(config, state);
  return state;
}

function activeEngineMcpServerState(
  config: ServerConfig,
  candidate?: EngineMcpServerState | null,
): EngineMcpServerState | undefined {
  if (candidate === null) return undefined;
  const active = engineMcpServerStateByConfig.get(config);
  if (!active || (candidate && active !== candidate)) return undefined;
  return candidate ?? active;
}

function invalidateEngineMcpServerState(config: ServerConfig, state: EngineMcpServerState): void {
  clearEngineMcpServerEvidence(state);
  if (engineMcpServerStateByConfig.get(config) === state) {
    engineMcpServerStateByConfig.delete(config);
  }
}

function invalidateEngineMcpWorkspace(state: EngineMcpServerState, workspaceId: string): void {
  const deferred = state.deferredSyncByWorkspace.get(workspaceId);
  if (deferred) clearTimeout(deferred.timer);
  state.syncStateByWorkspace.delete(workspaceId);
  state.registrationByWorkspace.delete(workspaceId);
  state.engineIdentityByWorkspace.delete(workspaceId);
  state.deferredSyncByWorkspace.delete(workspaceId);
}

function reconcileEngineMcpWorkspaceIdentity(
  state: EngineMcpServerState,
  workspaceId: string,
  engineIdentity: string | null,
): void {
  const previous = state.engineIdentityByWorkspace.get(workspaceId);
  if (!engineIdentity) {
    invalidateEngineMcpWorkspace(state, workspaceId);
    return;
  }
  if (previous && previous !== engineIdentity) {
    invalidateEngineMcpWorkspace(state, workspaceId);
  }
  state.engineIdentityByWorkspace.set(workspaceId, engineIdentity);
}

function engineMcpRegistrationMaxAgeMs(): number {
  const configured = Number(process.env.OPENWORK_MCP_REGISTRATION_MAX_AGE_MS);
  if (!Number.isFinite(configured) || configured < 1) return ENGINE_MCP_REGISTRATION_MAX_AGE_MS;
  return Math.min(ENGINE_MCP_REGISTRATION_MAX_AGE_MS, Math.round(configured));
}

const MCP_REGISTRATION_FINGERPRINT_MAX_DEPTH = 32;
const MCP_REGISTRATION_FINGERPRINT_MAX_NODES = 10_000;

function hasBoundedMcpRegistrationStructure(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new Set<object>();
  let nodes = 0;
  try {
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      nodes += 1;
      if (nodes > MCP_REGISTRATION_FINGERPRINT_MAX_NODES) return false;
      if (current.depth > MCP_REGISTRATION_FINGERPRINT_MAX_DEPTH) return false;
      if (typeof current.value !== "object" || current.value === null) continue;
      if (visited.has(current.value)) return false;
      visited.add(current.value);
      const children = Array.isArray(current.value)
        ? current.value
        : Object.values(current.value);
      for (const child of children) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
    return true;
  } catch {
    return false;
  }
}

function serializeStableMcpRegistrationValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(serializeStableMcpRegistrationValue).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${serializeStableMcpRegistrationValue(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function stableMcpRegistrationValue(value: unknown): string | null {
  if (!hasBoundedMcpRegistrationStructure(value)) return null;
  try {
    return serializeStableMcpRegistrationValue(value);
  } catch {
    return null;
  }
}

function mcpRegistrationFingerprint(config: Record<string, unknown>): string | null {
  const stableValue = stableMcpRegistrationValue(config);
  return stableValue === null ? null : hashToken(stableValue);
}

function engineMcpConnectionIdentity(config: ServerConfig, workspace: WorkspaceInfo): string | null {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const baseUrl = connection.baseUrl?.trim() ?? "";
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    url.pathname = "/mcp";
    url.search = "";
    url.hash = "";
    const directory = resolveOpencodeDirectory(workspace);
    if (directory) url.searchParams.set("directory", directory);
    const stableIdentity = stableMcpRegistrationValue({
      endpoint: url.toString(),
      authorization: connection.authHeader ?? null,
    });
    return stableIdentity === null ? null : hashToken(stableIdentity);
  } catch {
    return null;
  }
}

function trustedOpencodeProcessIdentity(config: ServerConfig, workspace: WorkspaceInfo): string | null {
  const trusted = trustedOpencodeProcessByConfig.get(config);
  if (!trusted) return null;

  let isAlive = false;
  try {
    isAlive = trusted.isAlive();
  } catch {
    isAlive = false;
  }
  if (!isAlive) {
    clearTrustedOpencodeProcess(config);
    return null;
  }

  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const endpoint = normalizedOpencodeProcessEndpoint(connection.baseUrl?.trim() ?? "");
  if (!endpoint || endpoint !== trusted.endpoint) return null;

  const stableIdentity = stableMcpRegistrationValue({
    generation: trusted.generation,
    identityHash: trusted.identityHash,
  });
  return stableIdentity === null ? null : hashToken(stableIdentity);
}

function engineMcpRegistrationIdentity(config: ServerConfig, workspace: WorkspaceInfo): string | null {
  const connectionIdentity = engineMcpConnectionIdentity(config, workspace);
  const processIdentity = trustedOpencodeProcessIdentity(config, workspace);
  if (!connectionIdentity || !processIdentity) return null;
  const stableIdentity = stableMcpRegistrationValue({ connectionIdentity, processIdentity });
  return stableIdentity === null ? null : hashToken(stableIdentity);
}

function recordEngineMcpSyncResult(
  config: ServerConfig,
  serverState: EngineMcpServerState | null,
  workspace: WorkspaceInfo,
  connectionIdentity: string,
  registrationIdentity: string | null,
  result: {
    entries: Array<[string, Record<string, unknown>]>;
    registrations?: EngineMcpRegistrationResult[];
    failures: EngineMcpSyncFailure[];
    replace: boolean;
  },
): void {
  const state = activeEngineMcpServerState(config, serverState);
  if (!state) return;
  const currentConnectionIdentity = engineMcpConnectionIdentity(config, workspace);
  if (currentConnectionIdentity !== connectionIdentity) {
    invalidateEngineMcpWorkspace(state, workspace.id);
    return;
  }
  reconcileEngineMcpWorkspaceIdentity(state, workspace.id, connectionIdentity);
  const currentRegistrationIdentity = engineMcpRegistrationIdentity(config, workspace);
  // The liveness check above can revoke trust and clear the state. Restore the
  // transport identity before recording the non-sensitive sync outcome.
  reconcileEngineMcpWorkspaceIdentity(state, workspace.id, connectionIdentity);
  const workspaceId = workspace.id;
  const syncedNames = result.entries.map(([name]) => name);
  const previous = state.syncStateByWorkspace.get(workspaceId);
  // Partial syncs (onlyNames) shouldn't clear recorded failures for entries
  // they didn't touch; merge by name instead.
  const remaining = result.replace
    ? []
    : (previous?.failures ?? []).filter((failure) => !syncedNames.includes(failure.name));
  const merged = [...remaining, ...result.failures];
  const recordedAt = Date.now();
  state.syncStateByWorkspace.set(workspaceId, {
    status: merged.length > 0 ? "failed" : "ok",
    at: recordedAt,
    failures: merged,
  });

  if (!registrationIdentity || currentRegistrationIdentity !== registrationIdentity) {
    state.registrationByWorkspace.delete(workspaceId);
    return;
  }

  const registrations = result.replace
    ? new Map<string, EngineMcpRegistrationRecord>()
    : new Map(state.registrationByWorkspace.get(workspaceId) ?? []);
  const registrationByName = new Map(result.registrations?.map((registration) => [registration.name, registration]));
  for (const [name, mcpConfig] of result.entries) {
    const fingerprint = mcpRegistrationFingerprint(mcpConfig);
    const registration = registrationByName.get(name);
    if (fingerprint === null || !registration?.status || !registration.source) {
      registrations.delete(name);
      continue;
    }
    registrations.set(name, {
      fingerprint,
      status: registration.status,
      source: registration.source,
      errorSummary: registration.errorSummary,
      registrationIdentity,
      generation: state.generation,
      recordedAt,
    });
  }
  state.registrationByWorkspace.set(workspaceId, registrations);
}

function engineMcpSyncStateInState(
  config: ServerConfig,
  serverState: EngineMcpServerState,
  workspace: WorkspaceInfo,
): EngineMcpSyncState | null {
  const state = activeEngineMcpServerState(config, serverState);
  if (!state) return null;
  const engineIdentity = engineMcpConnectionIdentity(config, workspace);
  reconcileEngineMcpWorkspaceIdentity(state, workspace.id, engineIdentity);
  if (!engineIdentity) return null;
  return state.syncStateByWorkspace.get(workspace.id) ?? null;
}

function inspectEngineMcpRegistrationInState(
  config: ServerConfig,
  serverState: EngineMcpServerState,
  workspace: WorkspaceInfo,
  name: string,
  mcpConfig: Record<string, unknown>,
): EngineMcpRegistrationInspection {
  const state = activeEngineMcpServerState(config, serverState);
  if (!state) return notRecordedEngineMcpRegistration();
  const connectionIdentity = engineMcpConnectionIdentity(config, workspace);
  reconcileEngineMcpWorkspaceIdentity(state, workspace.id, connectionIdentity);
  if (!connectionIdentity) return notRecordedEngineMcpRegistration();
  const registrationIdentity = engineMcpRegistrationIdentity(config, workspace);
  if (!registrationIdentity) {
    state.registrationByWorkspace.delete(workspace.id);
    return notRecordedEngineMcpRegistration();
  }
  const registrations = state.registrationByWorkspace.get(workspace.id);
  const registration = registrations?.get(name);
  if (!registration) return notRecordedEngineMcpRegistration();
  const currentFingerprint = mcpRegistrationFingerprint(mcpConfig);
  const ageMs = Date.now() - registration.recordedAt;
  if (
    registration.generation !== state.generation
    || registration.registrationIdentity !== registrationIdentity
    || !Number.isFinite(ageMs)
    || ageMs < 0
    || ageMs > engineMcpRegistrationMaxAgeMs()
    || currentFingerprint === null
    || registration.fingerprint !== currentFingerprint
  ) {
    registrations?.delete(name);
    return notRecordedEngineMcpRegistration();
  }
  return {
    status: registration.status,
    source: registration.source,
    recordAgeMs: Math.round(ageMs),
    errorSummary: registration.errorSummary,
  };
}

function notRecordedEngineMcpRegistration(): EngineMcpRegistrationInspection {
  return { status: "not-recorded", source: null, recordAgeMs: null, errorSummary: null };
}

export function inspectEngineMcpRegistration(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  name: string,
  mcpConfig: Record<string, unknown>,
): EngineMcpRegistrationStatus | "not-recorded" {
  return inspectEngineMcpRegistrationDetails(config, workspace, name, mcpConfig).status;
}

export function inspectEngineMcpRegistrationDetails(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  name: string,
  mcpConfig: Record<string, unknown>,
): EngineMcpRegistrationInspection {
  const state = activeEngineMcpServerState(config);
  if (!state) return notRecordedEngineMcpRegistration();
  return inspectEngineMcpRegistrationInState(config, state, workspace, name, mcpConfig);
}

export function refreshEngineMcpRegistrationFromLiveStatus(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  name: string,
  mcpConfig: Record<string, unknown>,
  liveStatus: unknown,
  liveError: unknown = null,
): boolean {
  const status = normalizeEngineMcpRegistrationStatus(liveStatus);
  if (!status) return false;
  const state = activeEngineMcpServerState(config);
  if (!state) return false;
  const connectionIdentity = engineMcpConnectionIdentity(config, workspace);
  reconcileEngineMcpWorkspaceIdentity(state, workspace.id, connectionIdentity);
  if (!connectionIdentity) return false;
  const registrationIdentity = engineMcpRegistrationIdentity(config, workspace);
  if (!registrationIdentity) {
    state.registrationByWorkspace.delete(workspace.id);
    return false;
  }
  const fingerprint = mcpRegistrationFingerprint(mcpConfig);
  if (fingerprint === null) {
    state.registrationByWorkspace.get(workspace.id)?.delete(name);
    return false;
  }
  const registrations = new Map(state.registrationByWorkspace.get(workspace.id) ?? []);
  registrations.set(name, {
    fingerprint,
    status,
    source: "engine_status",
    errorSummary: sanitizeEngineMcpRegistrationErrorSummary(liveError, status),
    registrationIdentity,
    generation: state.generation,
    recordedAt: Date.now(),
  });
  state.registrationByWorkspace.set(workspace.id, registrations);
  return true;
}

function deleteEngineMcpRegistration(
  config: ServerConfig,
  serverState: EngineMcpServerState,
  workspace: WorkspaceInfo,
  name: string,
): void {
  const state = activeEngineMcpServerState(config, serverState);
  if (!state) return;
  reconcileEngineMcpWorkspaceIdentity(state, workspace.id, engineMcpConnectionIdentity(config, workspace));
  state.registrationByWorkspace.get(workspace.id)?.delete(name);
}

function logPersistedCloudMcpReconcileResult(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  trigger: WorkspaceMcpRefreshTrigger;
  health: CloudMcpHealth;
}): void {
  if (!input.health.desired.present || input.health.usable) return;
  const failure = input.health.firstFailure;
  createServerLogger(input.config).log(
    "warn",
    `Cloud MCP ${input.trigger} reconciliation left connected service tools unavailable for workspace ${input.workspace.id}.`,
    {
      "workspace.id": input.workspace.id,
      "mcp.name": "openwork-cloud",
      "mcp.trigger": input.trigger,
      "mcp.failure.code": failure?.code ?? "unknown",
      "mcp.failure.stage": failure?.stage ?? "unknown",
      "mcp.failure.retryable": failure?.retryable ?? null,
      "mcp.failure.message": failure?.message ?? "Cloud MCP health remained unusable after reconciliation.",
    },
  );
}

function logRuntimeMcpSyncError(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  trigger: WorkspaceMcpRefreshTrigger;
  error: unknown;
}): void {
  createServerLogger(input.config).log(
    "error",
    `Runtime MCP ${input.trigger} sync crashed for workspace ${input.workspace.id}.`,
    {
      "workspace.id": input.workspace.id,
      "mcp.trigger": input.trigger,
      "mcp.failure.code": "runtime_mcp_sync_exception",
      "mcp.failure.message": input.error instanceof Error ? input.error.message : String(input.error),
    },
  );
}

function logDetachedPostEngineRefreshSyncError(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  error: unknown;
}): void {
  createServerLogger(input.config).log(
    "error",
    `Detached post-refresh MCP sync crashed for workspace ${input.workspace.id}.`,
    {
      "workspace.id": input.workspace.id,
      "mcp.trigger": "engine_reload",
      "mcp.failure.code": "detached_post_refresh_sync_exception",
      "mcp.failure.message": input.error instanceof Error ? input.error.message : String(input.error),
    },
  );
}

function logPersistedCloudMcpReconcileError(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  trigger: WorkspaceMcpRefreshTrigger;
  error: unknown;
}): void {
  createServerLogger(input.config).log(
    "error",
    `Cloud MCP ${input.trigger} reconciliation crashed for workspace ${input.workspace.id}.`,
    {
      "workspace.id": input.workspace.id,
      "mcp.name": "openwork-cloud",
      "mcp.trigger": input.trigger,
      "mcp.failure.code": "cloud_mcp_reconcile_exception",
      "mcp.failure.message": input.error instanceof Error ? input.error.message : String(input.error),
    },
  );
}

// Re-push every workspace's runtime-DB MCPs into the engine. Used at startup:
// the runtime config file injected via OPENCODE_CONFIG covers workspaces[0]
// only, so other workspaces' runtime MCPs are invisible to the engine until
// something re-syncs them. Best-effort.
export async function syncAllWorkspacesRuntimeMcpToEngine(config: ServerConfig): Promise<void> {
  await migrateOpenworkCloudMcpRuntimeConfig(config);
  await migrateWorkspaceRuntimeConfigToEngineGlobal(config);
  const serverState = activeEngineMcpServerState(config);
  for (const workspace of config.workspaces) {
    await enqueueWorkspaceMcpRefreshSync({ config, workspace, serverState, trigger: "startup" });
  }
}

// Counterpart of syncRuntimeMcpToOpencodeEngine for removals: tell the engine
// to drop the MCP's client so deleted MCPs stop serving tools immediately
// instead of lingering until the next engine restart. Best-effort.
async function disconnectMcpFromOpencodeEngine(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  name: string,
): Promise<void> {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const baseUrl = connection.baseUrl?.trim() ?? "";
  if (!baseUrl) return;

  const url = new URL(baseUrl);
  url.pathname = `/mcp/${encodeURIComponent(name)}/disconnect`;
  url.search = "";
  const directory = resolveOpencodeDirectory(workspace);
  if (directory) url.searchParams.set("directory", directory);
  const headers: Record<string, string> = {};
  if (connection.authHeader) headers.Authorization = connection.authHeader;

  // MCP disconnect targets the managed loopback engine.
  const response = await loopbackFetch(url, { method: "POST", headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const body = parseOpencodeErrorBody(await response.text());
    throw new ApiError(502, "opencode_mcp_disconnect_failed", `Failed to disconnect MCP ${name} from the engine`, {
      status: response.status,
      body,
    });
  }
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
