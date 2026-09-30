import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient, DenApiError } from "../src/app/lib/den";
import type { GatewayProviderSummary } from "@openwork/types/den/gateway";

const originalFetch = globalThis.fetch;
const client = createDenClient({
  baseUrl: "https://den.example.test",
  apiBaseUrl: "https://api.den.example.test",
  token: "test-token",
});

const provider = {
  id: "ipr_test",
  providerId: "openai",
  name: "Team AI",
  source: "openwork_gateway",
  credentialMode: "per_member",
  credentialStatus: "member_auth_required",
  authUrl: null,
  status: "active",
  updatedAt: "2026-09-01T00:00:00.000Z",
  providerConfig: {},
  modelIds: [],
  models: [],
  authorizationRequests: [],
} satisfies GatewayProviderSummary;

function respond(response: () => Response | Promise<Response>) {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: response });
}

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

describe("Den accessible Gateway provider summaries", () => {
  test("uses the member-scoped non-secret list and retains access with no ready models", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers }> = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
        return Response.json({ inferenceProviders: [{
          ...provider,
          apiKey: "must-not-reach-onboarding",
          apiKeys: { TEST_KEY: "must-not-reach-onboarding" },
          settings: { internal: true },
        }] });
      },
    });

    expect(await client.listOrgGatewayProviders("org_test")).toEqual([{
      id: provider.id,
      providerId: provider.providerId,
      name: provider.name,
      source: provider.source,
    }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.den.example.test/v1/inference-providers?scope=usable");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-token");
    expect(requests[0]?.headers.get("x-openwork-org-id")).toBe("org_test");
    expect(requests[0]?.headers.get("x-openwork-legacy-org-id")).toBe("org_test");
  });

  test("accepts an empty accessible list", async () => {
    respond(() => Response.json({ inferenceProviders: [] }));
    expect(await client.listOrgGatewayProviders("org_test")).toEqual([]);
  });

  for (const status of [404, 405, 501]) {
    test(`falls back for unavailable list status ${status}`, async () => {
      respond(() => new Response("Not supported", { status }));
      expect(await client.listOrgGatewayProviders("org_test")).toEqual([]);
    });
  }

  for (const status of [400, 401, 403, 409, 429, 500, 502, 503]) {
    test(`surfaces list error ${status}`, async () => {
      respond(() => Response.json({ error: "gateway_failed", message: "Gateway unavailable" }, { status }));
      await expect(client.listOrgGatewayProviders("org_test")).rejects.toMatchObject({
        status,
        code: "gateway_failed",
        message: "Gateway unavailable",
      });
    });
  }

  test("surfaces network failure", async () => {
    respond(() => Promise.reject(new Error("Network unavailable")));
    await expect(client.listOrgGatewayProviders("org_test")).rejects.toThrow("Network unavailable");
  });

  test("rejects malformed JSON instead of reporting no accessible providers", async () => {
    respond(() => new Response("not-json", { status: 200 }));
    await expect(client.listOrgGatewayProviders("org_test")).rejects.toBeInstanceOf(DenApiError);
  });

  const invalidPayloads = [
    null,
    {},
    { inferenceProviders: null },
    { inferenceProviders: {} },
    { inferenceProviders: [null] },
    { inferenceProviders: [provider, { ...provider, id: " " }] },
    { inferenceProviders: [{ ...provider, providerId: 1 }] },
    { inferenceProviders: [{ ...provider, name: null }] },
    { inferenceProviders: [{ ...provider, source: "openwork" }] },
  ];
  for (const [index, payload] of invalidPayloads.entries()) {
    test(`rejects invalid summary payload ${index + 1} without silently dropping rows`, async () => {
      respond(() => Response.json(payload));
      await expect(client.listOrgGatewayProviders("org_test")).rejects.toMatchObject({
        code: "invalid_gateway_providers_payload",
        message: "AI Gateway provider response was invalid.",
      });
    });
  }
});
