/**
 * A function-driven client for native OpenWork threads.
 *
 * Every call uses the OpenCode SDK through OpenWork's workspace-scoped mount:
 *
 * - `POST /workspace/:id/opencode/session` creates a thread
 * - native session reads provide messages, todos, and status
 * - native prompt and abort calls control a turn
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
} from "./wire.js";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const errorBodySchema = z
  .object({ code: z.string().optional(), message: z.string().optional() })
  .passthrough();

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
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...(options.hostToken === undefined ? {} : { "X-OpenWork-Host-Token": options.hostToken }),
    },
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
    throw new HeadlessThreadError({
      code: detail.success && detail.data.code !== undefined ? detail.data.code : "request_failed",
      message: detail.success && detail.data.message !== undefined
        ? detail.data.message
        : result.response
          ? `OpenWork returned ${result.response.status} for ${method} ${path}`
          : `OpenWork request failed for ${method} ${path}`,
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

  async function readMessages(threadId: string, signal?: AbortSignal) {
    const path = `${opencodePath}/session/${encodeURIComponent(threadId)}/message`;
    return sdkJson(
      threadMessagesSchema,
      await opencode.session.messages({ sessionID: threadId }, { signal: requestSignal(signal) }),
      "GET",
      path,
    );
  }

  async function getThreadSnapshot(threadId: string, input?: { signal?: AbortSignal; limit?: number }): Promise<HeadlessThreadSnapshot> {
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
  }

  async function createThread(input: CreateThreadInput): Promise<HeadlessThread> {
    const model = input.model ?? options.defaultModel;
    const createPath = `${opencodePath}/session`;
    const prompt = initialPrompt(input.prompt);
    const session = sdkJson(
      sessionSchema,
      await opencode.session.create({ title: createTitle(input.title) }, { signal: requestSignal(input.signal) }),
      "POST",
      createPath,
    );
    if (prompt !== undefined) {
      const promptPath = `${opencodePath}/session/${encodeURIComponent(session.id)}/prompt_async`;
      const result = await opencode.session.promptAsync({
        sessionID: session.id,
        parts: [{ type: "text", text: prompt }],
        ...(model === undefined ? {} : { model: { providerID: model.providerId, modelID: model.modelId } }),
        ...(model?.variant === undefined ? {} : { variant: model.variant }),
      }, { signal: requestSignal(input.signal) });
      sdkSuccess(result, "POST", promptPath);
    }
    return toThread(session, workspaceId, prompt !== undefined);
  }

  async function sendTurn(threadId: string, input: HeadlessThreadTurnInput): Promise<HeadlessTurnAcceptance> {
    const model = input.model ?? options.defaultModel;
    const messages = await readMessages(threadId, input.signal);
    const messageCountBefore = messages.length;
    if (input.messageId && messages.some((message) => message.info.id === input.messageId && message.info.role === "user")) {
      return { threadId, acceptedAt: now(), messageCountBefore, messageId: input.messageId, alreadyPresent: true };
    }
    const path = `${opencodePath}/session/${encodeURIComponent(threadId)}/prompt_async`;
    const result = await opencode.session.promptAsync({
      sessionID: threadId,
      parts: [{ type: "text", text: input.prompt }],
      ...(input.messageId === undefined ? {} : { messageID: input.messageId }),
      ...(model === undefined ? {} : { model: { providerID: model.providerId, modelID: model.modelId } }),
      ...(model?.variant === undefined ? {} : { variant: model.variant }),
    }, { signal: requestSignal(input.signal) });
    sdkSuccess(result, "POST", path);
    return { threadId, acceptedAt: now(), messageCountBefore, messageId: input.messageId ?? null, alreadyPresent: false };
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
    const path = `${opencodePath}/session/${encodeURIComponent(threadId)}/abort`;
    const accepted = sdkJson(
      abortResultSchema,
      await opencode.session.abort({ sessionID: threadId }, { signal: requestSignal(input?.signal) }),
      "POST",
      path,
    );
    return { threadId, accepted };
  }

  async function exportTranscript(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadTranscript> {
    return toTranscript(await getThreadSnapshot(threadId, input));
  }

  return { createThread, sendTurn, waitForThread, waitUntilIdle, getThreadSnapshot, abortThread, exportTranscript };
}
