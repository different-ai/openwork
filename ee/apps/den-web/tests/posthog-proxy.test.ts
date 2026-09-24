import { describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";

import { config, proxy } from "../proxy";

const sensitiveHeaders = {
  CoOkIe: "session=proxy-cookie-fixture",
  AuThOrIzAtIoN: "Bearer proxy-authorization-fixture",
  ReFeReR: "https://app.example.test/sign-in?state=proxy-referrer-fixture",
};

function expectPassThrough(response: NextResponse) {
  expect(response).toBeInstanceOf(NextResponse);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(response.headers.has("x-middleware-rewrite")).toBe(false);
  expect(response.headers.has("location")).toBe(false);
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.body).toBeNull();
}

function expectSanitizedRequestHeaders(request: NextRequest, response: NextResponse) {
  const expectedHeaders = new Headers(request.headers);
  const overriddenHeaders = response.headers.get("x-middleware-override-headers")?.split(",") ?? [];

  for (const name of ["cookie", "authorization", "referer"]) {
    expectedHeaders.delete(name);
    expect(overriddenHeaders).not.toContain(name);
    expect(response.headers.has(`x-middleware-request-${name}`)).toBe(false);
    expect(response.headers.has(name)).toBe(false);
  }

  expect(overriddenHeaders.sort()).toEqual([...expectedHeaders.keys()].sort());
  for (const [name, value] of expectedHeaders) {
    expect(response.headers.get(`x-middleware-request-${name}`)).toBe(value);
    expect(response.headers.has(name)).toBe(false);
  }

  const responseHeaderValues = [...response.headers.values()].join("\n");
  for (const value of Object.values(sensitiveHeaders)) {
    expect(responseHeaderValues).not.toContain(value);
  }
}

describe("PostHog proxy request sanitation", () => {
  test.each([
    "/ow",
    "/ow/",
    "/ow/static/array.js",
    "/ow/array/test-project/config.js",
    "/ow/e/?compression=gzip-js",
    "/ow/batch/",
    "/ow/flags/?v=2",
  ])("sanitizes only forwarded headers for %s", (pathname) => {
    const request = new NextRequest(`https://app.example.test:8443${pathname}`, {
      headers: {
        ...sensitiveHeaders,
        Host: "app.example.test:8443",
        Accept: "*/*",
        "Content-Type": "application/json",
        "X-Request-Id": "proxy-request-fixture",
      },
    });
    const originalHeaders = [...request.headers.entries()];
    const originalUrl = request.url;
    const originalNextUrl = request.nextUrl.href;

    const response = proxy(request);

    expectPassThrough(response);
    expectSanitizedRequestHeaders(request, response);
    expect(request.method).toBe("GET");
    expect(request.url).toBe(originalUrl);
    expect(request.nextUrl.href).toBe(originalNextUrl);
    expect([...request.headers.entries()]).toEqual(originalHeaders);
    expect(request.cookies.get("session")?.value).toBe("proxy-cookie-fixture");
  });

  test.each([
    "application/json",
    "application/x-www-form-urlencoded",
    "text/plain;charset=UTF-8",
    "application/octet-stream",
  ])("preserves POST body bytes and %s content type without consuming the body", async (contentType) => {
    const payload = new Uint8Array([0, 31, 139, 255, 123, 34, 120, 34, 58, 49, 125]);
    const request = new NextRequest("https://app.example.test/ow/e/?compression=gzip-js", {
      method: "POST",
      headers: {
        ...sensitiveHeaders,
        "Content-Type": contentType,
        "Content-Encoding": "gzip",
      },
      body: payload,
    });
    const originalHeaders = [...request.headers.entries()];
    const originalBody = request.body;

    const response = proxy(request);

    expectPassThrough(response);
    expectSanitizedRequestHeaders(request, response);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://app.example.test/ow/e/?compression=gzip-js");
    expect([...request.headers.entries()]).toEqual(originalHeaders);
    expect(request.body).toBe(originalBody);
    expect(request.bodyUsed).toBe(false);
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(payload);
  });

  test.each([
    "/",
    "/owl",
    "/owl/static/array.js",
    "/owish",
    "/OW/e/",
    "/api/auth/get-session",
    "/api/auth/sign-in/email",
    "/api/auth/callback/google?code=fixture-code",
    "/api/den/v1/me",
    "/sign-in",
    "/reauth/complete",
  ])("leaves %s untouched without overrides, rewrites, or auth redirects", (pathname) => {
    const request = new NextRequest(`https://app.example.test${pathname}`, {
      headers: sensitiveHeaders,
    });
    const originalHeaders = [...request.headers.entries()];
    const originalUrl = request.url;
    const originalNextUrl = request.nextUrl.href;

    const response = proxy(request);

    expectPassThrough(response);
    expect([...response.headers.entries()]).toEqual([...NextResponse.next().headers.entries()]);
    expect(response.headers.has("x-middleware-override-headers")).toBe(false);
    expect(request.url).toBe(originalUrl);
    expect(request.nextUrl.href).toBe(originalNextUrl);
    expect([...request.headers.entries()]).toEqual(originalHeaders);
  });

  test("keeps the matcher limited to /ow/:path*", () => {
    expect(config).toEqual({ matcher: "/ow/:path*" });
  });
});
