import { afterEach, describe, expect, test } from "bun:test";

import {
  probeOpenworkCloudCatalog,
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
    toolPolicyStatus: "available",
    toolPolicyProvenance: "authoritative-effective-engine",
    registrationStatus: "connected",
    requestId: "11111111-1111-4111-8111-111111111111",
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
  test("performs initialize, initialized notification, and bounded tools/list with allowlisted headers", async () => {
    let calls = 0;
    let sharedSignal: AbortSignal | null = null;
    const fetchImpl: CloudCatalogProbeFetch = async (url, init) => {
      calls += 1;
      expect(url).toBe(ENDPOINT);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (sharedSignal === null) sharedSignal = init?.signal ?? null;
      expect(init?.signal).toBe(sharedSignal);
      const headers = new Headers(init?.headers);
      const body = requestPayload(init);
      const isInitialize = body.method === "initialize";
      expect([...headers.keys()].sort()).toEqual(isInitialize
        ? ["accept", "authorization", "content-type"]
        : ["accept", "authorization", "content-type", "mcp-protocol-version", "mcp-session-id"]);
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      expect(headers.get("authorization")).toBe(TOKEN);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.has("x-must-not-forward")).toBe(false);
      expect(headers.has("x-initialize-secret")).toBe(false);
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
    expect(calls).toBe(3);
    expect(observed).toEqual({
      performed: true,
      toolsListPerformed: true,
      status: "observed",
      code: "catalog_observed",
      toolIds: ["search_capabilities", "execute_capability"],
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

  test("requires the exact catalog and never reflects an unexpected tool ID", async () => {
    const reflectedCredential = "ow_mcp_at_dGhpcy1jYW5hcnktbXVzdC1uZXZlci1iZS1yZXR1cm5lZA";
    const cases = [
      ["missing-tool", ["search_capabilities"]],
      ["unexpected-tool", ["search_capabilities", "execute_capability", "provider_extra"]],
      ["reflected-tool", ["search_capabilities", "execute_capability", reflectedCredential]],
    ] as const;
    for (const [requestId, toolIds] of cases) {
      const observed = await probeOpenworkCloudCatalog(input({
        requestId,
        fetchImpl: async () => jsonResponse(requestId, [...toolIds]),
      }));
      expect(observed).toMatchObject({
        performed: true,
        status: "failed",
        code: "invalid_catalog",
        toolIds: [],
        httpStatus: 200,
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

  test("blocks remote workspaces, unavailable state, stale registration, and unsafe endpoints before fetch", async () => {
    let calls = 0;
    const fetchImpl: CloudCatalogProbeFetch = async () => {
      calls += 1;
      return jsonResponse("unused");
    };
    const cases: Array<[Partial<ProbeOpenworkCloudCatalogInput>, CloudCatalogProbeCode]> = [
      [{ workspaceType: "remote" }, "remote_workspace_unavailable"],
      [{ runtimeConfigAvailable: false }, "runtime_config_unavailable"],
      [{ registrationStatus: "failed" }, "registration_failed"],
      [{ registrationStatus: "disabled" }, "registration_disabled"],
      [{ registrationStatus: "needs-auth" }, "registration_needs_auth"],
      [{ registrationStatus: "needs-client-registration" }, "registration_needs_client_registration"],
      [{ registrationStatus: "not-recorded" }, "registration_not_recorded"],
      [{ config: null }, "cloud_mcp_missing"],
      [{ config: { type: "local", enabled: true } }, "cloud_mcp_not_remote"],
      [{ config: { type: "remote", enabled: false, url: ENDPOINT } }, "cloud_mcp_disabled"],
      [{ toolPolicyStatus: "unavailable" }, "cloud_tool_policy_unavailable"],
      [{ toolPolicyStatus: "denied" }, "cloud_tool_policy_denied"],
      [{ toolPolicyProvenance: "passive-static-subset" }, "cloud_tool_policy_unavailable"],
      [{ toolPolicyProvenance: "unavailable" }, "cloud_tool_policy_unavailable"],
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
      expect(blocked.code).toBe(code);
    }
    expect(calls).toBe(0);
  });

  test("allows exact loopback and explicitly configured HTTPS origins only", async () => {
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
    const cases: Array<[string, unknown, CloudCatalogProbeCode]> = [
      ["wrong-id", payload("different-id"), "invalid_response"],
      ["rpc-error", { jsonrpc: "2.0", id: "rpc-error", error: { code: -1, message: "Bearer private" } }, "jsonrpc_error"],
      ["pagination", { ...payload("pagination"), result: { tools: [], nextCursor: "secret-cursor" } }, "pagination_unsupported"],
      ["duplicate", payload("duplicate", ["search_capabilities", "search_capabilities"]), "invalid_catalog"],
      ["unsafe", payload("unsafe", ["search_capabilities\r\nspoof"]), "invalid_catalog"],
    ];
    for (const [requestId, body, code] of cases) {
      const observed = await probeOpenworkCloudCatalog(input({
        workspaceId: `ws_${requestId}`,
        requestId,
        fetchImpl: async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      }));
      expect(observed.code).toBe(code);
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

  test("classifies allowlisted network causes without exposing raw errors", async () => {
    const cases = [
      ["ENOTFOUND", "dns_error"],
      ["ECONNREFUSED", "connection_refused"],
      ["ECONNRESET", "connection_reset"],
      ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_error"],
      ["ERR_PROXY_AUTH_FAILED", "proxy_error"],
    ] as const;
    for (const [causeCode, expectedCode] of cases) {
      const failed = await probeOpenworkCloudCatalog(input({
        requestId: `network-${expectedCode}`,
        fetchImpl: async () => {
          throw new Error("RAW_NETWORK_SECRET", { cause: { code: causeCode } });
        },
      }));
      expect(failed).toMatchObject({ performed: true, status: "failed", code: expectedCode });
      expect(JSON.stringify(failed)).not.toContain("RAW_NETWORK_SECRET");
      expect(JSON.stringify(failed)).not.toContain(causeCode);
    }
  });
});
