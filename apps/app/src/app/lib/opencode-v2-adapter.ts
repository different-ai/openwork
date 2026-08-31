import type {
  Model,
  Provider,
  ProviderListResponse,
  Session,
  TextPart,
} from "@opencode-ai/sdk/v2/client";

import { createClient, createDesktopFetch, type FieldsResult } from "./opencode";
import { isDesktopRuntime } from "./runtime-env";
import type { OpencodeEvent } from "../types";

type RequestOptions = {
  signal?: AbortSignal;
  throwOnError?: boolean;
};

type DirectoryParameters = {
  directory?: string;
  workspace?: string;
};

type SessionParameters = DirectoryParameters & {
  sessionID: string;
};

type ModelBinding = {
  providerID: string;
  modelID?: string;
  id?: string;
};

type PromptPart = {
  type?: unknown;
  text?: unknown;
};

type PromptParameters = SessionParameters & {
  model?: { providerID: string; modelID: string };
  parts?: PromptPart[];
  messageID?: string;
  agent?: string;
  noReply?: boolean;
  tools?: Record<string, boolean>;
  system?: string;
  variant?: string;
  reasoning_effort?: string;
};

type SessionCreateParameters = DirectoryParameters & {
  model?: ModelBinding;
};

type SessionUpdateParameters = SessionParameters & {
  title?: string;
  time?: { archived?: number };
};

type V2MessageRole = "user" | "assistant" | "system";

export type V2MappedMessage = {
  info: {
    id: string;
    sessionID: string;
    role: V2MessageRole;
    time: {
      created: number;
      completed?: number;
    };
  };
  parts: TextPart[];
};

type TextStream = {
  sessionID: string;
  messageID: string;
  partID: string;
  ordinal: number;
  text: string;
};

export type V2EventTranslationState = {
  streams: Map<string, TextStream>;
  latestStreamKeyBySession: Map<string, string>;
  nextOrdinalByMessage: Map<string, number>;
  unknownTypes: Set<string>;
};

