import { describe, expect, test } from "bun:test";

import { mcpBrowserOpenFailedUrl } from "../src/react-app/domains/connections/mcp-browser-handoff";

describe("mcpBrowserOpenFailedUrl", () => {
  const url = "https://provider.example/authorize?state=visible";

  test("accepts the existing browser-open failure event", () => {
    expect(mcpBrowserOpenFailedUrl({
      type: "mcp.browser.open.failed",
      properties: { mcpName: "notion", url },
    }, "notion")).toBe(url);
  });

  test("ignores another MCP or an unrelated event", () => {
    expect(mcpBrowserOpenFailedUrl({
      type: "mcp.browser.open.failed",
      properties: { mcpName: "slack", url },
    }, "notion")).toBeNull();
    expect(mcpBrowserOpenFailedUrl({
      type: "mcp.tools.changed",
      properties: { mcpName: "notion", url },
    }, "notion")).toBeNull();
  });
});
