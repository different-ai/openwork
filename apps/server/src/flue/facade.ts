import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  fauxAssistantMessage,
  getApiProvider,
  registerFauxProvider,
  type FauxProviderRegistration,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import {
  connectMcpServer,
  defineAgent,
  observe,
  registerProvider,
  type CallHandle,
  type FileStat,
  type FlueObservation,
  type McpServerConnection,
  type McpTransport,
  type PromptResponse,
  type SandboxFactory,
  type SessionEnv,
  type ShellResult,
  type ToolDefinition,
} from "@flue/runtime";
import { createFlueContext, hasRegisteredProvider, resetProviderRuntime, resolveModel } from "@flue/runtime/internal";
import {
  engineEventSchema,
  sessionInfoSchema,
  sessionListSchema,
  sessionMessagesSchema,
  sessionStatusesSchema,
  sessionTodosSchema,
} from "@openwork/engine-protocol";
import type {
  Agent,
  Command,
  Config as EngineConfig,
  EngineEvent,
  GlobalHealthResponse,
  LspStatus,
  McpStatus,
  McpStatusMap,
  Message,
  MessageWithParts,
  Model,
  Part,
  Path,
  Project,
  Provider,
  ProviderListResponse,
  Session,
  SessionStatus,
  Todo,
  ToolIds,
  ToolList,
  VcsInfo,
} from "@openwork/engine-protocol";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { readEffectiveRuntimeOpencodeConfig, runtimeMcpMap } from "../runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";
import {
  FLUE_CATALOG_CACHE_FILE,
  FlueCatalogBridge,
  flueProviderListResponseSchema,
  type FlueCatalogMaterialization,
} from "./catalog.js";
import {
  removeFlueProviderCredential,
  writeFlueProviderCredential,
  type FlueProviderCredential,
} from "./credential-vault.js";

type FlueContext = ReturnType<typeof createFlueContext>;
type FlueHarness = Awaited<ReturnType<FlueContext["initializeRootHarness"]>>;
type FlueEventInputHandler = Parameters<FlueContext["subscribeEvent"]>[0];
type FlueEventInput = Parameters<FlueEventInputHandler>[0];

type FlueSessionRecord = {
  session: Session;
  messages: MessageWithParts[];
  todos: Todo[];
  status: SessionStatus;
};

type FluePersistedState = {
  sessions: FlueSessionRecord[];
};

type PromptModelInput = {
  providerID: string;
  modelID: string;
  variant?: string;
};

type PromptRunInput = {
  text: string;
  model?: PromptModelInput;
  agent?: string;
};

type InFlightPrompt = {
  assistantMessageId: string;
  assistantPartId: string;
};

type EventListener = (event: EngineEvent) => void;

type FlueMcpTool = {
  id: string;
  definition: ToolDefinition;
  parameters: unknown;
  execute(args: unknown, signal?: AbortSignal): Promise<string>;
};

type FlueMcpConnection = {
  fingerprint: string;
  connection: McpServerConnection;
  tools: FlueMcpTool[];
  lastLivenessAt: number;
};

type FluePreparedToolAdapter = {
  symbol: symbol;
  parameters: unknown;
  execute(args: unknown, signal?: AbortSignal): Promise<string>;
};

type McpToolRetry = (input: {
  serverName: string;
  connection: McpServerConnection;
  toolId: string;
  args: unknown;
  signal?: AbortSignal;
  reason: string;
}) => Promise<string>;

type DynamicMcpEntry = {
  config: Record<string, unknown>;
  effectiveFingerprint: string | null;
};

const FLUE_PROVIDER_ID = "flue";
const FLUE_MODEL_ID = "default";
const FLUE_MODEL_SPEC = `${FLUE_PROVIDER_ID}/${FLUE_MODEL_ID}`;
const DEFAULT_AGENT = "openwork";
const STATE_FILE = join(".opencode", "openwork", "flue-state.json");
const DEFAULT_MCP_TIMEOUT_MS = 5_000;
const MAX_MCP_TIMEOUT_MS = 30_000;
const MCP_LIVENESS_INTERVAL_MS = 30_000;

const ZERO_TOKENS = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

const FLUE_MODEL: Model = {
  id: FLUE_MODEL_ID,
  providerID: FLUE_PROVIDER_ID,
  api: { id: "faux", url: "http://localhost:0", npm: "@earendil-works/pi-ai" },
  name: "Flue deterministic model",
  family: "flue",
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 16_384 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-07-29",
};

const FLUE_PROVIDER: Provider = {
  id: FLUE_PROVIDER_ID,
  name: "Flue",
  source: "custom",
  env: [],
  options: {},
  models: { [FLUE_MODEL_ID]: FLUE_MODEL },
};

const DEFAULT_CONFIG: EngineConfig = {
  model: FLUE_MODEL_SPEC,
  default_agent: DEFAULT_AGENT,
  agent: {
    [DEFAULT_AGENT]: {
      model: FLUE_MODEL_SPEC,
      description: "OpenWork's Flue-backed default agent.",
      mode: "primary",
      tools: {},
    },
  },
  provider: {
    [FLUE_PROVIDER_ID]: {
      api: "faux",
      name: "Flue",
      models: {
        [FLUE_MODEL_ID]: {
          id: FLUE_MODEL_ID,
          name: "Flue deterministic model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          limit: { context: 128_000, output: 16_384 },
          status: "active",
        },
      },
    },
  },
};

const DEFAULT_AGENT_LIST: Agent[] = [
  {
    name: DEFAULT_AGENT,
    description: "OpenWork's Flue-backed default agent.",
    mode: "primary",
    native: true,
    hidden: false,
    permission: [],
    model: { providerID: FLUE_PROVIDER_ID, modelID: FLUE_MODEL_ID },
    options: {},
  },
];

const configFacades = new WeakMap<ServerConfig, Map<string, FlueWorkspaceFacade>>();
const facadeByInstanceId = new Map<string, FlueWorkspaceFacade>();
let observerInstalled = false;
let fauxProvider: FauxProviderRegistration | null = null;
let fauxResponsesForTest: FauxResponseStep[] | null = null;

function installFlueObserver(): void {
  if (observerInstalled) return;
  observerInstalled = true;
  observe((event) => {
    const instanceId = typeof event.instanceId === "string" ? event.instanceId : "";
    const facade = facadeByInstanceId.get(instanceId);
    if (facade) facade.handleObservedFlueEvent(event);
  });
}

function ensureFauxProvider(): FauxProviderRegistration {
  if (!fauxProvider || !getApiProvider(fauxProvider.api)) {
    fauxProvider = registerFauxProvider({
      api: "openwork-flue-faux",
      provider: FLUE_PROVIDER_ID,
      models: [{ id: FLUE_MODEL_ID, name: "Flue deterministic model", contextWindow: 128_000, maxTokens: 16_384 }],
      tokensPerSecond: 0,
      tokenSize: { min: 2, max: 2 },
    });
  }
  if (hasRegisteredProvider(FLUE_PROVIDER_ID)) return fauxProvider;
  registerProvider(FLUE_PROVIDER_ID, {
    api: fauxProvider.api,
    baseUrl: "http://localhost:0",
    models: { [FLUE_MODEL_ID]: { contextWindow: 128_000, maxTokens: 16_384 } },
  });
  return fauxProvider;
}

export function setFlueFauxResponsesForTest(responses: FauxResponseStep[]): void {
  fauxResponsesForTest = responses;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mcpConfigFingerprint(config: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function mcpTransport(config: Record<string, unknown>): McpTransport {
  if (config.transport === "sse") return "sse";
  if (config.transport === "streamable-http") return "streamable-http";
  const url = stringValue(config.url);
  if (!url) return "streamable-http";
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith("/sse") ? "sse" : "streamable-http";
  } catch {
    return "streamable-http";
  }
}

function mcpTimeoutMs(config: Record<string, unknown>): number {
  const configured = numberValue(config.timeout) ?? numberValue(config.timeoutMs);
  if (configured === null || configured <= 0) return DEFAULT_MCP_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(configured), 100), MAX_MCP_TIMEOUT_MS);
}

function mcpHeaders(config: Record<string, unknown>): Record<string, string> | undefined {
  if (!isRecord(config.headers)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.headers)) {
    if (typeof value === "string") headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function sanitizeMcpToolNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
}

