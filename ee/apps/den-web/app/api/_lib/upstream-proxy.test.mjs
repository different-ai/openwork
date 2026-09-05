import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import { NextRequest } from "next/server";

import { setStructuredLogSink, useJsonStdoutStructuredLogSink } from "../../../observability/runtime-logger.ts";

const previousDenApiBase = process.env.DEN_API_BASE;
const previousDenBaseUrl = process.env.DEN_BASE_URL;
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

        if (url.pathname === "/v1/internal-headers") {
          const upstreamOrigin = new URL(request.url).origin;
          return new Response("sanitized", {
            headers: {
              "access-control-expose-headers": "Content-Length, X-Request-Id, X-Origin-Host",
              "content-location": `${upstreamOrigin}/v1/internal-headers/body`,
              "link": `<${upstreamOrigin}/v1/internal-headers/next>; rel="next"`,
              "location": `${upstreamOrigin}/v1/internal-headers/redirect?next=1`,
              "refresh": `0; url=${upstreamOrigin}/v1/internal-headers/login`,
              "rndr-id": "render-request",
              "server": "internal-origin",
              "via": "internal-proxy",
              "x-cache-key": "cache:key",
              "x-content-type-options": "nosniff",
              "x-origin-host": "den-api.internal",
              "x-render-origin-server": "Render",
              "x-request-id": "req_internal",
              "x-upstream-result": "ok",
            },
          });
        }

        if (url.pathname === "/api/auth/callback/google") {
          const headers = new Headers({ "content-type": "text/plain" });
          headers.append(
            "set-cookie",
            "__Secure-better-auth.session_token=abc; Path=/; Domain=api.app.example.com; Secure; HttpOnly; SameSite=Lax",
          );
          headers.append(
            "set-cookie",
            "better-auth.session_data=def; Path=/; Secure; HttpOnly; SameSite=Lax",
          );
          return new Response("signed in", { headers });
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
    delete process.env.DEN_BASE_URL;
    delete process.env.DEN_WEB_PUBLIC_ORIGIN;
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
    if (previousDenBaseUrl === undefined) {
      delete process.env.DEN_BASE_URL;
    } else {
      process.env.DEN_BASE_URL = previousDenBaseUrl;
    }
  });

  const INSTANCE_ORIGIN = "https://8787-2bnptanfwxs5j8vu.daytonaproxy01.net";

  test("answers the preflight for a rotating Cloud instance origin", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/me", {
      method: "OPTIONS",
      headers: {
        origin: INSTANCE_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    const response = await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(INSTANCE_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization,content-type");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  test("reflects the instance origin on the real response and strips cookies upstream", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/me", {
      method: "GET",
      headers: {
        origin: INSTANCE_ORIGIN,
        authorization: "Bearer tok_instance",
        cookie: "ow_session=must_not_leak",
      },
    });

    const response = await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(response.headers.get("access-control-allow-origin")).toBe(INSTANCE_ORIGIN);
    // The whole safety argument: an instance-origin call is bearer-only and can
    // never ride the viewer's dashboard session.
    expect(observed.cookie).toBeNull();
    expect(observed.authorization).toBe("Bearer tok_instance");
  });

  test("does not reflect a non-instance origin and keeps its cookies", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/me", {
      method: "GET",
      headers: {
        origin: "https://evil.example.com",
        cookie: "ow_session=sess_test",
      },
    });

    const response = await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(observed.cookie).toBe("ow_session=sess_test");
  });

  test("does not reflect instance origins on the auth proxy", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/auth/session", {
      method: "GET",
      headers: { origin: INSTANCE_ORIGIN, cookie: "better-auth.session_token=sess_test" },
    });

    const response = await proxyUpstream(request, [], { routePrefix: "/api/auth", upstreamPathPrefix: "api/auth" });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(observed.cookie).toBe("better-auth.session_token=sess_test");
  });

  test("forwards only OpenWork Den and legacy Better Auth cookies through the auth proxy", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        cookie: "ph_posthog=analytics; __Secure-openwork-den.state=oauth-state; openwork-den.session_token=session; better-auth.state=legacy-oauth-state; __Secure-better-auth.session_token=legacy-session; other=value",
      },
    });

    await proxyUpstream(request, [], { routePrefix: "/api/auth", upstreamPathPrefix: "api/auth" });

    expect(observed.cookie).toBe("__Secure-openwork-den.state=oauth-state; openwork-den.session_token=session; better-auth.state=legacy-oauth-state; __Secure-better-auth.session_token=legacy-session");
  });

  test("rewrites auth Set-Cookie domains to the browser origin", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const originalFetch = globalThis.fetch;
    process.env.DEN_API_BASE = "https://api.app.example.com";
    globalThis.fetch = async () => {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append(
        "set-cookie",
        "__Secure-better-auth.session_token=abc; Path=/; Domain=api.app.example.com; Secure; HttpOnly; SameSite=Lax",
      );
      headers.append(
        "set-cookie",
        "better-auth.session_data=def; Path=/; Secure; HttpOnly; SameSite=Lax",
      );
      return new Response("signed in", { headers });
    };
    const request = new NextRequest("https://app.example.com/api/auth/callback/google", {
      method: "GET",
    });

    let response;
    try {
      response = await proxyUpstream(request, ["callback", "google"], { routePrefix: "/api/auth", upstreamPathPrefix: "api/auth" });
    } finally {
      globalThis.fetch = originalFetch;
      process.env.DEN_API_BASE = `http://127.0.0.1:${server.port}`;
    }

    expect(response.headers.getSetCookie()).toEqual([
      "__Secure-better-auth.session_token=abc; Path=/; Domain=app.example.com; Secure; HttpOnly; SameSite=Lax",
      "better-auth.session_data=def; Path=/; Secure; HttpOnly; SameSite=Lax; Domain=app.example.com",
    ]);
  });

  test("preserves auth Set-Cookie parent domains shared by sibling web and API hosts", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const originalFetch = globalThis.fetch;
    process.env.DEN_API_BASE = "https://api.openworklabs.com";
    globalThis.fetch = async () => {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append(
        "set-cookie",
        "__Secure-better-auth.session_token=abc; Path=/; Domain=openworklabs.com; Secure; HttpOnly; SameSite=Lax",
      );
      return new Response("signed in", { headers });
    };
    const request = new NextRequest("https://app.openworklabs.com/api/auth/callback/google", {
      method: "GET",
    });

    let response;
    try {
      response = await proxyUpstream(request, ["callback", "google"], { routePrefix: "/api/auth", upstreamPathPrefix: "api/auth" });
    } finally {
      globalThis.fetch = originalFetch;
      process.env.DEN_API_BASE = `http://127.0.0.1:${server.port}`;
    }

    expect(response.headers.getSetCookie()).toEqual([
      "__Secure-better-auth.session_token=abc; Path=/; Domain=openworklabs.com; Secure; HttpOnly; SameSite=Lax",
    ]);
  });

  test("copies auth Set-Cookie from runtimes that only expose the combined header", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const originalFetch = globalThis.fetch;
    process.env.DEN_API_BASE = "https://api.app.example.com";
    globalThis.fetch = async () => {
      const response = new Response("signed in", {
        headers: {
          "set-cookie": "better-auth.session_token=abc; Path=/; Secure; HttpOnly; SameSite=Lax, better-auth.session_data=def; Path=/; Expires=Tue, 25 Aug 2026 23:54:00 GMT; Secure; HttpOnly; SameSite=Lax",
        },
      });
      Object.defineProperty(response.headers, "getSetCookie", { value: () => [] });
      return response;
    };
    const request = new NextRequest("https://app.example.com/api/auth/callback/google", {
      method: "GET",
    });

    let response;
    try {
      response = await proxyUpstream(request, ["callback", "google"], { routePrefix: "/api/auth", upstreamPathPrefix: "api/auth" });
    } finally {
      globalThis.fetch = originalFetch;
      process.env.DEN_API_BASE = `http://127.0.0.1:${server.port}`;
    }

    expect(response.headers.getSetCookie()).toEqual([
      "better-auth.session_token=abc; Path=/; Secure; HttpOnly; SameSite=Lax; Domain=app.example.com",
      "better-auth.session_data=def; Path=/; Expires=Tue, 25 Aug 2026 23:54:00 GMT; Secure; HttpOnly; SameSite=Lax; Domain=app.example.com",
    ]);
  });

  test("rejects http and lookalike hostnames", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    for (const origin of ["http://8787-x.daytonaproxy01.net", "https://daytonaproxy01.net.evil.com"]) {
      const request = new NextRequest("https://app.example.com/api/den/v1/me", {
        method: "GET",
        headers: { origin },
      });
      const response = await proxyUpstream(request, [], { routePrefix: "/api/den" });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
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
    expect(response.headers.get("x-upstream-result")).toBeNull();
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

  test("strips internal upstream response headers and rewrites upstream URLs", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/internal-headers");

    const response = await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(response.headers.get("access-control-expose-headers")).toBe("Content-Length");
    for (const header of [
      "rndr-id",
      "server",
      "via",
      "x-cache-key",
      "x-origin-host",
      "x-render-origin-server",
      "x-request-id",
      "x-upstream-result",
    ]) {
      expect(response.headers.get(header)).toBeNull();
    }
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-location")).toBe("https://app.example.com/api/den/v1/internal-headers/body");
    expect(response.headers.get("link")).toBe("<https://app.example.com/api/den/v1/internal-headers/next>; rel=\"next\"");
    expect(response.headers.get("location")).toBe("https://app.example.com/api/den/v1/internal-headers/redirect?next=1");
    expect(response.headers.get("refresh")).toBe("0; url=https://app.example.com/api/den/v1/internal-headers/login");
    expect(await response.text()).toBe("sanitized");
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

  test("uses DEN_BASE_URL for forwarded public origin headers", async () => {
    process.env.DEN_BASE_URL = "http://cloud.example.test:3005";
    process.env.DEN_WEB_PUBLIC_ORIGIN = "https://migration.example.test";
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://request.example.com/api/den/v1/me");

    await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(observed.forwardedHost).toBe("cloud.example.test:3005");
    expect(observed.forwardedProto).toBe("http");
  });

  test("keeps DEN_WEB_PUBLIC_ORIGIN as the forwarded origin migration fallback", async () => {
    process.env.DEN_WEB_PUBLIC_ORIGIN = "https://migration.example.test";
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://request.example.com/api/den/v1/me");

    await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(observed.forwardedHost).toBe("migration.example.test");
    expect(observed.forwardedProto).toBe("https");
  });

  test("preserves a rotating public ingress origin when the server request URL is internal", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    for (const internalHost of ["127.0.0.1", "0.0.0.0"]) {
      const request = new NextRequest(`http://${internalHost}:3005/api/den/v1/me`, {
        headers: {
          "x-forwarded-host": "3005-rotated.daytonaproxy01.net",
          "x-forwarded-proto": "https",
        },
      });

      await proxyUpstream(request, [], { routePrefix: "/api/den" });

      expect(observed.forwardedHost).toBe("3005-rotated.daytonaproxy01.net");
      expect(observed.forwardedPrefix).toBe("/api/den");
      expect(observed.forwardedProto).toBe("https");
    }
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
