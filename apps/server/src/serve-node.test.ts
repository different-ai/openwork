import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "./serve-node.js";

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
      server.stop();
    }
  });
});