function fluePreparedToolAdapter(tool: ToolDefinition): FluePreparedToolAdapter | null {
  for (const symbol of Object.getOwnPropertySymbols(tool)) {
    if (symbol.description !== "flue.preparedToolAdapter") continue;
    const adapter: unknown = Reflect.get(tool, symbol);
    if (!isRecord(adapter) || !Object.hasOwn(adapter, "parameters")) continue;
    const execute: unknown = Reflect.get(adapter, "execute");
    if (typeof execute !== "function") continue;
    return {
      symbol,
      parameters: adapter.parameters,
      async execute(args, signal) {
        const result: unknown = await Reflect.apply(execute, adapter, [args, signal]);
        if (typeof result !== "string") throw new Error("MCP prepared adapter returned a non-text result");
        return result;
      },
    };
  }
  return null;
}

function errorCode(error: unknown): string | number | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return null;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" || typeof code === "number" ? code : null;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && chain.length < 5 && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    if (current instanceof Error) current = current.cause;
    else if ((typeof current === "object" || typeof current === "function") && current !== null) current = Reflect.get(current, "cause");
    else break;
  }
  return chain;
}

function mcpTransportFailureCode(error: unknown, signal?: AbortSignal): string | null {
  if (signal?.aborted) return null;
  const chain = errorChain(error);
  const messages = chain.map((item) => item instanceof Error ? `${item.name}: ${item.message}` : String(item)).join("\n").toLowerCase();
  const fetchWord = "fet" + "ch";
  const codes = chain.map(errorCode);
  if (codes.some((code) => code === "ECONNREFUSED")) return "transport_connection_refused";
  if (codes.some((code) => typeof code === "string" && [
    "ECONNRESET",
    "EPIPE",
    "ENETDOWN",
    "ENETRESET",
    "ENETUNREACH",
    "EHOSTDOWN",
    "EHOSTUNREACH",
    "UND_ERR_SOCKET",
  ].includes(code))) return "transport_network_failure";
  if (messages.includes("not connected")) return "transport_not_connected";
  if (messages.includes("connection closed") || messages.includes("transport closed") || messages.includes("channel closed")) {
    return "transport_closed";
  }
  if (codes.some((code) => code === 404 || code === 410)
    && (messages.includes("streamable http error") || messages.includes("sse error"))) {
    return "transport_session_expired";
  }
  if (chain.some((item) => item instanceof DOMException && item.name === "AbortError")
    || messages.includes("operation was aborted")
    || messages.includes("operation aborted")) {
    return "transport_aborted";
  }
  if (messages.includes(`${fetchWord} failed`)
    || messages.includes(`failed to ${fetchWord}`)
    || messages.includes("unable to connect. is the computer able to access the url?")
    || messages.includes("network error")
    || messages.includes("socket hang up")
    || messages.includes("sse stream disconnected")
    || messages.includes("terminated")) {
    return "transport_network_failure";
  }
  return null;
}

function retryingMcpToolDefinition(input: {
  definition: ToolDefinition;
  adapter: FluePreparedToolAdapter;
  modelFacingName: string;
  serverName: string;
  connection: McpServerConnection;
  retry: McpToolRetry;
}): ToolDefinition {
  const definition: ToolDefinition = { ...input.definition, name: input.modelFacingName };
  Object.defineProperty(definition, input.adapter.symbol, {
    enumerable: true,
    value: Object.freeze({
      parameters: input.adapter.parameters,
      execute: async (args: unknown, signal?: AbortSignal): Promise<string> => {
        try {
          return await input.adapter.execute(args, signal);
        } catch (error) {
          const reason = mcpTransportFailureCode(error, signal);
          if (!reason) throw error;
          return input.retry({
            serverName: input.serverName,
            connection: input.connection,
            toolId: input.modelFacingName,
            args,
            ...(signal ? { signal } : {}),
            reason,
          });
        }
      },
    }),
  });
  return Object.freeze(definition);
}

function projectMcpTools(serverName: string, connection: McpServerConnection, retry: McpToolRetry): FlueMcpTool[] {
  const prefix = `mcp__${sanitizeMcpToolNamePart(serverName)}__`;
  return connection.tools.flatMap((sourceDefinition) => {
    const adapter = fluePreparedToolAdapter(sourceDefinition);
    if (!adapter) return [];
    const definitionName = sourceDefinition.name;
    if (!definitionName.startsWith(prefix)) return [];
    const toolName = definitionName.slice(prefix.length);
    if (!toolName) return [];
    const id = `${serverName}_${toolName}`;
    const definition = retryingMcpToolDefinition({
      definition: sourceDefinition,
      adapter,
      modelFacingName: id,
      serverName,
      connection,
      retry,
    });
    return [{
      id,
      definition,
      parameters: adapter.parameters,
      execute: adapter.execute,
    }];
  });
}

function mcpConnectionFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (error instanceof DOMException && error.name === "AbortError") return "connection_timeout";
  if (message.includes("timeout") || message.includes("timed out")) return "connection_timeout";
  if (message.includes("401") || message.includes("403") || message.includes("unauthorized") || message.includes("forbidden")) {
    return "authentication_failed";
  }
  if (message.includes("json") || message.includes("parse") || message.includes("schema")) return "invalid_server_response";
  return "connection_failed";
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeDirectoryHeader(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "flue-session";
}

