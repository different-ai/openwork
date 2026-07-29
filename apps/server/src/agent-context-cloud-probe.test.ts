import { afterEach, describe, expect, test } from "bun:test";

import {
  differentialCloudVerdict,
  probeOpenworkCloudCatalog,
  type CloudCatalogProbe,
  type CloudCatalogProbeCode,
  type CloudCatalogProbeFetch,
  type ProbeOpenworkCloudCatalogInput,
} from "./agent-context-cloud-probe.js";

const TOKEN = "Bearer ow_diagnostics_token_abcdefghijklmnopqrstuvwxyz";
const ENDPOINT = "https://app.openworklabs.com/api/den/mcp/agent";
const SESSION_ID = "diagnostics-session-id";
const PROTOCOL_VERSION = "2025-06-18";

function input(overrides: Partial<ProbeOpenworkCloudCatalogInput> = {}): ProbeOpenworkCloudCatalogInput {
  const { fetchImpl, ...values } = overrides;
  return {
    workspaceId: "ws_diagnostics",
    workspaceType: "local",
    config: {
      type: "remote",
      enabled: true,
      url: ENDPOINT,
      headers: {
        authorization: TOKEN,
        "x-must-not-forward": "private-value",
      },
    },
    engineRegistration: { status: "connected", source: "engine_status", recordAgeMs: 1_000 },
    requestId: "11111111-1111-4111-8111-111111111111",
    env: {},
    ...values,
    ...(fetchImpl ? { fetchImpl: withCompletedHandshake(fetchImpl) } : {}),
  };
}

function payload(requestId: string, toolNames = ["search_capabilities", "execute_capability"]): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: requestId,
    result: {
      tools: toolNames.map((name) => ({
        name,
        description: "Bearer response-secret must never be returned",
        inputSchema: { type: "object" },
      })),
    },
  };
}

function jsonResponse(requestId: string, toolNames?: string[]): Response {
  return new Response(JSON.stringify(payload(requestId, toolNames)), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sseResponse(requestId: string): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload(requestId))}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function requestPayload(init?: RequestInit): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(init?.body));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON-RPC request object");
  }
  return Object.fromEntries(Object.entries(parsed));
}

function initializeResponse(extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: "openwork-agent-diagnostics-initialize",
    result: {
      capabilities: {},
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: "test-mcp", version: "1.0.0" },
    },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": SESSION_ID,
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...extraHeaders,
    },
  });
}

function withCompletedHandshake(toolsListFetch: CloudCatalogProbeFetch): CloudCatalogProbeFetch {
  return async (url, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const body = requestPayload(init);
    if (body.method === "initialize") return initializeResponse();
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method !== "tools/list") throw new Error("Unexpected JSON-RPC method");
    return toolsListFetch(url, init);
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test probe requests");
}

afterEach(() => {
  delete process.env.OPENWORK_AGENT_DIAGNOSTICS_TRUSTED_ORIGINS;
});

