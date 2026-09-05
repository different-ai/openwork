import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
});

describe("Den MCP connection presets", () => {
  test("loads the organization-scoped authoritative preset catalog", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
        });
        return Response.json({
          presets: [
            {
              presetId: "notion",
              displayName: "Notion",
              description: "Pages and databases.",
              url: "https://mcp.notion.com/mcp",
              authType: "oauth",
            },
            {
              presetId: "invalid",
              displayName: "Invalid",
              description: "Missing a URL and valid auth type.",
              authType: "unknown",
            },
          ],
        });
      },
    });

    const presets = await createDenClient({
      baseUrl: "https://den.example.test",
      apiBaseUrl: "https://api.den.example.test",
      token: "token",
    }).listMcpConnectionPresets("organization_test");

    expect(presets).toEqual([{
      presetId: "notion",
      displayName: "Notion",
      description: "Pages and databases.",
      url: "https://mcp.notion.com/mcp",
      authType: "oauth",
    }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.den.example.test/v1/mcp-connections/presets");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer token");
    expect(requests[0]?.headers.get("x-openwork-org-id")).toBe("organization_test");
  });
});