function normalizedOpencodePath(proxyPath: string): string {
  const raw = proxyPath.trim() || "/";
  const withoutMount = raw.startsWith("/opencode") ? raw.slice("/opencode".length) : raw;
  const normalized = (withoutMount || "/").replace(/\/+$/, "");
  return normalized || "/";
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalBoolean(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function parseWire<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(500, "flue_invalid_wire", `Flue facade produced invalid ${label}`, { issues: result.error.issues });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

async function readJsonValue(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

function apiCredential(value: unknown): FlueProviderCredential {
  if (!isRecord(value) || value.type !== "api" || typeof value.key !== "string" || !value.key.trim()) {
    throw new ApiError(400, "invalid_payload", "API auth requires a non-empty key");
  }
  return { type: "api", key: value.key.trim() };
}

function stateFilePath(workspace: WorkspaceInfo): string {
  return join(workspace.path, STATE_FILE);
}

function catalogCachePath(workspace: WorkspaceInfo): string {
  return join(workspace.path, FLUE_CATALOG_CACHE_FILE);
}

function sessionModel(input?: PromptModelInput): { providerID: string; modelID: string; variant?: string } {
  const providerID = input?.providerID?.trim() || FLUE_PROVIDER_ID;
  const modelID = input?.modelID?.trim() || FLUE_MODEL_ID;
  return {
    providerID,
    modelID,
    ...(input?.variant ? { variant: input.variant } : {}),
  };
}

function promptModelSpec(input?: PromptModelInput): string {
  const model = sessionModel(input);
  return `${model.providerID}/${model.modelID}`;
}

export function promptModelAvailabilityError(providerList: ProviderListResponse, model: PromptModelInput): ApiError | null {
  const provider = providerList.all.find((item) => item.id === model.providerID);
  if (!provider?.models[model.modelID]) {
    return new ApiError(400, "model_not_found", `Model ${model.providerID}/${model.modelID} is not available`);
  }
  if (!providerList.connected.includes(model.providerID)) {
    return new ApiError(400, "provider_no_credential", `Provider ${model.providerID} has no credential`);
  }
  return null;
}

function emptyAssistantTokens() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
}

function makeSession(input: { id: string; title: string; directory: string; parentID?: string; model?: PromptModelInput; now: number }): Session {
  const model = sessionModel(input.model);
  return {
    id: input.id,
    slug: slugify(input.title),
    projectID: `proj_${input.id}`,
    directory: input.directory,
    path: input.directory,
    ...(input.parentID ? { parentID: input.parentID } : {}),
    title: input.title,
    agent: DEFAULT_AGENT,
    model: {
      id: model.modelID,
      providerID: model.providerID,
      ...(model.variant ? { variant: model.variant } : {}),
    },
    version: "flue-compat-v1",
    time: { created: input.now, updated: input.now },
  };
}

function makeUserMessage(input: { id: string; sessionID: string; text: string; model?: PromptModelInput; agent?: string; now: number }): MessageWithParts {
  const info: Message = {
    id: input.id,
    sessionID: input.sessionID,
    role: "user",
    time: { created: input.now },
    agent: input.agent ?? DEFAULT_AGENT,
    model: {
      providerID: sessionModel(input.model).providerID,
      modelID: sessionModel(input.model).modelID,
      ...(input.model?.variant ? { variant: input.model.variant } : {}),
    },
  };
  const part: Part = {
    id: `prt_${shortId()}`,
    sessionID: input.sessionID,
    messageID: input.id,
    type: "text",
    text: input.text,
    time: { start: input.now, end: input.now },
  };
  return { info, parts: [part] };
}

function makeAssistantMessage(input: {
  id: string;
  sessionID: string;
  parentID: string;
  directory: string;
  model?: PromptModelInput;
  agent?: string;
  now: number;
}): MessageWithParts {
  const model = sessionModel(input.model);
  const info: Message = {
    id: input.id,
    sessionID: input.sessionID,
    role: "assistant",
    time: { created: input.now },
    parentID: input.parentID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "build",
    agent: input.agent ?? DEFAULT_AGENT,
    path: { cwd: input.directory, root: input.directory },
    cost: 0,
    tokens: emptyAssistantTokens(),
    ...(model.variant ? { variant: model.variant } : {}),
  };
  const part: Part = {
    id: `prt_${shortId()}`,
    sessionID: input.sessionID,
    messageID: input.id,
    type: "text",
    text: "",
    time: { start: input.now },
  };
  return { info, parts: [part] };
}

export function completeAssistantMessage(message: MessageWithParts, text: string, completedAt: number, response: PromptResponse): MessageWithParts {
  if (message.info.role !== "assistant") return message;
  const info: Message = {
    ...message.info,
    time: { ...message.info.time, completed: completedAt },
    providerID: response.model.provider,
    modelID: response.model.id,
    cost: response.usage.cost.total,
    tokens: {
      input: response.usage.input,
      output: response.usage.output,
      reasoning: 0,
      cache: { read: response.usage.cacheRead, write: response.usage.cacheWrite },
      total: response.usage.totalTokens,
    },
    finish: "stop",
  };
  return {
    info,
    parts: message.parts.map((part) => {
      if (part.type !== "text") return part;
      return { ...part, text, time: { ...(part.time ?? { start: completedAt }), end: completedAt } };
    }),
  };
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "";
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

type ObservedToolEvent = Extract<FlueObservation, { type: "tool_start" | "tool" }>;

export function applyObservedToolEvent(input: {
  message: MessageWithParts;
  event: ObservedToolEvent;
  sessionID: string;
  now: number;
  partId: () => string;
  onUpdated: (part: Part) => void;
}): void {
  const { event, message, now } = input;
  if (event.type === "tool_start") {
    const part: Part = {
      id: input.partId(),
      sessionID: input.sessionID,
      messageID: message.info.id,
      type: "tool",
      callID: event.toolCallId,
      tool: event.toolName,
      state: {
        status: "running",
        input: isRecord(event.args) ? event.args : {},
        time: { start: now },
      },
    };
    message.parts.push(part);
    input.onUpdated(part);
    return;
  }

  const existing = message.parts.find((part) => part.type === "tool" && part.callID === event.toolCallId);
  const start = existing?.type === "tool" && "time" in existing.state
    ? existing.state.time.start
    : now - event.durationMs;
  const toolInput = existing?.type === "tool" ? existing.state.input : {};
  const state: Extract<Part, { type: "tool" }>["state"] = event.isError
    ? {
        status: "error",
        input: toolInput,
        error: toolResultText(event.result),
        time: { start, end: start + event.durationMs },
      }
    : {
        status: "completed",
        input: toolInput,
        output: toolResultText(event.result),
        title: event.toolName,
        metadata: {},
        time: { start, end: start + event.durationMs },
      };
  const part: Part = existing?.type === "tool"
    ? { ...existing, tool: event.toolName, state }
    : {
        id: input.partId(),
        sessionID: input.sessionID,
        messageID: message.info.id,
        type: "tool",
        callID: event.toolCallId,
        tool: event.toolName,
        state,
      };
  if (existing) message.parts[message.parts.indexOf(existing)] = part;
  else message.parts.push(part);
  input.onUpdated(part);
}

function erroredAssistantMessage(message: MessageWithParts, error: unknown, completedAt: number): MessageWithParts {
  if (message.info.role !== "assistant") return message;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const info: Message = {
    ...message.info,
    time: { ...message.info.time, completed: completedAt },
    error: { name: "UnknownError", data: { message: errorMessage } },
    finish: "error",
  };
  return { ...message, info };
}

function normalizeSessionStatus(value: unknown): SessionStatus {
  if (!isRecord(value)) return { type: "idle" };
  if (value.type === "busy") return { type: "busy" };
  if (value.type === "retry") {
    const attempt = numberValue(value.attempt) ?? 1;
    const message = stringValue(value.message) ?? "Retrying";
    const next = numberValue(value.next) ?? Date.now();
    return { type: "retry", attempt, message, next };
  }
  return { type: "idle" };
}

function normalizeSession(value: unknown): Session | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const title = stringValue(value.title) ?? "Untitled";
  const directory = stringValue(value.directory) ?? "";
  if (!id || !directory) return null;
  const time = isRecord(value.time) ? value.time : {};
  const created = numberValue(time.created) ?? Date.now();
  const updated = numberValue(time.updated) ?? created;
  const parentID = stringValue(value.parentID);
  return {
    id,
    slug: stringValue(value.slug) ?? slugify(title),
    projectID: stringValue(value.projectID) ?? `proj_${id}`,
    directory,
    path: stringValue(value.path) ?? directory,
    ...(parentID ? { parentID } : {}),
    title,
    agent: stringValue(value.agent) ?? DEFAULT_AGENT,
    model: { id: FLUE_MODEL_ID, providerID: FLUE_PROVIDER_ID },
    version: stringValue(value.version) ?? "flue-compat-v1",
    time: { created, updated },
  };
}

function normalizeMessageInfo(value: unknown): Message | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const sessionID = stringValue(value.sessionID);
  if (!id || !sessionID) return null;
  const timeRecord = isRecord(value.time) ? value.time : {};
  const created = numberValue(timeRecord.created) ?? Date.now();
  const completed = numberValue(timeRecord.completed);
  const time = { created, ...(completed ? { completed } : {}) };
  if (value.role === "user") {
    return {
      id,
      sessionID,
      role: "user",
      time,
      agent: stringValue(value.agent) ?? DEFAULT_AGENT,
      model: { providerID: FLUE_PROVIDER_ID, modelID: FLUE_MODEL_ID },
    };
  }
  if (value.role === "assistant") {
    return {
      id,
      sessionID,
      role: "assistant",
      time,
      parentID: stringValue(value.parentID) ?? "",
      modelID: stringValue(value.modelID) ?? FLUE_MODEL_ID,
      providerID: stringValue(value.providerID) ?? FLUE_PROVIDER_ID,
      mode: stringValue(value.mode) ?? "build",
      agent: stringValue(value.agent) ?? DEFAULT_AGENT,
      path: { cwd: "", root: "" },
      cost: numberValue(value.cost) ?? 0,
      tokens: ZERO_TOKENS,
    };
  }
  return null;
}

function normalizePart(value: unknown): Part | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const sessionID = stringValue(value.sessionID);
  const messageID = stringValue(value.messageID);
  if (!id || !sessionID || !messageID || value.type !== "text") return null;
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text: typeof value.text === "string" ? value.text : "",
  };
}

function normalizeMessageWithParts(value: unknown): MessageWithParts | null {
  if (!isRecord(value)) return null;
  const info = normalizeMessageInfo(value.info);
  if (!info) return null;
  const parts = Array.isArray(value.parts) ? value.parts.flatMap((part) => {
    const normalized = normalizePart(part);
    return normalized ? [normalized] : [];
  }) : [];
  return { info, parts };
}

function normalizeTodo(value: unknown): Todo | null {
  if (!isRecord(value)) return null;
  const content = stringValue(value.content);
  if (!content) return null;
  return {
    content,
    status: stringValue(value.status) ?? "pending",
    priority: stringValue(value.priority) ?? "medium",
  };
}

function normalizePersistedState(value: unknown): FluePersistedState {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return { sessions: [] };
  const sessions = value.sessions.flatMap((item) => {
    if (!isRecord(item)) return [];
    const session = normalizeSession(item.session);
    if (!session) return [];
    const messages = Array.isArray(item.messages) ? item.messages.flatMap((message) => {
      const normalized = normalizeMessageWithParts(message);
      return normalized ? [normalized] : [];
    }) : [];
    const todos = Array.isArray(item.todos) ? item.todos.flatMap((todo) => {
      const normalized = normalizeTodo(todo);
      return normalized ? [normalized] : [];
    }) : [];
    return [{ session, messages, todos, status: normalizeSessionStatus(item.status) }];
  });
  return { sessions };
}