type TransportResult = {
  payload: unknown;
  request: Request;
  response: Response;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function responseData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

function responseItems(value: unknown): unknown[] {
  const data = responseData(value);
  return Array.isArray(data) ? data : [];
}

function eventProperties(value: Record<string, unknown>): Record<string, unknown> {
  const data = readRecord(value, "data");
  if (data) return data;
  const properties = readRecord(value, "properties");
  return properties ?? value;
}

function readSessionID(value: Record<string, unknown>): string {
  return readString(value, "sessionID") ?? readString(value, "sessionId") ?? "";
}

function readMessageID(value: Record<string, unknown>): string {
  return readString(value, "assistantMessageID") ?? readString(value, "messageID") ?? readString(value, "messageId") ?? "";
}

function readTimestamp(value: Record<string, unknown>): number {
  return readNumber(value, "timestamp") ?? Date.now();
}

function mapV2Session(value: unknown, directory: string | undefined): Session | null {
  const data = responseData(value);
  if (!isRecord(data)) return null;
  const source = readRecord(data, "info") ?? data;
  const id = readString(source, "id") ?? readString(source, "sessionID");
  if (!id) return null;
  const time = readRecord(source, "time");
  const location = readRecord(source, "location");
  const created = readNumber(time, "created") ?? readNumber(source, "created") ?? 0;
  const updated = readNumber(time, "updated") ?? readNumber(source, "updated") ?? created;
  const archived = readNumber(time, "archived");
  const parentID = readString(source, "parentID");
  const mapped: Session = {
    id,
    slug: readString(source, "slug") ?? id,
    projectID: readString(source, "projectID") ?? "v2",
    directory: readString(source, "directory") ?? readString(location, "directory") ?? directory ?? "",
    title: readString(source, "title") ?? "Untitled session",
    version: readString(source, "version") ?? "v2",
    time: {
      created,
      updated,
      ...(archived === undefined ? {} : { archived }),
    },
    ...(parentID ? { parentID } : {}),
  };
  return mapped;
}

function messageRole(value: Record<string, unknown>): V2MessageRole {
  const raw = readString(value, "role") ?? readString(value, "type");
  if (raw === "user") return "user";
  if (raw === "system" || raw === "synthetic" || raw === "compaction") return "system";
  return "assistant";
}

function messageTextEntries(value: Record<string, unknown>): string[] {
  const content = value.content;
  if (Array.isArray(content)) {
    return content.flatMap((entry) => {
      if (!isRecord(entry) || readString(entry, "type") !== "text") return [];
      const text = readString(entry, "text");
      return text === undefined ? [] : [text];
    });
  }
  const text = readString(value, "text");
  return text === undefined ? [] : [text];
}

function mapV2Message(value: unknown, sessionID: string): V2MappedMessage | null {
  if (!isRecord(value)) return null;
  const id = readString(value, "id") ?? readString(value, "messageID");
  if (!id) return null;
  const time = readRecord(value, "time");
  const created = readNumber(time, "created") ?? readNumber(value, "timestamp") ?? 0;
  const completed = readNumber(time, "completed");
  const resolvedSessionID = readString(value, "sessionID") ?? sessionID;
  const parts = messageTextEntries(value).map<TextPart>((text, ordinal) => ({
    id: `${id}:${ordinal}`,
    messageID: id,
    sessionID: resolvedSessionID,
    type: "text",
    text,
  }));
  return {
    info: {
      id,
      sessionID: resolvedSessionID,
      role: messageRole(value),
      time: {
        created,
        ...(completed === undefined ? {} : { completed }),
      },
    },
    parts,
  };
}

function modelStatus(value: unknown): Model["status"] {
  return value === "alpha" || value === "beta" || value === "deprecated" || value === "active"
    ? value
    : "active";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapV2Model(value: unknown): Model | null {
  if (!isRecord(value)) return null;
  const id = readString(value, "id");
  const providerID = readString(value, "providerID");
  if (!id || !providerID) return null;
  const rawApi = readRecord(value, "api");
  const rawCapabilities = readRecord(value, "capabilities");
  const rawLimit = readRecord(value, "limit");
  const rawTime = readRecord(value, "time");
  const rawCosts = value.cost;
  const firstCost = Array.isArray(rawCosts) && rawCosts.length > 0 && isRecord(rawCosts[0])
    ? rawCosts[0]
    : isRecord(rawCosts)
      ? rawCosts
      : null;
  const rawCacheCost = readRecord(firstCost, "cache");
  const inputCapabilities = stringArray(rawCapabilities?.input);
  const outputCapabilities = stringArray(rawCapabilities?.output);
  const toolcall = rawCapabilities?.tools === true;
  const released = readNumber(rawTime, "released");
  return {
    id,
    providerID,
    api: {
      id: readString(rawApi, "id") ?? id,
      url: readString(rawApi, "url") ?? "",
      npm: readString(rawApi, "npm") ?? readString(rawApi, "package") ?? "",
    },
    name: readString(value, "name") ?? id,
    capabilities: {
      temperature: false,
      reasoning: outputCapabilities.includes("reasoning"),
      attachment: inputCapabilities.some((kind) => kind !== "text"),
      toolcall,
      input: {
        text: inputCapabilities.length === 0 || inputCapabilities.includes("text"),
        audio: inputCapabilities.includes("audio"),
        image: inputCapabilities.includes("image"),
        video: inputCapabilities.includes("video"),
        pdf: inputCapabilities.includes("pdf"),
      },
      output: {
        text: outputCapabilities.length === 0 || outputCapabilities.includes("text"),
        audio: outputCapabilities.includes("audio"),
        image: outputCapabilities.includes("image"),
        video: outputCapabilities.includes("video"),
        pdf: outputCapabilities.includes("pdf"),
      },
      interleaved: false,
    },
    cost: {
      input: readNumber(firstCost, "input") ?? 0,
      output: readNumber(firstCost, "output") ?? 0,
      cache: {
        read: readNumber(rawCacheCost, "read") ?? 0,
        write: readNumber(rawCacheCost, "write") ?? 0,
      },
    },
    limit: {
      context: readNumber(rawLimit, "context") ?? 0,
      output: readNumber(rawLimit, "output") ?? 0,
      ...(readNumber(rawLimit, "input") === undefined ? {} : { input: readNumber(rawLimit, "input") }),
    },
    status: modelStatus(value.status),
    options: {},
    headers: {},
    release_date: released === undefined ? "" : new Date(released).toISOString(),
  };
}

function mapDefaultModels(value: unknown): Record<string, string> {
  const data = responseData(value);
  const defaults: Record<string, string> = {};
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!isRecord(item)) continue;
      const providerID = readString(item, "providerID");
      const modelID = readString(item, "modelID") ?? readString(item, "id");
      if (providerID && modelID) defaults[providerID] = modelID;
    }
    return defaults;
  }
  if (!isRecord(data)) return defaults;
  const providerID = readString(data, "providerID");
  const modelID = readString(data, "modelID") ?? readString(data, "id");
  if (providerID && modelID) defaults[providerID] = modelID;
  for (const [key, item] of Object.entries(data)) {
    if (typeof item === "string") defaults[key] = item;
  }
  return defaults;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const direct = readString(value, "message");
    if (direct) return direct;
    if ("error" in value) return errorMessage(value.error);
  }
  try {
    return JSON.stringify(value) || "OpenCode v2 execution failed.";
  } catch {
    return "OpenCode v2 execution failed.";
  }
}

