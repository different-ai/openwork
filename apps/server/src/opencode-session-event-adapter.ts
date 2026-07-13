import {
  OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES,
  OPEN_WORK_SESSION_EVENT_FRAME_VERSION,
  validateOpenWorkSession,
  validateOpenWorkSessionStreamFrame,
  type OpenWorkSessionEventFrame,
  type OpenWorkSessionFailure,
  type OpenWorkSessionStreamError,
  type OpenWorkSessionStreamErrorFrame,
  type OpenWorkSessionStreamFrame,
} from "@openwork/session-contracts";

const ADAPTER_ID = "builtin/opencode";
const COMPATIBILITY_TYPES = new Set<string>(OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES);

type RecordValue = Record<string, unknown>;

export interface OpenCodeSessionEventSubscribeOptions {
  signal: AbortSignal;
  onSseError: (error: unknown) => void;
  onSseEvent: (event: unknown) => void;
  sseMaxRetryAttempts: number;
}

export type OpenCodeSessionEventSubscribe = (
  options: OpenCodeSessionEventSubscribeOptions,
) => Promise<{ stream: AsyncIterable<unknown> }>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function firstStringValue(records: unknown[], keys: string[]): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = recordValue(record, key);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function firstNumberValue(records: unknown[], keys: string[]): number | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = recordValue(record, key);
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return undefined;
}

function firstBooleanValue(records: unknown[], keys: string[]): boolean | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = recordValue(record, key);
      if (typeof value === "boolean") return value;
    }
  }
  return undefined;
}

function failureDefaults(name: string | undefined): {
  code: OpenWorkSessionFailure["code"];
  message: string;
} {
  switch (name) {
    case "ProviderAuthError":
      return { code: "provider_auth", message: "Provider authentication failed" };
    case "MessageOutputLengthError":
      return { code: "output_limit", message: "The model reached its output limit before finishing" };
    case "MessageAbortedError":
      return { code: "aborted", message: "The message was interrupted" };
    case "StructuredOutputError":
      return { code: "structured_output", message: "The model could not produce valid structured output" };
    case "ContextOverflowError":
      return { code: "context_overflow", message: "The conversation is too large for the model context window" };
    case "ContentFilterError":
      return { code: "content_filter", message: "Content was filtered by the model provider" };
    case "APIError":
      return { code: "upstream_api", message: "The model provider request failed" };
    default:
      return { code: "unknown", message: "Session failed" };
  }
}

export function normalizeOpenCodeSessionFailure(error: unknown): OpenWorkSessionFailure {
  if (error instanceof Error) {
    return {
      code: "unknown",
      message: error.message.trim() || "Session failed",
      retryable: false,
    };
  }

  const data = recordValue(error, "data");
  const cause = recordValue(error, "cause");
  const causeData = recordValue(cause, "data");
  const records = [error, data, cause, causeData].filter(Boolean);
  const name = firstStringValue(records, ["name", "type"]);
  const defaults = failureDefaults(name);
  const message = firstStringValue(records, ["message", "detail", "reason", "error"]);
  const providerId = firstStringValue(records, ["providerID", "providerId", "provider"]);
  const statusCode = firstNumberValue(records, ["statusCode", "status"]);
  const responseBody = firstStringValue(records, ["responseBody", "body", "response"]);
  const reference = firstStringValue(records, ["ref", "reference"]);
  const retries = firstNumberValue(records, ["retries", "retryCount"]);
  const retryable = defaults.code === "upstream_api"
    ? firstBooleanValue(records, ["isRetryable", "retryable"]) === true
    : false;

  return {
    code: defaults.code,
    message: message ?? defaults.message,
    retryable,
    ...(providerId ? { providerId } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(responseBody ? { responseBody } : {}),
    ...(reference ? { reference } : {}),
    ...(retries !== undefined && Number.isInteger(retries) && retries >= 0 ? { retries } : {}),
  };
}

function rawEventRecord(raw: unknown): RecordValue | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.type === "string") return raw;
  return isRecord(raw.payload) ? raw.payload : undefined;
}

function validatedFrame(frame: OpenWorkSessionEventFrame): OpenWorkSessionEventFrame {
  const result = validateOpenWorkSessionStreamFrame(frame);
  if (!result.ok || result.value.kind !== "event") {
    throw new Error("The OpenCode session event adapter produced an invalid canonical frame.");
  }
  return result.value;
}

export function normalizeOpenCodeSessionEvent(
  raw: unknown,
  workspaceId: string,
  observedEventId?: string,
): OpenWorkSessionEventFrame {
  const record = rawEventRecord(raw);
  const sourceType = typeof record?.type === "string" && record.type.trim()
    ? record.type.trim()
    : "unknown";
  const rawEventId = typeof record?.id === "string" && record.id.trim() ? record.id.trim() : undefined;
  const eventId = rawEventId ?? (observedEventId?.trim() || undefined);
  const properties = record?.properties;
  const source = {
    adapterId: ADAPTER_ID,
    eventType: sourceType,
    ...(eventId ? { eventId } : {}),
  };
  const base = {
    schemaVersion: OPEN_WORK_SESSION_EVENT_FRAME_VERSION,
    kind: "event" as const,
    workspaceId,
    source,
  };

  if (sourceType === "session.updated") {
    const info = recordValue(properties, "info");
    const sessionId = firstStringValue([properties, info], ["sessionID", "id"]);
    const validated = validateOpenWorkSession(info);
    if (sessionId && validated.ok && validated.value.id === sessionId) {
      return validatedFrame({
        ...base,
        event: { kind: "session.updated", sessionId, info: validated.value },
      });
    }
    return validatedFrame({
      ...base,
      event: { kind: "unknown", sourceType, reason: "invalid_payload" },
    });
  }

  if (sourceType === "session.error") {
    const sessionId = firstStringValue([properties], ["sessionID"]);
    if (sessionId) {
      return validatedFrame({
        ...base,
        event: {
          kind: "session.failed",
          sessionId,
          failure: normalizeOpenCodeSessionFailure(recordValue(properties, "error")),
        },
      });
    }
    return validatedFrame({
      ...base,
      event: { kind: "unknown", sourceType, reason: "invalid_payload" },
    });
  }

  if (COMPATIBILITY_TYPES.has(sourceType)) {
    return validatedFrame({
      ...base,
      event: {
        kind: "compatibility",
        sourceType: sourceType as (typeof OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES)[number],
        // `undefined` is not representable in JSON and would erase this
        // required contract field during SSE serialization.
        properties: properties ?? null,
      },
    });
  }

  return validatedFrame({
    ...base,
    event: {
      kind: "unknown",
      sourceType,
      reason: record ? "unsupported_type" : "invalid_payload",
    },
  });
}

