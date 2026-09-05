import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;
const originalElectronBridge = typeof window === "undefined" ? undefined : window.__OPENWORK_ELECTRON__;

beforeEach(() => {
  if (typeof window !== "undefined") window.__OPENWORK_ELECTRON__ = undefined;
});

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  if (typeof window !== "undefined") window.__OPENWORK_ELECTRON__ = originalElectronBridge;
});

describe("Cloud workspace retry client", () => {
  test("uses explicit recovery when Den supports it", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          method: init?.method ?? "GET",
          path: new URL(String(input)).pathname,
        });
        return new Response(JSON.stringify({ status: "waking", url: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) satisfies typeof fetch,
    });

    const instance = await createDenClient({ baseUrl: "https://den.test", token: "tok_test" })
      .retryCloudInstance("org_test");

    expect(instance.status).toBe("waking");
    expect(requests).toEqual([
      { method: "POST", path: "/api/den/v1/cloud/instance/retry" },
    ]);
  });

  test("falls back to status recovery when an older Den has no retry route", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = {
          method: init?.method ?? "GET",
          path: new URL(String(input)).pathname,
        };
        requests.push(request);
        if (request.path.endsWith("/retry")) {
          return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ status: "failed", url: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) satisfies typeof fetch,
    });

    const instance = await createDenClient({ baseUrl: "https://den.test", token: "tok_test" })
      .retryCloudInstance("org_test");

    expect(instance.status).toBe("failed");
    expect(requests).toEqual([
      { method: "POST", path: "/api/den/v1/cloud/instance/retry" },
      { method: "GET", path: "/api/den/v1/cloud/instance" },
    ]);
  });
});