function streamKey(properties: Record<string, unknown>, sessionID: string, messageID: string): string {
  const explicit = readString(properties, "textID") ?? readString(properties, "textId");
  if (explicit) return explicit;
  const ordinal = readNumber(properties, "ordinal");
  // v2 emits one text stream per (assistantMessageID, ordinal); keying on the
  // event-provided ordinal keeps multi-part messages from merging into one part.
  return ordinal === undefined ? `${sessionID}:${messageID}` : `${messageID}:${ordinal}`;
}

function resolveTextStream(
  properties: Record<string, unknown>,
  state: V2EventTranslationState,
): TextStream | null {
  const sessionID = readSessionID(properties);
  const messageID = readMessageID(properties);
  const explicitKey = streamKey(properties, sessionID, messageID);
  const byExplicitKey = state.streams.get(explicitKey);
  if (byExplicitKey) return byExplicitKey;
  const latestKey = sessionID ? state.latestStreamKeyBySession.get(sessionID) : undefined;
  if (latestKey) return state.streams.get(latestKey) ?? null;
  return null;
}

function terminalEvents(sessionID: string, error?: unknown): OpencodeEvent[] {
  const events: OpencodeEvent[] = [];
  if (error !== undefined) {
    events.push({
      type: "session.error",
      properties: {
        sessionID,
        error: { name: "UnknownError", data: { message: errorMessage(error) } },
      },
    });
  }
  events.push(
    { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID } },
  );
  return events;
}

export function createV2EventTranslationState(): V2EventTranslationState {
  return {
    streams: new Map(),
    latestStreamKeyBySession: new Map(),
    nextOrdinalByMessage: new Map(),
    unknownTypes: new Set(),
  };
}