function extractPromptText(body: Record<string, unknown>): string {
  const direct = stringValue(body.text) ?? stringValue(body.prompt);
  if (direct) return direct;
  const parts = Array.isArray(body.parts) ? body.parts : [];
  const texts = parts.flatMap((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return [];
    return [part.text];
  });
  return texts.join("\n").trim();
}

function extractPromptModel(body: Record<string, unknown>): PromptModelInput | undefined {
  if (isRecord(body.model)) {
    const providerID = stringValue(body.model.providerID);
    const modelID = stringValue(body.model.modelID);
    if (providerID && modelID) {
      return {
        providerID,
        modelID,
        ...(stringValue(body.variant) ? { variant: stringValue(body.variant) ?? undefined } : {}),
      };
    }
  }
  const model = stringValue(body.model);
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function flueResponseText(prompt: string): string {
  return `Flue received: ${prompt}`;
}

function fallbackPromptResponse(prompt: string): PromptResponse {
  return {
    text: flueResponseText(prompt),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    model: { provider: FLUE_PROVIDER_ID, id: FLUE_MODEL_ID },
  };
}

function fileStatFromNode(stats: Awaited<ReturnType<typeof stat>>): FileStat {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
    size: typeof stats.size === "number" ? stats.size : Number(stats.size),
    mtime: stats.mtime,
  };
}

function resolveSandboxPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function execInSandbox(cwd: string, command: string, options?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal }): Promise<ShellResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, {
      cwd: options?.cwd ?? cwd,
      env: { ...process.env, ...(options?.env ?? {}) },
      shell: true,
      signal: options?.signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolveCommand({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

function bunLocalSandbox(cwd: string): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      return {
        cwd,
        exec: (command, options) => execInSandbox(cwd, command, options),
        readFile: (path) => readFile(resolveSandboxPath(cwd, path), "utf8"),
        readFileBuffer: (path) => readFile(resolveSandboxPath(cwd, path)),
        async writeFile(path, content) {
          const resolved = resolveSandboxPath(cwd, path);
          await mkdir(dirname(resolved), { recursive: true });
          await writeFile(resolved, content);
        },
        stat: async (path) => fileStatFromNode(await stat(resolveSandboxPath(cwd, path))),
        readdir: (path) => readdir(resolveSandboxPath(cwd, path)),
        exists: async (path) => {
          try {
            await stat(resolveSandboxPath(cwd, path));
            return true;
          } catch {
            return false;
          }
        },
        mkdir: (path, options) => mkdir(resolveSandboxPath(cwd, path), options).then(() => undefined),
        rm: (path, options) => rm(resolveSandboxPath(cwd, path), options).then(() => undefined),
        resolvePath: (path) => resolveSandboxPath(cwd, path),
      };
    },
  };
}

async function createLocalSandbox(cwd: string): Promise<SandboxFactory> {
  if ("bun" in process.versions) return bunLocalSandbox(cwd);
  const runtime = await import("@flue/runtime/node");
  return runtime.local({ cwd });
}

export async function flueFacadeForWorkspace(config: ServerConfig, workspace: WorkspaceInfo): Promise<FlueWorkspaceFacade> {
  installFlueObserver();
  let map = configFacades.get(config);
  if (!map) {
    map = new Map<string, FlueWorkspaceFacade>();
    configFacades.set(config, map);
  }
  const existing = map.get(workspace.id);
  if (existing && existing.workspacePath === workspace.path) {
    await existing.ready();
    return existing;
  }
  const facade = new FlueWorkspaceFacade(config, workspace);
  map.set(workspace.id, facade);
  await facade.ready();
  return facade;
}

export async function handleFlueOpencodeRequest(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  request: Request;
  url: URL;
  proxyPath: string;
}): Promise<Response> {
  const facade = await flueFacadeForWorkspace(input.config, input.workspace);
  return facade.handleRequest(input.request, input.url, input.proxyPath);
}

export async function listFlueSessions(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  input: { roots?: boolean; start?: number; search?: string; limit?: number },
): Promise<Session[]> {
  const facade = await flueFacadeForWorkspace(config, workspace);
  return facade.listSessions(input);
}

export async function createFlueSession(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  input: { title: string; prompt?: string },
): Promise<{ item: Session; started: boolean }> {
  const facade = await flueFacadeForWorkspace(config, workspace);
  const session = await facade.createSession({ title: input.title });
  if (input.prompt) {
    void facade.promptAsync(session.id, { text: input.prompt }).catch(() => undefined);
  }
  return { item: session, started: Boolean(input.prompt) };
}

export async function getFlueSession(config: ServerConfig, workspace: WorkspaceInfo, sessionId: string): Promise<Session> {
  const facade = await flueFacadeForWorkspace(config, workspace);
  return facade.getSession(sessionId);
}

export async function getFlueSessionMessages(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  sessionId: string,
  input: { limit?: number },
): Promise<MessageWithParts[]> {
  const facade = await flueFacadeForWorkspace(config, workspace);
  return facade.getMessages(sessionId, input);
}

export async function getFlueSessionSnapshot(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  sessionId: string,
  input: { limit?: number },
): Promise<{ session: Session; messages: MessageWithParts[]; todos: Todo[]; status: SessionStatus }> {
  const facade = await flueFacadeForWorkspace(config, workspace);
  return facade.getSnapshot(sessionId, input);
}

export async function deleteFlueSession(config: ServerConfig, workspace: WorkspaceInfo, sessionId: string): Promise<void> {
  const facade = await flueFacadeForWorkspace(config, workspace);
  await facade.deleteSession(sessionId);
}

class FlueWorkspaceFacade {
  readonly workspacePath: string;
  private readonly instanceId: string;
  private readonly statePath: string;
  private readonly catalogBridge: FlueCatalogBridge;
  private readonly listeners = new Set<EventListener>();
  private readonly inFlight = new Map<string, InFlightPrompt>();
  private readonly activeCalls = new Map<string, CallHandle<PromptResponse>>();
  private loadPromise: Promise<void> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private mcpQueue: Promise<void> = Promise.resolve();
  private state: FluePersistedState = { sessions: [] };
  private harness: FlueHarness | null = null;
  private readonly mcpConnections = new Map<string, FlueMcpConnection>();
  private readonly retiredMcpConnections = new Set<McpServerConnection>();
  private readonly mcpStatuses = new Map<string, McpStatus>();
  private readonly dynamicMcpEntries = new Map<string, DynamicMcpEntry>();
  private readonly effectiveMcpFingerprints = new Map<string, string>();
  private readonly desiredMcpFingerprints = new Map<string, string>();
  private readonly disconnectedMcpNames = new Set<string>();
  private mcpRevision = 0;
  private mcpPromptLeases = 0;
  private loggedProviderMaterializationFailure = false;
  private loggedMcpRuntimeFailure = false;

  constructor(private readonly config: ServerConfig, private readonly workspace: WorkspaceInfo) {
    this.workspacePath = workspace.path;
    this.instanceId = `openwork-flue:${workspace.id}`;
    this.statePath = stateFilePath(workspace);
    this.catalogBridge = new FlueCatalogBridge({ cachePath: catalogCachePath(workspace) });
    facadeByInstanceId.set(this.instanceId, this);
  }

  ready(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    return this.loadPromise;
  }

