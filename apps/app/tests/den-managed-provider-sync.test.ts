import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient, DenApiError } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;

describe("Den managed provider worker sync client", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  });

  test("posts to the org-scoped worker sync endpoint", async () => {
    const calls: Array<{ url: string; method: string; org: string | null; authorized: boolean; body: string | null }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        org: headers.get("x-openwork-legacy-org-id"),
        authorized: headers.get("authorization") === "Bearer user-token",
        body: typeof init?.body === "string" ? init.body : null,
      });
      return new Response(JSON.stringify({
        status: "applied",
        providerCount: 1,
        revision: "safe-revision",
        providerIds: ["lpr_applied"],
      }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    };

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    const client = createDenClient({ baseUrl: "http://den.local", token: "user-token" });
    const result = await client.syncWorkerManagedProviders("org_test", "wrk_test");

    expect(result).toEqual({ status: "applied", providerCount: 1, revision: "safe-revision", providerIds: ["lpr_applied"] });
    expect(calls).toEqual([{
      url: "http://den.local/v1/workers/wrk_test/managed-providers/sync",
      method: "POST",
      org: "org_test",
      authorized: true,
      body: "{}",
    }]);
  });

  test("surfaces sanitized worker sync failures", async () => {
    const secret = "sk-secret-value";
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
      status: "failed",
      reason: "Worker provider sync failed.",
      secret,
    }), {
      headers: { "Content-Type": "application/json" },
      status: 502,
    });

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    const client = createDenClient({ baseUrl: "http://den.local", token: "user-token" });

    await expect(client.syncWorkerManagedProviders("org_test", "wrk_test")).rejects.toThrow("Worker provider sync failed.");
    try {
      await client.syncWorkerManagedProviders("org_test", "wrk_test");
    } catch (error) {
      expect(error).toBeInstanceOf(DenApiError);
      expect(error instanceof Error ? error.message.includes(secret) : true).toBe(false);
    }
  });

  test("rejects sync payloads whose applied provider IDs do not match the provider count", async () => {
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
      status: "applied",
      providerCount: 2,
      revision: "mismatch-revision",
      providerIds: ["lpr_only_one"],
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    const client = createDenClient({ baseUrl: "http://den.local", token: "user-token" });
    await expect(client.syncWorkerManagedProviders("org_test", "wrk_test")).rejects.toThrow("Managed provider sync response was invalid.");
  });
});
