/**
 * A function-driven client for native OpenWork threads.
 *
 * Every call goes through OpenWork's workspace-scoped OpenCode mount,
 * `/workspace/:id/opencode2/api`, so a headless thread is an ordinary chat.
 */
import { z } from "zod";

import { HeadlessThreadError } from "./errors.js";
import { assistantReplyForTurn, toTranscript } from "./transcript.js";
import type {
  CreateThreadInput,
  HeadlessAbortResult,
  HeadlessThread,
  HeadlessThreadClient,
  HeadlessThreadClientOptions,
  HeadlessThreadModel,
  HeadlessThreadSnapshot,
  HeadlessThreadTranscript,
  HeadlessThreadTurnInput,
  HeadlessThreadWaitInput,
  HeadlessThreadWaitResult,
  HeadlessThreadWaitingFor,
  HeadlessTurnAcceptance,
} from "./types.js";
import {
  isRunning,
  threadSnapshotSchema,
  toSnapshot,
  toThread,
  type MessageWire,
} from "./wire.js";
import {
  defaultModelSchema,
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
    message: z.string().optional(),
  })
  .passthrough();

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
  const v2Path = `${workspacePath}/opencode2/api`;
  const createPath = `${v2Path}/session`;
  const v2SessionPath = (threadId: string) => `${v2Path}/session/${encodeURIComponent(threadId)}`;
  const V2_MESSAGE_PAGE_LIMIT = 200;

  function invalidCreatePayload(message: string): never {
    throw new HeadlessThreadError({
      code: "invalid_payload",
      message,
      method: "POST",
      path: createPath,
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

  type RawResult = { response: Response; payload: unknown };

  /** Plain JSON calls to the OpenWork server and its OpenCode mount. */
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

  function parsed<T>(schema: z.ZodType<T>, method: string, path: string, result: RawResult): T {
    const value = schema.safeParse(result.payload);
    if (value.success) return value.data;
    throw new HeadlessThreadError({
      code: "invalid_response",
      message: `OpenWork returned an unexpected payload for ${method} ${path}`,
      method,
      path,
      status: result.response.status,
      body: value.error.issues,
    });
  }

  async function json<T>(schema: z.ZodType<T>, method: string, path: string, input?: { body?: unknown; signal?: AbortSignal }): Promise<T> {
    const result = await send(method, path, input);
    if (!result.response.ok) throw failure(method, path, result);
    return parsed(schema, method, path, result);
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

  async function v2Session(threadId: string, signal?: AbortSignal) {
    return (await json(v2SessionSchema, "GET", v2SessionPath(threadId), { signal })).data;
  }

  /** Pages v2 history (newest first) and returns it oldest first. */
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

  async function createSession(title: string, model: HeadlessThreadModel, signal: AbortSignal | undefined,
    identity: Pick<CreateThreadInput, "id" | "metadata">) {
    // The server binds the session to this workspace's folder while forwarding
    // native id/metadata intact. V2 deduplicates a repeated creation id.
    const created = await json(v2SessionSchema, "POST", createPath, {
      body: {
        title,
        ...(identity.id === undefined ? {} : { id: identity.id }),
        ...(identity.metadata === undefined ? {} : { metadata: identity.metadata }),
        model: { providerID: model.providerId, id: model.modelId },
      },
      signal,
    });
    const expectedMetadata = identity.metadata;
    const matchesMetadata = expectedMetadata === undefined || Object.entries(expectedMetadata).every(([key, value]) => (
      JSON.stringify(canonicalJson(created.data.metadata?.[key])) === JSON.stringify(canonicalJson(value))
    ));
    if ((identity.id !== undefined && created.data.id !== identity.id) || !matchesMetadata) {
      // An existing id is not authority to adopt its session. Fail before a
      // prompt when its ownership metadata or native identity differs.
      throw new HeadlessThreadError({ code: "creation_identity_mismatch", message: "The native session creation receipt did not match its requested identity and metadata.",
        method: "POST", path: createPath });
    }
    return fromV2Session(created.data);
  }

  /**
   * v2 takes a client-chosen prompt `id`, keeps it as the user message id,
   * and admits a repeated id once, so a retried turn never runs twice.
   * `model` null keeps the session's current model.
   */
  async function submit(threadId: string, prompt: string, model: HeadlessThreadModel | null, messageId: string | undefined, signal?: AbortSignal): Promise<void> {
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
  }

  async function getThreadSnapshot(threadId: string, input?: { signal?: AbortSignal; limit?: number }): Promise<HeadlessThreadSnapshot> {
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
  }

  /** Opt-in preflight: refuse before creating or prompting anything when the model is not runnable here. */
  async function requireAvailableModel(model: HeadlessThreadModel, signal?: AbortSignal): Promise<void> {
    if (!options.requireModelAvailability) return;
    const path = `${v2Path}/model`;
    const catalog = await json(v2ModelCatalogSchema, "GET", path, { signal });
    const entries = Array.isArray(catalog) ? catalog : catalog.data;
    if (!entries.some((entry) => entry.providerID === model.providerId && entry.id === model.modelId)) {
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
    if (input.id !== undefined && (!/^ses_[a-zA-Z0-9]+$/.test(input.id) || input.id.length > 240)) {
      return invalidCreatePayload("id must be a native V2 session id");
    }
    if (input.metadata !== undefined && !z.record(z.string(), z.json()).safeParse(input.metadata).success) {
      return invalidCreatePayload("metadata must be a JSON object");
    }
    // v2 binds a model to the session. Refuse before creating anything, so
    // no empty session is left behind.
    const model = input.model ?? options.defaultModel ?? await workspaceDefaultModel(input.signal);
    if (model === null) return modelRequired("POST", createPath);
    await requireAvailableModel(model, input.signal);
    const session = await createSession(title, model, input.signal, { id: input.id, metadata: input.metadata });
    if (prompt !== undefined) {
      try {
        await submit(session.id, prompt, model, undefined, input.signal);
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
    return { ...toThread(session, workspaceId, prompt !== undefined), model };
  }

  async function sendTurn(threadId: string, input: HeadlessThreadTurnInput): Promise<HeadlessTurnAcceptance> {
    const messages = await v2Messages(threadId, { signal: input.signal });
    const messageCountBefore = messages.length;
    if (input.messageId && messages.some((message) => message.info.id === input.messageId && message.info.role === "user")) {
      return { threadId, acceptedAt: now(), messageCountBefore, messageId: input.messageId, alreadyPresent: true };
    }
    const model = input.model ?? options.defaultModel ?? await workspaceDefaultModel(input.signal);
    // A v2 session keeps the model it was given; reuse it rather than refuse.
    const sessionModel = model === null ? v2SessionModel(await v2Session(threadId, input.signal)) : null;
    const runModel = model ?? sessionModel;
    if (runModel === null) return modelRequired("POST", `${v2SessionPath(threadId)}/prompt`);
    await requireAvailableModel(runModel, input.signal);
    await submit(threadId, input.prompt, model, input.messageId, input.signal);
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
    const pendingRequestList = z.union([z.array(z.object({}).passthrough()), z.object({ data: z.array(z.object({}).passthrough()) })])
      .transform((value) => Array.isArray(value) ? value : value.data);
    const [permissions, questions] = await Promise.all([
      json(pendingRequestList, "GET", `${v2SessionPath(threadId)}/permission`, { signal: input?.signal }),
      json(pendingRequestList, "GET", `${v2SessionPath(threadId)}/form`, { signal: input?.signal }),
    ]);
    const pending = { permissions: permissions.length, questions: questions.length };
    // A permission blocks the run outright, so it is the one to surface.
    return pending.permissions > 0 ? "permission" : pending.questions > 0 ? "question" : null;
  }

  async function abortThread(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessAbortResult> {
    const result = await json(v2InterruptSchema, "POST", `${v2SessionPath(threadId)}/interrupt`, { body: {}, signal: input?.signal });
    return { threadId, accepted: result.data.interrupted };
  }

  async function exportTranscript(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadTranscript> {
    return toTranscript(await getThreadSnapshot(threadId, input));
  }

  return { createThread, sendTurn, waitForThread, waitUntilIdle, getThreadSnapshot, getThreadWaitingFor, abortThread, exportTranscript };
}
