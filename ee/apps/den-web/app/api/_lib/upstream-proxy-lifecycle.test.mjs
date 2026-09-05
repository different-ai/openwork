import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { setStructuredLogSink, useJsonStdoutStructuredLogSink } from "../../../observability/runtime-logger.ts";

const previousDenApiBase = process.env.DEN_API_BASE;

describe("Den upstream proxy lifecycle", () => {
  beforeAll(() => {
    process.env.DEN_API_BASE = "https://den-api.example.test";
  });

  beforeEach(() => {
    setStructuredLogSink({ log() {} });
  });

  afterAll(() => {
    useJsonStdoutStructuredLogSink();
    if (previousDenApiBase === undefined) {
      delete process.env.DEN_API_BASE;
    } else {
      process.env.DEN_API_BASE = previousDenApiBase;
    }
  });

  async function withMockFetch(mockFetch, run) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function rejectWhenAborted(capture, started) {
    return async (url, init) => {
      capture.signal = init.signal;
      started();
      return await new Promise((resolve, reject) => {
        const rejectForAbort = () => reject(new DOMException(`internal upstream ${url}`, "AbortError"));
        if (init.signal.aborted) {
          rejectForAbort();
          return;
        }
        init.signal.addEventListener("abort", rejectForAbort, { once: true });
      });
    };
  }

  test("aborts the upstream fetch when the client cancels", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const client = new AbortController();
    const request = new NextRequest("https://app.example.com/api/den/v1/slow", {
      signal: client.signal,
    });
    const capture = {};
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });

    await withMockFetch(rejectWhenAborted(capture, markStarted), async () => {
      const pending = proxyUpstream(request, [], {
        routePrefix: "/api/den",
        upstreamDeadlineMs: 1_000,
      });
      await started;
      client.abort();
      await expect(pending).rejects.toThrow();
    });

    expect(capture.signal.aborted).toBe(true);
  });

  test("returns a stable sanitized timeout response and aborts upstream", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/slow", {
      headers: { "x-request-id": "req_proxy_timeout" },
    });
    const capture = {};

    const response = await withMockFetch(rejectWhenAborted(capture, () => {}), () => proxyUpstream(
      request,
      [],
      { routePrefix: "/api/den", upstreamDeadlineMs: 10 },
    ));
    const body = await response.json();

    expect(capture.signal.aborted).toBe(true);
    expect(response.status).toBe(504);
    expect(response.headers.get("x-request-id")).toBe("req_proxy_timeout");
    expect(body).toEqual({
      error: "upstream_timeout",
      message: "The upstream service did not respond before the deadline.",
      referenceId: "req_proxy_timeout",
    });
    expect(JSON.stringify(body)).not.toContain("internal upstream");
    expect(JSON.stringify(body)).not.toContain(process.env.DEN_API_BASE);
  });

  test("returns a distinct stable sanitized response for connection failures", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/unreachable", {
      headers: { "x-request-id": "req_proxy_unreachable" },
    });

    const response = await withMockFetch(async (url) => {
      throw new Error(`connect ECONNREFUSED ${url}: secret socket detail`);
    }, () => proxyUpstream(request, [], { routePrefix: "/api/den" }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(response.headers.get("x-request-id")).toBe("req_proxy_unreachable");
    expect(body).toEqual({
      error: "upstream_unreachable",
      message: "The upstream service could not be reached.",
      referenceId: "req_proxy_unreachable",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("den-api.example.test");
    expect(serialized).not.toContain("secret socket detail");
  });

  test("streams successful upstream responses without buffering", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const encoder = new TextEncoder();
    let releaseSecondChunk;
    let upstreamFinished = false;
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("first"));
        releaseSecondChunk = () => {
          upstreamFinished = true;
          controller.enqueue(encoder.encode("second"));
          controller.close();
        };
      },
    });

    await withMockFetch(async () => new Response(upstreamBody), async () => {
      const response = await proxyUpstream(
        new NextRequest("https://app.example.com/api/den/v1/stream"),
        [],
        { routePrefix: "/api/den", upstreamDeadlineMs: 1_000 },
      );
      const reader = response.body.getReader();
      const first = await reader.read();

      expect(new TextDecoder().decode(first.value)).toBe("first");
      expect(upstreamFinished).toBe(false);

      releaseSecondChunk();
      const second = await reader.read();
      expect(new TextDecoder().decode(second.value)).toBe("second");
      expect((await reader.read()).done).toBe(true);
    });
  });

  test("clears the deadline and client listener after the response completes", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/complete");
    const signal = request.signal;
    const originalAddEventListener = signal.addEventListener.bind(signal);
    const originalRemoveEventListener = signal.removeEventListener.bind(signal);
    let abortListenersAdded = 0;
    let abortListenersRemoved = 0;
    signal.addEventListener = (type, listener, options) => {
      if (type === "abort") abortListenersAdded += 1;
      return originalAddEventListener(type, listener, options);
    };
    signal.removeEventListener = (type, listener, options) => {
      if (type === "abort") abortListenersRemoved += 1;
      return originalRemoveEventListener(type, listener, options);
    };

    let upstreamSignal;
    await withMockFetch(async (url, init) => {
      upstreamSignal = init.signal;
      return new Response("complete");
    }, async () => {
      const response = await proxyUpstream(request, [], {
        routePrefix: "/api/den",
        upstreamDeadlineMs: 20,
      });
      expect(await response.text()).toBe("complete");
      await Bun.sleep(40);
    });

    expect(upstreamSignal.aborted).toBe(false);
    expect(abortListenersAdded).toBe(1);
    expect(abortListenersRemoved).toBe(1);
  });
});
