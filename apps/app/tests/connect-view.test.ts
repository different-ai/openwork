import { describe, expect, test } from "bun:test";

import type { OpenworkCloudMcpHealth } from "../src/app/lib/openwork-server";
import {
  createOpaqueDiagnosticsScopeKey,
  readDiagnosticsValueForScope,
  readyCloudMcpToolIds,
  resolveConnectViewState,
} from "../src/react-app/domains/settings/pages/connect-view";
import {
  formatPluginConnectRowMeta,
  isDesktopInstallableMarketplacePlugin,
  resolveConnectionRowGroup,
  resolveConnectRowGroup,
} from "../src/react-app/domains/settings/connect-cloud-readiness";

describe("resolveConnectViewState", () => {
  test("shows loading while auth is being checked", () => {
    expect(resolveConnectViewState({ authStatus: "checking", connectionsCount: 0 })).toBe("loading");
  });

  test("signed-out users see the sign-in state", () => {
    expect(resolveConnectViewState({ authStatus: "signed_out", connectionsCount: 0 })).toBe("signin");
  });

  test("a temporary Cloud outage does not replace Connect with sign-in", () => {
    expect(resolveConnectViewState({ authStatus: "unavailable", connectionsCount: 1 })).toBe("active");
  });

  test("signed-in users with the org Connect flag see active", () => {
    expect(resolveConnectViewState({ authStatus: "signed_in", connectEnabled: true, connectionsCount: 0 })).toBe("active");
  });

  test("signed-in users with usable org connections see active even without the flag", () => {
    expect(resolveConnectViewState({ authStatus: "signed_in", connectEnabled: false, connectionsCount: 1 })).toBe("active");
  });

  test("signed-in users with no flag and no connections see the pitch", () => {
    expect(resolveConnectViewState({ authStatus: "signed_in", connectEnabled: false, connectionsCount: 0 })).toBe("pitch");
    expect(resolveConnectViewState({ authStatus: "signed_in", connectionsCount: 0 })).toBe("pitch");
  });

  test("signed-in users with an active org keep the Agent access card visible without catalog rollout", () => {
    expect(resolveConnectViewState({ authStatus: "signed_in", connectEnabled: false, connectionsCount: 0, activeOrgSelected: true })).toBe("active");
  });
});

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
});

describe("Connect diagnostics scope", () => {
  test("a report from an old workspace or organization cannot render or copy", () => {
    const originalIdentity = { workspace: "workspace_a", organization: "org_a" };
    const originalScope = { key: originalIdentity, generation: 0 };
    const storedReport = { scope: originalScope, value: "report-from-org-a" };

    expect(readDiagnosticsValueForScope(storedReport, {
      key: { workspace: "workspace_a", organization: "org_b" },
      generation: 1,
    })).toBeNull();
    expect(readDiagnosticsValueForScope(storedReport, {
      key: { workspace: "workspace_a", organization: "org_a" },
      generation: 2,
    })).toBeNull();
    // A credential or signed-in-principal change creates a new opaque scope
    // identity even when every public route field remains the same.
    expect(readDiagnosticsValueForScope(storedReport, {
      key: { workspace: "workspace_a", organization: "org_a" },
      generation: 0,
    })).toBeNull();
    expect(readDiagnosticsValueForScope(storedReport, originalScope)).toBe("report-from-org-a");
  });

  test("credential and principal changes create opaque invalidation keys without retaining secrets", () => {
    const client = {};
    const commonSignals = {
      client,
      workspaceId: "workspace_a",
      workspaceType: "local",
      denBaseUrl: "https://api.example.test",
      denSignedIn: true,
      organizationId: "org_a",
    };
    const credentialAKey = createOpaqueDiagnosticsScopeKey({
      ...commonSignals,
      workspaceCredential: "workspace-secret-a",
      denCredential: "den-secret-a",
      principalId: "user_a",
    });
    const credentialBKey = createOpaqueDiagnosticsScopeKey({
      ...commonSignals,
      workspaceCredential: "workspace-secret-b",
      denCredential: "den-secret-b",
      principalId: "user_a",
    });
    const principalBKey = createOpaqueDiagnosticsScopeKey({
      ...commonSignals,
      workspaceCredential: "workspace-secret-b",
      denCredential: "den-secret-b",
      principalId: "user_b",
    });
    const storedReport = {
      scope: { key: credentialAKey, generation: 0 },
      value: "credential-a-report",
    };

    expect(readDiagnosticsValueForScope(storedReport, {
      key: credentialBKey,
      generation: 1,
    })).toBeNull();
    expect(readDiagnosticsValueForScope(storedReport, {
      key: principalBKey,
      generation: 2,
    })).toBeNull();
    expect(Object.keys(credentialAKey)).toEqual([]);
    const serializedKeys = JSON.stringify([credentialAKey, credentialBKey, principalBKey]);
    expect(serializedKeys).toBe("[{},{},{}]");
    expect(serializedKeys).not.toContain("workspace-secret");
    expect(serializedKeys).not.toContain("den-secret");
    expect(serializedKeys).not.toContain("user_a");
  });
});

describe("Connect cloud-readiness row resolution", () => {
  test("maps plugin readiness states to Connect groups", () => {
    expect(resolveConnectRowGroup({ state: "needs_signin", hasInstructional: false, connections: [] }, "member")).toBe("needs_signin");
    expect(resolveConnectRowGroup({ state: "ready", hasInstructional: true, connections: [] }, "member")).toBe("ready");
    expect(resolveConnectRowGroup({ state: "needs_admin_setup", hasInstructional: false, connections: [] }, "admin")).toBe("needs_admin_setup");
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

  test("filters Extensions marketplace rows to desktop-installable plugins in Connect mode", () => {
    expect(isDesktopInstallableMarketplacePlugin({ componentCounts: {}, cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [] } })).toBe(true);
    expect(isDesktopInstallableMarketplacePlugin({ componentCounts: {}, cloudReadiness: { state: "ready", hasInstructional: true, connections: [] } })).toBe(false);
    expect(isDesktopInstallableMarketplacePlugin({ componentCounts: { tool: 1 } })).toBe(true);
  });
});
