import { describe, expect, test } from "bun:test";

import {
  AGENT_CONTEXT_DIAGNOSTICS_RESPONSE_MAX_BYTES,
  requestAgentContextDiagnosticsPayload,
} from "../src/app/lib/agent-context-diagnostics-transport";

describe("agent context diagnostics renderer transport", () => {
  test("keeps the request deadline active while a response body is stalled", async () => {
    let bodyCanceled = false;
    let observedDeadlineAtMs = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        bodyCanceled = true;
      },
    }), { status: 200 });
    const startedAtMs = Date.now();

    await expect(requestAgentContextDiagnosticsPayload({
      url: "https://remote.openwork.test/workspace/test/diagnostics/agent-context",
      init: { method: "POST", body: "{}" },
      timeoutMs: 40,
      fetchImpl: async (_input, _init, deadlineAtMs) => {
        observedDeadlineAtMs = deadlineAtMs;
        return response;
      },
    })).rejects.toMatchObject({
      code: "agent_context_diagnostics_request_timed_out",
    });

    expect(Date.now() - startedAtMs).toBeLessThan(1_000);
    expect(observedDeadlineAtMs).toBeGreaterThanOrEqual(startedAtMs + 30);
    await Promise.resolve();
    expect(bodyCanceled).toBe(true);
  });

  test("rejects a chunked remote response once it crosses the fixed cap", async () => {
    const chunk = new Uint8Array((AGENT_CONTEXT_DIAGNOSTICS_RESPONSE_MAX_BYTES / 2) + 1);
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 });

    await expect(requestAgentContextDiagnosticsPayload({
      url: "https://remote.openwork.test/workspace/test/diagnostics/agent-context",
      init: { method: "POST", body: "{}" },
      timeoutMs: 1_000,
      fetchImpl: async () => response,
    })).rejects.toMatchObject({
      code: "agent_context_diagnostics_response_too_large",
    });
  });

  test("rejects an oversized declared remote response before buffering it", async () => {
    const response = new Response("{}", {
      status: 200,
      headers: {
        "content-length": String(AGENT_CONTEXT_DIAGNOSTICS_RESPONSE_MAX_BYTES + 1),
      },
    });

    await expect(requestAgentContextDiagnosticsPayload({
      url: "https://remote.openwork.test/workspace/test/diagnostics/agent-context",
      init: { method: "POST", body: "{}" },
      timeoutMs: 1_000,
      fetchImpl: async () => response,
    })).rejects.toMatchObject({
      code: "agent_context_diagnostics_response_too_large",
    });
  });

  test("does not forward diagnostics credentials across a remote redirect", async () => {
    const hostToken = "diagnostics-host-token-canary";
    const bearerToken = "diagnostics-bearer-token-canary";
    let redirectHostToken: string | null = null;
    let targetHostToken: string | null = null;
    let targetAuthorization: string | null = null;
    let targetRequests = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        targetRequests += 1;
        targetHostToken = request.headers.get("x-openwork-host-token");
        targetAuthorization = request.headers.get("authorization");
        return Response.json({ ok: true });
      },
    });
    const targetUrl = `http://127.0.0.1:${target.port}/capture`;
    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        redirectHostToken = request.headers.get("x-openwork-host-token");
        return new Response(null, {
          status: 307,
          headers: { location: targetUrl },
        });
      },
    });

    try {
      await expect(requestAgentContextDiagnosticsPayload({
        url: `http://127.0.0.1:${redirector.port}/diagnostics`,
        init: {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            "X-OpenWork-Host-Token": hostToken,
          },
          body: "{}",
        },
        timeoutMs: 1_000,
        fetchImpl: (input, init) => globalThis.fetch(input, init),
      })).rejects.toBeInstanceOf(Error);

      expect(redirectHostToken).toBe(hostToken);
      expect(targetRequests).toBe(0);
      expect(targetHostToken).toBeNull();
      expect(targetAuthorization).toBeNull();
    } finally {
      await redirector.stop(true);
      await target.stop(true);
    }
  });
});
