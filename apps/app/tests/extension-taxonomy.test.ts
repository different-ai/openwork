import { describe, expect, test } from "bun:test";

import { MCP_QUICK_CONNECT, type McpDirectoryInfo } from "../src/app/constants";
import { BUILT_IN_OPENWORK_EXTENSION_MANIFESTS } from "../src/app/extensions";
import {
  matchesExtensionFilter,
  extensionInventoryFilters,
  primaryLibraryFilter,
  taxonomyForDirectoryEntry,
} from "../src/react-app/domains/settings/extension-taxonomy";

function builtInEntry(id: string): McpDirectoryInfo {
  const entry = MCP_QUICK_CONNECT.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`missing built-in entry ${id}`);
  return entry;
}

describe("extension taxonomy", () => {
  test("only MCPs, Skills, and Plugins are primary, with MCPs as the default", () => {
    expect(extensionInventoryFilters).toEqual(["mcp", "skill", "plugin"]);
    expect(primaryLibraryFilter()).toBe("mcp");
    expect(primaryLibraryFilter("all")).toBe("mcp");
    expect(primaryLibraryFilter("connection")).toBe("mcp");
    expect(primaryLibraryFilter("skill")).toBe("skill");
    expect(primaryLibraryFilter("plugin")).toBe("plugin");
  });
  test("built-ins are apps because they run on this device", () => {
    for (const id of ["openwork-browser", "computer-use", "ollama"]) {
      expect(taxonomyForDirectoryEntry(builtInEntry(id))).toBe("app");
    }
  });

  test("Google Workspace is not a built-in app; it arrives as an org connection", () => {
    expect(MCP_QUICK_CONNECT.some((entry) => entry.id === "google-workspace")).toBe(false);
    expect(BUILT_IN_OPENWORK_EXTENSION_MANIFESTS.some((entry) => entry.id === "google-workspace")).toBe(false);
  });

  test("directory entries that are not built-in stay MCPs", () => {
    const notion = MCP_QUICK_CONNECT.find((entry) => entry.name === "Notion");
    expect(notion).toBeDefined();
    if (notion) expect(taxonomyForDirectoryEntry(notion)).toBe("mcp");
  });

  test("the all filter keeps every taxonomy and non-MCP filters match exactly", () => {
    expect(matchesExtensionFilter("all", "plugin")).toBe(true);
    expect(matchesExtensionFilter("connection", "connection")).toBe(true);
    expect(matchesExtensionFilter("connection", "mcp")).toBe(false);
    expect(matchesExtensionFilter("skill", "app")).toBe(false);
    expect(matchesExtensionFilter("skill", "connection", "mcp")).toBe(false);
    expect(matchesExtensionFilter("command", "command")).toBe(true);
    expect(matchesExtensionFilter("command", "skill")).toBe(false);
    expect(matchesExtensionFilter("agent", "agent")).toBe(true);
    expect(matchesExtensionFilter("agent", "command")).toBe(false);
  });

  test("the MCP filter includes both MCP-backed and native connections", () => {
    expect(matchesExtensionFilter("mcp", "connection", "mcp")).toBe(true);
    expect(matchesExtensionFilter("mcp", "connection", "native")).toBe(true);
    expect(matchesExtensionFilter("mcp", "mcp", null)).toBe(true);
  });
});
