import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import { NextRequest } from "next/server";

import { setStructuredLogSink, useJsonStdoutStructuredLogSink } from "../../../observability/runtime-logger.ts";

const previousDenApiBase = process.env.DEN_API_BASE;
const previousDenWebPublicOrigin = process.env.DEN_WEB_PUBLIC_ORIGIN;

describe("Den upstream proxy", () => {
  let server;
  let observed = null;
  let logs = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        observed = {
          method: request.method,
          path: `${url.pathname}${url.search}`,
          body: await request.text(),
          cookie: request.headers.get("cookie"),
          authorization: request.headers.get("authorization"),
          custom: request.headers.get("x-custom-proxy-test"),
          forwarded: request.headers.get("forwarded"),
          forwardedHost: request.headers.get("x-forwarded-host"),
          forwardedPrefix: request.headers.get("x-forwarded-prefix"),
          forwardedProto: request.headers.get("x-forwarded-proto"),
          traceparent: request.headers.get("traceparent"),
          tracestate: request.headers.get("tracestate"),
        };

        if (url.pathname === "/v1/compressed") {
          return new Response(Bun.gzipSync(JSON.stringify({ ok: true, source: "gzip" })), {
            headers: {
              "content-type": "application/json",
              "content-encoding": "gzip",
            },
          });
        }

        if (url.pathname === "/v1/error") {
          return new Response("upstream unavailable", { status: 502 });
        }

        return new Response("proxied", {
          status: 207,
          headers: {
            "content-type": "text/plain",
            "set-cookie": "sid=abc; Path=/; HttpOnly",
            "x-upstream-result": "ok",
          },
        });
      },
    });
    process.env.DEN_API_BASE = `http://127.0.0.1:${server.port}`;
  });

  beforeEach(() => {
    logs = [];
    setStructuredLogSink({
      log(level, message, fields) {
        logs.push({ level, message, fields });
      },
    });
  });

  afterAll(() => {
    useJsonStdoutStructuredLogSink();
    server.stop(true);
    if (previousDenApiBase === undefined) {
      delete process.env.DEN_API_BASE;
    } else {
      process.env.DEN_API_BASE = previousDenApiBase;
    }
    if (previousDenWebPublicOrigin === undefined) {
      delete process.env.DEN_WEB_PUBLIC_ORIGIN;
    } else {
      process.env.DEN_WEB_PUBLIC_ORIGIN = previousDenWebPublicOrigin;
    }
  });

  test("passes method, path, query, body, cookies, auth, status, and headers through", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/me?include=org", {
      method: "POST",
      headers: {
        authorization: "Bearer tok_test",
        cookie: "ow_session=sess_test",
        "content-type": "application/json",
        "x-custom-proxy-test": "kept",
      },
      body: JSON.stringify({ ok: true }),
    });

    const response = await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(observed).toEqual({
      method: "POST",
      path: "/v1/me?include=org",
      body: JSON.stringify({ ok: true }),
      cookie: "ow_session=sess_test",
      authorization: "Bearer tok_test",
      custom: "kept",
      forwarded: null,
      forwardedHost: "app.example.com",
      forwardedPrefix: "/api/den",
      forwardedProto: "https",
      traceparent: null,
      tracestate: null,
    });
    expect(response.status).toBe(207);
    expect(response.headers.get("x-upstream-result")).toBe("ok");
    expect(response.headers.get("set-cookie")).toContain("sid=abc");
    expect(await response.text()).toBe("proxied");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "info",
      message: "den-web upstream proxy completed",
      fields: {
        route_prefix: "/api/den",
        method: "POST",
        upstream_path: "/v1/me",
        status: 207,
      },
    });
    expect(typeof logs[0].fields.duration_ms).toBe("number");
    const serializedLog = JSON.stringify(logs[0]);
    expect(serializedLog).not.toContain("include=org");
    expect(serializedLog).not.toContain("tok_test");
    expect(serializedLog).not.toContain("sess_test");
    expect(serializedLog).not.toContain(JSON.stringify({ ok: true }));
  });

  test("drops content-encoding after upstream fetch decompresses the body", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/compressed");

    const response = await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual({ ok: true, source: "gzip" });
  });

  test("logs non-ok upstream completions without credentials or query strings", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/error?token=secret", {
      headers: {
        authorization: "Bearer should-not-log",
        cookie: "ow_session=should-not-log",
      },
    });

    const response = await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(response.status).toBe(502);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "warn",
      message: "den-web upstream proxy completed",
      fields: {
        route_prefix: "/api/den",
        method: "GET",
        upstream_path: "/v1/error",
        status: 502,
      },
    });
    const serializedLog = JSON.stringify(logs[0]);
    expect(serializedLog).not.toContain("token=secret");
    expect(serializedLog).not.toContain("should-not-log");
  });

  test("continues W3C trace context into upstream requests", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01";
    const tracestate = "vendor=value";
    const request = new NextRequest("https://app.example.com/api/den/v1/me", {
      headers: { traceparent, tracestate },
    });

    await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(observed.traceparent).toBe(traceparent);
    expect(observed.tracestate).toBe(tracestate);
  });

  test("overwrites spoofable forwarded headers", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/me", {
      headers: {
        forwarded: "host=evil.example;proto=http",
        "x-forwarded-host": "evil.example",
        "x-forwarded-prefix": "/evil",
        "x-forwarded-proto": "http",
      },
    });

    await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(observed.forwardedHost).toBe("app.example.com");
    expect(observed.forwardedPrefix).toBe("/api/den");
    expect(observed.forwardedProto).toBe("https");
    expect(observed.forwarded).toBeNull();
  });

  test("injects the active W3C trace context into upstream requests", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/me");
    const spanContext = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b9c7c989f97918e1",
      traceFlags: TraceFlags.SAMPLED,
    };

    const activeContext = trace.setSpanContext(context.active(), spanContext);
    const contextManager = {
      active: () => activeContext,
      with: (nextContext, callback, thisArg, ...args) => callback.apply(thisArg, args),
      bind: (nextContext, target) => target,
      enable: () => contextManager,
      disable: () => contextManager,
    };

    context.setGlobalContextManager(contextManager);
    try {
      await proxyUpstream(request, [], { routePrefix: "/api/den" });
    } finally {
      context.disable();
    }

    expect(observed.traceparent).toBe("00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01");
  });
});