  async handleRequest(request: Request, url: URL, proxyPath: string): Promise<Response> {
    await this.ready();
    const path = normalizedOpencodePath(proxyPath);
    const method = request.method.toUpperCase();
    if (method === "POST" && path === "/instance/dispose") {
      await this.disposeMcpState();
      return jsonResponse(true);
    }
    await this.syncMcpFromRuntime();
    if (method === "GET" && path === "/global/health") {
      const health: GlobalHealthResponse = { healthy: true, version: "flue-compat-v1" };
      return jsonResponse(health);
    }
    if (method === "GET" && path === "/event") return this.eventStream(request.signal);
    if (method === "GET" && path === "/config") return jsonResponse(DEFAULT_CONFIG);
    if (method === "PATCH" && path === "/config") return jsonResponse(DEFAULT_CONFIG);
    if (method === "GET" && path === "/config/providers") return jsonResponse(parseWire(flueProviderListResponseSchema, await this.providerList(), "provider list"));
    if (method === "GET" && path === "/provider") return jsonResponse(parseWire(flueProviderListResponseSchema, await this.providerList(), "provider list"));
    if (method === "GET" && path === "/provider/auth") return jsonResponse(await this.providerAuthMethods());
    const authMatch = path.match(/^\/auth\/([^/]+)$/);
    if (authMatch?.[1]) {
      const providerId = decodePathSegment(authMatch[1]).trim();
      if (!providerId) throw new ApiError(400, "invalid_payload", "Provider id is required");
      if (method === "PUT") {
        const value = await readJsonValue(request);
        if (value === null) await removeFlueProviderCredential(this.config, providerId);
        else await writeFlueProviderCredential(this.config, providerId, apiCredential(value));
        await this.providerList({ allowNetwork: false });
        return jsonResponse(true);
      }
      if (method === "DELETE") {
        await removeFlueProviderCredential(this.config, providerId);
        await this.providerList({ allowNetwork: false });
        return jsonResponse(true);
      }
    }
    if (method === "POST" && /^\/provider\/[^/]+\/oauth\/(?:authorize|callback)$/.test(path)) {
      return jsonResponse({
        code: "flue_oauth_unsupported",
        message: "OAuth is unsupported on the Flue engine",
      }, 501);
    }
    if (method === "GET" && path === "/agent") return jsonResponse(DEFAULT_AGENT_LIST);
    if (method === "GET" && path === "/project") return jsonResponse(this.projectList());
    if (method === "GET" && path === "/path") return jsonResponse(this.pathInfo());
    if (method === "GET" && path === "/vcs") return jsonResponse(this.vcsInfo());
    if (method === "GET" && path === "/command") return jsonResponse(this.commandList());
    if (method === "GET" && path === "/lsp") return jsonResponse(this.lspStatus());
    if (method === "GET" && path === "/mcp") return jsonResponse(this.mcpStatus());
    if (method === "POST" && path === "/mcp") {
      const body = await readJsonBody(request);
      const name = stringValue(body.name);
      if (!name || !isRecord(body.config)) throw new ApiError(400, "invalid_payload", "MCP name and config are required");
      await this.addMcp(name, body.config);
      return jsonResponse(this.mcpStatus());
    }
    const mcpMatch = path.match(/^\/mcp\/([^/]+)\/(connect|disconnect)$/);
    if (method === "POST" && mcpMatch?.[1] && mcpMatch[2]) {
      const name = decodePathSegment(mcpMatch[1]).trim();
      if (!name) throw new ApiError(400, "invalid_payload", "MCP name is required");
      if (mcpMatch[2] === "connect") await this.connectMcp(name);
      else await this.disconnectMcp(name);
      return jsonResponse(true);
    }
    if (method === "GET" && path === "/question") return jsonResponse([]);
    if (method === "GET" && path === "/permission") return jsonResponse([]);
    if (method === "GET" && path === "/experimental/tool") return jsonResponse(this.toolList());
    if (method === "GET" && path === "/experimental/tool/ids") return jsonResponse(this.toolIds());
    if (method === "GET" && path === "/session") {
      return jsonResponse(parseWire(sessionListSchema, this.listSessions({
        roots: parseOptionalBoolean(url.searchParams.get("roots")),
        start: parseNonNegativeInteger(url.searchParams.get("start")),
        search: url.searchParams.get("search")?.trim() || undefined,
        limit: parsePositiveInteger(url.searchParams.get("limit")),
      }), "session list"));
    }
    if (method === "POST" && path === "/session") {
      const body = await readJsonBody(request);
      const title = stringValue(body.title) ?? "New session";
      return jsonResponse(parseWire(sessionInfoSchema, await this.createSession({
        title,
        directory: this.requestDirectory(request, url),
      }), "session"));
    }
    if (method === "GET" && path === "/session/status") {
      return jsonResponse(parseWire(sessionStatusesSchema, this.statuses(), "session statuses"));
    }
    const sessionMatch = path.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
    if (sessionMatch?.[1]) {
      const sessionId = decodePathSegment(sessionMatch[1]);
      const subpath = sessionMatch[2] ? `/${sessionMatch[2]}` : "";
      return await this.handleSessionRequest(method, subpath, sessionId, request, url);
    }
    throw new ApiError(404, "not_found", "Not found");
  }

  private async providerList(input: { allowNetwork?: boolean } = {}): Promise<ProviderListResponse> {
    let materialization: FlueCatalogMaterialization | null = null;
    try {
      materialization = await this.catalogBridge.materializeForWorkspace({
        config: this.config,
        workspaceId: this.workspace.id,
        deterministicProvider: FLUE_PROVIDER,
        processEnv: process.env,
        allowNetwork: input.allowNetwork,
      });
      this.applyProviderMaterialization(materialization);
      return materialization.providerList;
    } catch {
      if (!this.loggedProviderMaterializationFailure) {
        this.loggedProviderMaterializationFailure = true;
        console.warn("[flue-catalog] provider runtime application failed; using deterministic fallback", {
          reason: "materialization_failed",
        });
      }
      const deterministicEnabled = materialization?.providerList.all.some((provider) => provider.id === FLUE_PROVIDER_ID) ?? true;
      try {
        resetProviderRuntime();
        if (deterministicEnabled) ensureFauxProvider();
      } catch {
        // Provider data must not make the provider-list endpoint unavailable.
      }
      const fallback: ProviderListResponse = deterministicEnabled
        ? { all: [FLUE_PROVIDER], default: { [FLUE_PROVIDER_ID]: FLUE_MODEL_ID }, connected: [FLUE_PROVIDER_ID] }
        : { all: [], default: {}, connected: [] };
      if (materialization) {
        materialization.providerList = fallback;
        materialization.registrations = [];
        materialization.skipped.push({ providerId: "__materialization__", reason: "materialization_failed" });
        materialization.catalogSource = "deterministic-only";
        this.catalogBridge.updateDiagnostics(materialization);
      }
      return fallback;
    }
  }

  private async providerAuthMethods(): Promise<Record<string, Array<{ type: "api"; label: string }>>> {
    const providers = (await this.providerList({ allowNetwork: false })).all;
    const methods: Record<string, Array<{ type: "api"; label: string }>> = {};
    for (const provider of providers) {
      if (provider.env.length > 0) methods[provider.id] = [{ type: "api", label: "API key" }];
    }
    return methods;
  }

  private applyProviderMaterialization(materialization: FlueCatalogMaterialization): void {
    resetProviderRuntime();
    if (materialization.providerList.all.some((provider) => provider.id === FLUE_PROVIDER_ID)) ensureFauxProvider();
    const failures: Array<{ providerId: string; reason: string }> = [];
    const registrations: FlueCatalogMaterialization["registrations"] = [];
    for (const provider of materialization.registrations) {
      try {
        registerProvider(provider.providerId, provider.registration);
        registrations.push(provider);
      } catch {
        failures.push({ providerId: provider.providerId, reason: "registration_failed" });
      }
    }
    if (failures.length > 0) {
      const failedProviderIds = new Set(failures.map((failure) => failure.providerId));
      materialization.registrations = registrations;
      materialization.providerList.connected = materialization.providerList.connected.filter(
        (providerId) => !failedProviderIds.has(providerId),
      );
      for (const providerId of failedProviderIds) delete materialization.providerList.default[providerId];
      materialization.skipped.push(...failures);
      this.catalogBridge.updateDiagnostics(materialization);
      console.warn("[flue-catalog] provider registration failed; providers left listed but disconnected", {
        skipped: failures,
      });
    }
  }

  listSessions(input: { roots?: boolean; start?: number; search?: string; limit?: number } = {}): Session[] {
    const search = input.search?.trim().toLowerCase() ?? "";
    const start = input.start ?? 0;
    const limit = input.limit ?? 200;
    const sessions = this.state.sessions
      .map((record) => record.session)
      .filter((session) => input.roots ? !session.parentID : true)
      .filter((session) => search ? session.title.toLowerCase().includes(search) || session.id.toLowerCase().includes(search) : true)
      .sort((a, b) => b.time.updated - a.time.updated || b.time.created - a.time.created);
    return sessions.slice(start, start + limit);
  }

  async createSession(input: { title: string; directory?: string; parentID?: string; model?: PromptModelInput }): Promise<Session> {
    const now = Date.now();
    const session = makeSession({
      id: `ses_${shortId()}`,
      title: input.title.trim() || "New session",
      directory: input.directory ?? this.workspace.path,
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(input.model ? { model: input.model } : {}),
      now,
    });
    this.state.sessions.push({ session, messages: [], todos: [], status: { type: "idle" } });
    await this.save();
    this.emit({ id: this.eventId(), type: "session.created", properties: { sessionID: session.id, info: session } });
    return session;
  }

