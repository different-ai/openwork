/**
 * A function-driven client for native OpenWork threads.
 *
 * Every call goes through OpenWork's workspace-scoped engine mounts, on the
 * engine the server routes chats to, so a headless thread is an ordinary chat:
 *
 * - v1: the OpenCode SDK against `/workspace/:id/opencode`
 * - v2: native routes under `/workspace/:id/opencode2/api`
 *
 * `GET /experimental/engine-v2-preview/status` picks the engine once per client.
 */
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { HeadlessThreadError } from "./errors.js";
import { assistantReplyForTurn, toTranscript } from "./transcript.js";
import type {
  CreateThreadInput,
  HeadlessAbortResult,
  HeadlessThread,
  HeadlessThreadClient,
  HeadlessThreadClientOptions,
  HeadlessThreadEngine,
  HeadlessThreadModel,
  HeadlessThreadSnapshot,
  HeadlessThreadTranscript,
  HeadlessThreadTurnInput,
  HeadlessThreadWaitInput,
  HeadlessThreadWaitResult,
  HeadlessTurnAcceptance,
} from "./types.js";
import {
  abortResultSchema,
  isRunning,
  sessionSchema,
  threadMessagesSchema,
  threadSnapshotSchema,
  threadStatusesSchema,
  threadTodosSchema,
  toSnapshot,
  toThread,
  type MessageWire,
  type SessionWire,
} from "./wire.js";
import {
  defaultModelSchema,
  engineStatusSchema,
  fromV2Messages,
  fromV2Session,
  toHeadlessModel,
  v2ActiveSchema,
  v2InterruptSchema,
  v2MessagePageSchema,
  v2SessionModel,
  v2SessionSchema,
} from "./v2-wire.js";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const errorBodySchema = z
  .object({
    code: z.string().optional(),
    _tag: z.string().optional(),
    name: z.string().optional(),
    message: z.string().optional(),
    data: z.object({ message: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const effectiveProvidersSchema = z.object({
  providers: z.array(z.object({
    id: z.string(),
    models: z.record(z.string(), z.object({}).passthrough()),
  })),
});

const v2ModelEntrySchema = z.object({ providerID: z.string(), id: z.string() }).passthrough();
const v2ModelCatalogSchema = z.union([
  z.array(v2ModelEntrySchema),
  z.object({ data: z.array(v2ModelEntrySchema) }).passthrough(),
]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scanned rather than matched with `/\/+$/`: the anchored form backtracks
 * quadratically on a long run of slashes, which CodeQL flags.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function createHeadlessThreadClient(options: HeadlessThreadClientOptions): HeadlessThreadClient {
  const baseUrl = stripTrailingSlashes(options.baseUrl);
  const workspaceId = options.workspaceId;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const workspacePath = `/workspace/${encodeURIComponent(workspaceId)}`;
  const opencodePath = `${workspacePath}/opencode`;

  function invalidCreatePayload(message: string): never {
    const path = `${opencodePath}/session`;
    throw new HeadlessThreadError({
      code: "invalid_payload",
      message,
      method: "POST",
      path,
      status: 400,
      body: { code: "invalid_payload", message },
    });
  }

  function createTitle(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) {
      return invalidCreatePayload("title must be a non-empty string");
    }
    const title = value.trim();
    if (title.length > 120) return invalidCreatePayload("title must be 120 characters or fewer");
    return title;
  }

  function initialPrompt(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !value.trim()) {
      return invalidCreatePayload("prompt must be a non-empty string");
    }
    const prompt = value.trim();
    if (prompt.length > 100_000) return invalidCreatePayload("prompt must be 100000 characters or fewer");
    return prompt;
  }

  function requestSignal(signal?: AbortSignal): AbortSignal | undefined {
    const signals = [options.signal, signal].filter((item): item is AbortSignal => item !== undefined);
    if (requestTimeoutMs !== 0) signals.push(AbortSignal.timeout(requestTimeoutMs));
    return signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  }

  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
    ...(options.hostToken === undefined ? {} : { "X-OpenWork-Host-Token": options.hostToken }),
  };

  const sdkFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    return fetchImpl(request.url, {
      method: request.method,
      headers,
      ...(body === "" ? {} : { body }),
      redirect: "error",
      signal: request.signal,
    });
  };
  const opencode = createOpencodeClient({
    baseUrl: `${baseUrl}${opencodePath}`,
    headers: authHeaders,
    redirect: "error",
    fetch: Object.assign(sdkFetch, { preconnect: () => {} }),
  });

  type SdkResult<T> = {
    data?: T;
    error?: unknown;
    response?: Response;
  };

  function sdkSuccess<T>(result: SdkResult<T>, method: string, path: string): T | undefined {
    if (result.error === undefined) return result.data;
    const detail = errorBodySchema.safeParse(result.error);
    const message = detail.success ? detail.data.message ?? detail.data.data?.message : undefined;
    throw new HeadlessThreadError({
      code: detail.success ? detail.data.code ?? detail.data.name ?? "request_failed" : "request_failed",
      message: message ?? (result.response
        ? `OpenWork returned ${result.response.status} for ${method} ${path}`
        : `OpenWork request failed for ${method} ${path}`),
      method,
      path,
      ...(result.response === undefined ? {} : { status: result.response.status }),
      body: result.error,
    });
  }

  function sdkJson<T>(schema: z.ZodType<T>, result: SdkResult<unknown>, method: string, path: string): T {
    const parsed = schema.safeParse(sdkSuccess(result, method, path));
    if (parsed.success) return parsed.data;
    throw new HeadlessThreadError({
      code: "invalid_response",
      message: `OpenWork returned an unexpected payload for ${method} ${path}`,
      method,
      path,
      ...(result.response === undefined ? {} : { status: result.response.status }),
      body: parsed.error.issues,
    });
  }

  type RawResult = { response: Response; payload: unknown };

  /** Plain JSON calls for routes the OpenCode SDK does not model: engine status, default model, and v2. */
  async function send(method: string, path: string, input?: { body?: unknown; signal?: AbortSignal }): Promise<RawResult> {
    const body = input?.body;
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...authHeaders,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: requestSignal(input?.signal),
      });
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
      return { response, payload };
    } catch (error) {
      throw new HeadlessThreadError({
        code: "request_failed",
        message: `OpenWork request failed for ${method} ${path}`,
        method,
        path,
        body: error instanceof Error ? error.message : error,
        retryable: true,
      });
    }
  }

  function failure(method: string, path: string, result: RawResult, input?: { code?: string; retryable?: boolean }): HeadlessThreadError {
    const detail = errorBodySchema.safeParse(result.payload);
    const code = detail.success ? detail.data.code ?? detail.data._tag : undefined;
    return new HeadlessThreadError({
      code: input?.code ?? code ?? "request_failed",
      message: detail.success && detail.data.message !== undefined
        ? detail.data.message
        : `OpenWork returned ${result.response.status} for ${method} ${path}`,
      method,
      path,
      status: result.response.status,
      body: result.payload,
      ...(input?.retryable === undefined ? {} : { retryable: input.retryable }),
    });
  }

  function parsed<T>(schema: z.ZodType<T>, method: string, path: string, result: RawResult, retryable?: boolean): T {
    const value = schema.safeParse(result.payload);
    if (value.success) return value.data;
    throw new HeadlessThreadError({
      code: "invalid_response",
      message: `OpenWork returned an unexpected payload for ${method} ${path}`,
      method,
      path,
      status: result.response.status,
      body: value.error.issues,
      ...(retryable === undefined ? {} : { retryable }),
    });
  }

  async function json<T>(schema: z.ZodType<T>, method: string, path: string, input?: { body?: unknown; signal?: AbortSignal }): Promise<T> {
    const result = await send(method, path, input);
    if (!result.response.ok) throw failure(method, path, result);
    return parsed(schema, method, path, result);
  }

  async function detectEngine(signal?: AbortSignal): Promise<HeadlessThreadEngine> {
    const path = "/experimental/engine-v2-preview/status";
    const result = await send("GET", path, { signal });
    // Only a server that predates the v2 preview answers 404, and it can only run v1.
    if (result.response.status === 404) return "v1";
    // Anything else is unknown, not v1: guessing v1 would start the thread
    // where the app does not look and on a model it does not show.
    if (!result.response.ok) throw failure("GET", path, result, { code: "engine_unresolved", retryable: true });
    const status = parsed(engineStatusSchema, "GET", path, result, true);
    return status.enabled && status.chatRouting ? "v2" : "v1";
  }

  let enginePromise: Promise<HeadlessThreadEngine> | null =
    options.engine === "v1" || options.engine === "v2" ? Promise.resolve(options.engine) : null;

  /** Resolved once per client; a failed lookup is forgotten so the next call retries it. */
  function resolveEngine(signal?: AbortSignal): Promise<HeadlessThreadEngine> {
    if (enginePromise) return enginePromise;
    const pending = detectEngine(signal);
    enginePromise = pending;
    pending.catch(() => {
      if (enginePromise === pending) enginePromise = null;
    });
    return pending;
  }

  /** The workspace's chosen model. Servers without the route answer 404, which means none. */
  async function workspaceDefaultModel(signal?: AbortSignal): Promise<HeadlessThreadModel | null> {
    const path = `${workspacePath}/default-model`;
    const result = await send("GET", path, { signal });
    if (result.response.status === 404) return null;
    if (!result.response.ok) throw failure("GET", path, result, { retryable: result.response.status >= 500 });
    return toHeadlessModel(parsed(defaultModelSchema, "GET", path, result).model);
  }

  function modelRequired(method: string, path: string): never {
    const message = "OpenCode v2 needs a model to run a thread. Pass a model or choose a default model for this workspace. Nothing was sent.";
    throw new HeadlessThreadError({
      code: "model_required",
      message,
      method,
      path,
      status: 400,
      body: { code: "model_required", message },
      retryable: false,
    });
  }

  /** One engine's session routes, in the v1 wire shapes `wire.ts` parses. */
  interface Transport {
    engine: HeadlessThreadEngine;
    createPath: string;
    createSession(title: string, model: HeadlessThreadModel | null, signal?: AbortSignal): Promise<SessionWire>;
    /** `model` null keeps the session's current model. */
    submit(threadId: string, prompt: string, model: HeadlessThreadModel | null, messageId: string | undefined, signal?: AbortSignal): Promise<void>;
    messages(threadId: string, signal?: AbortSignal): Promise<MessageWire[]>;
    snapshot(threadId: string, input?: { signal?: AbortSignal; limit?: number }): Promise<HeadlessThreadSnapshot>;
    abort(threadId: string, signal?: AbortSignal): Promise<boolean>;
    sessionModel(threadId: string, signal?: AbortSignal): Promise<HeadlessThreadModel | null>;
  }

  const v1: Transport = {
    engine: "v1",
    createPath: `${opencodePath}/session`,
    async createSession(title, _model, signal) {
      return sdkJson(
        sessionSchema,
        await opencode.session.create({ title }, { signal: requestSignal(signal) }),
        "POST",
        `${opencodePath}/session`,
      );
    },
    async submit(threadId, prompt, model, messageId, signal) {
      const path = `${opencodePath}/session/${encodeURIComponent(threadId)}/prompt_async`;
      const result = await opencode.session.promptAsync({
        sessionID: threadId,
        parts: [{ type: "text", text: prompt }],
        ...(messageId === undefined ? {} : { messageID: messageId }),
        ...(model === null ? {} : { model: { providerID: model.providerId, modelID: model.modelId } }),
        ...(model?.variant === undefined ? {} : { variant: model.variant }),
      }, { signal: requestSignal(signal) });
      sdkSuccess(result, "POST", path);
    },
    async messages(threadId, signal) {
      const path = `${opencodePath}/session/${encodeURIComponent(threadId)}/message`;
      return sdkJson(
        threadMessagesSchema,
        await opencode.session.messages({ sessionID: threadId }, { signal: requestSignal(signal) }),
        "GET",
        path,
      );
    },
    async snapshot(threadId, input) {
      const encodedThreadId = encodeURIComponent(threadId);
      const sessionPath = `${opencodePath}/session/${encodedThreadId}`;
      const messagesPath = `${sessionPath}/message`;
      const todosPath = `${sessionPath}/todo`;
      const statusPath = `${opencodePath}/session/status`;
      const [sessionResult, messagesResult, todosResult, statusResult] = await Promise.all([
        opencode.session.get({ sessionID: threadId }, { signal: requestSignal(input?.signal) }),
        opencode.session.messages({ sessionID: threadId, limit: input?.limit }, { signal: requestSignal(input?.signal) }),
        opencode.session.todo({ sessionID: threadId }, { signal: requestSignal(input?.signal) }),
        opencode.session.status(undefined, { signal: requestSignal(input?.signal) }),
      ]);
      const session = sdkJson(sessionSchema, sessionResult, "GET", sessionPath);
      const messages = sdkJson(threadMessagesSchema, messagesResult, "GET", messagesPath);
      const todos = sdkJson(threadTodosSchema, todosResult, "GET", todosPath);
      const statuses = sdkJson(threadStatusesSchema, statusResult, "GET", statusPath);
      return toSnapshot(threadSnapshotSchema.parse({
        session,
        messages,
        todos,
        status: statuses[threadId] ?? { type: "idle" },
      }));
    },
    async abort(threadId, signal) {
      const path = `${opencodePath}/session/${encodeURIComponent(threadId)}/abort`;
      return sdkJson(
        abortResultSchema,
        await opencode.session.abort({ sessionID: threadId }, { signal: requestSignal(signal) }),
        "POST",
        path,
      );
    },
    // v1 falls back to the engine's own default; there is nothing to read.
    async sessionModel() {
      return null;
    },
  };

  const v2Path = `${workspacePath}/opencode2/api`;
  const v2SessionPath = (threadId: string) => `${v2Path}/session/${encodeURIComponent(threadId)}`;
  const V2_MESSAGE_PAGE_LIMIT = 200;

  async function v2Session(threadId: string, signal?: AbortSignal) {
    return (await json(v2SessionSchema, "GET", v2SessionPath(threadId), { signal })).data;
  }

  /** Pages v2 history (newest first) and returns it oldest first, like v1. */
  async function v2Messages(threadId: string, input?: { signal?: AbortSignal; limit?: number }): Promise<MessageWire[]> {
    const limit = input?.limit === undefined ? undefined : Math.min(input.limit, V2_MESSAGE_PAGE_LIMIT);
    const path = `${v2SessionPath(threadId)}/message`;
    const rows: z.infer<typeof v2MessagePageSchema>["data"] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ limit: String(limit ?? V2_MESSAGE_PAGE_LIMIT) });
      if (cursor !== undefined) query.set("cursor", cursor);
      const page = await json(v2MessagePageSchema, "GET", `${path}?${query.toString()}`, { signal: input?.signal });
      rows.push(...page.data);
      const next = page.cursor?.next;
      if (limit !== undefined || !next || page.data.length === 0) break;
      if (seen.has(next)) {
        throw new HeadlessThreadError({ code: "invalid_response", message: `OpenWork returned a repeating cursor for GET ${path}`, method: "GET", path });
      }
      seen.add(next);
      cursor = next;
    }
    return fromV2Messages(rows.reverse());
  }

  const v2: Transport = {
    engine: "v2",
    createPath: `${v2Path}/session`,
    async createSession(title, model, signal) {
      // The server binds the session to this workspace's folder.
      const created = await json(v2SessionSchema, "POST", `${v2Path}/session`, {
        body: { title, ...(model === null ? {} : { model: { providerID: model.providerId, id: model.modelId } }) },
        signal,
      });
      return fromV2Session(created.data);
    },
    // v2 takes a client-chosen prompt `id`, keeps it as the user message id,
    // and admits a repeated id once, so a retried turn never runs twice.
    async submit(threadId, prompt, model, messageId, signal) {
      if (model !== null) {
        const modelPath = `${v2SessionPath(threadId)}/model`;
        const result = await send("POST", modelPath, {
          body: { model: { providerID: model.providerId, id: model.modelId, ...(model.variant === undefined ? {} : { variant: model.variant }) } },
          signal,
        });
        if (!result.response.ok) throw failure("POST", modelPath, result);
      }
      const promptPath = `${v2SessionPath(threadId)}/prompt`;
      const result = await send("POST", promptPath, {
        body: { text: prompt, ...(messageId === undefined ? {} : { id: messageId }) },
        signal,
      });
      if (!result.response.ok) throw failure("POST", promptPath, result);
    },
    messages: (threadId, signal) => v2Messages(threadId, { signal }),
    async snapshot(threadId, input) {
      const [session, messages, active] = await Promise.all([
        v2Session(threadId, input?.signal),
        v2Messages(threadId, input),
        json(v2ActiveSchema, "GET", `${v2Path}/session/active`, { signal: input?.signal }),
      ]);
      return toSnapshot(threadSnapshotSchema.parse({
        session: fromV2Session(session),
        messages,
        // v2 has no todo list.
        todos: [],
        status: active.data[threadId]?.type === "running" ? { type: "busy" } : { type: "idle" },
      }));
    },
    async abort(threadId, signal) {
      const result = await json(v2InterruptSchema, "POST", `${v2SessionPath(threadId)}/interrupt`, { body: {}, signal });
      return result.data.interrupted;
    },
    async sessionModel(threadId, signal) {
      return v2SessionModel(await v2Session(threadId, signal));
    },
  };

  async function transport(signal?: AbortSignal): Promise<Transport> {
    return await resolveEngine(signal) === "v2" ? v2 : v1;
  }

  async function getThreadSnapshot(threadId: string, input?: { signal?: AbortSignal; limit?: number }): Promise<HeadlessThreadSnapshot> {
    return (await transport(input?.signal)).snapshot(threadId, input);
  }

  /** Whether the engine's effective catalog for this workspace lists the model. */
  async function catalogHasModel(engine: HeadlessThreadEngine, model: HeadlessThreadModel, signal?: AbortSignal): Promise<{ path: string; available: boolean }> {
    if (engine === "v2") {
      const path = `${v2Path}/model`;
      const catalog = await json(v2ModelCatalogSchema, "GET", path, { signal });
      const entries = Array.isArray(catalog) ? catalog : catalog.data;
      return { path, available: entries.some((entry) => entry.providerID === model.providerId && entry.id === model.modelId) };
    }
    const path = `${opencodePath}/config/providers`;
    const catalog = sdkJson(
      effectiveProvidersSchema,
      await opencode.config.providers(undefined, { signal: requestSignal(signal) }),
      "GET",
      path,
    );
    const provider = catalog.providers.find((candidate) => candidate.id === model.providerId);
    return { path, available: provider !== undefined && Object.hasOwn(provider.models, model.modelId) };
  }

  /** Opt-in preflight: refuse before creating or prompting anything when the model is not runnable here. */
  async function requireAvailableModel(engine: Transport, model: HeadlessThreadModel | null, signal?: AbortSignal): Promise<void> {
    if (!options.requireModelAvailability) return;
    if (!model) {
      throw new HeadlessThreadError({ code: "invalid_payload", message: "An explicit model is required.", method: "POST", path: engine.createPath });
    }
    const { path, available } = await catalogHasModel(engine.engine, model, signal);
    if (!available) {
      throw new HeadlessThreadError({
        code: "model_access_lost",
        message: `The selected model ${model.providerId}/${model.modelId} is not available in this workspace. Choose a supported model to resume this Automation.`,
        method: "GET",
        path,
      });
    }
  }

  async function createThread(input: CreateThreadInput): Promise<HeadlessThread> {
    const prompt = initialPrompt(input.prompt);
    const title = createTitle(input.title);
    const engine = await transport(input.signal);
    let model = input.model ?? options.defaultModel ?? null;
    // v1 only needs a model to run a prompt; v2 binds one to the session.
    if (model === null && (engine.engine === "v2" || prompt !== undefined)) {
      model = await workspaceDefaultModel(input.signal);
    }
    // Refuse before creating anything, so no empty session is left behind.
    if (model === null && engine.engine === "v2") modelRequired("POST", engine.createPath);
    await requireAvailableModel(engine, model, input.signal);
    const session = await engine.createSession(title, model, input.signal);
    if (prompt !== undefined) {
      try {
        await engine.submit(session.id, prompt, model, undefined, input.signal);
      } catch (error) {
        // Keep the created thread's identity so a caller can link to and recover it.
        const contextualError = error instanceof Error ? error : new Error(String(error));
        Object.defineProperties(contextualError, {
          sessionId: { value: session.id },
          workspaceId: { value: workspaceId },
        });
        throw contextualError;
      }
    }
    return {
      ...toThread(session, workspaceId, prompt !== undefined),
      engine: engine.engine,
      ...(model === null ? {} : { model }),
    };
  }

  async function sendTurn(threadId: string, input: HeadlessThreadTurnInput): Promise<HeadlessTurnAcceptance> {
    const engine = await transport(input.signal);
    const messages = await engine.messages(threadId, input.signal);
    const messageCountBefore = messages.length;
    if (input.messageId && messages.some((message) => message.info.id === input.messageId && message.info.role === "user")) {
      return { threadId, acceptedAt: now(), messageCountBefore, messageId: input.messageId, alreadyPresent: true };
    }
    const model = input.model ?? options.defaultModel ?? await workspaceDefaultModel(input.signal);
    // A v2 session keeps the model it was given; reuse it rather than refuse.
    const sessionModel = model === null && engine.engine === "v2" ? await engine.sessionModel(threadId, input.signal) : null;
    if (model === null && engine.engine === "v2" && sessionModel === null) {
      modelRequired("POST", `${v2SessionPath(threadId)}/prompt`);
    }
    await requireAvailableModel(engine, model ?? sessionModel, input.signal);
    await engine.submit(threadId, input.prompt, model, input.messageId, input.signal);
    return {
      threadId,
      acceptedAt: now(),
      messageCountBefore,
      messageId: input.messageId ?? null,
      alreadyPresent: false,
    };
  }

  async function waitForThread(threadId: string, input: HeadlessThreadWaitInput): Promise<HeadlessThreadWaitResult> {
    const startedAt = now();
    const deadline = startedAt + input.timeoutMs;
    const interval = input.pollIntervalMs ?? pollIntervalMs;
    const messageCountBefore = input.since?.messageCountBefore ?? 0;
    const messageId = input.since?.messageId ?? null;
    let polls = 0;
    let observedRunning = false;

    for (;;) {
      if (input.signal?.aborted) {
        const snapshot = await getThreadSnapshot(threadId);
        return { outcome: "aborted", snapshot, waitedMs: now() - startedAt, polls, observedRunning, terminalError: null };
      }
      const snapshot = await getThreadSnapshot(threadId, { signal: input.signal });
      polls += 1;
      const finish = (outcome: HeadlessThreadWaitResult["outcome"]): HeadlessThreadWaitResult => ({
        outcome,
        snapshot,
        waitedMs: now() - startedAt,
        polls,
        observedRunning,
        terminalError: outcome === "failed"
          ? assistantReplyForTurn(snapshot.messages, { messageId, messageCountBefore })?.error ?? null
          : null,
      });

      if (isRunning(snapshot.status)) {
        observedRunning = true;
      } else {
        const reply = assistantReplyForTurn(snapshot.messages, { messageId, messageCountBefore });
        if (reply?.error) return finish("failed");
        if (reply) return finish("settled");
      }

      if (input.signal?.aborted) return finish("aborted");
      const remaining = deadline - now();
      if (remaining <= 0) return finish("timeout");
      await sleep(Math.min(interval, remaining));
    }
  }

  async function waitUntilIdle(threadId: string, input: HeadlessThreadWaitInput): Promise<HeadlessThreadWaitResult> {
    const startedAt = now();
    const deadline = startedAt + input.timeoutMs;
    const interval = input.pollIntervalMs ?? pollIntervalMs;
    let polls = 0;
    let observedRunning = false;
    for (;;) {
      if (input.signal?.aborted) {
        const snapshot = await getThreadSnapshot(threadId);
        return { outcome: "aborted", snapshot, waitedMs: now() - startedAt, polls, observedRunning, terminalError: null };
      }
      const snapshot = await getThreadSnapshot(threadId, { signal: input.signal });
      polls += 1;
      if (!isRunning(snapshot.status)) {
        return { outcome: "settled", snapshot, waitedMs: now() - startedAt, polls, observedRunning, terminalError: null };
      }
      observedRunning = true;
      const remaining = deadline - now();
      if (remaining <= 0) {
        return { outcome: "timeout", snapshot, waitedMs: now() - startedAt, polls, observedRunning, terminalError: null };
      }
      await sleep(Math.min(interval, remaining));
    }
  }

  async function abortThread(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessAbortResult> {
    const accepted = await (await transport(input?.signal)).abort(threadId, input?.signal);
    return { threadId, accepted };
  }

  async function exportTranscript(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadTranscript> {
    return toTranscript(await getThreadSnapshot(threadId, input));
  }

  return { createThread, sendTurn, waitForThread, waitUntilIdle, getThreadSnapshot, abortThread, exportTranscript };
}
