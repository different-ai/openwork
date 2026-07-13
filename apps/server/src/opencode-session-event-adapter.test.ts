import { describe, expect, test } from "bun:test";
import { OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES } from "@openwork/session-contracts";

import {
  createOpenCodeSessionEventStreamResponse,
  normalizeOpenCodeSessionEvent,
  normalizeOpenCodeSessionFailure,
  normalizeOpenCodeSessionStreamError,
} from "./opencode-session-event-adapter.js";

const sessionInfo = {
  id: "ses_1",
  title: "Adapter contract",
  slug: "adapter-contract",
  directory: "/workspace",
  time: { created: 10, updated: 20 },
};

function parseSseFrames(text: string) {
  return text
    .trim()
    .split(/\n\n+/)
    .map((chunk) => chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, ""))
      .join("\n"))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

describe("OpenCode session event adapter", () => {
  test("normalizes direct and wrapped session updates and retains source ids", () => {
    const direct = normalizeOpenCodeSessionEvent({
      id: "evt_source",
      type: "session.updated",
      properties: { info: sessionInfo },
    }, "ws_1");
    const wrapped = normalizeOpenCodeSessionEvent({
      payload: {
        type: "session.updated",
        properties: { info: sessionInfo },
      },
    }, "ws_1", "evt_sse");

    expect(direct).toMatchObject({
      schemaVersion: 1,
      kind: "event",
      workspaceId: "ws_1",
      source: { adapterId: "builtin/opencode", eventType: "session.updated", eventId: "evt_source" },
      event: { kind: "session.updated", sessionId: "ses_1", info: sessionInfo },
    });
    expect(wrapped.source.eventId).toBe("evt_sse");
    expect(wrapped.event.kind).toBe("session.updated");
  });

  test("maps every known provider failure to a package-owned code", () => {
    const cases = [
      ["ProviderAuthError", "provider_auth"],
      ["MessageOutputLengthError", "output_limit"],
      ["MessageAbortedError", "aborted"],
      ["StructuredOutputError", "structured_output"],
      ["ContextOverflowError", "context_overflow"],
      ["ContentFilterError", "content_filter"],
      ["APIError", "upstream_api"],
      ["UnknownError", "unknown"],
    ] as const;

    for (const [name, code] of cases) {
      const failure = normalizeOpenCodeSessionFailure({
        name,
        data: {
          message: `${name} message`,
          providerID: "provider-1",
          statusCode: 429,
          isRetryable: true,
          responseBody: "body",
          ref: "ref-1",
          retries: 2,
        },
      });
      expect(failure.code).toBe(code);
      expect(failure.message).toBe(`${name} message`);
      expect(failure.retryable).toBe(code === "upstream_api");
    }
  });

  test("keeps exactly eighteen event types behind the explicit compatibility bridge", () => {
    expect(OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES).toHaveLength(18);
    for (const type of OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES) {
      const properties = { retained: type };
      const frame = normalizeOpenCodeSessionEvent({ type, properties }, "ws_1");
      expect(frame.event).toEqual({ kind: "compatibility", sourceType: type, properties });
    }
  });

  test("turns malformed and future events into diagnostics without leaking payloads", () => {
    const malformed = normalizeOpenCodeSessionEvent({
      type: "session.updated",
      properties: { info: { title: "missing id" } },
    }, "ws_1");
    const future = normalizeOpenCodeSessionEvent({
      type: "session.future",
      properties: { secretVendorShape: true },
    }, "ws_1");
    const empty = normalizeOpenCodeSessionEvent(null, "ws_1");

    expect(malformed.event).toEqual({
      kind: "unknown",
      sourceType: "session.updated",
      reason: "invalid_payload",
    });
    expect(future.event).toEqual({
      kind: "unknown",
      sourceType: "session.future",
      reason: "unsupported_type",
    });
    expect(empty.event).toEqual({
      kind: "unknown",
      sourceType: "unknown",
      reason: "invalid_payload",
    });

    const compatibilityWithoutProperties = normalizeOpenCodeSessionEvent({
      type: "session.idle",
    }, "ws_1");
    expect(JSON.parse(JSON.stringify(compatibilityWithoutProperties))).toMatchObject({
      event: { kind: "compatibility", sourceType: "session.idle", properties: null },
    });
  });

  test("maps upstream SSE statuses to stable retry policy", () => {
    expect(normalizeOpenCodeSessionStreamError(new Error("SSE failed: 401 Unauthorized"))).toEqual({
      code: "OPENWORK_SESSION_STREAM_UNAUTHORIZED",
      message: "OpenCode rejected the session event subscription.",
      retryable: false,
      status: 401,
    });
    expect(normalizeOpenCodeSessionStreamError(new Error("SSE failed: 403 Forbidden")).retryable).toBe(false);
    expect(normalizeOpenCodeSessionStreamError(new Error("SSE failed: 404 Not Found")).retryable).toBe(false);
    expect(normalizeOpenCodeSessionStreamError(new Error("socket closed"))).toEqual({
      code: "OPENWORK_SESSION_STREAM_ENGINE_UNAVAILABLE",
      message: "socket closed",
      retryable: true,
    });
  });

  test("emits canonical SSE frames and an honest terminal disconnect frame", async () => {
    const abortController = new AbortController();
    let options: Record<string, unknown> | undefined;
    const response = createOpenCodeSessionEventStreamResponse({
      workspaceId: "ws_1",
      signal: abortController.signal,
      subscribe: async (input) => {
        options = input as unknown as Record<string, unknown>;
        return {
          stream: (async function* () {
            input.onSseEvent({ id: "evt_1", data: { type: "session.updated" } });
            yield { type: "session.updated", properties: { info: sessionInfo } };
          })(),
        };
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = parseSseFrames(await response.text());
    expect(options?.sseMaxRetryAttempts).toBe(1);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      kind: "event",
      source: { eventId: "evt_1" },
      event: { kind: "session.updated", sessionId: "ses_1" },
    });
    expect(frames[1]).toMatchObject({
      kind: "stream.error",
      error: { code: "OPENWORK_SESSION_STREAM_DISCONNECTED", retryable: true },
    });
  });

  test("correlates callback ids with their exact yielded event", async () => {
    const response = createOpenCodeSessionEventStreamResponse({
      workspaceId: "ws_1",
      signal: new AbortController().signal,
      subscribe: async (input) => ({
        stream: (async function* () {
          input.onSseEvent({ id: "evt_1", data: { type: "session.idle" } });
          input.onSseEvent({ id: "evt_2", data: { type: "session.status" } });
          yield { type: "session.idle", properties: { sessionID: "ses_1" } };
          yield { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } };
        })(),
      }),
    });

    const frames = parseSseFrames(await response.text());
    expect(frames[0]?.source.eventId).toBe("evt_1");
    expect(frames[1]?.source.eventId).toBe("evt_2");
  });

  test("does not subscribe or emit a stream error when downstream is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();
    let subscribed = false;
    const response = createOpenCodeSessionEventStreamResponse({
      workspaceId: "ws_1",
      signal: abortController.signal,
      subscribe: async () => {
        subscribed = true;
        return { stream: (async function* () {})() };
      },
    });

    expect(await response.text()).toBe("");
    expect(subscribed).toBe(false);
  });

  test("does not emit a stream error after active downstream cancellation", async () => {
    const abortController = new AbortController();
    const response = createOpenCodeSessionEventStreamResponse({
      workspaceId: "ws_1",
      signal: abortController.signal,
      subscribe: async () => ({
        stream: (async function* () {
          abortController.abort();
          yield { type: "session.idle", properties: { sessionID: "ses_1" } };
        })(),
      }),
    });

    expect(await response.text()).toBe("");
  });
});