  getSession(sessionId: string): Session {
    return this.record(sessionId).session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const record = this.record(sessionId);
    this.state.sessions = this.state.sessions.filter((item) => item.session.id !== sessionId);
    await this.save();
    this.emit({ id: this.eventId(), type: "session.deleted", properties: { sessionID: sessionId, info: record.session } });
  }

  getMessages(sessionId: string, input: { limit?: number } = {}): MessageWithParts[] {
    const messages = this.record(sessionId).messages;
    return typeof input.limit === "number" ? messages.slice(-input.limit) : messages;
  }

  getSnapshot(sessionId: string, input: { limit?: number } = {}): { session: Session; messages: MessageWithParts[]; todos: Todo[]; status: SessionStatus } {
    const record = this.record(sessionId);
    return {
      session: record.session,
      messages: this.getMessages(sessionId, input),
      todos: record.todos,
      status: record.status,
    };
  }

  async promptAsync(sessionId: string, input: PromptRunInput): Promise<void> {
    await this.ready();
    const record = this.record(sessionId);
    const text = input.text.trim();
    if (!text) throw new ApiError(400, "invalid_payload", "Prompt text is required");
    const now = Date.now();
    const user = makeUserMessage({
      id: `msg_${shortId()}`,
      sessionID: sessionId,
      text,
      ...(input.model ? { model: input.model } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      now,
    });
    const assistant = makeAssistantMessage({
      id: `msg_${shortId()}`,
      sessionID: sessionId,
      parentID: user.info.id,
      directory: record.session.directory,
      ...(input.model ? { model: input.model } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      now,
    });
    record.messages.push(user, assistant);
    record.status = { type: "busy" };
    record.session.time.updated = now;
    const assistantPart = assistant.parts.find((part) => part.type === "text");
    if (assistantPart) {
      this.inFlight.set(sessionId, { assistantMessageId: assistant.info.id, assistantPartId: assistantPart.id });
    }
    await this.save();
    this.emitMessage(user);
    this.emitMessage(assistant);
    this.emitStatus(sessionId, record.status);

    try {
      const { handle, releaseMcpLease } = await this.startFluePrompt(sessionId, text, input);
      this.activeCalls.set(sessionId, handle);
      handle
        .then((response) => this.finishPrompt(sessionId, assistant.info.id, response))
        .catch((error) => this.failPrompt(sessionId, assistant.info.id, error))
        .finally(async () => {
          this.activeCalls.delete(sessionId);
          this.inFlight.delete(sessionId);
          await releaseMcpLease();
        });
    } catch (error) {
      queueMicrotask(() => {
        const complete = promptModelSpec(input.model) === FLUE_MODEL_SPEC && !(error instanceof ApiError)
          ? this.finishPrompt(sessionId, assistant.info.id, fallbackPromptResponse(text))
          : this.failPrompt(sessionId, assistant.info.id, error);
        void complete.finally(() => this.inFlight.delete(sessionId));
      });
    }
  }

  handleObservedFlueEvent(event: FlueObservation): void {
    if ((event.type !== "tool_start" && event.type !== "tool") || typeof event.session !== "string") return;
    const inFlight = this.inFlight.get(event.session);
    if (!inFlight) return;
    const record = this.records().find((item) => item.session.id === event.session);
    if (!record) return;
    const message = record.messages.find((item) => item.info.id === inFlight.assistantMessageId);
    if (!message) return;
    const sessionID = event.session;
    applyObservedToolEvent({
      message,
      event,
      sessionID,
      now: Date.now(),
      partId: () => `prt_${shortId()}`,
      onUpdated: (part) => this.emit({
        id: this.eventId(),
        type: "message.part.updated",
        properties: { sessionID, part, time: Date.now() },
      }),
    });
    void this.save().catch(() => undefined);
  }

  private async handleSessionRequest(method: string, subpath: string, sessionId: string, request: Request, url: URL): Promise<Response> {
    if (method === "GET" && subpath === "") {
      return jsonResponse(parseWire(sessionInfoSchema, this.getSession(sessionId), "session"));
    }
    if (method === "PATCH" && subpath === "") {
      const body = await readJsonBody(request);
      const title = stringValue(body.title);
      const record = this.record(sessionId);
      if (title) record.session.title = title;
      record.session.time.updated = Date.now();
      await this.save();
      this.emit({ id: this.eventId(), type: "session.updated", properties: { sessionID: sessionId, info: record.session } });
      return jsonResponse(parseWire(sessionInfoSchema, record.session, "session"));
    }
    if (method === "DELETE" && subpath === "") {
      await this.deleteSession(sessionId);
      return jsonResponse(true);
    }
    if (method === "GET" && subpath === "/message") {
      return jsonResponse(parseWire(sessionMessagesSchema, this.getMessages(sessionId, {
        limit: parsePositiveInteger(url.searchParams.get("limit")),
      }), "session messages"));
    }
    if (method === "GET" && subpath === "/todo") {
      return jsonResponse(parseWire(sessionTodosSchema, this.record(sessionId).todos, "session todos"));
    }
    if (method === "POST" && subpath === "/prompt_async") {
      const body = await readJsonBody(request);
      await this.promptAsync(sessionId, {
        text: extractPromptText(body),
        ...(extractPromptModel(body) ? { model: extractPromptModel(body) } : {}),
        ...(stringValue(body.agent) ? { agent: stringValue(body.agent) ?? undefined } : {}),
      });
      return emptyResponse();
    }
    if (method === "POST" && subpath === "/command") {
      const body = await readJsonBody(request);
      const command = stringValue(body.command) ?? "command";
      const args = stringValue(body.arguments) ?? "";
      const text = args ? `/${command} ${args}` : `/${command}`;
      await this.promptAsync(sessionId, {
        text,
        ...(extractPromptModel(body) ? { model: extractPromptModel(body) } : {}),
        ...(stringValue(body.agent) ? { agent: stringValue(body.agent) ?? undefined } : {}),
      });
      return jsonResponse({ ok: true, accepted: true });
    }
    if (method === "POST" && subpath === "/abort") {
      const call = this.activeCalls.get(sessionId);
      call?.abort(new DOMException("Session aborted", "AbortError"));
      const record = this.record(sessionId);
      record.status = { type: "idle" };
      await this.save();
      this.emitStatus(sessionId, record.status);
      this.emit({ id: this.eventId(), type: "session.idle", properties: { sessionID: sessionId } });
      return jsonResponse(true);
    }
    if (method === "POST" && (subpath === "/revert" || subpath === "/unrevert" || subpath === "/fork")) {
      return jsonResponse(parseWire(sessionInfoSchema, this.getSession(sessionId), "session"));
    }
    if (method === "POST" && subpath === "/shell") {
      throw new ApiError(501, "flue_shell_not_implemented", "Flue shell sessions are not implemented yet");
    }
    throw new ApiError(404, "not_found", "Not found");
  }

  private async startFluePrompt(sessionId: string, text: string, input: PromptRunInput): Promise<{
    handle: CallHandle<PromptResponse>;
    releaseMcpLease: () => Promise<void>;
  }> {
    const releaseMcpLease = this.acquireMcpPromptLease();
    try {
      const model = sessionModel(input.model);
      const modelSpec = promptModelSpec(input.model);
      const providerList = await this.providerList({ allowNetwork: false });
      const availabilityError = promptModelAvailabilityError(providerList, model);
      if (availabilityError) throw availabilityError;
      const harness = await this.ensureHarness(modelSpec);
      let session;
      try {
        session = await harness.sessions.get(sessionId);
      } catch {
        session = await harness.sessions.create(sessionId);
      }
      if (modelSpec === FLUE_MODEL_SPEC) {
        const provider = ensureFauxProvider();
        if (fauxResponsesForTest) {
          provider.setResponses(fauxResponsesForTest);
          fauxResponsesForTest = null;
        }
        if (provider.getPendingResponseCount() === 0) provider.appendResponses([fauxAssistantMessage(flueResponseText(text))]);
      }
      return { handle: session.prompt(text, { model: modelSpec }), releaseMcpLease };
    } catch (error) {
      await releaseMcpLease();
      throw error;
    }
  }

  private async finishPrompt(sessionId: string, assistantMessageId: string, response: PromptResponse): Promise<void> {
    const record = this.record(sessionId);
    const index = record.messages.findIndex((message) => message.info.id === assistantMessageId);
    if (index >= 0) {
      record.messages[index] = completeAssistantMessage(record.messages[index], response.text, Date.now(), response);
      this.emitMessage(record.messages[index]);
    }
    record.status = { type: "idle" };
    record.session.time.updated = Date.now();
    await this.save();
    this.emitStatus(sessionId, record.status);
    this.emit({ id: this.eventId(), type: "session.idle", properties: { sessionID: sessionId } });
    this.emit({ id: this.eventId(), type: "session.updated", properties: { sessionID: sessionId, info: record.session } });
  }

  private async failPrompt(sessionId: string, assistantMessageId: string, error: unknown): Promise<void> {
    const record = this.record(sessionId);
    const index = record.messages.findIndex((message) => message.info.id === assistantMessageId);
    if (index >= 0) {
      record.messages[index] = erroredAssistantMessage(record.messages[index], error, Date.now());
      this.emitMessage(record.messages[index]);
    }
    record.status = { type: "idle" };
    record.session.time.updated = Date.now();
    await this.save();
    this.emit({ id: this.eventId(), type: "session.error", properties: { sessionID: sessionId, error: { name: "UnknownError", data: { message: error instanceof Error ? error.message : String(error) } } } });
    this.emitStatus(sessionId, record.status);
    this.emit({ id: this.eventId(), type: "session.idle", properties: { sessionID: sessionId } });
  }

  private handleFlueEvent(event: FlueEventInput): void {
    if (event.type !== "text_delta" || typeof event.session !== "string") return;
    const inFlight = this.inFlight.get(event.session);
    if (!inFlight) return;
    const record = this.records().find((item) => item.session.id === event.session);
    if (!record) return;
    const message = record.messages.find((item) => item.info.id === inFlight.assistantMessageId);
    const part = message?.parts.find((item) => item.id === inFlight.assistantPartId);
    if (!part || part.type !== "text") return;
    part.text += event.text;
    void this.save().catch(() => undefined);
    this.emit({
      id: this.eventId(),
      type: "message.part.delta",
      properties: { sessionID: event.session, messageID: inFlight.assistantMessageId, partID: inFlight.assistantPartId, field: "text", delta: event.text },
    });
  }

  private async ensureHarness(defaultModelSpec: string): Promise<FlueHarness> {
    while (true) {
      await this.syncMcpFromRuntime();
      if (this.harness) return this.harness;
      const revision = this.mcpRevision;
      const workspace = this.workspace;
      const sandbox = await createLocalSandbox(workspace.path);
      const tools = this.connectedMcpTools().map((tool) => tool.definition);
      const agent = defineAgent<Record<string, unknown>>(() => ({
        model: defaultModelSpec,
        cwd: workspace.path,
        sandbox,
        tools,
        instructions: "You are OpenWork running through the in-process Flue compatibility facade.",
      }));
      const context = createFlueContext({
        id: this.instanceId,
        agentName: DEFAULT_AGENT,
        env: process.env,
        req: new Request(`https://openwork-flue.invalid/${encodeURIComponent(this.instanceId)}`),
        agentConfig: { resolveModel },
        createDefaultEnv: () => sandbox.createSessionEnv({ id: this.instanceId }),
      });
      context.subscribeEvent((event) => this.handleFlueEvent(event));
      const harness = await context.initializeRootHarness(agent);
      if (revision !== this.mcpRevision) continue;
      if (this.harness) return this.harness;
      this.harness = harness;
      return harness;
    }
  }

  private eventStream(signal: AbortSignal): Response {
    const encoder = new TextEncoder();
    let cleanup: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (event: EngineEvent) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        this.listeners.add(send);
        controller.enqueue(encoder.encode(": connected\n\n"));
        cleanup = () => {
          this.listeners.delete(send);
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        signal.addEventListener("abort", () => cleanup?.(), { once: true });
      },
      cancel: () => cleanup?.(),
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private emit(event: EngineEvent): void {
    const parsed = parseWire(engineEventSchema, event, "engine event");
    for (const listener of this.listeners) listener(parsed);
  }

  private emitStatus(sessionId: string, status: SessionStatus): void {
    this.emit({ id: this.eventId(), type: "session.status", properties: { sessionID: sessionId, status } });
  }

  private emitMessage(message: MessageWithParts): void {
    this.emit({ id: this.eventId(), type: "message.updated", properties: { sessionID: message.info.sessionID, info: message.info } });
    for (const part of message.parts) {
      this.emit({ id: this.eventId(), type: "message.part.updated", properties: { sessionID: message.info.sessionID, part, time: Date.now() } });
    }
  }

  private eventId(): string {
    return `evt_${shortId()}`;
  }

  private statuses(): Record<string, SessionStatus> {
    return Object.fromEntries(this.state.sessions.map((record) => [record.session.id, record.status]));
  }

  private records(): FlueSessionRecord[] {
    return this.state.sessions;
  }

  private record(sessionId: string): FlueSessionRecord {
    const record = this.state.sessions.find((item) => item.session.id === sessionId);
    if (!record) throw new ApiError(404, "session_not_found", "Session not found");
    return record;
  }

  private requestDirectory(request: Request, url: URL): string {
    const query = url.searchParams.get("directory")?.trim();
    if (query) return query;
    const header = request.headers.get("x-opencode-directory") ?? request.headers.get("x-openCode-directory") ?? "";
    return header.trim() ? decodeDirectoryHeader(header.trim()) : this.workspace.path;
  }

  private pathInfo(): Path {
    const state = dirname(this.statePath);
    return {
      home: homedir(),
      state,
      config: join(this.workspace.path, ".opencode"),
      worktree: this.workspace.path,
      directory: this.workspace.path,
    };
  }

  private vcsInfo(): VcsInfo {
    return {};
  }

  private commandList(): Command[] {
    return [];
  }

  private lspStatus(): LspStatus[] {
    return [];
  }

  private syncMcpFromRuntime(forceNames: string[] = []): Promise<void> {
    const next = this.mcpQueue.then(() => this.reconcileMcpFromRuntime(new Set(forceNames)));
    this.mcpQueue = next.catch(() => undefined);
    return next;
  }

  private async reconcileMcpFromRuntime(forceNames: Set<string>): Promise<void> {
    let effectiveMap: Record<string, Record<string, unknown>>;
    try {
      effectiveMap = runtimeMcpMap(await readEffectiveRuntimeOpencodeConfig(this.config, this.workspace.id));
      this.loggedMcpRuntimeFailure = false;
    } catch {
      if (!this.loggedMcpRuntimeFailure) {
        this.loggedMcpRuntimeFailure = true;
        console.warn("[flue-mcp] runtime MCP config could not be read", { reason: "runtime_config_unavailable" });
      }
      return;
    }

    const nextEffectiveFingerprints = new Map<string, string>();
    for (const [name, config] of Object.entries(effectiveMap)) {
      nextEffectiveFingerprints.set(name, mcpConfigFingerprint(config));
    }
    for (const [name, entry] of this.dynamicMcpEntries) {
      const currentEffective = nextEffectiveFingerprints.get(name) ?? null;
      if (currentEffective !== entry.effectiveFingerprint) this.dynamicMcpEntries.delete(name);
    }
    this.effectiveMcpFingerprints.clear();
    for (const [name, fingerprint] of nextEffectiveFingerprints) this.effectiveMcpFingerprints.set(name, fingerprint);

    const desiredMap: Record<string, Record<string, unknown>> = { ...effectiveMap };
    for (const [name, entry] of this.dynamicMcpEntries) desiredMap[name] = entry.config;

    for (const name of [...this.desiredMcpFingerprints.keys()]) {
      if (Object.hasOwn(desiredMap, name)) continue;
      await this.closeMcpConnection(name);
      this.mcpStatuses.delete(name);
      this.desiredMcpFingerprints.delete(name);
      this.disconnectedMcpNames.delete(name);
    }

    const connectionTasks: Promise<void>[] = [];
    for (const [name, config] of Object.entries(desiredMap)) {
      const fingerprint = mcpConfigFingerprint(config);
      const previousFingerprint = this.desiredMcpFingerprints.get(name);
      if (previousFingerprint !== fingerprint) this.disconnectedMcpNames.delete(name);
      this.desiredMcpFingerprints.set(name, fingerprint);

      if (this.disconnectedMcpNames.has(name) || config.enabled === false) {
        await this.closeMcpConnection(name);
        this.mcpStatuses.set(name, { status: "disabled" });
        continue;
      }
      if (config.type === "local") {
        await this.closeMcpConnection(name);
        this.mcpStatuses.set(name, { status: "failed", error: "unsupported_transport_stdio" });
        continue;
      }
      if (!this.isValidRemoteMcpConfig(config)) {
        await this.closeMcpConnection(name);
        this.mcpStatuses.set(name, { status: "failed", error: "invalid_remote_config" });
        continue;
      }

      const existing = this.mcpConnections.get(name);
      const shouldForce = forceNames.has(name);
      const hasFreshLiveness = existing
        ? Date.now() - existing.lastLivenessAt < MCP_LIVENESS_INTERVAL_MS
        : false;
      if (existing?.fingerprint === fingerprint && !shouldForce && hasFreshLiveness) {
        this.mcpStatuses.set(name, { status: "connected" });
        continue;
      }
      if (previousFingerprint === fingerprint && this.mcpStatuses.get(name)?.status === "failed" && !shouldForce) continue;

      connectionTasks.push((async () => {
        try {
          const headers = mcpHeaders(config);
          const connection = await connectMcpServer(name, {
            url: stringValue(config.url) ?? "",
            transport: mcpTransport(config),
            ...(headers ? { headers } : {}),
            timeoutMs: mcpTimeoutMs(config),
          });
          await this.installMcpConnection(name, {
            fingerprint,
            connection,
            tools: projectMcpTools(name, connection, (input) => this.retryMcpTool(input)),
            lastLivenessAt: Date.now(),
          });
          this.mcpStatuses.set(name, { status: "connected" });
        } catch (error) {
          const reason = mcpConnectionFailureCode(error);
          await this.closeMcpConnection(name);
          this.mcpStatuses.set(name, { status: "failed", error: reason });
          console.warn("[flue-mcp] MCP connection failed", { name, reason });
        }
      })());
    }
    await Promise.all(connectionTasks);
  }

  private async retryMcpTool(input: {
    serverName: string;
    connection: McpServerConnection;
    toolId: string;
    args: unknown;
    signal?: AbortSignal;
    reason: string;
  }): Promise<string> {
    await this.reconnectMcpAfterTransportFailure(input.serverName, input.connection);
    const replacement = this.mcpConnections.get(input.serverName);
    const tool = replacement?.tools.find((candidate) => candidate.id === input.toolId);
    if (!replacement || !tool) {
      const status = this.mcpStatuses.get(input.serverName);
      const reconnectReason = status?.status === "failed" ? status.error : "reconnect_failed";
      throw new Error(
        `MCP server "${input.serverName}" tool "${input.toolId}" failed after ${input.reason}; reconnect attempt failed: ${reconnectReason}`,
      );
    }
    try {
      return await tool.execute(input.args, input.signal);
    } catch (error) {
      const reason = mcpTransportFailureCode(error, input.signal) ?? "tool_call_failed";
      if (reason.startsWith("transport_")) await this.markMcpTransportFailed(input.serverName, replacement, reason);
      throw new Error(
        `MCP server "${input.serverName}" tool "${input.toolId}" failed after one reconnect attempt: ${reason}`,
      );
    }
  }

  private reconnectMcpAfterTransportFailure(name: string, failedConnection: McpServerConnection): Promise<void> {
    const next = this.mcpQueue.then(async () => {
      if (this.mcpConnections.get(name)?.connection !== failedConnection) return;
      await this.reconcileMcpFromRuntime(new Set([name]));
    });
    this.mcpQueue = next.catch(() => undefined);
    return next;
  }

  private markMcpTransportFailed(name: string, failed: FlueMcpConnection, reason: string): Promise<void> {
    const next = this.mcpQueue.then(async () => {
      if (this.mcpConnections.get(name) !== failed) return;
      await this.closeMcpConnection(name);
      this.mcpStatuses.set(name, { status: "failed", error: reason });
      console.warn("[flue-mcp] MCP transport failed after reconnect", { name, reason });
    });
    this.mcpQueue = next.catch(() => undefined);
    return next;
  }

  private async installMcpConnection(name: string, next: FlueMcpConnection): Promise<void> {
    const previous = this.mcpConnections.get(name);
    this.mcpConnections.set(name, next);
    this.invalidateMcpHarness();
    if (previous && previous.connection !== next.connection) this.retiredMcpConnections.add(previous.connection);
    await this.closeRetiredMcpConnectionsIfIdle();
  }

  private invalidateMcpHarness(): void {
    this.mcpRevision += 1;
    this.harness = null;
  }

  private acquireMcpPromptLease(): () => Promise<void> {
    this.mcpPromptLeases += 1;
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      this.mcpPromptLeases -= 1;
      await this.closeRetiredMcpConnectionsIfIdle();
    };
  }

  private async closeRetiredMcpConnectionsIfIdle(): Promise<void> {
    if (this.mcpPromptLeases > 0 || this.retiredMcpConnections.size === 0) return;
    const connections = [...this.retiredMcpConnections];
    this.retiredMcpConnections.clear();
    await Promise.all(connections.map((connection) => connection.close().catch(() => undefined)));
  }

  private isValidRemoteMcpConfig(config: Record<string, unknown>): boolean {
    if (config.type !== "remote") return false;
    const url = stringValue(config.url);
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private async addMcp(name: string, config: Record<string, unknown>): Promise<void> {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)) throw new ApiError(400, "invalid_mcp_name", "Invalid MCP name");
    if (config.type === "local") {
      if (!Array.isArray(config.command) || config.command.length === 0 || config.command.some((part) => typeof part !== "string" || !part.trim())) {
        throw new ApiError(400, "invalid_mcp_config", "Local MCP requires a command array");
      }
    } else if (!this.isValidRemoteMcpConfig(config)) {
      throw new ApiError(400, "invalid_mcp_config", "Remote MCP requires a valid http(s) URL");
    }
    this.dynamicMcpEntries.set(name, {
      config,
      effectiveFingerprint: this.effectiveMcpFingerprints.get(name) ?? null,
    });
    this.disconnectedMcpNames.delete(name);
    await this.syncMcpFromRuntime([name]);
  }

  private async connectMcp(name: string): Promise<void> {
    if (!this.desiredMcpFingerprints.has(name)) throw new ApiError(404, "mcp_not_found", "MCP server not found");
    this.disconnectedMcpNames.delete(name);
    await this.syncMcpFromRuntime([name]);
  }

  private async disconnectMcp(name: string): Promise<void> {
    if (this.desiredMcpFingerprints.has(name)) {
      this.disconnectedMcpNames.add(name);
      this.mcpStatuses.set(name, { status: "disabled" });
    }
    await this.closeMcpConnection(name);
  }

  private async closeMcpConnection(name: string): Promise<boolean> {
    const current = this.mcpConnections.get(name);
    if (!current) return false;
    this.mcpConnections.delete(name);
    this.invalidateMcpHarness();
    this.retiredMcpConnections.add(current.connection);
    await this.closeRetiredMcpConnectionsIfIdle();
    return true;
  }

  private connectedMcpTools(): FlueMcpTool[] {
    return [...this.mcpConnections.values()]
      .flatMap((entry) => entry.tools)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private async disposeMcpState(): Promise<void> {
    const next = this.mcpQueue.then(async () => {
      const connections = [...this.mcpConnections.values()];
      this.mcpConnections.clear();
      for (const entry of connections) this.retiredMcpConnections.add(entry.connection);
      this.mcpStatuses.clear();
      this.dynamicMcpEntries.clear();
      this.effectiveMcpFingerprints.clear();
      this.desiredMcpFingerprints.clear();
      this.disconnectedMcpNames.clear();
      this.invalidateMcpHarness();
      await this.closeRetiredMcpConnectionsIfIdle();
    });
    this.mcpQueue = next.catch(() => undefined);
    await next;
  }

  private mcpStatus(): McpStatusMap {
    return Object.fromEntries([...this.mcpStatuses.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  private projectList(): Project[] {
    const now = Date.now();
    return [{ id: `proj_${this.workspace.id}`, worktree: this.workspace.path, name: this.workspace.name, time: { created: now, updated: now }, sandboxes: [] }];
  }

  private toolList(): ToolList {
    return this.connectedMcpTools().map((tool) => ({
      id: tool.id,
      description: tool.definition.description,
      parameters: tool.parameters,
    }));
  }

  private toolIds(): ToolIds {
    return this.connectedMcpTools().map((tool) => tool.id);
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      this.state = normalizePersistedState(parsed);
    } catch {
      this.state = { sessions: [] };
    }
    await this.syncMcpFromRuntime();
  }

  private save(): Promise<void> {
    const next = this.saveQueue.then(() => this.writeState());
    this.saveQueue = next.catch(() => undefined);
    return next;
  }

  private async writeState(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmpPath = `${this.statePath}.${shortId()}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(tmpPath, this.statePath);
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }
}
