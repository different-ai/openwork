import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient, DenApiError } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
});

describe("published desktop MCP connect compatibility", () => {
  test("surfaces an issuer-review conflict as an actionable Den error", async () => {
    const message = "This connection's OAuth issuer changed and existing credentials must be cleared. Ask a workspace admin to reconnect it.";
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.den.example.test/v1/mcp-connections/connection_1/connect/start");
        expect(init?.method).toBe("GET");
        return Response.json({
          error: "mcp_oauth_issuer_mismatch",
          message,
        }, { status: 409 });
      },
    });

    const client = createDenClient({
      baseUrl: "https://den.example.test",
      apiBaseUrl: "https://api.den.example.test",
      token: "published-desktop-token",
    });

    let failure: unknown;
    try {
      await client.startMcpConnectionConnect("org_1", "connection_1");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DenApiError);
    if (!(failure instanceof DenApiError)) throw new Error("Expected a structured Den API error.");
    expect(failure.status).toBe(409);
    expect(failure.code).toBe("mcp_oauth_issuer_mismatch");
    expect(failure.message).toBe(message);
  });
});
