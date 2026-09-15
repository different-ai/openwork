import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { serve, writeWebResponse } from "./serve-node.js";

const processEvents: EventEmitter = process;

describe("serve", () => {
  test("handles a malformed raw Node TRACE request without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (error: unknown) => {
      unhandled.push(error);
    };
    processEvents.on("unhandledRejection", onUnhandledRejection);
    let fetchCalls = 0;
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        fetchCalls += 1;
        return Response.json({ ok: true });
      },
    });

    try {
      const response = await new Promise<string>((resolve, reject) => {
        let received = "";
        const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
          socket.write([
            "TRACE http://example.com/ HTTP/1.1",
            `Host: 127.0.0.1:${server.port}`,
            "Connection: close",
            "",
            "",
          ].join("\r\n"));
        });
        const timeout = setTimeout(() => {
          socket.destroy(new Error("Timed out waiting for the TRACE response"));
        }, 1_000);
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          received += chunk;
        });
        socket.once("end", () => {
          clearTimeout(timeout);
          resolve(received);
        });
        socket.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      await delay(25);
      expect(response).toContain("HTTP/1.1 500 Internal Server Error");
      expect(response).toEndWith(JSON.stringify({ error: "internal_error" }));
      expect(fetchCalls).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      processEvents.off("unhandledRejection", onUnhandledRejection);
      await server.stop();
    }
  });

  test("cancels a streaming response body when the client disconnects", async () => {
    let cancelled = false;
    const events = new EventEmitter();
    const responseState = {
      destroyed: false,
      closed: false,
      writableEnded: false,
      writeHead: () => undefined,
      write: () => true,
      end: () => undefined,
      once: events.once.bind(events),
      off: events.off.bind(events),
    } as unknown as ServerResponse;
    const response = new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await delay(5);
        controller.enqueue(new TextEncoder().encode("event\n"));
      },
      cancel() {
        cancelled = true;
      },
    }));

    const writing = writeWebResponse(response, responseState);
    await delay(20);
    Object.assign(responseState, { closed: true });
    events.emit("close");
    await writing;

    expect(cancelled).toBe(true);
  });

  test("does not write an error response after a streaming response has ended", async () => {
    const uncaught: unknown[] = [];
    const onUncaughtException = (error: unknown) => {
      uncaught.push(error);
    };
    processEvents.on("uncaughtException", onUncaughtException);

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
      processEvents.off("uncaughtException", onUncaughtException);
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

  test("aborts the Web request signal when the client cancels", async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let observedAbort: unknown;
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => new Promise<Response>((_resolve, reject) => {
        markStarted();
        const onAbort = () => {
          observedAbort = request.signal.reason;
          reject(request.signal.reason);
        };
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      }),
    });
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${server.port}/cancel`, { signal: controller.signal });

    try {
      await started;
      controller.abort();
      await pending.catch(() => undefined);
      for (let attempt = 0; attempt < 20 && observedAbort === undefined; attempt += 1) {
        await delay(10);
      }

      expect(observedAbort).toBeInstanceOf(DOMException);
      expect(observedAbort).toMatchObject({ name: "AbortError" });
    } finally {
      await server.stop();
    }
  });
});