export function translateV2Event(
  value: unknown,
  state: V2EventTranslationState,
): OpencodeEvent[] | null {
  if (!isRecord(value)) return null;
  const type = readString(value, "type");
  if (!type) return null;
  const properties = eventProperties(value);
  const sessionID = readSessionID(properties);

  if (type === "session.execution.started") {
    if (!sessionID) return null;
    return [{ type: "session.status", properties: { sessionID, status: { type: "busy" } } }];
  }

  if (type === "session.text.started" || type === "session.next.text.started") {
    const messageID = readMessageID(properties);
    if (!sessionID || !messageID) return null;
    const key = streamKey(properties, sessionID, messageID);
    const existing = state.streams.get(key);
    const ordinal = readNumber(properties, "ordinal")
      ?? existing?.ordinal
      ?? state.nextOrdinalByMessage.get(messageID)
      ?? 0;
    const stream = existing ?? {
      sessionID,
      messageID,
      partID: `${messageID}:${ordinal}`,
      ordinal,
      text: "",
    };
    state.streams.set(key, stream);
    state.latestStreamKeyBySession.set(sessionID, key);
    if (!existing) state.nextOrdinalByMessage.set(messageID, ordinal + 1);
    const part: TextPart = {
      id: stream.partID,
      messageID,
      sessionID,
      type: "text",
      text: "",
    };
    return [
      {
        type: "message.updated",
        properties: {
          info: {
            id: messageID,
            sessionID,
            role: "assistant",
            time: { created: readTimestamp(properties) },
          },
        },
      },
      { type: "message.part.updated", properties: { part } },
    ];
  }

  if (type === "session.text.delta" || type === "session.next.text.delta") {
    const stream = resolveTextStream(properties, state);
    const delta = readString(properties, "delta");
    if (!stream || delta === undefined) return null;
    stream.text += delta;
    return [{
      type: "message.part.delta",
      properties: {
        sessionID: stream.sessionID,
        messageID: stream.messageID,
        partID: stream.partID,
        field: "text",
        delta,
      },
    }];
  }

  if (type === "session.text.ended" || type === "session.next.text.ended") {
    const stream = resolveTextStream(properties, state);
    if (!stream) return null;
    const fullText = readString(properties, "text");
    if (fullText !== undefined) stream.text = fullText;
    const part: TextPart = {
      id: stream.partID,
      messageID: stream.messageID,
      sessionID: stream.sessionID,
      type: "text",
      text: stream.text,
    };
    return [{ type: "message.part.updated", properties: { part } }];
  }

  if (
    type === "session.execution.succeeded" ||
    type === "session.execution.interrupted"
  ) {
    return sessionID ? terminalEvents(sessionID) : null;
  }

  if (type === "session.execution.failed") {
    return sessionID ? terminalEvents(sessionID, properties.error ?? properties) : null;
  }

  if (type === "session.status") {
    if (!sessionID || !isRecord(properties.status)) return null;
    return [{ type: "session.status", properties: { sessionID, status: properties.status } }];
  }

  if (type === "session.idle") {
    return sessionID ? [{ type: "session.idle", properties: { sessionID } }] : null;
  }

  if (type === "session.created" || type === "session.renamed") {
    const info = mapV2Session(properties, undefined);
    if (!info) return null;
    return [{
      type: type === "session.created" ? "session.created" : "session.updated",
      properties: { info },
    }];
  }

  if (type === "session.deleted") {
    const info = mapV2Session(properties, undefined);
    const deletedSessionID = sessionID || info?.id || "";
    if (!deletedSessionID) return null;
    return [{
      type: "session.deleted",
      properties: { sessionID: deletedSessionID, ...(info ? { info } : {}) },
    }];
  }

  if (!state.unknownTypes.has(type)) {
    state.unknownTypes.add(type);
    console.debug(`[opencode-v2] skipping unsupported event type: ${type}`);
  }
  return null;
}

