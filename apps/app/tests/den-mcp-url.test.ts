import { describe, expect, test } from "bun:test";

import { getDenMcpUrl, isLegacyWebAppMcpUrl, resolveDenBaseUrls } from "../src/app/lib/den";

describe("resolveDenBaseUrls", () => {
  test("heals a stale bare web-app apiBaseUrl through the /api/den proxy", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "https://app.openworklabs.com",
      apiBaseUrl: "https://app.openworklabs.com",
    });
    expect(resolved.apiBaseUrl).toBe("https://app.openworklabs.com/api/den");
  });

  test("keeps an explicit API origin verbatim", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "https://app.openworklabs.com",
      apiBaseUrl: "https://api.openworklabs.com",
    });
    expect(resolved.apiBaseUrl).toBe("https://api.openworklabs.com");
  });

  test("keeps an explicit loopback apiBaseUrl verbatim (dev den-api)", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "http://localhost:3000",
      apiBaseUrl: "http://127.0.0.1:8787",
    });
    expect(resolved.apiBaseUrl).toBe("http://127.0.0.1:8787");
  });

  test("derives the /api/den proxy from a web-app baseUrl when no apiBaseUrl is set", () => {
    const resolved = resolveDenBaseUrls({ baseUrl: "https://app.openworklabs.com" });
    expect(resolved.apiBaseUrl).toBe("https://app.openworklabs.com/api/den");
  });
});

describe("getDenMcpUrl", () => {
  test("never targets the bare web-app origin", () => {
    const url = getDenMcpUrl();
    expect(isLegacyWebAppMcpUrl(url)).toBe(false);
    expect(url.endsWith("/mcp")).toBe(true);
  });
});

describe("isLegacyWebAppMcpUrl", () => {
  test("flags the legacy bare web-app MCP URL", () => {
    expect(isLegacyWebAppMcpUrl("https://app.openworklabs.com/mcp")).toBe(true);
    expect(isLegacyWebAppMcpUrl("https://app.openwork.software/mcp/")).toBe(true);
  });

  test("accepts valid MCP URLs", () => {
    expect(isLegacyWebAppMcpUrl("https://api.openworklabs.com/mcp")).toBe(false);
    expect(isLegacyWebAppMcpUrl("https://app.openworklabs.com/api/den/mcp")).toBe(false);
    expect(isLegacyWebAppMcpUrl("http://127.0.0.1:8787/mcp")).toBe(false);
  });

  test("ignores empty or malformed input", () => {
    expect(isLegacyWebAppMcpUrl(null)).toBe(false);
    expect(isLegacyWebAppMcpUrl("not a url")).toBe(false);
  });
});
