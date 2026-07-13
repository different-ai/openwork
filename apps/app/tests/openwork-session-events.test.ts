import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __readOpenworkSessionEventStreamForTest,
  createOpenworkServerClient,
  OpenworkServerError,
  OpenworkSessionEventStreamError,
} from "../src/app/lib/openwork-server";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const stops: Array<() => void | Promise<void>> = [];
const originalWindow = globalThis.window;

beforeEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
});

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

function startServer(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }) as Served;
  stops.push(() => server.stop(true));
  return server;
}

describe("OpenworkServerClient session event stream", () => {
  test("subscribes to the canonical route and validates every frame", async () => {
    const requests: Array<{ url: string; authorization: string | null; accept: string | null }> = [];
    const update = {
      schemaVersion: 1,
      kind: "event",
      workspaceId: "ws_1",
      source: { adapterId: "builtin/opencode", eventType: "session.updated", eventId: "evt_1" },
      event: {
        kind: "session.updated",
        sessionId: "ses_1",
        info: { id: "ses_1", title: "Canonical app event" },
      },
    };
    const unknown = {
      schemaVersion: 1,
      kind: "event",
      workspaceId: "ws_1",
      source: { adapterId: "builtin/opencode", eventType: "session.future" },
      event: { kind: "unknown", sourceType: "session.future", reason: "unsupported_type" },
    };
    const server = startServer((request) => {
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
      });
      return new Response([
        "event: openwork.session",
        `data: ${JSON.stringify(update)}`,
        "",
        "event: openwork.session",
        `data: ${JSON.stringify(unknown)}`,
        "",
        "",
      ].join("\r\n"), { headers: { "Content-Type": "text/event-stream" } });
    });
    const client = createOpenworkServerClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: "client-token",
    });

    const subscription = await client.subscribeSessionEvents("ws_1");
    const frames = [];
    for await (const frame of subscription.stream) frames.push(frame);

    expect(frames).toEqual([update, unknown]);
    expect(new URL(requests[0]!.url).pathname).toBe("/workspace/ws_1/sessions/events");
    expect(requests[0]!.authorization).toBe("Bearer client-token");
    expect(requests[0]!.accept).toBe("text/event-stream");
  });

  test("preserves HTTP status for the narrow old-server fallback decision", async () => {
    const server = startServer(() => Response.json({
      code: "not_found",
      message: "No canonical stream",
    }, { status: 404 }));
    const client = createOpenworkServerClient({ baseUrl: `http://127.0.0.1:${server.port}` });

    await expect(client.subscribeSessionEvents("ws_1")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
      message: "No canonical stream",
    });
    await client.subscribeSessionEvents("ws_1").catch((error) => {
      expect(error).toBeInstanceOf(OpenworkServerError);
    });
  });

  test("rejects malformed frames with a stable stream error", async () => {
    const server = startServer(() => new Response(
      "data: {\"schemaVersion\":2,\"kind\":\"event\"}\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    const client = createOpenworkServerClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    const subscription = await client.subscribeSessionEvents("ws_1");

    let failure: unknown;
    try {
      for await (const _frame of subscription.stream) {
        // No malformed frame may escape validation.
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenworkSessionEventStreamError);
    expect(failure).toMatchObject({
      code: "OPENWORK_SESSION_STREAM_INVALID_FRAME",
      retryable: true,
    });
  });

  test("cancels a live response body when frame validation fails", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "data: {\"schemaVersion\":2,\"kind\":\"event\"}\n\n",
        ));
      },
      cancel() {
        cancelled = true;
      },
    });

    let failure: unknown;
    try {
      for await (const _frame of __readOpenworkSessionEventStreamForTest(body)) {
        // Invalid frames are rejected before reaching a consumer.
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenworkSessionEventStreamError);
    expect(cancelled).toBe(true);
  });
});
