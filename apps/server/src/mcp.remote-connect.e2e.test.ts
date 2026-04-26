import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { addMcp, listMcp, removeMcp, setMcpEnabled } from "./mcp.js";

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

  test("pauses and resumes a project MCP without removing its config", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-mcp-toggle-e2e-"));

    try {
      await addMcp(workspaceRoot, "simple-remote", {
        type: "remote",
        url: "https://example.com/mcp",
        enabled: true,
      });

      const enabledAgain = await setMcpEnabled(workspaceRoot, "simple-remote", true);
      expect(enabledAgain).toEqual({ changed: false, enabled: true });

      const paused = await setMcpEnabled(workspaceRoot, "simple-remote", false);
      expect(paused).toEqual({ changed: true, enabled: false });

      const listedAfterPause = await listMcp(workspaceRoot);
      expect(listedAfterPause.find((entry) => entry.name === "simple-remote")?.config).toEqual({
        type: "remote",
        url: "https://example.com/mcp",
        enabled: false,
      });

      const pausedConfigText = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
      expect(pausedConfigText).toContain("\"simple-remote\"");
      expect(pausedConfigText).toContain("\"enabled\": false");

      const resumed = await setMcpEnabled(workspaceRoot, "simple-remote", true);
      expect(resumed).toEqual({ changed: true, enabled: true });

      const listedAfterResume = await listMcp(workspaceRoot);
      expect(listedAfterResume.find((entry) => entry.name === "simple-remote")?.config).toEqual({
        type: "remote",
        url: "https://example.com/mcp",
        enabled: true,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("pauses and resumes an inherited global MCP with a workspace override", async () => {
    const previousHome = process.env.HOME;
    const homeRoot = await mkdtemp(join(tmpdir(), "openwork-mcp-home-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-mcp-global-toggle-e2e-"));

    try {
      process.env.HOME = homeRoot;
      const globalConfigPath = join(homeRoot, ".config", "opencode", "opencode.jsonc");
      await mkdir(join(homeRoot, ".config", "opencode"), { recursive: true });
      await writeFile(
        globalConfigPath,
        JSON.stringify(
          {
            mcp: {
              inherited: {
                type: "remote",
                url: "https://example.com/global-mcp",
                enabled: true,
              },
              disabledGlobal: {
                type: "remote",
                url: "https://example.com/disabled-global-mcp",
                enabled: false,
              },
            },
          },
          null,
          2,
        ),
      );

      const listedBeforePause = await listMcp(workspaceRoot);
      expect(listedBeforePause.find((entry) => entry.name === "inherited")).toMatchObject({
        source: "config.global",
        config: {
          type: "remote",
          url: "https://example.com/global-mcp",
          enabled: true,
        },
      });

      const paused = await setMcpEnabled(workspaceRoot, "inherited", false);
      expect(paused).toEqual({ changed: true, enabled: false });

      const projectConfigText = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
      expect(projectConfigText).toContain("\"inherited\"");
      expect(projectConfigText).toContain("\"enabled\": false");
      expect(projectConfigText).not.toContain("global-mcp");

      const listedAfterPause = await listMcp(workspaceRoot);
      expect(listedAfterPause.find((entry) => entry.name === "inherited")).toMatchObject({
        source: "config.project",
        config: {
          type: "remote",
          url: "https://example.com/global-mcp",
          enabled: false,
        },
      });

      const resumed = await setMcpEnabled(workspaceRoot, "inherited", true);
      expect(resumed).toEqual({ changed: true, enabled: true });

      const listedAfterResume = await listMcp(workspaceRoot);
      expect(listedAfterResume.find((entry) => entry.name === "inherited")).toMatchObject({
        source: "config.global",
        config: {
          type: "remote",
          url: "https://example.com/global-mcp",
          enabled: true,
        },
      });

      const disabledGlobalPause = await setMcpEnabled(workspaceRoot, "disabledGlobal", false);
      expect(disabledGlobalPause).toEqual({ changed: false, enabled: false });
      const configAfterDisabledPause = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
      expect(configAfterDisabledPause).not.toContain("disabledGlobal");

      await expect(setMcpEnabled(workspaceRoot, "disabledGlobal", true)).rejects.toMatchObject({
        status: 409,
        code: "global_mcp_disabled",
      });
    } finally {
      if (previousHome == null) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(homeRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects malformed project MCP entries instead of treating them as disabled overrides", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-mcp-invalid-toggle-e2e-"));

    try {
      await writeFile(
        join(workspaceRoot, "opencode.jsonc"),
        JSON.stringify({ mcp: { broken: { enabled: true } } }, null, 2),
      );

      await expect(setMcpEnabled(workspaceRoot, "broken", false)).rejects.toMatchObject({
        status: 409,
        code: "invalid_mcp_config",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
