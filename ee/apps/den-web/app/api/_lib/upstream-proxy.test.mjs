import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const previousDenApiBase = process.env.DEN_API_BASE;

describe("Den upstream proxy", () => {
  let server;
  let observed = null;

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
        };

        if (url.pathname === "/v1/compressed") {
          return new Response(Bun.gzipSync(JSON.stringify({ ok: true, source: "gzip" })), {
            headers: {
              "content-type": "application/json",
              "content-encoding": "gzip",
            },
          });
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

  afterAll(() => {
    server.stop(true);
    if (previousDenApiBase === undefined) {
      delete process.env.DEN_API_BASE;
    } else {
      process.env.DEN_API_BASE = previousDenApiBase;
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
    });
    expect(response.status).toBe(207);
    expect(response.headers.get("x-upstream-result")).toBe("ok");
    expect(response.headers.get("set-cookie")).toContain("sid=abc");
    expect(await response.text()).toBe("proxied");
  });

  test("drops content-encoding after upstream fetch decompresses the body", async () => {
    const { proxyUpstream } = await import("./upstream-proxy.ts");
    const request = new NextRequest("https://app.example.com/api/den/v1/compressed");

    const response = await proxyUpstream(request, [], { routePrefix: "/api/den" });

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual({ ok: true, source: "gzip" });
  });
});
