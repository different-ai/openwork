declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import {
  describeCloudMcpTarget,
  describeDenEndpointSource,
} from "./den-endpoint-sources";

describe("Den endpoint sources", () => {
  test("bootstrap wins over stale storage", () => {
    expect(describeDenEndpointSource({
      storedValue: "https://custom.example.com/",
      bootstrapValue: "http://127.0.0.1:8788",
      buildDefault: "https://app.openworklabs.com",
    })).toEqual({
      effective: "http://127.0.0.1:8788",
      source: "bootstrap",
    });
  });

  test("bootstrap wins over default and exposes localhost MCP targets", () => {
    const endpoint = describeDenEndpointSource({
      storedValue: null,
      bootstrapValue: "http://127.0.0.1:8788/api/den",
      buildDefault: "https://app.openworklabs.com/api/den",
    });

    expect(endpoint).toEqual({
      effective: "http://127.0.0.1:8788/api/den",
      source: "bootstrap",
    });

    const mcpTarget = describeCloudMcpTarget({
      mcpUrl: "http://127.0.0.1:8788/mcp/agent",
      effectiveApiBaseUrl: endpoint.effective,
    });

    expect(mcpTarget.isLocalhost).toBe(true);
    expect(mcpTarget.matchesApi).toBe(true);
  });

  test("default is used when neither storage nor bootstrap has a value", () => {
    expect(describeDenEndpointSource({
      storedValue: null,
      bootstrapValue: null,
      buildDefault: "https://app.openworklabs.com/",
    })).toEqual({
      effective: "https://app.openworklabs.com",
      source: "default",
    });
  });

  test("detects MCP targets that do not match the API origin", () => {
    const target = describeCloudMcpTarget({
      mcpUrl: "https://other.example.com/mcp/agent",
      effectiveApiBaseUrl: "https://app.openworklabs.com/api/den",
    });

    expect(target.url).toBe("https://other.example.com/mcp/agent");
    expect(target.isLocalhost).toBe(false);
    expect(target.matchesApi).toBe(false);
  });

  test("handles a missing MCP URL", () => {
    expect(describeCloudMcpTarget({
      mcpUrl: null,
      effectiveApiBaseUrl: "https://app.openworklabs.com/api/den",
    })).toEqual({
      url: null,
      isLocalhost: false,
      matchesApi: false,
    });
  });
});
