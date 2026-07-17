import { describe, expect, test } from "bun:test";
import { request as requestHttp, type ClientRequest } from "node:http";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "./serve-node.js";

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function ignoreClientError(request: ClientRequest): ClientRequest {
  request.on("error", () => undefined);
  return request;
}

async function startAbortObservingServer() {
  let observeRequest: ((request: Request) => void) | undefined;
  const requestObserved = new Promise<Request>((resolve) => {
    observeRequest = resolve;
  });
  const server = await serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      observeRequest?.(request);
      await waitForAbort(request.signal);
      return Response.json({ aborted: true });
    },
  });
  return { requestObserved, server };
}

describe("serve", () => {
  test("does not write an error response after a streaming response has ended", async () => {
    const uncaught: unknown[] = [];
    const onUncaughtException = (error: unknown) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaughtException);

    const encoder = new TextEncoder();
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/health") {
          return Response.json({ ok: true });
        }

        let wroteChunk = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!wroteChunk) {
                wroteChunk = true;
                controller.enqueue(encoder.encode("partial"));
                return;
              }
              controller.error(new Error("stream failed after response started"));
            },
          }),
        );
      },
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/stream`);
      await response.text().catch(() => undefined);
      await delay(25);

      expect(uncaught).toEqual([]);

      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      process.off("uncaughtException", onUncaughtException);
      await server.stop();
    }
  });

  test("awaits shutdown before resolving stop", async () => {
    const first = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    const port = first.port;

    await first.stop();

    const second = await serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ ok: true }),
    });
    expect(second.port).toBe(port);
    await second.stop();
  });

  test("reuses the in-flight shutdown for repeated stop calls", async () => {
    const first = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    const port = first.port;

    await Promise.all([first.stop(), first.stop()]);

    const second = await serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ ok: true }),
    });
    expect(second.port).toBe(port);
    await second.stop();
  });

  test("does not log expected connection aborts as unhandled errors", async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/health") {
          return Response.json({ ok: true });
        }
        throw new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } });
      },
    });

    try {
      await fetch(`http://127.0.0.1:${server.port}/abort`).catch(() => undefined);
      await delay(25);
      expect(errors).toEqual([]);

      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      console.error = originalError;
      await server.stop();
    }
  });

  test("aborts the Web request when a client disconnects before the response", async () => {
    const { requestObserved, server } = await startAbortObservingServer();
    const clientRequest = ignoreClientError(
      requestHttp({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/wait-for-response",
      }),
    );

    try {
      clientRequest.end();
      const webRequest = await requestObserved;
      const requestAborted = waitForAbort(webRequest.signal);
      expect(webRequest.signal.aborted).toBe(false);

      clientRequest.destroy();

      await requestAborted;
      expect(webRequest.signal.aborted).toBe(true);
    } finally {
      clientRequest.destroy();
      await server.stop();
    }
  });

  test("aborts the Web request when a client disconnects during the request body", async () => {
    const { requestObserved, server } = await startAbortObservingServer();
    const clientSocket = createConnection({
      host: "127.0.0.1",
      port: server.port,
    });
    clientSocket.on("error", () => undefined);

    try {
      await new Promise<void>((resolve) => {
        clientSocket.once("connect", () => resolve());
      });
      clientSocket.write(
        [
          "POST /partial-upload HTTP/1.1",
          `Host: 127.0.0.1:${server.port}`,
          "Content-Length: 16",
          "Connection: close",
          "",
          "partial",
        ].join("\r\n"),
      );
      const webRequest = await requestObserved;
      const requestAborted = waitForAbort(webRequest.signal);
      expect(webRequest.signal.aborted).toBe(false);

      clientSocket.destroy();

      await requestAborted;
      expect(webRequest.signal.aborted).toBe(true);
    } finally {
      clientSocket.destroy();
      await server.stop();
    }
  });

  test("does not abort the Web request after a normal response completes", async () => {
    let requestSignal: AbortSignal | undefined;
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requestSignal = request.signal;
        return Response.json({ ok: true });
      },
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/complete`);
      expect(await response.json()).toEqual({ ok: true });
      expect(requestSignal?.aborted).toBe(false);
    } finally {
      await server.stop();
    }

    expect(requestSignal?.aborted).toBe(false);
  });

  test("stops tracking disconnects when the handler rejects", async () => {
    let requestSignal: AbortSignal | undefined;
    const originalError = console.error;
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requestSignal = request.signal;
        throw new Error("handler failed");
      },
    });

    try {
      console.error = () => undefined;
      const response = await fetch(`http://127.0.0.1:${server.port}/reject`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
      expect(requestSignal?.aborted).toBe(false);
    } finally {
      console.error = originalError;
      await server.stop();
    }

    expect(requestSignal?.aborted).toBe(false);
  });
});
