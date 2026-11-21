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
  HeadlessThreadWaitingFor,
  HeadlessThreadAnswer,
  HeadlessThreadPending,
  HeadlessTurnAcceptance,
} from "./types.js";
import {
  answerRefusal,
  HEADLESS_THREAD_PENDING_ITEMS_MAX,
  permissionPending,
  PLAIN_FORM,
  v1QuestionPending,
  v2FormAnswer,
  v2FormPending,
  type PendingForm,
} from "./pending.js";
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

const pendingRequestRowSchema = z.object({ sessionID: z.string().optional() }).passthrough();
const pendingRequestListSchema = z.union([
  z.array(pendingRequestRowSchema),
  z.object({ data: z.array(pendingRequestRowSchema) }).passthrough(),
]).transform((value) => Array.isArray(value) ? value : value.data);
type PendingRequestRow = z.infer<typeof pendingRequestRowSchema>;

const helperSessionSchema = z.object({ id: z.string(), parentID: z.string().nullish() }).passthrough();
const helperSessionListSchema = z.object({ data: z.array(helperSessionSchema) }).passthrough();
const HELPER_DEPTH_MAX = 3;
const HELPERS_MAX = 8;

const v2ModelEntrySchema = z.object({ providerID: z.string(), id: z.string() }).passthrough();
const v2ModelCatalogSchema = z.union([
  z.array(v2ModelEntrySchema),
  z.object({ data: z.array(v2ModelEntrySchema) }).passthrough(),
]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]));
  }
  return value;
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
    if (result.response.status === 404) return "v1";
    if (!result.response.ok) throw failure("GET", path, result, { code: "engine_unresolved", retryable: true });
    const status = parsed(engineStatusSchema, "GET", path, result, true);
    return status.enabled && status.chatRouting ? "v2" : "v1";
  }

  let enginePromise: Promise<HeadlessThreadEngine> | null =
    options.engine === "v1" || options.engine === "v2" ? Promise.resolve(options.engine) : null;

  function resolveEngine(signal?: AbortSignal): Promise<HeadlessThreadEngine> {
    if (enginePromise) return enginePromise;
    const pending = detectEngine(signal);
    enginePromise = pending;
    pending.catch(() => {
      if (enginePromise === pending) enginePromise = null;
    });
    return pending;
  }

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

  interface Transport {
    engine: HeadlessThreadEngine;
    createPath: string;
    createSession(title: string, model: HeadlessThreadModel | null, signal?: AbortSignal,
      identity?: Pick<CreateThreadInput, "id" | "metadata">): Promise<SessionWire>;
    submit(threadId: string, prompt: string, model: HeadlessThreadModel | null, messageId: string | undefined, signal?: AbortSignal): Promise<void>;
    messages(threadId: string, signal?: AbortSignal): Promise<MessageWire[]>;
    snapshot(threadId: string, input?: { signal?: AbortSignal; limit?: number }): Promise<HeadlessThreadSnapshot>;
    abort(threadId: string, signal?: AbortSignal): Promise<boolean>;
    sessionModel(threadId: string, signal?: AbortSignal): Promise<HeadlessThreadModel | null>;
    requests(threadId: string, signal?: AbortSignal): Promise<{ permissions: PendingRequestRow[]; questions: PendingRequestRow[] }>;
    question(rows: unknown[]): PendingForm & { pending: HeadlessThreadPending } | null;
    replyQuestion(threadId: string, requestId: string, answer: Extract<HeadlessThreadAnswer, { kind: "question" }>, form: PendingForm, signal?: AbortSignal): Promise<void>;
    rejectQuestion(threadId: string, requestId: string, signal?: AbortSignal): Promise<void>;
    replyPermission(threadId: string, requestId: string, decision: "once" | "reject", signal?: AbortSignal): Promise<void>;
  }

  const v1Parents = new Map<string, string | null>();

  async function v1StartedBy(threadId: string, sessionId: string, signal?: AbortSignal): Promise<boolean> {
    let current = sessionId;
    for (let depth = 0; depth < HELPER_DEPTH_MAX; depth += 1) {
      let parent = v1Parents.get(current);
      if (parent === undefined) {
        const result = await send("GET", `${opencodePath}/session/${encodeURIComponent(current)}`, { signal }).catch(() => null);
        const session = result?.response.ok ? helperSessionSchema.safeParse(result.payload) : null;
        if (!session?.success) return false;
        parent = session.data.parentID ?? null;
        v1Parents.set(current, parent);
      }
      if (parent === null) return false;
      if (parent === threadId) return true;
      current = parent;
    }
    return false;
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
        ...(model?.variant ? { variant: model.variant } : {}),
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
    async sessionModel() {
      return null;
    },
    async requests(threadId, signal) {
      const [permissions, questions] = await Promise.all([
        json(pendingRequestListSchema, "GET", `${opencodePath}/permission`, { signal }),
        json(pendingRequestListSchema, "GET", `${opencodePath}/question`, { signal }),
      ]);
      const others = [...new Set([...permissions, ...questions].flatMap((row) => (
        row.sessionID !== undefined && row.sessionID !== threadId ? [row.sessionID] : []
      )))].slice(0, HELPERS_MAX);
      const helpers = new Set<string>();
      for (const id of others) if (await v1StartedBy(threadId, id, signal)) helpers.add(id);
      const mine = (rows: PendingRequestRow[]) => [
        ...rows.filter((row) => row.sessionID === threadId),
        ...rows.filter((row) => row.sessionID !== undefined && helpers.has(row.sessionID)),
      ];
      return { permissions: mine(permissions), questions: mine(questions) };
    },
    question(rows) {
      for (const row of rows) {
        const pending = v1QuestionPending(row);
        if (pending) return { ...PLAIN_FORM, pending };
      }
      return null;
    },
    async replyQuestion(_threadId, requestId, answer, _form, signal) {
      const path = `${opencodePath}/question/${encodeURIComponent(requestId)}/reply`;
      const result = await send("POST", path, { body: { answers: answer.answers }, signal });
      if (!result.response.ok) throw failure("POST", path, result);
    },
    async rejectQuestion(_threadId, requestId, signal) {
      const path = `${opencodePath}/question/${encodeURIComponent(requestId)}/reject`;
      const result = await send("POST", path, { signal });
      if (!result.response.ok) throw failure("POST", path, result);
    },
    async replyPermission(_threadId, requestId, decision, signal) {
      const path = `${opencodePath}/permission/${encodeURIComponent(requestId)}/reply`;
      const result = await send("POST", path, { body: { reply: decision }, signal });
      if (!result.response.ok) throw failure("POST", path, result);
    },
  };

  const v2Path = `${workspacePath}/opencode2/api`;
  const v2SessionPath = (threadId: string) => `${v2Path}/session/${encodeURIComponent(threadId)}`;
  const V2_MESSAGE_PAGE_LIMIT = 200;

  async function v2Session(threadId: string, signal?: AbortSignal) {
    return (await json(v2SessionSchema, "GET", v2SessionPath(threadId), { signal })).data;
  }

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

  async function v2Requests(sessionId: string, signal?: AbortSignal) {
    const [permissions, forms] = await Promise.all([
      json(pendingRequestListSchema, "GET", `${v2SessionPath(sessionId)}/permission`, { signal }),
      json(pendingRequestListSchema, "GET", `${v2SessionPath(sessionId)}/form`, { signal }),
    ]);
    const owned = (rows: PendingRequestRow[]) => rows.map((row) => ({ ...row, sessionID: row.sessionID ?? sessionId }));
    return { permissions: owned(permissions), questions: owned(forms) };
  }

  async function v2RunningHelpers(threadId: string, signal?: AbortSignal): Promise<string[]> {
    const helpers: string[] = [];
    let active: z.infer<typeof v2ActiveSchema>["data"] | null = null;
    let parents = [threadId];
    try {
      for (let depth = 0; depth < HELPER_DEPTH_MAX && parents.length > 0 && helpers.length < HELPERS_MAX; depth += 1) {
        const started: string[] = [];
        for (const parent of parents) {
          const query = new URLSearchParams({ parentID: parent, limit: "100" });
          const listed = await json(helperSessionListSchema, "GET", `${v2Path}/session?${query.toString()}`, { signal });
          started.push(...listed.data.flatMap((session) => session.parentID === parent ? [session.id] : []));
        }
        if (started.length === 0) break;
        active ??= (await json(v2ActiveSchema, "GET", `${v2Path}/session/active`, { signal })).data;
        const running = active;
        parents = started.filter((id) => running[id]?.type === "running");
        helpers.push(...parents);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return helpers.slice(0, HELPERS_MAX);
  }

  const v2: Transport = {
    engine: "v2",
    createPath: `${v2Path}/session`,
    async createSession(title, model, signal, identity) {
      const created = await json(v2SessionSchema, "POST", `${v2Path}/session`, {
        body: {
          title,
          ...(identity?.id === undefined ? {} : { id: identity.id }),
          ...(identity?.metadata === undefined ? {} : { metadata: identity.metadata }),
          ...(model === null ? {} : { model: { providerID: model.providerId, id: model.modelId } }),
        },
        signal,
      });
      const expectedMetadata = identity?.metadata;
      const matchesMetadata = expectedMetadata === undefined || Object.entries(expectedMetadata).every(([key, value]) => (
        JSON.stringify(canonicalJson(created.data.metadata?.[key])) === JSON.stringify(canonicalJson(value))
      ));
      if ((identity?.id !== undefined && created.data.id !== identity.id) || !matchesMetadata) {
        throw new HeadlessThreadError({ code: "creation_identity_mismatch", message: "The native session creation receipt did not match its requested identity and metadata.",
          method: "POST", path: `${v2Path}/session` });
      }
      return fromV2Session(created.data);
    },
    async submit(threadId, prompt, model, messageId, signal) {
      if (model !== null) {
        const modelPath = `${v2SessionPath(threadId)}/model`;
        const result = await send("POST", modelPath, {
          body: { model: { providerID: model.providerId, id: model.modelId, ...(model.variant ? { variant: model.variant } : {}) } },
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
    async requests(threadId, signal) {
      const own = await v2Requests(threadId, signal);
      if (own.permissions.length > 0 || own.questions.length > 0) return own;
      for (const helper of await v2RunningHelpers(threadId, signal)) {
        const rows = await v2Requests(helper, signal).catch((error: unknown) => {
          if (signal?.aborted) throw error;
          return null;
        });
        if (rows && (rows.permissions.length > 0 || rows.questions.length > 0)) return rows;
      }
      return own;
    },
    question(rows) {
      for (const row of rows) {
        const read = v2FormPending(row);
        if (read?.pending) return { ...read, pending: read.pending };
      }
      return null;
    },
    async replyQuestion(threadId, requestId, answer, form, signal) {
      const path = `${v2SessionPath(threadId)}/form/${encodeURIComponent(requestId)}/reply`;
      const values = v2FormAnswer(form, answer);
      if (typeof values === "string") refused("invalid_answer", values);
      const result = await send("POST", path, { body: { answer: values }, signal });
      if (!result.response.ok) throw failure("POST", path, result);
    },
    async rejectQuestion(threadId, requestId, signal) {
      const path = `${v2SessionPath(threadId)}/form/${encodeURIComponent(requestId)}`;
      const result = await send("DELETE", path, { signal });
      if (!result.response.ok) throw failure("DELETE", path, result);
    },
    async replyPermission(threadId, requestId, decision, signal) {
      const path = `${v2SessionPath(threadId)}/permission/${encodeURIComponent(requestId)}/reply`;
      const result = await send("POST", path, { body: { decision, reply: decision }, signal });
      if (!result.response.ok) throw failure("POST", path, result);
    },
  };

  async function transport(signal?: AbortSignal): Promise<Transport> {
    return await resolveEngine(signal) === "v2" ? v2 : v1;
  }

  async function getThreadSnapshot(threadId: string, input?: { signal?: AbortSignal; limit?: number }): Promise<HeadlessThreadSnapshot> {
    return (await transport(input?.signal)).snapshot(threadId, input);
  }

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
    if ((input.id !== undefined || input.metadata !== undefined) && engine.engine !== "v2") {
      return invalidCreatePayload("Native creation id and metadata are supported only by OpenCode V2; nothing was created.");
    }
    if (input.id !== undefined && (!/^ses_[a-zA-Z0-9]+$/.test(input.id) || input.id.length > 240)) {
      return invalidCreatePayload("id must be a native V2 session id");
    }
    if (input.metadata !== undefined && !z.record(z.string(), z.json()).safeParse(input.metadata).success) {
      return invalidCreatePayload("metadata must be a JSON object");
    }
    let model = input.model ?? options.defaultModel ?? null;
    if (model === null && (engine.engine === "v2" || prompt !== undefined)) {
      model = await workspaceDefaultModel(input.signal);
    }
    if (model === null && engine.engine === "v2") modelRequired("POST", engine.createPath);
    await requireAvailableModel(engine, model, input.signal);
    const session = await engine.createSession(title, model, input.signal, { id: input.id, metadata: input.metadata });
    if (prompt !== undefined) {
      try {
        await engine.submit(session.id, prompt, model, undefined, input.signal);
      } catch (error) {
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

  async function unspecifiedTurnModel(
    engine: Transport,
    threadId: string,
    messages: MessageWire[],
    signal?: AbortSignal,
  ): Promise<{ send: HeadlessThreadModel | null; check: HeadlessThreadModel | null }> {
    if (engine.engine === "v2") {
      const bound = await engine.sessionModel(threadId, signal);
      if (bound !== null) return { send: null, check: bound };
    } else if (messages.some((message) => message.info.role === "user")) {
      return { send: null, check: null };
    }
    const model = await workspaceDefaultModel(signal);
    if (model === null && engine.engine === "v2") modelRequired("POST", `${v2SessionPath(threadId)}/prompt`);
    return { send: model, check: model };
  }

  async function sendTurn(threadId: string, input: HeadlessThreadTurnInput): Promise<HeadlessTurnAcceptance> {
    const engine = await transport(input.signal);
    const messages = await engine.messages(threadId, input.signal);
    const messageCountBefore = messages.length;
    if (input.messageId && messages.some((message) => message.info.id === input.messageId && message.info.role === "user")) {
      return { threadId, acceptedAt: now(), messageCountBefore, messageId: input.messageId, alreadyPresent: true };
    }
    const named = input.model ?? options.defaultModel ?? null;
    const model = named === null
      ? await unspecifiedTurnModel(engine, threadId, messages, input.signal)
      : { send: named, check: named };
    await requireAvailableModel(engine, model.check, input.signal);
    await engine.submit(threadId, input.prompt, model.send, input.messageId, input.signal);
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

  async function getThreadWaitingFor(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadWaitingFor> {
    const pending = await (await transport(input?.signal)).requests(threadId, input?.signal);
    return pending.permissions.length > 0 ? "permission" : pending.questions.length > 0 ? "question" : null;
  }

  async function readOpenRequests(threadId: string, signal?: AbortSignal) {
    const engine = await transport(signal);
    const rows = await engine.requests(threadId, signal);
    const items: Array<{ pending: HeadlessThreadPending; form: PendingForm; sessionId: string }> = [];
    for (const row of rows.permissions) {
      const pending = permissionPending(row);
      if (pending) items.push({ pending, form: PLAIN_FORM, sessionId: row.sessionID ?? threadId });
    }
    for (const row of rows.questions) {
      const question = engine.question([row]);
      if (question) items.push({ pending: question.pending, form: question, sessionId: row.sessionID ?? threadId });
    }
    return { engine, items };
  }

  async function getThreadPendingItems(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadPending[]> {
    const { items } = await readOpenRequests(threadId, input?.signal);
    return items.slice(0, HEADLESS_THREAD_PENDING_ITEMS_MAX).map((item) => item.pending);
  }

  async function getThreadPending(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadPending | null> {
    return (await readOpenRequests(threadId, input?.signal)).items[0]?.pending ?? null;
  }

  function refused(code: "stale_request" | "invalid_answer", message: string): never {
    throw new HeadlessThreadError({ code, message, method: "POST", path: `${workspacePath}/answer`, status: 409, body: { code, message }, retryable: false });
  }

  async function answerThread(threadId: string, answer: HeadlessThreadAnswer, input?: { signal?: AbortSignal }): Promise<void> {
    const { engine, items } = await readOpenRequests(threadId, input?.signal);
    const named = items.filter((item) => item.pending.requestId === answer.requestId);
    const kind = answer.kind === "permission" ? "permission" : "question";
    const open = named.find((item) => item.pending.kind === kind);
    if (!open) {
      if (answer.kind === "dismiss" && named.length > 0) refused("invalid_answer", "A permission can't be dismissed. Allow it once or reject it.");
      return refused("stale_request", "That question or permission is no longer pending. Read the task again.");
    }
    if (answer.kind === "permission") {
      await engine.replyPermission(open.sessionId, answer.requestId, answer.decision, input?.signal);
      return;
    }
    if (answer.kind === "dismiss") {
      await engine.rejectQuestion(open.sessionId, answer.requestId, input?.signal);
      return;
    }
    if (open.pending.kind !== "question") return refused("stale_request", "That question is no longer pending.");
    if (!open.form.answerable) refused("invalid_answer", "This step can't be answered from here.");
    const refusal = answerRefusal(open.pending, answer.answers);
    if (refusal) refused("invalid_answer", refusal);
    await engine.replyQuestion(open.sessionId, answer.requestId, answer, open.form, input?.signal);
  }

  async function abortThread(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessAbortResult> {
    const accepted = await (await transport(input?.signal)).abort(threadId, input?.signal);
    return { threadId, accepted };
  }

  async function exportTranscript(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadTranscript> {
    return toTranscript(await getThreadSnapshot(threadId, input));
  }

  return {
    createThread, sendTurn, waitForThread, waitUntilIdle, getThreadSnapshot, getThreadWaitingFor, getThreadPending, getThreadPendingItems,
    answerThread, abortThread, exportTranscript,
  };
}