async function* translateV2Events(
  response: Response,
  signal: AbortSignal | undefined,
): AsyncGenerator<OpencodeEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = createV2EventTranslationState();
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const text = line.slice("data:".length).trim();
        if (!text) continue;
        let event: unknown;
        try {
          event = JSON.parse(text);
        } catch {
          continue;
        }
        const translated = translateV2Event(event, state);
        if (!translated) continue;
        for (const item of translated) yield item;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function createWebFetch(auth: { token?: string }): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (auth.token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${auth.token}`);
    }
    if (input instanceof Request) {
      return globalThis.fetch(new Request(input, { headers }), init);
    }
    return globalThis.fetch(input, { ...init, headers });
  };
}

function createV2Fetch(auth: { token?: string }): typeof globalThis.fetch {
  return isDesktopRuntime()
    ? createDesktopFetch({ mode: "openwork", token: auth.token })
    : createWebFetch(auth);
}

async function readPayload(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function successfulResult<T>(transport: TransportResult, data: T): FieldsResult<T> {
  return { data, request: transport.request, response: transport.response };
}

function failedResult<T>(transport: TransportResult): FieldsResult<T> {
  return {
    error: transport.payload ?? { name: "OpenCodeV2RequestFailed" },
    request: transport.request,
    response: transport.response,
  };
}

function localResult<T>(baseUrl: string, path: string, data: T): FieldsResult<T> {
  return {
    data,
    request: new Request(`${baseUrl}${path}`),
    response: new Response(null, { status: 200 }),
  };
}

function unsupportedResult<T>(baseUrl: string, operation: string): FieldsResult<T> {
  return {
    error: { name: "UnsupportedInV2Preview", operation },
    request: new Request(`${baseUrl}/unsupported/${encodeURIComponent(operation)}`),
    response: new Response(null, { status: 501, statusText: "Unsupported in OpenCode v2 preview" }),
  };
}

export function isOpencodeV2BaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, "").endsWith("/opencode2");
  } catch {
    return baseUrl.replace(/\/+$/, "").endsWith("/opencode2");
  }
}

export function createClientV2(
  opencode2BaseUrl: string,
  directory: string | undefined,
  auth: { token?: string },
): ReturnType<typeof createClient> {
  const baseUrl = opencode2BaseUrl.replace(/\/+$/, "");
  const fetchImpl = createV2Fetch(auth);
  const compatibilityClient = createClient(baseUrl, directory, { mode: "openwork", token: auth.token });

  const request = async (
    method: string,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TransportResult> => {
    const headers = new Headers();
    if (auth.token) headers.set("Authorization", `Bearer ${auth.token}`);
    if (body) headers.set("Content-Type", "application/json");
    const transportRequest = new Request(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const response = await fetchImpl(transportRequest);
    return { payload: await readPayload(response), request: transportRequest, response };
  };

  const getSession = async (
    parameters: SessionParameters,
    options?: RequestOptions,
  ): Promise<FieldsResult<Session>> => {
    const result = await request("GET", `/api/session/${encodeURIComponent(parameters.sessionID)}`, undefined, options?.signal);
    if (!result.response.ok) return failedResult(result);
    const session = mapV2Session(result.payload, directory);
    if (session) return successfulResult(result, session);
    return failedResult({ ...result, payload: { name: "InvalidV2SessionResponse" } });
  };

  const createSession = async (
    parameters: SessionCreateParameters = {},
    options?: RequestOptions,
  ): Promise<FieldsResult<Session>> => {
    const modelID = parameters.model?.id ?? parameters.model?.modelID;
    const model = parameters.model && modelID
      ? { providerID: parameters.model.providerID, id: modelID }
      : undefined;
    // v2 binds a session's location through the create BODY; the query-param
    // location middleware does not apply to session.create (verified against
    // the running engine: query-only creates land in the engine cwd project).
    const location = parameters.directory ?? directory;
    const result = await request("POST", "/api/session", {
      ...(model ? { model } : {}),
      ...(location ? { location: { directory: location } } : {}),
    }, options?.signal);
    if (!result.response.ok) return failedResult(result);
    const session = mapV2Session(result.payload, directory);
    if (session) return successfulResult(result, session);
    return failedResult({ ...result, payload: { name: "InvalidV2SessionResponse" } });
  };

  const session = {
    list: async (
      parameters: DirectoryParameters & { limit?: number } = {},
      options?: RequestOptions,
    ): Promise<FieldsResult<Session[]>> => {
      const query = new URLSearchParams();
      if (parameters.limit !== undefined) query.set("limit", String(parameters.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      const result = await request("GET", `/api/session${suffix}`, undefined, options?.signal);
      if (!result.response.ok) return failedResult(result);
      const data = responseItems(result.payload).flatMap((item) => {
        const mapped = mapV2Session(item, directory);
        return mapped ? [mapped] : [];
      });
      return successfulResult(result, data);
    },
    create: createSession,
    get: getSession,
    messages: async (
      parameters: SessionParameters & { limit?: number; before?: string },
      options?: RequestOptions,
    ): Promise<FieldsResult<V2MappedMessage[]>> => {
      const query = new URLSearchParams();
      if (parameters.limit !== undefined) query.set("limit", String(parameters.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      const result = await request(
        "GET",
        `/api/session/${encodeURIComponent(parameters.sessionID)}/message${suffix}`,
        undefined,
        options?.signal,
      );
      if (!result.response.ok) return failedResult(result);
      const data = responseItems(result.payload).flatMap((item) => {
        const mapped = mapV2Message(item, parameters.sessionID);
        return mapped ? [mapped] : [];
      });
      return successfulResult(result, data);
    },
    todo: async (parameters: SessionParameters): Promise<FieldsResult<never[]>> =>
      localResult(baseUrl, `/api/session/${encodeURIComponent(parameters.sessionID)}/todo`, []),
    status: async (): Promise<FieldsResult<Record<string, never>>> =>
      localResult(baseUrl, "/api/session/status", {}),
    promptAsync: async (
      parameters: PromptParameters,
      options?: RequestOptions,
    ): Promise<FieldsResult<Record<string, never>>> => {
      if (!parameters.model) {
        return {
          error: { name: "ModelRequiredInV2Preview" },
          request: new Request(`${baseUrl}/api/session/${encodeURIComponent(parameters.sessionID)}/model`),
          response: new Response(null, { status: 400 }),
        };
      }
      const modelResult = await request(
        "POST",
        `/api/session/${encodeURIComponent(parameters.sessionID)}/model`,
        { model: { providerID: parameters.model.providerID, id: parameters.model.modelID } },
        options?.signal,
      );
      if (!modelResult.response.ok) return failedResult(modelResult);
      const text = (parameters.parts ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => typeof part.text === "string" ? part.text : "")
        .join("");
      const promptResult = await request(
        "POST",
        `/api/session/${encodeURIComponent(parameters.sessionID)}/prompt`,
        { text },
        options?.signal,
      );
      if (!promptResult.response.ok) return failedResult(promptResult);
      return successfulResult(promptResult, {});
    },
    abort: async (
      parameters: SessionParameters,
      options?: RequestOptions,
    ): Promise<FieldsResult<boolean>> => {
      const result = await request(
        "POST",
        `/api/session/${encodeURIComponent(parameters.sessionID)}/interrupt`,
        {},
        options?.signal,
      );
      return result.response.ok ? successfulResult(result, true) : failedResult(result);
    },
    update: async (
      parameters: SessionUpdateParameters,
      options?: RequestOptions,
    ): Promise<FieldsResult<Session>> => {
      if (!parameters.title) return getSession(parameters, options);
      const result = await request(
        "POST",
        `/api/session/${encodeURIComponent(parameters.sessionID)}/rename`,
        { title: parameters.title },
        options?.signal,
      );
      if (!result.response.ok) return failedResult(result);
      const mapped = mapV2Session(result.payload, directory);
      return mapped ? successfulResult(result, mapped) : getSession(parameters, options);
    },
    delete: async (
      parameters: SessionParameters,
      options?: RequestOptions,
    ): Promise<FieldsResult<boolean>> => {
      const result = await request(
        "DELETE",
        `/api/session/${encodeURIComponent(parameters.sessionID)}`,
        undefined,
        options?.signal,
      );
      return result.response.ok ? successfulResult(result, true) : failedResult(result);
    },
    fork: async (): Promise<FieldsResult<Session>> => unsupportedResult(baseUrl, "session.fork"),
    revert: async (): Promise<FieldsResult<Session>> => unsupportedResult(baseUrl, "session.revert"),
    unrevert: async (): Promise<FieldsResult<Session>> => unsupportedResult(baseUrl, "session.unrevert"),
    summarize: async (): Promise<FieldsResult<boolean>> => unsupportedResult(baseUrl, "session.summarize"),
    shell: async (): Promise<FieldsResult<Record<string, never>>> => unsupportedResult(baseUrl, "session.shell"),
    command: async (): Promise<FieldsResult<Record<string, never>>> => unsupportedResult(baseUrl, "session.command"),
  };

  const adapter = {
    global: {
      health: async (options?: RequestOptions): Promise<FieldsResult<{ healthy: boolean; version: string }>> => {
        const result = await request("GET", "/api/health", undefined, options?.signal);
        if (!result.response.ok) return failedResult(result);
        const data = responseData(result.payload);
        return successfulResult(result, {
          healthy: isRecord(data) && data.healthy === true,
          version: readString(data, "version") ?? "v2",
        });
      },
    },
    session,
    config: {
      get: async (): Promise<FieldsResult<Record<string, never>>> => localResult(baseUrl, "/api/config", {}),
    },
    provider: {
      list: async (
        _parameters: DirectoryParameters = {},
        options?: RequestOptions,
      ): Promise<FieldsResult<ProviderListResponse>> => {
        const modelsResult = await request("GET", "/api/model", undefined, options?.signal);
        if (!modelsResult.response.ok) return failedResult(modelsResult);
        const defaultsResult = await request("GET", "/api/model/default", undefined, options?.signal);
        const models = responseItems(modelsResult.payload).flatMap((item) => {
          const mapped = mapV2Model(item);
          return mapped ? [mapped] : [];
        });
        const providersByID = new Map<string, Provider>();
        for (const model of models) {
          const current = providersByID.get(model.providerID);
          if (current) {
            current.models[model.id] = model;
            continue;
          }
          providersByID.set(model.providerID, {
            id: model.providerID,
            name: model.providerID,
            source: "config",
            env: [],
            options: {},
            models: { [model.id]: model },
          });
        }
        const all = [...providersByID.values()];
        return successfulResult(modelsResult, {
          all,
          connected: all.map((provider) => provider.id),
          default: defaultsResult.response.ok ? mapDefaultModels(defaultsResult.payload) : {},
        });
      },
    },
    app: {
      agents: async (): Promise<FieldsResult<never[]>> => localResult(baseUrl, "/api/agent", []),
    },
    command: {
      list: async (): Promise<FieldsResult<never[]>> => localResult(baseUrl, "/api/command", []),
    },
    permission: {
      list: async (): Promise<FieldsResult<never[]>> => localResult(baseUrl, "/api/permission", []),
    },
    question: {
      list: async (): Promise<FieldsResult<never[]>> => localResult(baseUrl, "/api/question", []),
    },
    v2: {
      session: {
        permission: {
          list: async (): Promise<FieldsResult<{ data: never[] }>> =>
            localResult(baseUrl, "/api/session/permission", { data: [] }),
        },
      },
    },
    find: {
      files: async (): Promise<FieldsResult<never[]>> => localResult(baseUrl, "/api/fs/find", []),
    },
    mcp: {
      status: async (): Promise<FieldsResult<Record<string, never>>> => localResult(baseUrl, "/api/mcp", {}),
    },
    event: {
      subscribe: async (
        _parameters?: DirectoryParameters,
        options?: RequestOptions,
      ): Promise<{ stream: AsyncGenerator<OpencodeEvent> }> => {
        const headers = new Headers({ Accept: "text/event-stream" });
        if (auth.token) headers.set("Authorization", `Bearer ${auth.token}`);
        const eventRequest = new Request(`${baseUrl}/api/event`, {
          headers,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        const response = await fetchImpl(eventRequest);
        if (!response.ok) {
          const error = new Error(errorMessage(await readPayload(response)));
          Object.assign(error, { status: response.status, response });
          throw error;
        }
        return { stream: translateV2Events(response, options?.signal) };
      },
    },
  };

  Object.assign(compatibilityClient.global, adapter.global);
  Object.assign(compatibilityClient.session, adapter.session);
  Object.assign(compatibilityClient.config, adapter.config);
  Object.assign(compatibilityClient.provider, adapter.provider);
  Object.assign(compatibilityClient.app, adapter.app);
  Object.assign(compatibilityClient.command, adapter.command);
  Object.assign(compatibilityClient.permission, adapter.permission);
  Object.assign(compatibilityClient.question, adapter.question);
  Object.assign(compatibilityClient.v2.session.permission, adapter.v2.session.permission);
  Object.assign(compatibilityClient.find, adapter.find);
  Object.assign(compatibilityClient.mcp, adapter.mcp);
  Object.assign(compatibilityClient.event, adapter.event);
  return compatibilityClient;
}

export type OpencodeV2Client = ReturnType<typeof createClientV2>;
