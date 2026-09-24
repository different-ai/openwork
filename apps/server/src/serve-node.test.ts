import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { connect, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { serve, writeWebResponse } from "./serve-node.js";

const expectedAborts: Array<[string, Error]> = [
  ["AbortError", new DOMException("The operation was aborted", "AbortError")],
  ["terminated", new TypeError("terminated")],
  ["ECONNRESET", Object.assign(new Error("Connection reset"), { code: "ECONNRESET" })],
  ["nested UND_ERR_SOCKET", new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } })],
];

function mockResponse() {
  const events = new EventEmitter();
  const responseState = {
    destroyed: false,
    closed: false,
    writableEnded: false,
    writeHead: () => undefined,
    write: () => true,
    end: () => {
      Object.assign(responseState, { writableEnded: true });
      return responseState;
    },
    destroy: () => {
      Object.assign(responseState, { destroyed: true });
      events.emit("close");
      return responseState;
    },
    once: events.once.bind(events),
    off: events.off.bind(events),
  } as unknown as ServerResponse;
  return { events, responseState };
}

async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>) {
  while (!(await reader.read()).done) {}
}

async function expectIncompleteResponse(error: Error, quiet: boolean) {
  let failStream: () => void = () => undefined;
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  const server = await serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        failStream = () => controller.error(error);
      },
    })),
  });

  try {
    const signal = AbortSignal.timeout(1_000);
    const response = await fetch(`http://127.0.0.1:${server.port}/stream`, { signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("partial");
    failStream();
    await expect(readToEnd(reader)).rejects.toBeInstanceOf(Error);
    expect(signal.aborted).toBe(false);
    expect(errors).toEqual(quiet ? [] : [["[serve-node] Unhandled error:", error]]);
  } finally {
    console.error = originalError;
    await server.stop();
  }
}

describe("serve", () => {
  test("handles a malformed raw Node TRACE request without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandledRejection);
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
      process.off("unhandledRejection", onUnhandledRejection);
      await server.stop();
    }
  });

  test("cancels a streaming response body when the client disconnects", async () => {
    let cancelled = false;
    const { events, responseState } = mockResponse();
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
    process.on("uncaughtException", onUncaughtException);

    const encoder = new TextEncoder();
    let failStream: () => void = () => undefined;
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/health") {
          return Response.json({ ok: true });
        }

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("partial"));
              failStream = () => controller.error(new Error("stream failed after response started"));
            },
          }),
        );
      },
    });

    try {
      const signal = AbortSignal.timeout(1_000);
      const response = await fetch(`http://127.0.0.1:${server.port}/stream`, { signal });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("partial");
      failStream();
      await expect(readToEnd(reader)).rejects.toBeInstanceOf(Error);
      expect(signal.aborted).toBe(false);
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

  test.each(expectedAborts)("quietly rejects the body after a client-observed chunk: %s", async (_name, error) => {
    await expectIncompleteResponse(error, true);
  });

  test("rejects the body after a client-observed chunk on an ordinary error", async () => {
    await expectIncompleteResponse(new Error("upstream failed"), false);
  });

  test("returns a 500 JSON response for a generic failure before headers", async () => {
    const error = new Error("handler failed");
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => { throw error; },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.text()).toBe(JSON.stringify({ error: "internal_error" }));
      expect(errors).toEqual([["[serve-node] Unhandled error:", error]]);
    } finally {
      console.error = originalError;
      await server.stop();
    }
  });

  const acquisitionErrors: Array<[string, Error]> = [
    ...expectedAborts,
    ["generic", new Error("reader acquisition failed")],
  ];
  test.each(acquisitionErrors)("closes without an error body when reader acquisition fails after writeHead: %s", async (name, error) => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>();
        Object.defineProperty(stream, "getReader", { value: () => { throw error; } });
        return new Response(stream);
      },
    });
    try {
      const signal = AbortSignal.timeout(1_000);
      await expect(fetch(`http://127.0.0.1:${server.port}/`, { signal })).rejects.toBeInstanceOf(Error);
      expect(signal.aborted).toBe(false);
      expect(errors).toEqual(name === "generic" ? [["[serve-node] Unhandled error:", error]] : []);
    } finally {
      console.error = originalError;
      await server.stop();
    }
  });

  test("preserves the exact body when the reader releaseLock throws after EOF", async () => {
    const body = JSON.stringify({ value: "complete response" });
    let releases = 0;
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        });
        const getReader = stream.getReader.bind(stream);
        Object.defineProperty(stream, "getReader", {
          value() {
            const reader = getReader();
            reader.releaseLock = () => {
              releases += 1;
              throw new TypeError("reader release failed");
            };
            return reader;
          },
        });
        return new Response(stream, { headers: { "Content-Type": "application/json" } });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
      expect(releases).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("preserves eagerly buffered Bun fetch JSON without an internal_error suffix", async () => {
    const body = JSON.stringify({ value: "x".repeat(400_000) });
    const upstream = createServer((socket) => {
      socket.once("data", () => {
        socket.write([
          "HTTP/1.1 200 OK",
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"));
        setTimeout(() => socket.end(body), 2);
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream address");
    const server = await serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        const response = await fetch(`http://127.0.0.1:${address.port}/`);
        const stream = response.body;
        await delay(40);
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        return new Response(stream, { headers });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.status).toBe(200);
      const received = await response.text();
      expect(received.length).toBe(body.length);
      expect(received === body).toBe(true);
      expect(JSON.parse(received)).toEqual({ value: "x".repeat(400_000) });
    } finally {
      await server.stop();
      await new Promise<void>((resolve, reject) => upstream.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
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

  test.each(expectedAborts)("does not log expected connection aborts before headers: %s", async (_name, error) => {
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
        throw error;
      },
    });

    try {
      const signal = AbortSignal.timeout(1_000);
      await expect(fetch(`http://127.0.0.1:${server.port}/abort`, { signal })).rejects.toBeInstanceOf(Error);
      expect(signal.aborted).toBe(false);
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

  for (const failure of ["read", "write", "drain"]) {
    test.each(["throw", "reject", "pending"])(`destroys before cleanup and preserves ${failure} failure when cancel %s`, async (cancelMode) => {
      const original = new Error(`${failure} failed`);
      const { events, responseState } = mockResponse();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
        },
      });
      const response = new Response(stream);
      const reader = stream.getReader();
      const cleanup: string[] = [];
      Object.defineProperty(stream, "getReader", { value: () => reader });
      reader.cancel = () => {
        cleanup.push(responseState.destroyed ? "cancel after destroy" : "cancel before destroy");
        if (cancelMode === "throw") throw new Error("cancel threw");
        if (cancelMode === "reject") return Promise.reject(new Error("cancel rejected"));
        return new Promise<void>(() => undefined);
      };
      reader.releaseLock = () => {
        cleanup.push("release");
        throw new TypeError("release failed");
      };
      if (failure === "read") {
        reader.read = async () => { throw original; };
      } else {
        responseState.write = () => {
          if (failure === "write") throw original;
          queueMicrotask(() => events.emit("error", original));
          return false;
        };
      }

      const writing = writeWebResponse(response, responseState);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("cleanup blocked the original failure")), 250);
        });
        await expect(Promise.race([writing, deadline])).rejects.toBe(original);
        expect(responseState.destroyed).toBe(true);
        expect(responseState.writableEnded).toBe(false);
        expect(cleanup).toEqual(["cancel after destroy", "release"]);
        expect(events.listenerCount("close")).toBe(0);
        expect(events.listenerCount("drain")).toBe(0);
        expect(events.listenerCount("error")).toBe(0);
        await delay(0);
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  test.each(["throw", "reject"])("best-effort cancel on disconnect handles a synchronous throw or rejection: %s", async (cancelMode) => {
    const { events, responseState } = mockResponse();
    const stream = new ReadableStream<Uint8Array>();
    const response = new Response(stream);
    const reader = stream.getReader();
    Object.defineProperty(stream, "getReader", { value: () => reader });
    let finishRead: () => void = () => undefined;
    reader.read = () => new Promise<{ done: true; value: undefined }>((resolve) => {
      finishRead = () => resolve({ done: true, value: undefined });
    });
    reader.cancel = () => {
      finishRead();
      if (cancelMode === "throw") throw new Error("cancel threw");
      return Promise.reject(new Error("cancel rejected"));
    };
    const writing = writeWebResponse(response, responseState);
    Object.assign(responseState, { closed: true });
    expect(() => events.emit("close")).not.toThrow();
    await writing;
    expect(responseState.writableEnded).toBe(false);
    expect(events.listenerCount("close")).toBe(0);
    await delay(0);
  });

  test("preserves streaming order and waits for drain before reading again", async () => {
    const { events, responseState } = mockResponse();
    const chunks: string[] = [];
    let reads = 0;
    let releases = 0;
    const stream = new ReadableStream<Uint8Array>();
    const response = new Response(stream);
    const reader = stream.getReader();
    Object.defineProperty(stream, "getReader", { value: () => reader });
    reader.read = async () => {
      reads += 1;
      if (reads === 3) return { done: true, value: undefined };
      return { done: false, value: new TextEncoder().encode(`chunk-${reads}`) };
    };
    const release = reader.releaseLock.bind(reader);
    reader.releaseLock = () => {
      releases += 1;
      release();
    };
    responseState.write = (chunk: Uint8Array) => {
      chunks.push(new TextDecoder().decode(chunk));
      return chunks.length > 1;
    };
    const writing = writeWebResponse(response, responseState);
    await delay(0);
    expect(reads).toBe(1);
    expect(chunks).toEqual(["chunk-1"]);
    expect(responseState.writableEnded).toBe(false);
    events.emit("drain");
    await writing;
    expect(reads).toBe(3);
    expect(chunks).toEqual(["chunk-1", "chunk-2"]);
    expect(responseState.writableEnded).toBe(true);
    expect(responseState.destroyed).toBe(false);
    expect(releases).toBe(1);
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
