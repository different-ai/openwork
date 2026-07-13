import { describe, expect, test } from "bun:test";

import { resolveConnectViewState } from "../src/react-app/domains/settings/pages/connect-view";
import {
  formatPluginConnectRowMeta,
  isDesktopInstallableMarketplacePlugin,
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

  test("filters Extensions marketplace rows to desktop-installable plugins in Connect mode", () => {
    expect(isDesktopInstallableMarketplacePlugin({ componentCounts: {}, cloudReadiness: { state: "desktop_only", hasInstructional: false, connections: [] } })).toBe(true);
    expect(isDesktopInstallableMarketplacePlugin({ componentCounts: {}, cloudReadiness: { state: "ready", hasInstructional: true, connections: [] } })).toBe(false);
    expect(isDesktopInstallableMarketplacePlugin({ componentCounts: { tool: 1 } })).toBe(true);
  });
});
