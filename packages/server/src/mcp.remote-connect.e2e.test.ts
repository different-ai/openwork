import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { addMcp, listMcp, removeMcp } from "./mcp.js";

describe("mcp remote connect flow", () => {
  test("adds, lists, and removes a remote MCP without OAuth", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-mcp-remote-e2e-"));

    try {
      const added = await addMcp(workspaceRoot, "simple-remote", {
        type: "remote",
        url: "https://example.com/mcp",
        enabled: true,
      });
      expect(added.action).toBe("added");

      const listedAfterAdd = await listMcp(workspaceRoot);
      const item = listedAfterAdd.find((entry) => entry.name === "simple-remote");
      expect(item).toBeDefined();
      expect(item?.config).toEqual({
        type: "remote",
        url: "https://example.com/mcp",
        enabled: true,
      });
      expect(item?.source).toBe("config.project");

      const configText = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
      expect(configText).toContain("\"simple-remote\"");
      expect(configText).toContain("\"https://example.com/mcp\"");

      const removed = await removeMcp(workspaceRoot, "simple-remote");
      expect(removed).toBe(true);

      const listedAfterRemove = await listMcp(workspaceRoot);
      expect(listedAfterRemove.some((entry) => entry.name === "simple-remote")).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
