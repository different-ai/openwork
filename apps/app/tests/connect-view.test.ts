import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import type { OpenworkCloudMcpHealth } from "../src/app/lib/openwork-server";
import { readyCloudMcpToolIds } from "../src/react-app/domains/settings/cloud/agent-access-card";
import {
  formatPluginConnectRowMeta,
  isDesktopInstallableMarketplacePlugin,
  resolveConnectionRowGroup,
  resolveConnectRowGroup,
} from "../src/react-app/domains/settings/connect-cloud-readiness";

const agentAccessSource = readFileSync(
  fileURLToPath(new URL("../src/react-app/domains/settings/cloud/agent-access-card.tsx", import.meta.url)),
  "utf8",
);

function cloudHealth(usable: boolean): OpenworkCloudMcpHealth {
  return {
    schemaVersion: 1,
    phase: usable ? "ready" : "cloud_tools_missing",
    usable,
    usableByCurrentModel: usable,
    connectCatalogEnabled: true,
    workspace: { id: "ws_1", type: "local", directory: "/workspace", path: "/workspace" },
    desired: { present: true, name: "openwork-cloud", revision: "rev", config: null, token: { present: true, metadata: {} } },
    delivery: { state: usable ? "ready" : "pending", desiredRevision: "rev", appliedRevision: usable ? "rev" : null, updatedAt: 1, appliedAt: usable ? 1 : null, lastAttemptAt: 1 },
    engine: { status: usable ? "connected" : "failed" },
    tools: {
      expected: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
      present: usable ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability", "other_tool"] : ["openwork-cloud_search_capabilities"],
      missing: usable ? [] : ["openwork-cloud_execute_capability"],
      providerProjection: { checked: true, present: [], missing: [] },
    },
    pluginCanaries: { expected: [], present: [], missing: [] },
    toolDenies: [],
    firstFailure: usable ? null : { code: "cloud_tools_missing", stage: "tool_ids", retryable: true, recommendedAction: "repair", message: "missing" },
    checkedAt: "2026-07-09T12:00:00.000Z",
  };
}

describe("Agent access card helpers", () => {
  test("returns exact Cloud tools only when health is ready", () => {
    expect(readyCloudMcpToolIds(cloudHealth(false))).toEqual([]);
    expect(readyCloudMcpToolIds(cloudHealth(true))).toEqual([
      "openwork-cloud_search_capabilities",
      "openwork-cloud_execute_capability",
    ]);
  });

  test("retries Agent access through the repair reconciler when connectivity returns", () => {
    expect(agentAccessSource).toContain('window.addEventListener("online", retryAfterReconnect)');
    expect(agentAccessSource).toContain('window.removeEventListener("online", retryAfterReconnect)');
    expect(agentAccessSource).toContain('mode: "repair"');
    expect(agentAccessSource).toContain('trigger: "desktop-connect-online-retry"');
  });
});

describe("Connect cloud-readiness row resolution", () => {
  test("maps plugin readiness states to Connect groups", () => {
    expect(resolveConnectRowGroup({ state: "needs_signin", hasInstructional: false, connections: [] }, "member")).toBe("needs_signin");
    expect(resolveConnectRowGroup({ state: "ready", hasInstructional: true, connections: [] }, "member")).toBe("ready");
    expect(resolveConnectRowGroup({ state: "needs_admin_setup", hasInstructional: false, connections: [] }, "admin")).toBe("needs_admin_setup");
    expect(resolveConnectRowGroup({ state: "needs_admin_setup", hasInstructional: false, connections: [] }, "super-admin")).toBe("needs_admin_setup");
    expect(resolveConnectRowGroup({ state: "needs_admin_setup", hasInstructional: false, connections: [] }, "qa-reviewer, super-admin")).toBe("needs_admin_setup");
    expect(resolveConnectRowGroup({ state: "needs_admin_setup", hasInstructional: false, connections: [] }, "qa-reviewer")).toBe("excluded");
  });

  test("hides admin setup, desktop-only, and not-synced rows from non-admin Connect", () => {
    expect(resolveConnectRowGroup({ state: "needs_admin_setup", hasInstructional: false, connections: [] }, "member")).toBe("excluded");
    expect(resolveConnectRowGroup({ state: "desktop_only", hasInstructional: false, connections: [] }, "owner")).toBe("excluded");
    expect(resolveConnectRowGroup({ state: "not_synced", hasInstructional: false, connections: [] }, "admin")).toBe("excluded");
  });

  test("falls back for old servers without cloudReadiness", () => {
    expect(resolveConnectRowGroup(undefined, "member", { skill: 1 })).toBe("ready");
    expect(resolveConnectRowGroup(undefined, "member", { tool: 1 })).toBe("excluded");
  });

  test("formats row meta for component counts and mixed setup states", () => {
    expect(formatPluginConnectRowMeta({ componentCounts: { skill: 2, command: 1 } })).toBe("2 skills · 1 command");
    expect(formatPluginConnectRowMeta({
      componentCounts: { skill: 1, mcp: 1 },
      cloudReadiness: {
        state: "needs_admin_setup",
        hasInstructional: true,
        connections: [{ id: null, name: "Sales", url: "https://sales.example.test/mcp" }],
      },
    })).toBe("skills ready now · app needs setup · needs Sales");
  });

  test("never groups a connected account with missing features as ready", () => {
    expect(resolveConnectionRowGroup({
      credentialMode: "per_member",
      connectedForMe: true,
      needsReconnect: false,
      missingFeatures: ["gmailDraft"],
    })).toBe("needs_signin");
  });

  test("classifies desktop-only marketplace plugins for Connect exclusion", () => {
    expect(isDesktopInstallableMarketplacePlugin({ componentCounts: {}, cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [] } })).toBe(true);
    expect(isDesktopInstallableMarketplacePlugin({ componentCounts: {}, cloudReadiness: { state: "ready", hasInstructional: true, connections: [] } })).toBe(false);
    expect(isDesktopInstallableMarketplacePlugin({ componentCounts: { tool: 1 } })).toBe(true);
  });
});
