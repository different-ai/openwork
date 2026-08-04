import { describe, expect, test } from "bun:test";

import {
  openInDenLibraryUrl,
  shouldShowOpenInDenAction,
} from "../src/react-app/domains/settings/open-in-den";

describe("Open in Den", () => {
  test("builds a focused connection URL for an organization MCP item", () => {
    expect(openInDenLibraryUrl("https://den.example/", { id: "org-mcp:conn_123" })).toBe(
      "https://den.example/dashboard/library?focus=connection-conn_123",
    );
  });

  test("builds a focused plugin URL for a plugin item", () => {
    expect(openInDenLibraryUrl("https://den.example", {
      id: "marketplace:marketplace-1:plg_123",
      pluginId: "plg_123",
    })).toBe("https://den.example/dashboard/library?focus=plugin-plg_123");
  });

  test("hides the action without a Den base URL or cloud session", () => {
    const target = { id: "org-mcp:connection-123" };
    expect(shouldShowOpenInDenAction("", true, target)).toBe(false);
    expect(shouldShowOpenInDenAction("https://den.example", false, target)).toBe(false);
  });

  test("shows the action with a Den base URL and cloud session", () => {
    expect(shouldShowOpenInDenAction("https://den.example", true, {
      id: "marketplace:installed:plugin-123",
      pluginId: "plugin-123",
    })).toBe(true);
  });
});
