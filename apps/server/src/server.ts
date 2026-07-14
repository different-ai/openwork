import { existsSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { ApprovalRequest, Capabilities, ServerConfig, WorkspaceInfo, Actor, ReloadReason, ReloadTrigger, TokenScope } from "./types.js";
import { agentContextDiagnosticsRequestSchema } from "./agent-context-diagnostics-schema.js";
import { ApprovalService } from "./approvals.js";
import { addPlugin, listPlugins, normalizePluginSpec, removePlugin } from "./plugins.js";
import { sanitizePortableOpencodeConfig } from "./portable-opencode.js";
import { addMcp, listMcp, removeMcp, setMcpEnabled } from "./mcp.js";
import { exportExtensions } from "./extensions-export.js";
import { deleteSkill, listSkills, upsertSkill } from "./skills.js";
import { installHubSkill, listHubSkills } from "./skill-hub.js";
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
import { sanitizeCommandName, validateMcpName } from "./validators.js";
import { TokenService } from "./tokens.js";
import { EnvService } from "./env-file.js";
import {
  normalizeResourceSnapshot,
  readDesktopCloudSyncState,
  readWorkspaceCloudImports,
  syncDesktopCloudResources,
} from "./desktop-cloud-sync.js";
import { installCloudPlugin, readCloudPluginResolved, readInstalledCloudPlugins, removeCloudPlugin } from "./cloud-plugins.js";
import { resolveClaudePluginBundle } from "./claude-plugin-bundle.js";
import {
  applyMaterializedBlueprintSessions,
  normalizeBlueprintSessionTemplates,
  readMaterializedBlueprintSessions,
  sanitizeOpenworkTemplateConfig,
} from "./blueprint-sessions.js";
import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import { seedOpencodeSessionMessages } from "./opencode-db.js";
import { listPortableFiles } from "./portable-files.js";
import {
  buildWorkspaceImportPreview,
  normalizeWorkspaceImportPayload,
  publicWorkspaceImportPreview,
  summarizeWorkspaceImportApplied,
  summarizeWorkspaceImportPreview,
  type WorkspaceImportPlan,
  workspaceImportPreviewApprovalPaths,
} from "./workspace-import-preview.js";
import {
  collectWorkspaceExportWarnings,
  stripSensitiveWorkspaceExportData,
  type WorkspaceExportSensitiveMode,
} from "./workspace-export-safety.js";
import { serve, type ServeResult } from "./serve-node.js";
import { registerCoreRoutes } from "./routes/core.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerOperationRoutes } from "./routes/operations.js";
import { addRoute, matchRoute, type AuthMode, type RequestContext, type Route } from "./routes/registry.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerCloudMcpRoutes } from "./routes/cloud-mcp.js";
import { markOpenworkCloudMcpStale, reconcilePersistedOpenworkCloudMcp } from "./cloud-mcp-health.js";
import { runAgentContextDiagnostics } from "./agent-context-diagnostics.js";
import { createAgentDiagnosticsEngineFetch } from "./agent-context-engine-inspection.js";
import {
  mergeOpencodeConfigs,
  mergeRuntimeProviderUpdate,
  readRuntimeOpencodeConfig,
  runtimeMcpMap,
  type RuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import {
  hasOpenworkWorkspaceConfig,
  mergeOpenworkWorkspaceConfigs,
  readOpenworkWorkspaceConfig,
  seedOpenworkWorkspaceConfigIfEmpty,
  writeOpenworkWorkspaceConfig,
} from "./openwork-workspace-config-store.js";
import { buildOpenworkRuntimeConfigObject } from "./openwork-runtime-config.js";
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
const AGENT_DIAGNOSTICS_RATE_LIMIT_CAPACITY = 1_000;
const AGENT_DIAGNOSTICS_MAX_IN_FLIGHT_PER_SERVER = 16;
const AGENT_DIAGNOSTICS_MAX_REQUEST_BYTES = 256 * 1024;
const AGENT_DIAGNOSTICS_DEFAULT_BODY_DEADLINE_MS = 2_000;
const AGENT_DIAGNOSTICS_ERROR_FLUSH_MS = 25;

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

const LEGACY_RUNTIME_CONFIG_KEYS = ["plugin", "mcp", "permission", "provider"] as const;
const USER_OPENCODE_RUNTIME_CONFIG_KEYS = ["default_agent", "plugin", "mcp", "disabled_providers", "provider"] as const;

type LegacyRuntimeConfigKey = typeof LEGACY_RUNTIME_CONFIG_KEYS[number];
type UserOpencodeRuntimeConfigKey = typeof USER_OPENCODE_RUNTIME_CONFIG_KEYS[number];

function legacyRuntimeConfigFromOpenworkConfig(openwork: Record<string, unknown>): {
  config: RuntimeOpencodeConfig;
  keys: LegacyRuntimeConfigKey[];
} {
  const keys: LegacyRuntimeConfigKey[] = [];
  const plugin = Array.isArray(openwork.plugin) ? openwork.plugin.filter((item) => typeof item === "string") : [];
  const mcp: Record<string, Record<string, unknown>> = {};
  if (isRecord(openwork.mcp)) {
    for (const [name, value] of Object.entries(openwork.mcp)) {
      if (isRecord(value)) mcp[name] = value;
    }
  }
  const permission = isRecord(openwork.permission) ? openwork.permission : null;
  const externalDirectory = permission && isRecord(permission.external_directory) ? permission.external_directory : null;
  const provider = isRecord(openwork.provider) ? openwork.provider : null;

  if (plugin.length) keys.push("plugin");
  if (Object.keys(mcp).length) keys.push("mcp");
  if (externalDirectory && Object.keys(externalDirectory).length) keys.push("permission");
  if (provider && Object.keys(provider).length) keys.push("provider");

  return {
    keys,
    config: {
      ...(plugin.length ? { plugin } : {}),
      ...(Object.keys(mcp).length ? { mcp } : {}),
      ...(externalDirectory ? { permission: { external_directory: externalDirectory } } : {}),
      ...(provider ? { provider } : {}),
    },
  };
}

function removeLegacyRuntimeConfig(openwork: Record<string, unknown>): Record<string, unknown> {
  const next = { ...openwork };
  for (const key of LEGACY_RUNTIME_CONFIG_KEYS) {
    delete next[key];
  }
  return next;
}

function userRuntimeConfigFromOpencodeConfig(opencode: Record<string, unknown>): {
  config: RuntimeOpencodeConfig;
  keys: UserOpencodeRuntimeConfigKey[];
} {
  const keys: UserOpencodeRuntimeConfigKey[] = [];
  const defaultAgent = opencode.default_agent === "openwork" ? "openwork" : undefined;
  const plugin = Array.isArray(opencode.plugin) ? opencode.plugin.filter((item) => typeof item === "string") : undefined;
  const mcp: Record<string, Record<string, unknown>> = {};
  if (isRecord(opencode.mcp)) {
    for (const [name, value] of Object.entries(opencode.mcp)) {
      if (isRecord(value)) mcp[name] = value;
    }
  }
  const disabledProviders = Array.isArray(opencode.disabled_providers)
    ? opencode.disabled_providers.filter((item) => typeof item === "string")
    : undefined;
  const provider = isRecord(opencode.provider) ? opencode.provider : undefined;

  if (defaultAgent) keys.push("default_agent");
  if (Array.isArray(opencode.plugin)) keys.push("plugin");
  if (Object.keys(mcp).length) keys.push("mcp");
  if (Array.isArray(opencode.disabled_providers)) keys.push("disabled_providers");
  if (isRecord(opencode.provider)) keys.push("provider");

  return {
    keys,
    config: {
      ...(defaultAgent ? { default_agent: defaultAgent } : {}),
      ...(plugin?.length ? { plugin } : {}),
      ...(Object.keys(mcp).length ? { mcp } : {}),
      ...(disabledProviders?.length ? { disabled_providers: disabledProviders } : {}),
      ...(provider && Object.keys(provider).length ? { provider } : {}),
    },
  };
}

async function removeUserRuntimeConfigFromOpencode(workspaceRoot: string, keys: UserOpencodeRuntimeConfigKey[]): Promise<void> {
  if (!keys.length) return;
  const updates = Object.fromEntries(keys.map((key) => [key, undefined]));
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), updates);
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

function userOpencodeConfigKeys(config: Record<string, unknown>): string[] {
  return Object.keys(config).filter((key) => key !== "$schema").sort();
}

function mergeLegacyRuntimeConfig(
  current: RuntimeOpencodeConfig,
  legacy: RuntimeOpencodeConfig,
): RuntimeOpencodeConfig {
  const currentPermission = isRecord(current.permission) ? current.permission : {};
  const legacyPermission = isRecord(legacy.permission) ? legacy.permission : {};
  const currentExternalDirectory = isRecord(currentPermission.external_directory) ? currentPermission.external_directory : {};
  const legacyExternalDirectory = isRecord(legacyPermission.external_directory) ? legacyPermission.external_directory : {};
  return {
    default_agent: current.default_agent ?? legacy.default_agent,
    plugin: [
      ...(Array.isArray(current.plugin) ? current.plugin.filter((item) => typeof item === "string") : []),
      ...(Array.isArray(legacy.plugin) ? legacy.plugin.filter((item) => typeof item === "string") : []),
    ].filter((item, index, list) => list.indexOf(item) === index),
    disabled_providers: [
      ...(Array.isArray(current.disabled_providers) ? current.disabled_providers.filter((item) => typeof item === "string") : []),
      ...(Array.isArray(legacy.disabled_providers) ? legacy.disabled_providers.filter((item) => typeof item === "string") : []),
    ].filter((item, index, list) => list.indexOf(item) === index),
    mcp: {
      ...(isRecord(legacy.mcp) ? legacy.mcp : {}),
      ...(isRecord(current.mcp) ? current.mcp : {}),
    },
    permission: {
      ...legacyPermission,
      ...currentPermission,
      external_directory: {
        ...legacyExternalDirectory,
        ...currentExternalDirectory,
      },
    },
    provider: {
      ...(isRecord(legacy.provider) ? legacy.provider : {}),
      ...(isRecord(current.provider) ? current.provider : {}),
    },
  };
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
  const response = await fetch(`${config.baseUrl}/voice/realtime/session`, {
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
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
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

const LOG_LEVEL_NUMBERS: Record<LogLevel, number> = {
  info: 9,
  warn: 13,
  error: 17,
};

function toUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

export function createServerLogger(config: ServerConfig): ServerLogger {
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
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    process.stdout.write(`${message}\n`);
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
}) {
  const { logger, request, response, durationMs, authMode, proxyService, proxyBaseUrl, error } = input;
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

export async function startServer(config: ServerConfig): Promise<ServeResult> {
  const approvals = new ApprovalService(config.approval);
  const reloadEvents = new ReloadEventStore();
  const tokens = new TokenService(config);
  const env = new EnvService();
  const logger = createServerLogger(config);
  let watcherHandle = startReloadWatchers({ config, reloadEvents, logger });
  const refreshWorkspaceReloadBaseline = (workspaceId: string, reasons?: ReloadReason[]) =>
    watcherHandle.refreshWorkspace(workspaceId, reasons);
  reloadBaselineRefreshers.set(config, refreshWorkspaceReloadBaseline);
  const restartReloadWatchers = () => {
    watcherHandle.close();
    watcherHandle = startReloadWatchers({ config, reloadEvents, logger });
  };
  const engineMcpServerState = beginEngineMcpServerState(config);
  const routes = createRoutes(
    config,
    approvals,
    tokens,
    env,
    restartReloadWatchers,
    engineMcpServerState,
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
            });
        }
        return wrapped;
      };

      const proxyWorkspaceOpencodeMount = async (mount: { workspaceId: string; restPath: string }) => {
        authMode = "client";
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method, mount.restPath);
          const workspace = await resolveWorkspace(config, mount.workspaceId);
          proxyService = "opencode";
          proxyBaseUrl = workspace.baseUrl?.trim() || undefined;
          const response = await proxyOpencodeRequest({ config, request, url, workspace, proxyPath: mount.restPath });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
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
          const response = await proxyOpencodeRequest({ config, request, url, workspace: config.workspaces[0] });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      const route = matchRoute(routes, request.method, url.pathname);
      if (!route) {
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
        if (!(error instanceof ApiError)) {
          console.error("[openwork-server] Unhandled error:", error);
        }
        const apiError = error instanceof ApiError
          ? error
          : new ApiError(500, "internal_error", "Unexpected server error");
        errorMessage = apiError.message;
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
    invalidateEngineMcpServerState(config, engineMcpServerState);
    throw error;
  }

  return {
    ...server,
    stop: async () => {
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

function buildOpencodeDirectoryHeader(directory: string) {
  return /[^\x00-\x7F]/.test(directory) ? encodeURIComponent(directory) : directory;
}

function createOpencodeDirectoryFetch(directory: string, fetchImpl: typeof fetch = fetch): typeof fetch {
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
  | { data: undefined; error: E; response: Response };

function createWorkspaceOpencodeClient(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  options?: { boundedDiagnosticsReads?: boolean },
) {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const directory = resolveOpencodeDirectory(workspace);
  const baseFetch = directory ? createOpencodeDirectoryFetch(directory) : fetch;
  const clientFetch = options?.boundedDiagnosticsReads
    ? createAgentDiagnosticsEngineFetch(baseFetch)
    : directory ? baseFetch : undefined;

  return createOpencodeClient({
    baseUrl: connection.baseUrl?.trim(),
    ...(directory ? { directory } : {}),
    ...(clientFetch ? { fetch: clientFetch } : {}),
    ...(connection.authHeader ? { headers: { Authorization: connection.authHeader } } : {}),
  });
}

function unwrapOpencodeResult<T, E>(result: OpencodeClientResult<T, E>, path: string): NonNullable<T> {
  if (result.data != null) {
    return result.data;
  }
  if (result.error === undefined) {
    throw new ApiError(502, "opencode_empty_response", "OpenCode returned an empty response", { path });
  }
  throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
    status: result.response.status,
    body: result.error,
    path,
  });
}

async function proxyOpencodeRequest(input: {
  config: ServerConfig;
  request: Request;
  url: URL;
  workspace?: WorkspaceInfo;
  proxyPath?: string;
}) {
  const workspace = input.workspace;
  const baseUrl = workspace ? resolveWorkspaceOpencodeConnection(input.config, workspace).baseUrl?.trim() ?? "" : "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const proxyPath = input.proxyPath ?? input.url.pathname;
  const targetUrl = buildOpencodeProxyUrl(baseUrl, proxyPath, input.url.search);
  const headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("x-openwork-host-token");
  headers.delete("x-openwork-client-id");
  headers.delete("host");
  headers.delete("origin");

  const directory = workspace ? resolveOpencodeDirectory(workspace) : null;
  if (directory && !headers.has("x-opencode-directory")) {
    headers.set("x-opencode-directory", buildOpencodeDirectoryHeader(directory));
  }

  const auth = workspace ? resolveWorkspaceOpencodeConnection(input.config, workspace).authHeader ?? null : null;
  if (auth) {
    headers.set("Authorization", auth);
  }

  const method = input.request.method.toUpperCase();
  // Buffer the request body so it can be forwarded reliably across Node.js
  // stream boundaries (Readable.toWeb streams from the HTTP adapter aren't
  // always accepted directly by Node's global fetch as a body).
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await input.request.arrayBuffer().then((buf) => (buf.byteLength > 0 ? buf : undefined));
  if (isSessionCommandProxyRequest(method, proxyPath)) {
    void fetch(targetUrl, {
      method,
      headers,
      body,
    }).catch(() => {
      // Command failures are surfaced through the OpenCode event stream.
    });
    return jsonResponse({ ok: true, accepted: true });
  }
  const response = await fetch(targetUrl, {
    method,
    headers,
    body,
  });

  return sanitizeProxyResponse(response);
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
  const toyUiEnabled = resolveToyUiEnabled();
  const browserProvider = resolveBrowserProvider();
  const opencodeConfigured = config.workspaces.some((workspace) => Boolean(workspace.baseUrl?.trim()));
  return {
    schemaVersion,
    serverVersion: SERVER_VERSION,
    opencodeVersion: OPENCODE_VERSION,
    skills: { read: true, write: writeEnabled, source: "openwork" },
    hub: {
      skills: {
        read: true,
        install: writeEnabled,
        repo: { owner: "different-ai", name: "openwork-hub", ref: "main" },
      },
    },
    plugins: { read: true, write: writeEnabled },
    mcp: { read: true, write: writeEnabled },
    commands: { read: true, write: writeEnabled },
    config: { read: true, write: writeEnabled },

    approvals: { mode: config.approval.mode, timeoutMs: config.approval.timeoutMs },
    sandbox: { enabled: sandboxEnabled, backend: sandboxBackend },
    ui: { toy: toyUiEnabled },
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
    return Math.min(Math.trunc(parsed), 250_000_000);
  }
  return 50_000_000;
}

function resolveToyUiEnabled(): boolean {
  const raw = (process.env.OPENWORK_TOY_UI ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
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

function normalizeAuthorizedFolderPath(input: string | null | undefined): string {
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
  const withoutTrailing = unified.replace(/\/+$/, "");
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
): Route[] {
  const routes: Route[] = [];
  registerCoreRoutes({
    routes,
    config,
    tokens,
    env,
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
    serializeWorkspace,
    resolveToyUiEnabled,
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
    reloadOpencodeEngine: (routeConfig, workspace) =>
      reloadOpencodeEngine(routeConfig, workspace, engineMcpServerState),
  });

  registerSessionRoutes({
    routes,
    config,
    jsonResponse,
    parseOptionalBoolean,
    parseOptionalPositiveInteger,
    parseOptionalNonNegativeInteger,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    createWorkspaceOpencodeClient,
    unwrapOpencodeResult,
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
      const diagnosticsSignal = AbortSignal.any([ctx.request.signal, AbortSignal.timeout(24_000)]);
      const response = jsonResponse(await runAgentContextDiagnostics({
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
      response.headers.set("Cache-Control", "no-store");
      return response;
    } finally {
      releaseReservation();
    }
  });

  addRoute(routes, "GET", "/workspace/:id/config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const openwork = await readOpenworkConfigForWorkspace(config, workspace);
    const opencode = mergeOpencodeConfigs(
      await readOpencodeConfig(workspace.path),
      await readRuntimeOpencodeConfig(config, workspace.id),
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
      await readRuntimeOpencodeConfig(config, workspace.id),
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
    const runtimeOpencode = await readRuntimeOpencodeConfig(config, workspace.id);
    const existingOpencode = mergeOpencodeConfigs(persistedOpencode, runtimeOpencode);
    const existingFoldersConfig = readAuthorizedFoldersFromOpencodeConfig(existingOpencode, workspace.path);
    const nextExternalDirectory = mergeAuthorizedFoldersIntoExternalDirectory(
      folders,
      existingFoldersConfig.hiddenEntries,
    );

    await writeRuntimeOpencodeConfig(config, workspace.id, (current) => ({
      ...current,
      permission: {
        ...(ensurePlainObject(current.permission)),
        external_directory: nextExternalDirectory ?? {},
      },
    }));

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

  addRoute(routes, "POST", "/workspace/:id/runtime-config/migrate", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const configPath = openworkConfigPath(workspace.path);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.runtime_migrate",
      summary: "Migrate legacy runtime OpenCode config",
      paths: [configPath],
    });

    // Resolve the effective openwork config (DB, migrating any legacy file
    // contents in on read) so legacy runtime keys are detected wherever they
    // currently live.
    let openworkError: string | null = null;
    let openworkData: Record<string, unknown> = {};
    try {
      openworkData = await readOpenworkConfigForWorkspace(config, workspace);
    } catch (error) {
      if (error instanceof ApiError && error.code === "invalid_json") {
        openworkError = error.message;
      } else {
        throw error;
      }
    }
    const legacy = legacyRuntimeConfigFromOpenworkConfig(openworkData);
    const user = userRuntimeConfigFromOpencodeConfig(await readOpencodeConfig(workspace.path));
    if (!legacy.keys.length && !user.keys.length) {
      return jsonResponse({ migrated: false, keys: [], legacyKeys: [], userOpencodeKeys: [], updatedAt: null, legacyError: openworkError });
    }

    await writeRuntimeOpencodeConfig(config, workspace.id, (current) => (
      mergeLegacyRuntimeConfig(mergeLegacyRuntimeConfig(current, legacy.config), user.config)
    ));
    if (legacy.keys.length && !openworkError) {
      await writeOpenworkConfigForWorkspace(config, workspace, removeLegacyRuntimeConfig(openworkData), false);
    }
    await removeUserRuntimeConfigFromOpencode(workspace.path, user.keys);

    const updatedAt = Date.now();
    const keys = [...legacy.keys, ...user.keys];
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.runtime_migrate",
      target: configPath,
      summary: `Migrated runtime OpenCode config: ${keys.join(", ")}`,
      timestamp: updatedAt,
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(configPath));

    return jsonResponse({ migrated: true, keys, legacyKeys: legacy.keys, userOpencodeKeys: user.keys, updatedAt, legacyError: openworkError });
  });

  addRoute(routes, "GET", "/workspace/:id/runtime-config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const runtime = await readRuntimeOpencodeConfig(config, workspace.id);
    // Report legacy runtime keys from the effective (DB-backed) openwork config
    // so the status reflects post-migration state, while still surfacing parse
    // errors from a malformed legacy file.
    const fileStatus = await readOpenworkConfigForStatus(workspace.path);
    const effectiveOpenwork = fileStatus.error ? {} : await readOpenworkConfigForWorkspace(config, workspace);
    const legacy = legacyRuntimeConfigFromOpenworkConfig(effectiveOpenwork);
    const rawOpencode = await readRawOpencodeConfig(opencodeConfigPath(workspace.path));
    const persistedOpencode = await readOpencodeConfig(workspace.path);
    const globalOpencodePath = resolveOpencodeConfigFilePath("global", workspace.path);
    const rawGlobalOpencode = await readRawOpencodeConfig(globalOpencodePath);
    const globalOpencode = (await readJsoncFile(globalOpencodePath, {} as Record<string, unknown>, { allowInvalid: true })).data;
    const effectiveRuntime = await buildOpenworkRuntimeConfigObject(config, workspace.id);
    const user = userRuntimeConfigFromOpencodeConfig(persistedOpencode);

    return jsonResponse({
      runtime,
      runtimeKeys: runtimeConfigKeys(runtime),
      effectiveRuntime,
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
      legacyOpenwork: {
        path: openworkConfigPath(workspace.path),
        keys: legacy.keys,
        error: fileStatus.error,
      },
      userOpencode: {
        path: opencodeConfigPath(workspace.path),
        exists: rawOpencode.exists,
        keys: userOpencodeConfigKeys(persistedOpencode),
        migratableKeys: user.keys,
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
      const providerUpdate = isRecord(provider) ? provider : {};
      if (Object.keys(providerUpdate).length) {
        const currentRuntime = await readRuntimeOpencodeConfig(config, workspace.id);
        logicalUpdates.provider = mergeRuntimeProviderUpdate(currentRuntime.provider, providerUpdate);
      }

      const permissionUpdate = ensurePlainObject(permission);
      if (Object.prototype.hasOwnProperty.call(permissionUpdate, "external_directory")) {
        const existingRuntime = await readRuntimeOpencodeConfig(config, workspace.id);
        const existingPermission = ensurePlainObject(existingRuntime.permission);
        const nextExternalDirectory = permissionUpdate.external_directory;
        const existingPermissionKeys = Object.keys(existingPermission);
        const removePermissionParent =
          typeof nextExternalDirectory === "undefined" &&
            (existingPermissionKeys.length === 0 ||
            (existingPermissionKeys.length === 1 && Object.prototype.hasOwnProperty.call(existingPermission, "external_directory")));

        if (removePermissionParent) {
          logicalUpdates.permission = undefined;
        } else {
          logicalUpdates.permission = {
            ...existingPermission,
            external_directory: nextExternalDirectory,
          };
        }
      }

      if (Object.keys(logicalUpdates).length || Object.prototype.hasOwnProperty.call(logicalUpdates, "permission")) {
        const result = await writeRuntimeOpencodeConfig(config, workspace.id, (current) => ({
          ...current,
          ...logicalUpdates,
        }));
        runtimeChanged = result.changed;
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
    const changed = await addPlugin(config, workspace.id, spec);
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
    const removed = await removePlugin(config, workspace.id, name);
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

  addRoute(routes, "GET", "/hub/skills", "client", async (ctx) => {
    const owner = ctx.url.searchParams.get("owner")?.trim();
    const repo = ctx.url.searchParams.get("repo")?.trim();
    const ref = ctx.url.searchParams.get("ref")?.trim();
    const items = await listHubSkills({
      owner: owner || "different-ai",
      repo: repo || "openwork-hub",
      ref: ref || "main",
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/skills", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const items = await listSkills(workspace.path, includeGlobal);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/skills/hub/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const body = await readJsonBody(ctx.request);
    const overwrite = body?.overwrite === true;
    const repoPayload = body?.repo && typeof body.repo === "object" ? (body.repo as Record<string, unknown>) : undefined;
    const repo = repoPayload
      ? {
          owner: typeof repoPayload.owner === "string" ? repoPayload.owner : undefined,
          repo: typeof repoPayload.repo === "string" ? repoPayload.repo : undefined,
          ref: typeof repoPayload.ref === "string" ? repoPayload.ref : undefined,
        }
      : undefined;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.install_hub",
      summary: `Install hub skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });

    const result = await installHubSkill(workspace.path, { name, overwrite, repo });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.install_hub",
      target: result.path,
      summary: `Installed hub skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });

    return jsonResponse({ ok: true, ...result });
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
    const content = await readFile(item.path, "utf8");
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
    return jsonResponse({
      items,
      engineSync: engineMcpSyncStateInState(config, engineMcpServerState, workspace),
    });
  });

  // Portable export of installed skills and MCP servers (including
  // OpenWork-managed runtime MCPs that only live in the runtime DB), so
  // agents can package them into marketplace plugins. Read-only; MCP
  // secrets (headers/environment) are always redacted.
  addRoute(routes, "POST", "/workspace/:id/extensions/export", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const skills = Array.isArray(body.skills)
      ? body.skills.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const mcps = Array.isArray(body.mcps)
      ? body.mcps.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    if (skills.length === 0 && mcps.length === 0) {
      throw new ApiError(400, "invalid_payload", "At least one skill or mcp name is required");
    }
    const result = await exportExtensions({
      serverConfig: config,
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      skills,
      mcps,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/mcp", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
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
    const removed = await removeMcp(config, workspace.id, name);
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
      deleteEngineMcpRegistration(config, engineMcpServerState, workspace, name);
      await disconnectMcpFromOpencodeEngine(config, workspace, name).catch(() => undefined);
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
    const updated = await setMcpEnabled(config, workspace.id, name, enabled);
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

  addRoute(routes, "POST", "/workspace/:id/import/preview", "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const preview = await buildWorkspaceImportPreview(workspace.path, body);
    return jsonResponse(publicWorkspaceImportPreview(preview));
  });

  addRoute(routes, "POST", "/workspace/:id/import", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const expectedFingerprint = parseWorkspaceImportPreviewFingerprint(body);
    const preview = await buildWorkspaceImportPreview(workspace.path, body);
    if (expectedFingerprint && expectedFingerprint !== preview.fingerprint) {
      return jsonResponse(
        {
          ok: false,
          code: "workspace_import_preview_stale",
          message: "Workspace changed after this import was previewed. Review the latest preview before importing.",
          preview: publicWorkspaceImportPreview(preview),
        },
        409,
      );
    }
    const approvalPaths = workspaceImportPreviewApprovalPaths(preview);
    if (approvalPaths.length === 0) {
      return jsonResponse({ ok: true, preview: publicWorkspaceImportPreview(preview) });
    }
    if (!expectedFingerprint) {
      return jsonResponse(
        {
          ok: false,
          code: "workspace_import_preview_required",
          message: "Review this import preview before applying workspace changes.",
          preview: publicWorkspaceImportPreview(preview),
        },
        409,
      );
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.import",
      summary: summarizeWorkspaceImportPreview(preview),
      paths: approvalPaths,
    });
    const latestPreview = await buildWorkspaceImportPreview(workspace.path, body);
    if (latestPreview.fingerprint !== expectedFingerprint) {
      return jsonResponse(
        {
          ok: false,
          code: "workspace_import_preview_stale",
          message: "Workspace changed after this import was previewed. Review the latest preview before importing.",
          preview: publicWorkspaceImportPreview(latestPreview),
        },
        409,
      );
    }
    const configFingerprintBefore = await computeReloadFingerprint(workspace.path, "config");
    await importWorkspace(config, workspace, body, latestPreview);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.import",
      target: "workspace",
      summary: summarizeWorkspaceImportApplied(latestPreview),
      timestamp: Date.now(),
    });
    if (configFingerprintBefore !== await computeReloadFingerprint(workspace.path, "config")) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(opencodeConfigPath(workspace.path)));
    }
    return jsonResponse({ ok: true, preview: publicWorkspaceImportPreview(latestPreview) });
  });

  addRoute(routes, "POST", "/workspace/:id/blueprint/sessions/materialize", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const result = await materializeBlueprintSessions(config, workspace);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "blueprint.sessions.materialize",
      target: "workspace",
      summary: result.created.length
        ? `Materialized ${result.created.length} template starter session${result.created.length === 1 ? "" : "s"}`
        : "Checked template starter sessions",
      timestamp: Date.now(),
    });
    return jsonResponse(result);
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

async function resolveWorkspace(config: ServerConfig, id: string): Promise<WorkspaceInfo> {
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
  void reloadOpencodeEngine(config, workspace).catch(() => undefined);
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

function resolveOpencodeConfigFilePath(scope: "project" | "global", workspaceRoot: string): string {
  if (scope === "global") {
    const base = join(homedir(), ".config", "opencode");
    const jsoncPath = join(base, "opencode.jsonc");
    const jsonPath = join(base, "opencode.json");
    if (existsSync(jsoncPath)) return jsoncPath;
    if (existsSync(jsonPath)) return jsonPath;
    return jsoncPath;
  }
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
  const response = await fetch(`${control.baseUrl}${path}`, {
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

function normalizeOpencodeDirectory(directory: string): string {
  // OpenCode stores/list-filters Windows sessions by regular drive paths
  // (`C:\Users\...`). Electron can persist local workspaces as extended-length
  // paths (`\\?\C:\Users\...`); passing those through as the directory query
  // makes OpenCode return an empty session list even though the sessions exist.
  if (process.platform === "win32") {
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

async function reloadOpencodeEngine(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  serverState?: EngineMcpServerState,
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
    response = await fetch(targetUrl, { method: "POST", headers });
  } catch (error) {
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

  markOpenworkCloudMcpStale(workspace, directory);
  // Re-register runtime-DB MCPs: dispose rebuilds engine state from disk
  // configs (including the server-managed runtime config file for the
  // primary workspace), but other workspaces' runtime MCPs only reach the
  // engine through this dynamic push.
  await syncRuntimeMcpToOpencodeEngine(
    config,
    workspace,
    undefined,
    undefined,
    activeState ?? null,
  ).catch(() => undefined);
  await reconcilePersistedOpenworkCloudMcp({
    config,
    workspace,
    directory,
    serverMetadata: { serverVersion: SERVER_VERSION, expectedOpencodeVersion: OPENCODE_VERSION },
    createWorkspaceOpencodeClient,
    registerRuntimeMcp: (routeConfig, routeWorkspace, onlyNames, options) =>
      syncRuntimeMcpToOpencodeEngine(
        routeConfig,
        routeWorkspace,
        onlyNames,
        options,
        activeState ?? null,
      ),
    trigger: "engine_reload",
  }).catch(() => undefined);
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
  options?: { throwOnFailure?: boolean },
  serverState?: EngineMcpServerState | null,
): Promise<EngineMcpSyncResult> {
  const activeState = activeEngineMcpServerState(config, serverState);
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const baseUrl = connection.baseUrl?.trim() ?? "";
  const connectionIdentity = engineMcpConnectionIdentity(config, workspace);
  const registrationIdentity = engineMcpRegistrationIdentity(config, workspace);
  if (activeState) reconcileEngineMcpWorkspaceIdentity(activeState, workspace.id, connectionIdentity);
  if (!baseUrl || !connectionIdentity) {
    return { status: "skipped", syncedNames: [], failures: [] };
  }

  const runtimeConfig = await readRuntimeOpencodeConfig(config, workspace.id);
  const entries = Object.entries(runtimeMcpMap(runtimeConfig)).filter(
    ([name]) => !onlyNames || onlyNames.includes(name),
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
    const registration = await postMcpEntryWithRetry(url, headers, name, mcpConfig);
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

// POST one MCP entry to the engine, retrying once on 5xx/network errors
// (the engine is often mid-rebuild right after a dispose). 4xx responses
// are not retried — they won't change.
async function postMcpEntryWithRetry(
  url: URL,
  headers: Record<string, string>,
  name: string,
  mcpConfig: Record<string, unknown>,
): Promise<EngineMcpRegistrationResult> {
  let failure: EngineMcpSyncFailure | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, engineMcpSyncRetryDelayMs()));
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, config: mcpConfig }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        // OpenCode's dynamic registration endpoint historically treats every
        // 2xx response as accepted delivery and Cloud readiness verifies the
        // actual state by polling GET /mcp. Parse the response only as optional
        // diagnostics evidence: an absent or malformed status must fail closed
        // to `not-recorded` without turning accepted delivery into a failure.
        const status = await parseEngineMcpRegistrationStatus(response, name);
        return {
          name,
          status,
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
      if (response.status < 500) return { name, status: "failed", failure };
    } catch {
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

type EngineMcpRegistrationResult = {
  name: string;
  status: EngineMcpRegistrationStatus | null;
  failure: EngineMcpSyncFailure | null;
};

async function parseEngineMcpRegistrationStatus(
  response: Response,
  name: string,
): Promise<EngineMcpRegistrationStatus | null> {
  let text: string;
  try {
    text = await readBoundedEngineMcpRegistrationResponse(response);
  } catch {
    return null;
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(body) || !Object.hasOwn(body, name)) return null;
  const entry = body[name];
  if (!isRecord(entry)) return null;
  switch (entry.status) {
    case "connected":
    case "disabled":
    case "failed":
      return entry.status;
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
  registrationByWorkspace: Map<string, Map<string, EngineMcpRegistrationRecord>>;
  engineIdentityByWorkspace: Map<string, string>;
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
  state.syncStateByWorkspace.clear();
  state.registrationByWorkspace.clear();
  state.engineIdentityByWorkspace.clear();
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
  if (previous) invalidateEngineMcpServerState(config, previous);
  const state: EngineMcpServerState = {
    generation: ++nextEngineMcpServerGeneration,
    syncStateByWorkspace: new Map(),
    registrationByWorkspace: new Map(),
    engineIdentityByWorkspace: new Map(),
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
  state.syncStateByWorkspace.delete(workspaceId);
  state.registrationByWorkspace.delete(workspaceId);
  state.engineIdentityByWorkspace.delete(workspaceId);
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
  const statusByName = new Map(result.registrations?.map((registration) => [registration.name, registration.status]));
  for (const [name, mcpConfig] of result.entries) {
    const fingerprint = mcpRegistrationFingerprint(mcpConfig);
    const status = statusByName.get(name);
    if (fingerprint === null || !status) {
      registrations.delete(name);
      continue;
    }
    registrations.set(name, {
      fingerprint,
      status,
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
): EngineMcpRegistrationStatus | "not-recorded" {
  const state = activeEngineMcpServerState(config, serverState);
  if (!state) return "not-recorded";
  const connectionIdentity = engineMcpConnectionIdentity(config, workspace);
  reconcileEngineMcpWorkspaceIdentity(state, workspace.id, connectionIdentity);
  if (!connectionIdentity) return "not-recorded";
  const registrationIdentity = engineMcpRegistrationIdentity(config, workspace);
  if (!registrationIdentity) {
    state.registrationByWorkspace.delete(workspace.id);
    return "not-recorded";
  }
  const registrations = state.registrationByWorkspace.get(workspace.id);
  const registration = registrations?.get(name);
  if (!registration) return "not-recorded";
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
    return "not-recorded";
  }
  return registration.status;
}

export function inspectEngineMcpRegistration(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  name: string,
  mcpConfig: Record<string, unknown>,
): EngineMcpRegistrationStatus | "not-recorded" {
  const state = activeEngineMcpServerState(config);
  if (!state) return "not-recorded";
  return inspectEngineMcpRegistrationInState(config, state, workspace, name, mcpConfig);
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

// Re-push every workspace's runtime-DB MCPs into the engine. Used at startup:
// the runtime config file injected via OPENCODE_CONFIG covers workspaces[0]
// only, so other workspaces' runtime MCPs are invisible to the engine until
// something re-syncs them. Best-effort.
export async function syncAllWorkspacesRuntimeMcpToEngine(config: ServerConfig): Promise<void> {
  const serverState = activeEngineMcpServerState(config) ?? null;
  for (const workspace of config.workspaces) {
    await syncRuntimeMcpToOpencodeEngine(
      config,
      workspace,
      undefined,
      undefined,
      serverState,
    ).catch(() => undefined);
    await reconcilePersistedOpenworkCloudMcp({
      config,
      workspace,
      directory: resolveOpencodeDirectory(workspace),
      serverMetadata: { serverVersion: SERVER_VERSION, expectedOpencodeVersion: OPENCODE_VERSION },
      createWorkspaceOpencodeClient,
      registerRuntimeMcp: (routeConfig, routeWorkspace, onlyNames, options) =>
        syncRuntimeMcpToOpencodeEngine(
          routeConfig,
          routeWorkspace,
          onlyNames,
          options,
          serverState,
        ),
      trigger: "startup",
    }).catch(() => undefined);
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

  const response = await fetch(url, { method: "POST", headers, signal: AbortSignal.timeout(15_000) });
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

function parseWorkspaceImportPreviewFingerprint(payload: Record<string, unknown>): string | null {
  const value = payload.previewFingerprint;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(
      400,
      "invalid_workspace_import_preview_fingerprint",
      "Workspace import preview fingerprint must be a string",
    );
  }
  return value;
}

function workspaceImportRelativePath(workspace: WorkspaceInfo, path: string): string {
  return relative(workspace.path, path).replaceAll("\\", "/");
}

async function importWorkspace(config: ServerConfig, workspace: WorkspaceInfo, payload: Record<string, unknown>, preview: WorkspaceImportPlan): Promise<void> {
  const input = normalizeWorkspaceImportPayload(workspace.path, payload);
  const changed = new Set(
    preview.changes
      .filter((change) => change.action !== "unchanged")
      .map((change) => `${change.kind}:${change.path}`),
  );
  const changedPath = (kind: string, path: string) => changed.has(`${kind}:${path}`);

  if (
    input.opencode !== undefined &&
    changedPath("opencode", workspaceImportRelativePath(workspace, opencodeConfigPath(workspace.path)))
  ) {
    if (input.modes.opencode === "replace") {
      await writeJsoncFile(opencodeConfigPath(workspace.path), input.opencode);
    } else {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), input.opencode);
    }
  }

  if (
    input.openwork !== undefined &&
    changedPath("openwork", workspaceImportRelativePath(workspace, openworkConfigPath(workspace.path)))
  ) {
    if (input.modes.openwork === "replace") {
      await writeOpenworkConfigForWorkspace(config, workspace, input.openwork, false);
    } else {
      await writeOpenworkConfigForWorkspace(config, workspace, input.openwork, true);
    }
  }

  if (input.sections.skills) {
    for (const skill of input.skills) {
      const path = workspaceImportRelativePath(workspace, join(projectSkillsDir(workspace.path), skill.name, "SKILL.md"));
      if (!changedPath("skill", path)) continue;
      await upsertSkill(workspace.path, skill);
    }
    if (input.modes.skills === "replace") {
      for (const change of preview.changes) {
        if (change.kind === "skill" && change.action === "delete") {
          await rm(change.absolutePath, { recursive: true, force: true });
        }
      }
    }
  }

  if (input.sections.commands) {
    for (const command of input.commands) {
      const path = workspaceImportRelativePath(workspace, join(projectCommandsDir(workspace.path), `${command.name}.md`));
      if (!changedPath("command", path)) continue;
      await upsertCommand(workspace.path, command);
    }
    if (input.modes.commands === "replace") {
      for (const change of preview.changes) {
        if (change.kind === "command" && change.action === "delete") {
          await rm(change.absolutePath, { force: true });
        }
      }
    }
  }

  if (input.sections.files) {
    for (const file of input.files) {
      if (!changedPath("file", file.path)) continue;
      const path = join(workspace.path, file.path);
      await ensureDir(dirname(path));
      await writeFile(path, file.content, "utf8");
    }
    if (input.modes.files === "replace") {
      for (const change of preview.changes) {
        if (change.kind === "file" && change.action === "delete") {
          await rm(change.absolutePath, { force: true });
        }
      }
    }
  }
}

async function materializeBlueprintSessions(config: ServerConfig, workspace: WorkspaceInfo): Promise<{
  ok: boolean;
  created: Array<{ templateId: string; sessionId: string; title: string }>;
  existing: Array<{ templateId: string; sessionId: string }>;
  openSessionId: string | null;
}> {
  const openwork = await readOpenworkConfigForWorkspace(config, workspace);
  const templates = normalizeBlueprintSessionTemplates(openwork);
  if (!templates.length) {
    return { ok: true, created: [], existing: [], openSessionId: null };
  }

  const existing = readMaterializedBlueprintSessions(openwork);
  if (existing.length > 0) {
    const preferredTemplate = templates.find((template) => template.openOnFirstLoad) ?? templates[0] ?? null;
    const openSessionId = preferredTemplate
      ? existing.find((item) => item.templateId === preferredTemplate.id)?.sessionId ?? existing[0]?.sessionId ?? null
      : existing[0]?.sessionId ?? null;
    return { ok: true, created: [], existing, openSessionId };
  }

  const created: Array<{ templateId: string; sessionId: string; title: string }> = [];
  const opencode = createWorkspaceOpencodeClient(config, workspace);
  for (const template of templates) {
    const result = unwrapOpencodeResult(await opencode.session.create({ title: template.title }), "/session");
    const sessionId =
      result && typeof result === "object" && "id" in result && typeof result.id === "string" ? result.id.trim() : "";
    if (!sessionId) {
      throw new ApiError(502, "opencode_failed", "OpenCode session did not return an id");
    }
    seedOpencodeSessionMessages({
      sessionId,
      workspaceRoot: resolveOpencodeDirectory(workspace) ?? workspace.path,
      messages: template.messages,
    });
    created.push({ templateId: template.id, sessionId, title: template.title });
  }

  const now = Date.now();
  const nextOpenwork = applyMaterializedBlueprintSessions(
    openwork,
    created.map(({ templateId, sessionId }) => ({ templateId, sessionId })),
    now,
  );
  await writeOpenworkConfigForWorkspace(config, workspace, nextOpenwork, false);

  const preferredTemplate = templates.find((template) => template.openOnFirstLoad) ?? templates[0] ?? null;
  const openSessionId = preferredTemplate
    ? created.find((item) => item.templateId === preferredTemplate.id)?.sessionId ?? created[0]?.sessionId ?? null
    : created[0]?.sessionId ?? null;

  return { ok: true, created, existing: [], openSessionId };
}
