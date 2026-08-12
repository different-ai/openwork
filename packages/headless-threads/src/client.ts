/**
 * A function-driven client for native OpenWork threads.
 *
 * Every call goes to an OpenWork server surface that already exists:
 *
 * - `POST   /workspace/:id/sessions`                        create a thread
 * - `GET    /workspace/:id/sessions/:threadId/messages`     read messages
 * - `GET    /workspace/:id/sessions/:threadId/snapshot`     read status + messages + todos
 * - `POST   /workspace/:id/sessions/:threadId/abort`        stop a run
 * - `POST   /workspace/:id/opencode/session/:threadId/prompt_async`  submit a turn
 *
 * The last one is the workspace OpenCode mount the desktop app itself prompts
 * through. Routing turns through it — rather than adding a parallel prompt
 * route — is what keeps a headless thread indistinguishable from a thread the
 * user typed into. Callers depend on the functions below, not on those paths,
 * so the transport can move without breaking them.
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
  HeadlessThreadSnapshot,
  HeadlessThreadTranscript,
  HeadlessThreadTurnInput,
  HeadlessThreadWaitInput,
  HeadlessThreadWaitResult,
  HeadlessTurnAcceptance,
} from "./types.js";
import {
  abortResponseSchema,
  createThreadResponseSchema,
  isRunning,
  threadMessagesResponseSchema,
  threadSnapshotResponseSchema,
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

  function threadPath(threadId: string, suffix: string): string {
    return `${workspacePath}/sessions/${encodeURIComponent(threadId)}${suffix}`;
  }

  function requestSignal(signal?: AbortSignal): AbortSignal {
    const signals = [options.signal, signal].filter((item): item is AbortSignal => item !== undefined);
    signals.push(AbortSignal.timeout(requestTimeoutMs));
    return AbortSignal.any(signals);
  }

  async function send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; payload: unknown }> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(options.hostToken === undefined ? {} : { "X-OpenWork-Host-Token": options.hostToken }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestSignal(signal),
    });
    const text = await response.text().catch(() => "");
    const payload = text === "" ? undefined : safeJsonParse(text);
    if (response.ok) return { status: response.status, payload };

    const detail = errorBodySchema.safeParse(payload);
    throw new HeadlessThreadError({
      code: detail.success && detail.data.code !== undefined ? detail.data.code : "request_failed",
      message: detail.success && detail.data.message !== undefined
        ? detail.data.message
        : `OpenWork returned ${response.status} for ${method} ${path}`,
      method,
      path,
      status: response.status,
      body: payload,
    });
  }

  async function requestJson<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await send(method, path, body, signal);
    const parsed = schema.safeParse(response.payload);
    if (parsed.success) return parsed.data;
    throw new HeadlessThreadError({
      code: "invalid_response",
      message: `OpenWork returned an unexpected payload for ${method} ${path}`,
      method,
      path,
      status: response.status,
      body: parsed.error.issues,
    });
  }

  async function readMessages(threadId: string, signal?: AbortSignal) {
    const body = await requestJson(threadMessagesResponseSchema, "GET", threadPath(threadId, "/messages"), undefined, signal);
    return body.items;
  }

  async function getThreadSnapshot(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadSnapshot> {
    const body = await requestJson(threadSnapshotResponseSchema, "GET", threadPath(threadId, "/snapshot"), undefined, input?.signal);
    return toSnapshot(body.item);
  }

  async function createThread(input: CreateThreadInput): Promise<HeadlessThread> {
    const model = input.model ?? options.defaultModel;
    const body = await requestJson(createThreadResponseSchema, "POST", `${workspacePath}/sessions`, {
      title: input.title,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(model === undefined ? {} : { providerId: model.providerId, modelId: model.modelId }),
      ...(model?.variant === undefined ? {} : { variant: model.variant }),
    }, input.signal);
    return toThread(body.item, workspaceId, body.started);
  }

  async function sendTurn(threadId: string, input: HeadlessThreadTurnInput): Promise<HeadlessTurnAcceptance> {
    const model = input.model ?? options.defaultModel;
    const messages = await readMessages(threadId, input.signal);
    const messageCountBefore = messages.length;
    if (input.messageId && messages.some((message) => message.info.id === input.messageId && message.info.role === "user")) {
      return { threadId, acceptedAt: now(), messageCountBefore, messageId: input.messageId, alreadyPresent: true };
    }
    await send("POST", `${workspacePath}/opencode/session/${encodeURIComponent(threadId)}/prompt_async`, {
      parts: [{ type: "text", text: input.prompt }],
      ...(input.messageId === undefined ? {} : { messageID: input.messageId }),
      ...(model === undefined ? {} : { model: { providerID: model.providerId, modelID: model.modelId } }),
      ...(model?.variant === undefined ? {} : { variant: model.variant }),
    }, input.signal);
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
    const body = await requestJson(abortResponseSchema, "POST", threadPath(threadId, "/abort"), {}, input?.signal);
    return { threadId, accepted: body.ok };
  }

  async function exportTranscript(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadTranscript> {
    return toTranscript(await getThreadSnapshot(threadId, input));
  }

  return { createThread, sendTurn, waitForThread, waitUntilIdle, getThreadSnapshot, abortThread, exportTranscript };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