describe("OpenWork Cloud catalog probe", () => {
  test("performs initialize, initialized notification, bounded tools/list, and session cleanup with allowlisted headers", async () => {
    let calls = 0;
    let deleteCalls = 0;
    let sharedSignal: AbortSignal | null = null;
    const fetchImpl: CloudCatalogProbeFetch = async (url, init) => {
      calls += 1;
      expect(url).toBe(ENDPOINT);
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (sharedSignal === null) sharedSignal = init?.signal ?? null;
      expect(init?.signal).toBe(sharedSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      expect(headers.get("authorization")).toBe(TOKEN);
      expect(headers.has("x-must-not-forward")).toBe(false);
      expect(headers.has("x-initialize-secret")).toBe(false);
      if (init?.method === "DELETE") {
        deleteCalls += 1;
        expect(init.body).toBeUndefined();
        expect([...headers.keys()].sort()).toEqual(["accept", "authorization", "mcp-protocol-version", "mcp-session-id"]);
        expect(headers.get("mcp-session-id")).toBe(SESSION_ID);
        expect(headers.get("mcp-protocol-version")).toBe(PROTOCOL_VERSION);
        return new Response(null, { status: 204 });
      }
      expect(init?.method).toBe("POST");
      const body = requestPayload(init);
      const isInitialize = body.method === "initialize";
      expect([...headers.keys()].sort()).toEqual(isInitialize
        ? ["accept", "authorization", "content-type"]
        : ["accept", "authorization", "content-type", "mcp-protocol-version", "mcp-session-id"]);
      expect(headers.get("content-type")).toBe("application/json");
      if (isInitialize) {
        expect(body).toEqual({
          jsonrpc: "2.0",
          id: "openwork-agent-diagnostics-initialize",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "openwork-server-agent-context-diagnostics", version: "1.0.0" },
            protocolVersion: PROTOCOL_VERSION,
          },
        });
        return initializeResponse({ "x-initialize-secret": "must-not-forward" });
      }
      expect(headers.get("mcp-session-id")).toBe(SESSION_ID);
      expect(headers.get("mcp-protocol-version")).toBe(PROTOCOL_VERSION);
      if (body.method === "notifications/initialized") {
        expect(body).toEqual({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        return new Response(null, { status: 202 });
      }
      expect(body).toEqual({
        jsonrpc: "2.0",
        id: "11111111-1111-4111-8111-111111111111",
        method: "tools/list",
        params: {},
      });
      return sseResponse("11111111-1111-4111-8111-111111111111");
    };

    const probeInput = input();
    probeInput.fetchImpl = fetchImpl;
    const observed = await probeOpenworkCloudCatalog(probeInput);
    expect(calls).toBe(4);
    expect(deleteCalls).toBe(1);
    expect(observed).toEqual({
      performed: true,
      toolsListPerformed: true,
      status: "observed",
      stage: "complete",
      code: "catalog_observed",
      trustSource: "builtin-cloud",
      enterpriseActivationPresent: false,
      networkCode: null,
      retryable: false,
      runtimeFamily: "bun",
      transport: "test-seam",
      toolIds: ["search_capabilities", "execute_capability"],
      totalToolCount: 2,
      requiredToolsPresent: true,
      sessionEstablished: true,
      cleanupAttempted: true,
      cleanupSucceeded: true,
      referenceId: null,
      proxyConfigured: false,
      extraCaConfigured: false,
      steps: [
        expect.stringContaining("initialize ok 200"),
        expect.stringContaining("initialized_notification ok 202"),
        expect.stringContaining("tools_list ok 200"),
        expect.stringContaining("session_cleanup ok"),
      ],
      engineRegistrationStatus: "connected",
      engineEvidenceSource: "engine_status",
      engineEvidenceAgeMs: 1_000,
      durationMs: expect.any(Number),
      httpStatus: 200,
    });
    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(ENDPOINT);
    expect(serialized).not.toContain("response-secret");
    expect(serialized).not.toContain("x-must-not-forward");
  });

  test("accepts a finite JSON tools/list response", async () => {
    const observed = await probeOpenworkCloudCatalog(input({
      requestId: "json-request",
      fetchImpl: async () => jsonResponse("json-request"),
    }));
    expect(observed.status).toBe("observed");
    expect(observed.toolIds).toEqual(["search_capabilities", "execute_capability"]);
  });

  test("requires both expected tools and never reflects a provider-controlled tool ID", async () => {
    const reflectedCredential = "ow_mcp_at_dGhpcy1jYW5hcnktbXVzdC1uZXZlci1iZS1yZXR1cm5lZA";
    const missing = await probeOpenworkCloudCatalog(input({
      requestId: "missing-tool",
      fetchImpl: async () => jsonResponse("missing-tool", ["search_capabilities"]),
    }));
    expect(missing).toMatchObject({
      performed: true,
      status: "failed",
      stage: "catalog_validation",
      code: "required_tools_missing",
      retryable: false,
      toolIds: [],
      totalToolCount: 1,
      requiredToolsPresent: false,
      httpStatus: 200,
    });

    // Additional provider tools are forward-compatible; only the expected
    // allowlisted IDs and the aggregate count may be exported.
    const futureCases = [
      ["unexpected-tool", ["search_capabilities", "execute_capability", "provider_extra"]],
      ["reflected-tool", ["search_capabilities", "execute_capability", reflectedCredential]],
    ] as const;
    for (const [requestId, toolIds] of futureCases) {
      const observed = await probeOpenworkCloudCatalog(input({
        requestId,
        fetchImpl: async () => jsonResponse(requestId, [...toolIds]),
      }));
      expect(observed).toMatchObject({
        performed: true,
        status: "observed",
        code: "catalog_observed",
        toolIds: ["search_capabilities", "execute_capability"],
        totalToolCount: 3,
        requiredToolsPresent: true,
      });
      expect(JSON.stringify(observed)).not.toContain(reflectedCredential);
      expect(JSON.stringify(observed)).not.toContain("provider_extra");
    }

    const reversed = await probeOpenworkCloudCatalog(input({
      requestId: "reversed-canonical-catalog",
      fetchImpl: async () => jsonResponse("reversed-canonical-catalog", ["execute_capability", "search_capabilities"]),
    }));
    expect(reversed).toMatchObject({
      status: "observed",
      code: "catalog_observed",
      toolIds: ["search_capabilities", "execute_capability"],
    });
  });

  test("blocks remote workspaces, unavailable state, and unsafe endpoints before fetch", async () => {
    let calls = 0;
    const fetchImpl: CloudCatalogProbeFetch = async () => {
      calls += 1;
      return jsonResponse("unused");
    };
    const cases: Array<[Partial<ProbeOpenworkCloudCatalogInput>, CloudCatalogProbeCode]> = [
      [{ workspaceType: "remote" }, "remote_workspace_unavailable"],
      [{ runtimeConfigAvailable: false }, "runtime_config_unavailable"],
      [{ config: null }, "cloud_mcp_missing"],
      [{ config: { type: "local", enabled: true } }, "cloud_mcp_not_remote"],
      [{ config: { type: "remote", enabled: false, url: ENDPOINT } }, "cloud_mcp_disabled"],
      [{ config: { type: "remote", enabled: true, url: "https://app.openworklabs.com/api/den/mcp/agent?token=secret", headers: { Authorization: TOKEN } } }, "invalid_endpoint"],
      [{ config: { type: "remote", enabled: true, url: "https://app.openworklabs.com/api/den/mcp/agent/", headers: { Authorization: TOKEN } } }, "invalid_endpoint"],
      [{ config: { type: "remote", enabled: true, url: "https://app.openworklabs.com/api/den/mcp/agent/status", headers: { Authorization: TOKEN } } }, "invalid_endpoint"],
      [{ config: { type: "remote", enabled: true, url: "https://app.openworklabs.com/api/den/mcp/agentish", headers: { Authorization: TOKEN } } }, "invalid_endpoint"],
      [{ config: { type: "remote", enabled: true, url: "http://app.openworklabs.com/mcp/agent", headers: { Authorization: TOKEN } } }, "invalid_endpoint"],
      [{ config: { type: "remote", enabled: true, url: "https://localhost.evil/mcp/agent", headers: { Authorization: TOKEN } } }, "untrusted_endpoint"],
    ];
    for (const [overrides, code] of cases) {
      const blocked = await probeOpenworkCloudCatalog(input({ ...overrides, fetchImpl }));
      expect(blocked.performed).toBe(false);
      expect(blocked.status).toBe("not-performed");
      expect(blocked.stage).toBe("eligibility");
      expect(blocked.code).toBe(code);
      expect(blocked.steps).toEqual([`eligibility ${code}`]);
    }
    expect(calls).toBe(0);
  });

  test("runs the probe despite failed, stale, or missing engine registration evidence", async () => {
    const statuses = ["failed", "disabled", "needs-auth", "needs-client-registration", "not-recorded"] as const;
    for (const status of statuses) {
      let calls = 0;
      const observed = await probeOpenworkCloudCatalog(input({
        requestId: `despite-${status}`,
        engineRegistration: { status, source: "engine_status", recordAgeMs: 2_000 },
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(`despite-${status}`);
        },
      }));
      expect(calls).toBe(1);
      expect(observed).toMatchObject({
        performed: true,
        status: "observed",
        code: "catalog_observed",
        engineRegistrationStatus: status,
        engineEvidenceSource: "engine_status",
        engineEvidenceAgeMs: 2_000,
      });
    }
  });

  test("allows exact loopback and explicitly configured HTTPS origins only", async () => {
    let blockedCalls = 0;
    const blocked = await probeOpenworkCloudCatalog(input({
      config: {
        type: "remote",
        enabled: true,
        url: "https://den.customer.example/custom/mcp/agent",
        headers: { Authorization: TOKEN },
      },
      requestId: "untrusted-self-hosted-request",
      fetchImpl: async () => {
        blockedCalls += 1;
        return jsonResponse("untrusted-self-hosted-request");
      },
    }));
    expect(blocked).toMatchObject({
      performed: false,
      code: "untrusted_endpoint",
    });
    expect(blockedCalls).toBe(0);

    const loopback = await probeOpenworkCloudCatalog(input({
      config: {
        type: "remote",
        enabled: true,
        url: "http://127.0.0.1:8788/mcp/agent",
        headers: { Authorization: TOKEN },
      },
      requestId: "loopback-request",
      fetchImpl: async () => jsonResponse("loopback-request"),
    }));
    expect(loopback.status).toBe("observed");

    process.env.OPENWORK_AGENT_DIAGNOSTICS_TRUSTED_ORIGINS = "https://den.customer.example";
    const trusted = await probeOpenworkCloudCatalog(input({
      config: {
        type: "remote",
        enabled: true,
        url: "https://den.customer.example/custom/mcp/agent",
        headers: { Authorization: TOKEN },
      },
      requestId: "trusted-request",
      fetchImpl: async () => jsonResponse("trusted-request"),
    }));
    expect(trusted.status).toBe("observed");
  });

  test("rejects duplicate or malformed authorization without forwarding configured headers", async () => {
    let calls = 0;
    const fetchImpl: CloudCatalogProbeFetch = async () => {
      calls += 1;
      return jsonResponse("unused");
    };
    const duplicate = await probeOpenworkCloudCatalog(input({
      config: {
        type: "remote",
        enabled: true,
        url: ENDPOINT,
        headers: { Authorization: TOKEN, authorization: TOKEN },
      },
      fetchImpl,
    }));
    expect(duplicate.code).toBe("duplicate_authorization");

    const injected = await probeOpenworkCloudCatalog(input({
      config: {
        type: "remote",
        enabled: true,
        url: ENDPOINT,
        headers: { Authorization: `${TOKEN}\r\nx-api-key: leaked` },
      },
      fetchImpl,
    }));
    expect(injected.code).toBe("credential_missing");
    expect(calls).toBe(0);
  });

  test("rejects redirects and cancels a response that exceeds 64 KiB", async () => {
    const redirected = await probeOpenworkCloudCatalog(input({
      requestId: "redirect-request",
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/mcp/agent" } }),
    }));
    expect(redirected.code).toBe("redirect_rejected");
    expect(redirected.httpStatus).toBe(302);
    expect(redirected.toolsListPerformed).toBe(true);

    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const tooLarge = await probeOpenworkCloudCatalog(input({
      requestId: "large-request",
      fetchImpl: async () => new Response(oversized, { headers: { "content-type": "text/event-stream" } }),
    }));
    expect(tooLarge.code).toBe("response_too_large");
    expect(cancelled).toBe(true);
  });

  test("classifies a real redirect without following or forwarding authorization", async () => {
    const requests: Array<{ path: string; authorization: string | null }> = [];
    let redirectTarget = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        requests.push({ path: url.pathname, authorization: request.headers.get("authorization") });
        if (url.pathname === "/mcp/agent") {
          return new Response(null, {
            status: 307,
            headers: { location: redirectTarget },
          });
        }
        return jsonResponse("redirect-followed");
      },
    });
    redirectTarget = `http://127.0.0.1:${server.port}/redirect-target/mcp/agent`;
    try {
      const redirected = await probeOpenworkCloudCatalog(input({
        workspaceId: "ws_real_redirect",
        requestId: "real-redirect",
        config: {
          type: "remote",
          enabled: true,
          url: `http://127.0.0.1:${server.port}/mcp/agent`,
          headers: { Authorization: TOKEN },
        },
      }));
      expect(redirected).toMatchObject({
        performed: true,
        toolsListPerformed: false,
        status: "failed",
        code: "redirect_rejected",
        httpStatus: 307,
      });
      expect(requests).toEqual([{ path: "/mcp/agent", authorization: TOKEN }]);
    } finally {
      server.stop(true);
    }
  });

  test("keeps the absolute deadline active while a response body stalls", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const startedAt = Date.now();
    const timedOut = await probeOpenworkCloudCatalog(input({
      requestId: "stalled-body-request",
      timeoutMs: 15,
      fetchImpl: async () => new Response(stalled, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    }));
    expect(timedOut).toMatchObject({
      performed: true,
      status: "failed",
      code: "timeout",
      httpStatus: 200,
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(cancelled).toBe(true);
  });

  test("classifies abort-aware fetch and body failures as deadline timeouts", async () => {
    const fetchTimedOut = await probeOpenworkCloudCatalog(input({
      workspaceId: "ws_abort_aware_fetch",
      requestId: "abort-aware-fetch",
      timeoutMs: 15,
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("request aborted", "AbortError"));
        }, { once: true });
      }),
    }));
    expect(fetchTimedOut).toMatchObject({
      performed: true,
      status: "failed",
      code: "timeout",
      httpStatus: null,
    });

    const bodyTimedOut = await probeOpenworkCloudCatalog(input({
      workspaceId: "ws_abort_aware_body",
      requestId: "abort-aware-body",
      timeoutMs: 15,
      fetchImpl: async (_url, init) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("body aborted", "AbortError"));
            }, { once: true });
          },
          pull() {
            return new Promise<void>(() => {});
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    }));
    expect(bodyTimedOut).toMatchObject({
      performed: true,
      status: "failed",
      code: "timeout",
      httpStatus: 200,
    });
  });

  test("does not start authenticated egress when the parent signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const cancelled = await probeOpenworkCloudCatalog(input({
      signal: controller.signal,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse("must-not-run");
      },
    }));
    expect(calls).toBe(0);
    expect(cancelled).toMatchObject({
      performed: false,
      status: "not-performed",
      code: "timeout",
      toolIds: [],
      httpStatus: null,
    });
  });

  test("parent abort settles a hostile fetch that ignores its signal", async () => {
    const controller = new AbortController();
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const pending = probeOpenworkCloudCatalog(input({
      workspaceId: "ws_parent_abort_fetch",
      requestId: "parent-abort-fetch",
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        expect(init?.signal?.aborted).toBe(false);
        markFetchStarted?.();
        return new Promise<Response>(() => {});
      },
    }));
    await fetchStarted;
    controller.abort();
    const cancelled = await pending;
    expect(cancelled).toMatchObject({
      performed: true,
      status: "failed",
      code: "timeout",
      toolIds: [],
      httpStatus: null,
    });
  });

  test("parent abort settles and cancels a hostile response body", async () => {
    const controller = new AbortController();
    let markBodyReadStarted: (() => void) | undefined;
    const bodyReadStarted = new Promise<void>((resolve) => {
      markBodyReadStarted = resolve;
    });
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        markBodyReadStarted?.();
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const pending = probeOpenworkCloudCatalog(input({
      workspaceId: "ws_parent_abort_body",
      requestId: "parent-abort-body",
      signal: controller.signal,
      fetchImpl: async () => new Response(stalled, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    }));
    await bodyReadStarted;
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({
      performed: true,
      status: "failed",
      code: "timeout",
      toolIds: [],
      httpStatus: 200,
    });
    expect(cancelled).toBe(true);
  });

  test("rejects JSON-RPC errors, wrong IDs, pagination, duplicate tools, and unsafe names", async () => {
    const cases: Array<[string, unknown, CloudCatalogProbeCode, CloudCatalogProbe["stage"]]> = [
      ["wrong-id", payload("different-id"), "request_id_mismatch", "tools_list_protocol"],
      ["rpc-error", { jsonrpc: "2.0", id: "rpc-error", error: { code: -1, message: "Bearer private" } }, "jsonrpc_error", "tools_list_protocol"],
      ["pagination", { ...payload("pagination"), result: { tools: [], nextCursor: "secret-cursor" } }, "pagination_unsupported", "catalog_validation"],
      ["duplicate", payload("duplicate", ["search_capabilities", "search_capabilities"]), "invalid_catalog", "catalog_validation"],
      ["unsafe", payload("unsafe", ["search_capabilities\r\nspoof"]), "invalid_catalog", "catalog_validation"],
    ];
    for (const [requestId, body, code, stage] of cases) {
      const observed = await probeOpenworkCloudCatalog(input({
        workspaceId: `ws_${requestId}`,
        requestId,
        fetchImpl: async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      }));
      expect(observed.code).toBe(code);
      expect(observed.stage).toBe(stage);
      expect(observed.retryable).toBe(false);
      expect(JSON.stringify(observed)).not.toContain("private");
      expect(JSON.stringify(observed)).not.toContain("secret-cursor");
    }
  });

  test("keeps each caller cancellation-scoped and does not cache settled results", async () => {
    let calls = 0;
    const deferred: Array<{ requestId: string; release: (response: Response) => void }> = [];
    const fetchImpl: CloudCatalogProbeFetch = async (_url, init) => {
      calls += 1;
      const requestId = JSON.parse(String(init?.body)).id as string;
      return new Promise<Response>((resolve) => deferred.push({ requestId, release: resolve }));
    };
    const first = probeOpenworkCloudCatalog(input({ requestId: "single-flight-one", fetchImpl }));
    const joined = probeOpenworkCloudCatalog(input({ requestId: "single-flight-two", fetchImpl }));
    await waitUntil(() => calls === 2 && deferred.length === 2);
    expect(calls).toBe(2);
    expect(deferred).toHaveLength(2);
    for (const item of deferred) item.release(jsonResponse(item.requestId));
    expect((await first).status).toBe("observed");
    expect((await joined).status).toBe("observed");

    const afterSettlement = await probeOpenworkCloudCatalog(input({
      requestId: "single-flight-three",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse("single-flight-three");
      },
    }));
    expect(afterSettlement.status).toBe("observed");
    expect(calls).toBe(3);
  });

  test("caps global active probes without sharing a caller-owned request", async () => {
    const pending: Array<{ requestId: string; resolve: (response: Response) => void }> = [];
    const fetchImpl: CloudCatalogProbeFetch = async (_url, init) => {
      const requestId = JSON.parse(String(init?.body)).id as string;
      return new Promise<Response>((resolve) => pending.push({ requestId, resolve }));
    };
    const active = Array.from({ length: 16 }, (_, index) => probeOpenworkCloudCatalog(input({
      workspaceId: `ws_busy_${index}`,
      requestId: `busy-${index}`,
      fetchImpl,
    })));
    await waitUntil(() => pending.length === 16);
    expect(pending).toHaveLength(16);
    const sameFingerprintBusy = await probeOpenworkCloudCatalog(input({
      workspaceId: "ws_busy_0",
      requestId: "busy-joined",
      fetchImpl,
    }));
    const busy = await probeOpenworkCloudCatalog(input({
      workspaceId: "ws_busy_overflow",
      requestId: "busy-overflow",
      fetchImpl,
    }));
    expect(sameFingerprintBusy).toMatchObject({ performed: false, status: "not-performed", code: "probe_busy" });
    expect(busy).toMatchObject({ performed: false, status: "not-performed", code: "probe_busy" });
    for (const item of pending) item.resolve(jsonResponse(item.requestId));
    expect((await Promise.all(active)).every((item) => item.status === "observed")).toBe(true);
  });

  test("returns only a safe network code when fetch throws a secret-bearing error", async () => {
    const failed = await probeOpenworkCloudCatalog(input({
      fetchImpl: async () => { throw new Error(`Bearer hidden ${ENDPOINT}?token=private /Users/private/file`); },
    }));
    expect(failed).toMatchObject({ performed: true, status: "failed", code: "network_error", httpStatus: null });
    const serialized = JSON.stringify(failed);
    expect(serialized).not.toContain("Bearer hidden");
    expect(serialized).not.toContain("token=private");
    expect(serialized).not.toContain("/Users/private");
  });

  test("classifies allowlisted network causes with stage and retryability, never raw errors", async () => {
    const cases: Array<[string, CloudCatalogProbeCode, CloudCatalogProbe["networkCode"], CloudCatalogProbe["stage"], boolean]> = [
      ["ENOTFOUND", "dns_error", "ENOTFOUND", "dns", false],
      ["EAI_AGAIN", "dns_error", "EAI_AGAIN", "dns", true],
      ["ECONNREFUSED", "connection_refused", "ECONNREFUSED", "connect", false],
      ["ECONNRESET", "connection_reset", "ECONNRESET", "connect", true],
      ["ETIMEDOUT", "timeout", "ETIMEDOUT", "connect", true],
      ["UND_ERR_CONNECT_TIMEOUT", "timeout", "UND_ERR_CONNECT_TIMEOUT", "connect", true],
      ["CERT_HAS_EXPIRED", "tls_error", "CERT_HAS_EXPIRED", "tls", false],
      ["SELF_SIGNED_CERT_IN_CHAIN", "tls_error", "SELF_SIGNED_CERT_IN_CHAIN", "tls", false],
      ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls_error", "DEPTH_ZERO_SELF_SIGNED_CERT", "tls", false],
      ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_error", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls", false],
      ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_error", "ERR_TLS_CERT_ALTNAME_INVALID", "tls", false],
      ["ERR_PROXY_AUTH_FAILED", "proxy_error", "PROXY_ERROR", "proxy", false],
      ["EUNKNOWNISH", "network_error", "UNKNOWN_NETWORK_ERROR", "tools_list_request", false],
    ];
    for (const [causeCode, expectedCode, expectedNetworkCode, expectedStage, expectedRetryable] of cases) {
      const failed = await probeOpenworkCloudCatalog(input({
        requestId: `network-${causeCode}`,
        fetchImpl: async () => {
          throw new Error("RAW_NETWORK_SECRET", { cause: { code: causeCode } });
        },
      }));
      expect(failed).toMatchObject({
        performed: true,
        status: "failed",
        code: expectedCode,
        networkCode: expectedNetworkCode,
        stage: expectedStage,
        retryable: expectedRetryable,
      });
      expect(JSON.stringify(failed)).not.toContain("RAW_NETWORK_SECRET");
    }
  });

  test("classifies HTTP statuses with deterministic retryability", async () => {
    const cases: Array<[number, CloudCatalogProbeCode, boolean]> = [
      [401, "unauthorized", false],
      [403, "forbidden", false],
      [404, "mcp_route_not_found", false],
      [429, "rate_limited", true],
      [502, "gateway_unavailable", true],
      [503, "gateway_unavailable", true],
      [504, "gateway_unavailable", true],
      [500, "http_error", false],
    ];
    for (const [status, expectedCode, expectedRetryable] of cases) {
      const failed = await probeOpenworkCloudCatalog(input({
        requestId: `http-${status}`,
        fetchImpl: async () => new Response(null, { status }),
      }));
      expect(failed).toMatchObject({
        performed: true,
        status: "failed",
        stage: "tools_list_http",
        code: expectedCode,
        httpStatus: status,
        retryable: expectedRetryable,
        networkCode: null,
      });
    }
  });

  test("attributes initialize-phase failures to initialize stages", async () => {
    const initFails: CloudCatalogProbeFetch = async () => new Response(null, { status: 401 });
    const probeInput = input();
    probeInput.fetchImpl = initFails;
    const failed = await probeOpenworkCloudCatalog(probeInput);
    expect(failed).toMatchObject({
      performed: true,
      status: "failed",
      stage: "initialize_http",
      code: "unauthorized",
      httpStatus: 401,
      toolsListPerformed: false,
      sessionEstablished: false,
      cleanupAttempted: false,
      cleanupSucceeded: null,
    });
    expect(failed.steps).toEqual([
      expect.stringContaining("initialize transient 401 observed"),
      expect.stringContaining("initialize failed unauthorized"),
    ]);
  });

  test("retries one initialize 401 and records the recovered transient auth blip", async () => {
    let initializeCalls = 0;
    const fetchImpl: CloudCatalogProbeFetch = async (_url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const body = requestPayload(init);
      if (body.method === "initialize") {
        initializeCalls += 1;
        return initializeCalls === 1 ? new Response(null, { status: 401 }) : initializeResponse();
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return jsonResponse("retry-transient-401");
      throw new Error("Unexpected JSON-RPC method");
    };
    const probeInput = input({ requestId: "retry-transient-401" });
    probeInput.fetchImpl = fetchImpl;

    const observed = await probeOpenworkCloudCatalog(probeInput);

    expect(initializeCalls).toBe(2);
    expect(observed.status).toBe("observed");
    expect(observed.steps).toEqual([
      expect.stringContaining("initialize transient 401 observed"),
      expect.stringContaining("initialize recovered after transient 401"),
      expect.stringContaining("initialize ok 200"),
      expect.stringContaining("initialized_notification ok 202"),
      expect.stringContaining("tools_list ok 200"),
      expect.stringContaining("session_cleanup ok"),
    ]);
  });

  test("rejects an unsupported negotiated protocol version", async () => {
    const fetchImpl: CloudCatalogProbeFetch = async (_url, init) => {
      const body = requestPayload(init);
      if (body.method !== "initialize") throw new Error("Unexpected JSON-RPC method");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "openwork-agent-diagnostics-initialize",
        result: { capabilities: {}, protocolVersion: "2024-11-05", serverInfo: { name: "old", version: "0.1.0" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const probeInput = input();
    probeInput.fetchImpl = fetchImpl;
    const failed = await probeOpenworkCloudCatalog(probeInput);
    expect(failed).toMatchObject({
      performed: true,
      status: "failed",
      stage: "initialize_protocol",
      code: "unsupported_protocol_version",
      retryable: false,
      toolsListPerformed: false,
    });
  });

  test("splits invalid UTF-8, invalid JSON, and malformed envelopes into distinct codes", async () => {
    const utf8 = await probeOpenworkCloudCatalog(input({
      requestId: "bad-utf8",
      fetchImpl: async () => new Response(new Uint8Array([0xff, 0xfe, 0xfd]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }));
    expect(utf8).toMatchObject({ code: "invalid_utf8", stage: "tools_list_protocol" });

    const json = await probeOpenworkCloudCatalog(input({
      requestId: "bad-json",
      fetchImpl: async () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    }));
    expect(json).toMatchObject({ code: "invalid_json", stage: "tools_list_protocol" });

    const envelope = await probeOpenworkCloudCatalog(input({
      requestId: "bad-envelope",
      fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "1.0", id: "bad-envelope", result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }));
    expect(envelope).toMatchObject({ code: "invalid_jsonrpc_envelope", stage: "tools_list_protocol" });
  });

  test("keeps availability observed when only session cleanup fails and reports it", async () => {
    let deleteCalls = 0;
    const fetchImpl: CloudCatalogProbeFetch = async (url, init) => {
      if (init?.method === "DELETE") {
        deleteCalls += 1;
        return new Response(null, { status: 500 });
      }
      const body = requestPayload(init);
      if (body.method === "initialize") return initializeResponse();
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return jsonResponse("cleanup-fails");
    };
    const probeInput = input({ requestId: "cleanup-fails" });
    probeInput.fetchImpl = fetchImpl;
    const observed = await probeOpenworkCloudCatalog(probeInput);
    expect(deleteCalls).toBe(1);
    expect(observed).toMatchObject({
      status: "observed",
      code: "catalog_observed",
      sessionEstablished: true,
      cleanupAttempted: true,
      cleanupSucceeded: false,
    });
  });

  test("skips cleanup when the server never returned a session ID", async () => {
    let deleteCalls = 0;
    const fetchImpl: CloudCatalogProbeFetch = async (_url, init) => {
      if (init?.method === "DELETE") {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      const body = requestPayload(init);
      if (body.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: "openwork-agent-diagnostics-initialize",
          result: { capabilities: {}, protocolVersion: PROTOCOL_VERSION, serverInfo: { name: "t", version: "1" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return jsonResponse("no-session");
    };
    const probeInput = input({ requestId: "no-session" });
    probeInput.fetchImpl = fetchImpl;
    const observed = await probeOpenworkCloudCatalog(probeInput);
    expect(deleteCalls).toBe(0);
    expect(observed).toMatchObject({
      status: "observed",
      sessionEstablished: false,
      cleanupAttempted: false,
      cleanupSucceeded: null,
    });
  });

  test("exports a reference ID only from a strictly validated safe header", async () => {
    const safe = await probeOpenworkCloudCatalog(input({
      requestId: "with-reference",
      fetchImpl: async () => {
        const response = jsonResponse("with-reference");
        response.headers.set("x-request-id", "req-1234.abc:z");
        return response;
      },
    }));
    expect(safe.referenceId).toBe("req-1234.abc:z");

    const unsafe = await probeOpenworkCloudCatalog(input({
      requestId: "with-unsafe-reference",
      fetchImpl: async () => {
        const response = jsonResponse("with-unsafe-reference");
        response.headers.set("x-request-id", "spaced value with secrets");
        return response;
      },
    }));
    expect(unsafe.referenceId).toBeNull();
    expect(JSON.stringify(unsafe)).not.toContain("spaced value");
  });

  test("reports boolean-only proxy and extra-CA posture from the environment seam", async () => {
    const configured = await probeOpenworkCloudCatalog(input({
      requestId: "env-posture",
      env: {
        HTTPS_PROXY: "http://proxy.corp.example:8080",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-root.pem",
      },
      fetchImpl: async () => jsonResponse("env-posture"),
    }));
    expect(configured.proxyConfigured).toBe(true);
    expect(configured.extraCaConfigured).toBe(true);
    const serialized = JSON.stringify(configured);
    expect(serialized).not.toContain("proxy.corp.example");
    expect(serialized).not.toContain("corp-root");
  });

  test("derives the differential verdict from probe and engine evidence", () => {
    const base = (overrides: Partial<CloudCatalogProbe>): CloudCatalogProbe => ({
      performed: true,
      status: "observed",
      stage: "complete",
      code: "catalog_observed",
      networkCode: null,
      retryable: false,
      runtimeFamily: "bun",
      transport: "test-seam",
      trustSource: "builtin-cloud",
      enterpriseActivationPresent: false,
      httpStatus: 200,
      durationMs: 1,
      toolsListPerformed: true,
      sessionEstablished: true,
      cleanupAttempted: true,
      cleanupSucceeded: true,
      toolIds: ["search_capabilities", "execute_capability"],
      totalToolCount: 2,
      requiredToolsPresent: true,
      referenceId: null,
      proxyConfigured: false,
      extraCaConfigured: false,
      steps: [],
      engineRegistrationStatus: "connected",
      engineEvidenceSource: "engine_status",
      engineEvidenceAgeMs: 1_000,
      ...overrides,
    });
    expect(differentialCloudVerdict(base({}), true)).toBe("runtime_and_engine_connected");
    expect(differentialCloudVerdict(base({ engineRegistrationStatus: "failed" }), true))
      .toBe("runtime_connected_engine_failed");
    expect(differentialCloudVerdict(base({ status: "failed", code: "tls_error" }), true))
      .toBe("runtime_failed_engine_connected");
    expect(differentialCloudVerdict(base({ status: "failed", code: "tls_error", engineRegistrationStatus: "failed" }), true))
      .toBe("runtime_and_engine_failed");
    expect(differentialCloudVerdict(base({ performed: false, status: "not-performed", code: "untrusted_endpoint" }), true))
      .toBe("runtime_probe_not_performed");
    expect(differentialCloudVerdict(base({ engineRegistrationStatus: "not-recorded" }), true))
      .toBe("engine_evidence_stale_or_unavailable");
    // Aged connected evidence is the engine's standing state and stays
    // trusted; only an aged failure a reachable engine could have refreshed
    // is downgraded to stale.
    expect(differentialCloudVerdict(base({ engineEvidenceAgeMs: 120_000 }), true))
      .toBe("runtime_and_engine_connected");
    expect(differentialCloudVerdict(base({ engineRegistrationStatus: "failed", engineEvidenceAgeMs: 120_000 }), true))
      .toBe("engine_evidence_stale_or_unavailable");
    expect(differentialCloudVerdict(base({ engineRegistrationStatus: "failed", engineEvidenceAgeMs: 120_000 }), false))
      .toBe("runtime_connected_engine_failed");
  });

  test("trusts the activated enterprise origin and reports the trust source", async () => {
    const enterpriseEndpoint = "https://den.customer.example/custom/mcp/agent";
    const enterpriseConfig = {
      type: "remote",
      enabled: true,
      url: enterpriseEndpoint,
      headers: { Authorization: TOKEN },
    };

    // Every request must go to the operator's own configured Den endpoint.
    // The built-in origins are a membership allowlist, never a destination,
    // so an on-prem probe must never contact OpenWork-hosted Cloud.
    const requestedUrls: string[] = [];
    const activatedInput = input({
      requestId: "enterprise-activated",
      config: enterpriseConfig,
      activatedEnterpriseOrigin: "https://den.customer.example",
    });
    activatedInput.fetchImpl = async (url, init) => {
      requestedUrls.push(String(url));
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const body = requestPayload(init);
      if (body.method === "initialize") return initializeResponse();
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return jsonResponse("enterprise-activated");
    };
    const activated = await probeOpenworkCloudCatalog(activatedInput);
    expect(requestedUrls).toEqual([
      enterpriseEndpoint,
      enterpriseEndpoint,
      enterpriseEndpoint,
      enterpriseEndpoint,
    ]);
    expect(requestedUrls.some((url) => url.includes("openworklabs.com"))).toBe(false);
    expect(activated).toMatchObject({
      performed: true,
      status: "observed",
      trustSource: "enterprise-activation",
      enterpriseActivationPresent: true,
    });
    expect(JSON.stringify(activated)).not.toContain("den.customer.example");

    // Activated against a different control plane than the configured MCP:
    // the mismatch must stay fail-closed but remain distinguishable.
    let mismatchCalls = 0;
    const mismatch = await probeOpenworkCloudCatalog(input({
      requestId: "enterprise-mismatch",
      config: enterpriseConfig,
      activatedEnterpriseOrigin: "https://den.other.example",
      fetchImpl: async () => {
        mismatchCalls += 1;
        return jsonResponse("enterprise-mismatch");
      },
    }));
    expect(mismatchCalls).toBe(0);
    expect(mismatch).toMatchObject({
      performed: false,
      code: "untrusted_endpoint",
      trustSource: "untrusted",
      enterpriseActivationPresent: true,
    });

    let unactivatedCalls = 0;
    const unactivated = await probeOpenworkCloudCatalog(input({
      requestId: "enterprise-absent",
      config: enterpriseConfig,
      fetchImpl: async () => {
        unactivatedCalls += 1;
        return jsonResponse("enterprise-absent");
      },
    }));
    expect(unactivatedCalls).toBe(0);
    expect(unactivated).toMatchObject({
      performed: false,
      code: "untrusted_endpoint",
      trustSource: "untrusted",
      enterpriseActivationPresent: false,
    });
  });
});
