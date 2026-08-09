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
import { hasAssistantReplySince, toTranscript } from "./transcript.js";
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
  const workspacePath = `/workspace/${encodeURIComponent(workspaceId)}`;

  function threadPath(threadId: string, suffix: string): string {
    return `${workspacePath}/sessions/${encodeURIComponent(threadId)}${suffix}`;
  }

  async function send(method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  async function requestJson<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<T> {
    const response = await send(method, path, body);
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

  async function countMessages(threadId: string): Promise<number> {
    const body = await requestJson(threadMessagesResponseSchema, "GET", threadPath(threadId, "/messages"));
    return body.items.length;
  }

  async function getThreadSnapshot(threadId: string): Promise<HeadlessThreadSnapshot> {
    const body = await requestJson(threadSnapshotResponseSchema, "GET", threadPath(threadId, "/snapshot"));
    return toSnapshot(body.item);
  }

  async function createThread(input: CreateThreadInput): Promise<HeadlessThread> {
    const model = input.model ?? options.defaultModel;
    const body = await requestJson(createThreadResponseSchema, "POST", `${workspacePath}/sessions`, {
      title: input.title,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(model === undefined ? {} : { providerId: model.providerId, modelId: model.modelId }),
      ...(model?.variant === undefined ? {} : { variant: model.variant }),
    });
    return toThread(body.item, workspaceId, body.started);
  }

  async function sendTurn(threadId: string, input: HeadlessThreadTurnInput): Promise<HeadlessTurnAcceptance> {
    const model = input.model ?? options.defaultModel;
    // Read the message count first: it is the only way a later wait can tell a
    // reply to this turn apart from replies already in the thread.
    const messageCountBefore = await countMessages(threadId);
    await send("POST", `${workspacePath}/opencode/session/${encodeURIComponent(threadId)}/prompt_async`, {
      parts: [{ type: "text", text: input.prompt }],
      ...(model === undefined ? {} : { model: { providerID: model.providerId, modelID: model.modelId } }),
      ...(model?.variant === undefined ? {} : { variant: model.variant }),
    });
    return { threadId, acceptedAt: now(), messageCountBefore };
  }

  async function waitForThread(threadId: string, input: HeadlessThreadWaitInput): Promise<HeadlessThreadWaitResult> {
    const startedAt = now();
    const deadline = startedAt + input.timeoutMs;
    const interval = input.pollIntervalMs ?? pollIntervalMs;
    const messageCountBefore = input.since?.messageCountBefore ?? 0;
    let polls = 0;
    let observedRunning = false;

    for (;;) {
      const snapshot = await getThreadSnapshot(threadId);
      polls += 1;
      const finish = (outcome: HeadlessThreadWaitResult["outcome"]): HeadlessThreadWaitResult => ({
        outcome,
        snapshot,
        waitedMs: now() - startedAt,
        polls,
        observedRunning,
      });

      if (isRunning(snapshot.status)) {
        observedRunning = true;
      } else if (hasAssistantReplySince(snapshot.messages, messageCountBefore)) {
        return finish("settled");
      }

      if (input.signal?.aborted) return finish("aborted");
      const remaining = deadline - now();
      if (remaining <= 0) return finish("timeout");
      await sleep(Math.min(interval, remaining));
    }
  }

  async function abortThread(threadId: string): Promise<HeadlessAbortResult> {
    const body = await requestJson(abortResponseSchema, "POST", threadPath(threadId, "/abort"), {});
    return { threadId, accepted: body.ok };
  }

  async function exportTranscript(threadId: string): Promise<HeadlessThreadTranscript> {
    return toTranscript(await getThreadSnapshot(threadId));
  }

  return { createThread, sendTurn, waitForThread, getThreadSnapshot, abortThread, exportTranscript };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