function statusFromSseError(error: unknown): number | undefined {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const match = text.match(/SSE failed:\s*(\d{3})\b/i);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : undefined;
}

export function normalizeOpenCodeSessionStreamError(error: unknown): OpenWorkSessionStreamError {
  const status = statusFromSseError(error);
  if (status === 401) {
    return {
      code: "OPENWORK_SESSION_STREAM_UNAUTHORIZED",
      message: "OpenCode rejected the session event subscription.",
      retryable: false,
      status,
    };
  }
  if (status === 403) {
    return {
      code: "OPENWORK_SESSION_STREAM_FORBIDDEN",
      message: "OpenCode forbids the session event subscription.",
      retryable: false,
      status,
    };
  }
  if (status === 404) {
    return {
      code: "OPENWORK_SESSION_STREAM_NOT_FOUND",
      message: "OpenCode does not expose the session event stream.",
      retryable: false,
      status,
    };
  }
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "The OpenCode session event stream disconnected.";
  return {
    code: "OPENWORK_SESSION_STREAM_ENGINE_UNAVAILABLE",
    message,
    retryable: true,
    ...(status !== undefined ? { status } : {}),
  };
}

function streamErrorFrame(
  workspaceId: string,
  error: OpenWorkSessionStreamError,
): OpenWorkSessionStreamErrorFrame {
  return {
    schemaVersion: OPEN_WORK_SESSION_EVENT_FRAME_VERSION,
    kind: "stream.error",
    workspaceId,
    source: { adapterId: ADAPTER_ID, eventType: "stream.error" },
    error,
  };
}

function encodeSseFrame(frame: OpenWorkSessionStreamFrame): Uint8Array {
  const eventId = frame.kind === "event" ? frame.source.eventId : undefined;
  const lines = [
    ...(eventId ? [`id: ${eventId}`] : []),
    "event: openwork.session",
    `data: ${JSON.stringify(frame)}`,
    "",
    "",
  ];
  return new TextEncoder().encode(lines.join("\n"));
}

export function createOpenCodeSessionEventStreamResponse(input: {
  workspaceId: string;
  signal: AbortSignal;
  subscribe: OpenCodeSessionEventSubscribe;
}): Response {
  const subscriptionController = new AbortController();
  const abort = () => subscriptionController.abort();
  if (input.signal.aborted) subscriptionController.abort();
  else input.signal.addEventListener("abort", abort, { once: true });

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let upstreamError: unknown;
      // HeyAPI exposes SSE metadata separately from the yielded data. Keep a
      // FIFO entry for every data-bearing callback so ids remain correlated
      // when the producer queues multiple events before iteration resumes.
      // The queue is subscription-local; it is not a replay cursor.
      const observedEventIds: Array<string | undefined> = [];
      try {
        if (subscriptionController.signal.aborted) return;
        const subscription = await input.subscribe({
          signal: subscriptionController.signal,
          sseMaxRetryAttempts: 1,
          onSseError: (error) => {
            upstreamError = error;
          },
          onSseEvent: (event) => {
            if (!isRecord(event) || !("data" in event)) return;
            const id = recordValue(event, "id");
            observedEventIds.push(typeof id === "string" && id.trim() ? id.trim() : undefined);
          },
        });
        for await (const raw of subscription.stream) {
          if (subscriptionController.signal.aborted) return;
          const frame = normalizeOpenCodeSessionEvent(raw, input.workspaceId, observedEventIds.shift());
          controller.enqueue(encodeSseFrame(frame));
        }
        if (!subscriptionController.signal.aborted) {
          const error = upstreamError
            ? normalizeOpenCodeSessionStreamError(upstreamError)
            : {
                code: "OPENWORK_SESSION_STREAM_DISCONNECTED" as const,
                message: "The OpenCode session event stream closed.",
                retryable: true,
              };
          controller.enqueue(encodeSseFrame(streamErrorFrame(input.workspaceId, error)));
        }
      } catch (error) {
        if (!subscriptionController.signal.aborted) {
          controller.enqueue(encodeSseFrame(streamErrorFrame(
            input.workspaceId,
            normalizeOpenCodeSessionStreamError(error),
          )));
        }
      } finally {
        input.signal.removeEventListener("abort", abort);
        try {
          controller.close();
        } catch {
          // The downstream request may have cancelled while the adapter closed.
        }
      }
    },
    cancel() {
      subscriptionController.abort();
      input.signal.removeEventListener("abort", abort);
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
