import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectMcpLayersFromRuntimeSnapshot,
  resolveGlobalOpenCodeConfigPath,
} from "./mcp.js";

describe("passive MCP layer inspection", () => {
  test("resolves safe OPENCODE_CONFIG_DIR before XDG_CONFIG_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-passive-mcp-xdg-"));
    const xdgConfigHome = join(root, "xdg-config");
    const opencodeConfigDir = join(root, "explicit-opencode-config");
    const homeDir = join(root, "home");
    try {
      await mkdir(join(xdgConfigHome, "opencode"), { recursive: true });
      await mkdir(opencodeConfigDir, { recursive: true });
      await mkdir(join(homeDir, ".config", "opencode"), { recursive: true });
      const xdgJson = join(xdgConfigHome, "opencode", "opencode.json");
      const xdgJsonc = join(xdgConfigHome, "opencode", "opencode.jsonc");
      const homeJsonc = join(homeDir, ".config", "opencode", "opencode.jsonc");
      const explicitJson = join(opencodeConfigDir, "opencode.json");
      await writeFile(xdgJson, "{}", "utf8");
      await writeFile(homeJsonc, "{}", "utf8");
      await writeFile(explicitJson, "{}", "utf8");

      expect(resolveGlobalOpenCodeConfigPath({ opencodeConfigDir: "", xdgConfigHome, homeDir })).toBe(xdgJson);
      expect(resolveGlobalOpenCodeConfigPath({ opencodeConfigDir, xdgConfigHome, homeDir })).toBe(explicitJson);

      await writeFile(xdgJsonc, "{}", "utf8");
      expect(resolveGlobalOpenCodeConfigPath({ opencodeConfigDir: "", xdgConfigHome, homeDir })).toBe(xdgJsonc);
      expect(resolveGlobalOpenCodeConfigPath({ opencodeConfigDir: "", xdgConfigHome: "relative/config", homeDir })).toBe(homeJsonc);
      expect(resolveGlobalOpenCodeConfigPath({ opencodeConfigDir: "", xdgConfigHome: `${xdgConfigHome}\n`, homeDir })).toBe(homeJsonc);
      expect(resolveGlobalOpenCodeConfigPath({
        opencodeConfigDir: "relative/config",
        xdgConfigHome,
        homeDir,
      })).toBe(xdgJsonc);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports the bounded selected sources and ordered collisions without claiming complete resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-passive-mcp-layers-"));
    const globalConfigPath = join(root, "global-opencode.jsonc");
    try {
      await writeFile(globalConfigPath, JSON.stringify({
        mcp: {
          shared: { type: "remote", url: "https://global.example/mcp" },
          "global-only": { type: "remote", url: "https://global-only.example/mcp" },
        },
        permission: { "global-only_*": "deny" },
      }), "utf8");
      await writeFile(join(root, "opencode.jsonc"), JSON.stringify({
        mcp: {
          shared: { type: "remote", url: "https://project.example/mcp" },
          "project-only": { type: "remote", url: "https://project-only.example/mcp" },
        },
        permission: { "shared_*": "deny", "runtime-denied_*": "deny" },
      }), "utf8");

      const inspection = await inspectMcpLayersFromRuntimeSnapshot(root, {
        mcp: {
          shared: { type: "remote", url: "https://runtime.example/mcp" },
          "runtime-only": { type: "remote", url: "https://runtime-only.example/mcp" },
          "runtime-denied": { type: "remote", url: "https://runtime-denied.example/mcp" },
        },
      }, { globalConfigPath });

      expect(inspection.items.map((item) => `${item.name}:${item.source}`)).toEqual([
        "shared:config.global",
        "global-only:config.global",
        "shared:config.remote",
        "runtime-only:config.remote",
        "runtime-denied:config.remote",
        "shared:config.project",
        "project-only:config.project",
      ]);
      expect(inspection.items.filter((item) => item.name === "shared")).toHaveLength(3);
      expect(inspection.collisions).toEqual([{
        name: "shared",
        sources: ["config.global", "config.remote", "config.project"],
      }]);
      expect(inspection.collisions[0]).not.toHaveProperty("effectiveSource");

      const byNameAndSource = new Map(
        inspection.items.map((item) => [`${item.name}:${item.source}`, item]),
      );
      expect(byNameAndSource.get("shared:config.global")?.disabledByTools).toBe(true);
      expect(byNameAndSource.get("shared:config.remote")?.disabledByTools).toBe(true);
      expect(byNameAndSource.get("shared:config.project")?.disabledByTools).toBe(true);
      expect(byNameAndSource.get("global-only:config.global")?.disabledByTools).toBe(true);
      expect(byNameAndSource.get("runtime-denied:config.remote")?.disabledByTools).toBe(true);
      expect(byNameAndSource.get("runtime-only:config.remote")?.disabledByTools).toBeUndefined();
      expect(byNameAndSource.get("project-only:config.project")?.disabledByTools).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("evaluates ordered current permissions for exact flat MCP tool IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-passive-mcp-policy-"));
    const globalConfigPath = join(root, "global-opencode.jsonc");
    try {
      await writeFile(globalConfigPath, JSON.stringify({
        permission: {
          "openwork-cloud_search_capabilities": "deny",
        },
        mode: {
          openwork: {
            permission: {
              "openwork-cloud_execute_capability": "deny",
            },
          },
        },
      }), "utf8");
      await writeFile(join(root, "opencode.jsonc"), JSON.stringify({
        // Current permission rules outrank the deprecated top-level tools map
        // even when the legacy value comes from a later project layer.
        tools: {
          "openwork-cloud_search_capabilities": true,
        },
        agent: {
          openwork: {
            permission: {
              "openwork-cloud_execute_capability": "allow",
            },
          },
        },
      }), "utf8");

      const inspection = await inspectMcpLayersFromRuntimeSnapshot(root, {
        mcp: {
          "openwork-cloud": { type: "remote", url: "https://cloud.example/mcp" },
        },
      }, {
        globalConfigPath,
        toolPolicy: {
          agentName: "openwork",
          mcpName: "openwork-cloud",
          toolIds: [
            "openwork-cloud_search_capabilities",
            "openwork-cloud_execute_capability",
          ],
        },
      });

      expect(inspection.toolPolicy).toEqual({
        scope: "passive-static-subset",
        status: "available",
        inspectedToolIds: [
          "openwork-cloud_search_capabilities",
          "openwork-cloud_execute_capability",
        ],
        deniedToolIds: [
          "openwork-cloud_search_capabilities",
          "openwork-cloud_execute_capability",
        ],
      });
      expect(inspection.items[0]?.disabledByTools).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not hide a tool for a resource-scoped permission rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-passive-mcp-resource-policy-"));
    const globalConfigPath = join(root, "global-opencode.jsonc");
    try {
      await writeFile(globalConfigPath, "{}", "utf8");
      await writeFile(join(root, "opencode.jsonc"), JSON.stringify({
        permission: {
          "openwork-cloud_search_capabilities": {
            "restricted-resource": "deny",
          },
        },
      }), "utf8");

      const inspection = await inspectMcpLayersFromRuntimeSnapshot(root, {
        mcp: {
          "openwork-cloud": { type: "remote", url: "https://cloud.example/mcp" },
        },
      }, {
        globalConfigPath,
        toolPolicy: {
          agentName: "openwork",
          mcpName: "openwork-cloud",
          toolIds: [
            "openwork-cloud_search_capabilities",
            "openwork-cloud_execute_capability",
          ],
        },
      });

      expect(inspection.toolPolicy).toMatchObject({
        status: "available",
        deniedToolIds: [],
      });
      expect(inspection.items[0]?.disabledByTools).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("marks malformed static MCP layers invalid and omits unsafe entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-passive-mcp-invalid-"));
    const globalConfigPath = join(root, "missing-global-opencode.jsonc");
    try {
      await writeFile(join(root, "opencode.jsonc"), JSON.stringify({
        mcp: {
          valid: { type: "remote", url: "https://valid.example/mcp" },
          invalid: null,
        },
      }), "utf8");

      const inspection = await inspectMcpLayersFromRuntimeSnapshot(
        root,
        {},
        { globalConfigPath },
      );

      expect(inspection.layerStatus).toEqual({ project: "invalid", global: "missing" });
      expect(inspection.items.map((item) => item.name)).toEqual(["valid"]);
      expect(inspection.collisions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("marks non-regular and oversized static layers unreadable without dropping runtime entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-passive-mcp-bounded-"));
    const globalConfigPath = join(root, "global-opencode.jsonc");
    try {
      await mkdir(join(root, "opencode.jsonc"));
      await writeFile(globalConfigPath, JSON.stringify({
        mcp: {
          oversized: { type: "remote", url: "https://oversized.example/mcp" },
        },
      }), "utf8");

      const inspection = await inspectMcpLayersFromRuntimeSnapshot(root, {
        mcp: {
          runtime: { type: "remote", url: "https://runtime.example/mcp" },
        },
      }, {
        globalConfigPath,
        maxConfigBytes: 32,
        toolPolicy: {
          agentName: "openwork",
          mcpName: "runtime",
          toolIds: ["runtime_search"],
        },
      });

      expect(inspection.layerStatus).toEqual({ project: "unreadable", global: "unreadable" });
      expect(inspection.items.map((item) => `${item.name}:${item.source}`)).toEqual([
        "runtime:config.remote",
      ]);
      expect(inspection.toolPolicy).toMatchObject({
        status: "unavailable",
        deniedToolIds: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("propagates an aborted diagnostics deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-passive-mcp-abort-"));
    try {
      const controller = new AbortController();
      controller.abort(new Error("diagnostics deadline exceeded"));

      await expect(inspectMcpLayersFromRuntimeSnapshot(root, {}, {
        globalConfigPath: join(root, "global-opencode.jsonc"),
        signal: controller.signal,
      })).rejects.toThrow("diagnostics deadline exceeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
