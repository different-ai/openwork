import { describe, expect, test } from "bun:test";
import { MCP_QUICK_CONNECT, getMcpServerName, isBuiltInOpenWorkExtension } from "../src/app/constants";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { createOpenworkServerStore } from "../src/react-app/domains/connections/openwork-server-store";
import { createConnectionsStore } from "../src/react-app/domains/connections/store";
import { createExtensionsStore } from "../src/react-app/domains/settings/state/extensions-store";

import {
  applyRestrictedDesktopPolicy,
  calculateEffectiveDesktopPolicy,
  desktopPolicyDefaults,
  desktopPolicyDefinitions,
  isRestrictedDesktopPolicyValue,
  restrictedDesktopPolicyValue,
  normalizeDesktopPolicyDocument,
  resolveDesktopPolicyDocumentWrite,
} from "@openwork/types/den/desktop-policies";
import {
  SETTINGS_TAB_WITHOUT_CONTROL,
  checkDesktopAppRestriction,
  desktopRestrictionNotice,
  isSettingsTabAllowed,
  type DesktopAppRestrictionChecker,
} from "../src/app/cloud/desktop-app-restrictions";
import { SETTINGS_TAB_VALUES } from "../src/app/types";
import { libraryAddAction } from "../src/react-app/domains/settings/library";

const allowEverything: DesktopAppRestrictionChecker = () => false;
const restrictedChecker: DesktopAppRestrictionChecker = ({ restriction }) =>
  checkDesktopAppRestriction({ config: restrictedDesktopPolicyValue, restriction });

describe("restricted desktop policy mode", () => {
  test("locks every capability and leaves the welcome page preference alone", () => {
    expect(restrictedDesktopPolicyValue).toEqual({
      allowCustomProviders: false,
      allowZenModel: false,
      allowMultipleWorkspaces: false,
      allowControlSettings: false,
      allowManageExtensions: false,
      allowBuiltInExtensions: false,
      allowAlphaUpdates: false,
      showWelcomePage: true,
    });
    expect(
      applyRestrictedDesktopPolicy({ ...desktopPolicyDefaults, showWelcomePage: false }).showWelcomePage,
    ).toBe(false);
  });

  test("every catalog key declares how Restricted treats it", () => {
    for (const definition of desktopPolicyDefinitions) {
      expect([true, false, null]).toContain(definition.restrictedValue);
    }
  });

  test("derives the mode from saved values", () => {
    expect(isRestrictedDesktopPolicyValue(restrictedDesktopPolicyValue)).toBe(true);
    expect(isRestrictedDesktopPolicyValue({ ...restrictedDesktopPolicyValue, showWelcomePage: false })).toBe(true);
    expect(isRestrictedDesktopPolicyValue(desktopPolicyDefaults)).toBe(false);
    expect(isRestrictedDesktopPolicyValue({ ...restrictedDesktopPolicyValue, allowManageExtensions: true })).toBe(false);
  });

  test("a restricted default policy locks members down until an assigned policy grants more", () => {
    const locked = calculateEffectiveDesktopPolicy({
      orgPolicyCount: 1,
      defaultPolicy: restrictedDesktopPolicyValue,
      assignedPolicies: [],
    });
    expect(locked.allowControlSettings).toBe(false);
    expect(locked.allowManageExtensions).toBe(false);
    expect(locked.allowCustomProviders).toBe(false);
    expect(locked.showWelcomePage).toBe(true);

    const unlockedForTeam = calculateEffectiveDesktopPolicy({
      orgPolicyCount: 2,
      defaultPolicy: restrictedDesktopPolicyValue,
      assignedPolicies: [{ allowManageExtensions: true }],
    });
    expect(unlockedForTeam.allowManageExtensions).toBe(true);
    expect(unlockedForTeam.allowControlSettings).toBe(false);

    // Restricted on a targeted policy alone grants nothing extra: effective
    // policy is the union of grants, so the permissive default still wins.
    const restrictedTargetOnly = calculateEffectiveDesktopPolicy({
      orgPolicyCount: 2,
      defaultPolicy: desktopPolicyDefaults,
      assignedPolicies: [restrictedDesktopPolicyValue],
    });
    expect(restrictedTargetOnly.allowControlSettings).toBe(true);
  });
});

describe("allowManageExtensions Library gate", () => {
  test("removes only the local add flows and keeps organization-approved ones", () => {
    const signedInRestricted = { cloudSignedIn: true, allowManageExtensions: false };
    expect(libraryAddAction("workspace-mcp", signedInRestricted)).toBeNull();
    expect(libraryAddAction("mcp", signedInRestricted)).toEqual({ type: "den-modal", kind: "mcp" });
    expect(libraryAddAction("skill", signedInRestricted)).toEqual({ type: "den-modal", kind: "skill" });
    expect(libraryAddAction("workspace-mcp", { cloudSignedIn: true, allowManageExtensions: true })).toEqual({ type: "workspace-mcp" });
  });
});

describe("allowControlSettings settings gate", () => {
  test("leaves every settings tab reachable without a policy", () => {
    for (const tab of SETTINGS_TAB_VALUES) {
      expect(isSettingsTabAllowed({ tab, checkRestriction: allowEverything })).toBe(true);
    }
  });

  test("keeps only the Cloud tabs when the organization blocks settings control", () => {
    const allowed = SETTINGS_TAB_VALUES.filter((tab) =>
      isSettingsTabAllowed({ tab, checkRestriction: restrictedChecker }),
    );
    expect(allowed).toEqual(["cloud-account"]);
    expect(allowed).toContain(SETTINGS_TAB_WITHOUT_CONTROL);
    expect(isSettingsTabAllowed({ tab: "general", checkRestriction: restrictedChecker })).toBe(false);
    expect(isSettingsTabAllowed({ tab: "extensions", checkRestriction: restrictedChecker })).toBe(false);
    expect(isSettingsTabAllowed({ tab: "ai", checkRestriction: restrictedChecker })).toBe(false);
  });

  test("explains blocked capabilities with the catalog notice", () => {
    expect(desktopRestrictionNotice("allowManageExtensions")).toBe(
      "Your organization administrator has disabled local extension management.",
    );
    expect(desktopRestrictionNotice("allowControlSettings")).toBe(
      "Your organization administrator has disabled changing desktop app settings.",
    );
  });
});


describe("explicit team access limits", () => {
  test("a lock wins over all matching grants while preserving display preferences", () => {
    const result = calculateEffectiveDesktopPolicy({
      orgPolicyCount: 3,
      defaultPolicy: desktopPolicyDefaults,
      assignedPolicies: [desktopPolicyDefaults, JSON.stringify({ access: { mode: "locked", capabilities: {} } })],
    });
    expect(result).toEqual(restrictedDesktopPolicyValue);
  });

  test("custom limits block independently and cannot override another team's block", () => {
    const result = calculateEffectiveDesktopPolicy({
      orgPolicyCount: 3,
      defaultPolicy: desktopPolicyDefaults,
      assignedPolicies: [
        { access: { mode: "custom", capabilities: { allowManageExtensions: false } } },
        { access: { mode: "custom", capabilities: { allowManageExtensions: true, allowCustomProviders: false } } },
      ],
    });
    expect(result.allowManageExtensions).toBe(false);
    expect(result.allowCustomProviders).toBe(false);
    expect(result.allowControlSettings).toBe(true);
  });

  test("JSON storage and edits by older callers preserve explicit access limits", () => {
    const access = { mode: "locked", capabilities: { allowManageExtensions: false } };
    const existingPolicy = JSON.stringify({ access });
    expect(normalizeDesktopPolicyDocument(existingPolicy).access).toEqual(access);
    const result = resolveDesktopPolicyDocumentWrite({
      existingPolicy,
      value: { allowCustomProviders: true },
      preserveExistingOnboardingPrompts: true,
    });
    expect(result.access).toEqual(access);
    expect(calculateEffectiveDesktopPolicy({ orgPolicyCount: 2, defaultPolicy: desktopPolicyDefaults, assignedPolicies: [result] }).allowCustomProviders).toBe(false);
  });
});


describe("desktop extension mutation boundaries", () => {
  function fixture() {
    let blocked = false;
    let builtInsBlocked = false;
    let writes = 0;
    const errors: string[] = [];
    const checkDesktopAppRestriction: DesktopAppRestrictionChecker = ({ restriction }) =>
      restriction === "allowBuiltInExtensions" ? builtInsBlocked : blocked;
    const server = createOpenworkServerStore({
      startupPreference: () => "server",
      documentVisible: () => true,
      developerMode: () => false,
      runtimeWorkspaceId: () => "policy-workspace",
      activeClient: () => null,
      selectedWorkspaceDisplay: () => ({
        id: "policy-workspace", name: "Policy", path: "/tmp/policy", preset: "starter", workspaceType: "local",
      }),
      restartLocalServer: async () => false,
      createRemoteWorkspaceFlow: async () => false,
    });
    const recordWrite = async () => {
      writes += 1;
      throw new Error("Mutation boundary reached");
    };
    const client = {
      ...createOpenworkServerClient({ baseUrl: "http://127.0.0.1:1" }),
      addPlugin: recordWrite,
      removePlugin: recordWrite,
      upsertSkill: recordWrite,
      deleteSkill: recordWrite,
      installClaudePlugin: recordWrite,
      removeCloudPlugin: recordWrite,
      addMcp: recordWrite,
      removeMcp: recordWrite,
      setMcpEnabled: recordWrite,
    };
    const getSnapshot: typeof server.getSnapshot = () => ({
      ...server.getSnapshot(), openworkServerStatus: "connected", openworkServerClient: client,
    });
    const options = {
      checkDesktopAppRestriction,
      client: () => null,
      projectDir: () => "/tmp/policy",
      selectedWorkspaceId: () => "policy-workspace",
      selectedWorkspaceRoot: () => "/tmp/policy",
      workspaceType: (): "local" | "remote" => "remote",
      openworkServer: { ...server, getSnapshot },
      runtimeWorkspaceId: () => "policy-workspace",
    };
    const extensions = createExtensionsStore({
      ...options,
      setBusy: () => undefined,
      setBusyLabel: () => undefined,
      setBusyStartedAt: () => undefined,
      setError: (message) => { if (message) errors.push(message); },
    });
    const connections = createConnectionsStore({
      ...options,
      setClient: () => undefined,
      developerMode: () => false,
    });
    return {
      extensions, connections, errors,
      writes: () => writes,
      restrict: (value: boolean) => { blocked = value; },
      restrictBuiltIns: (value: boolean) => { builtInsBlocked = value; },
    };
  }

  test("direct extension handlers refuse local writes and use the current policy", async () => {
    const f = fixture();
    await f.extensions.addPlugin("example-plugin");
    expect(f.writes()).toBe(1);
    f.restrict(true);
    await f.extensions.addPlugin("example-plugin");
    await f.extensions.removePlugin("example-plugin");
    await f.extensions.importLocalSkill();
    await f.extensions.installSkillCreator();
    await f.extensions.uninstallSkill("example-skill");
    await f.extensions.saveSkill({ name: "example-skill", content: "changed" });
    await f.extensions.installClaudePlugin("https://example.com/plugin");
    await f.extensions.removeCloudOrgPlugin("plugin-id");
    await f.extensions.importCloudOrgPlugin(null, {
      id: "plugin-id", name: "Example", description: null, status: "active",
      memberCount: 1, updatedAt: null, componentCounts: {},
    });
    expect(f.writes()).toBe(1);
    expect(f.errors).toEqual(Array(9).fill(desktopRestrictionNotice("allowManageExtensions")));
    f.restrict(false);
    await f.extensions.saveSkill({ name: "example-skill", content: "allowed" });
    expect(f.writes()).toBe(2);
  });

  test("direct MCP mutations are blocked after a live policy change and restored after unlocking", async () => {
    const f = fixture();
    await f.connections.setMcpEnabled("example-mcp", true);
    expect(f.writes()).toBe(1);
    f.restrict(true);
    const result = await f.connections.connectMcp({
      name: "Example", serverName: "example-mcp", description: "", oauth: false,
      type: "remote", url: "https://example.com/mcp",
    });
    await f.connections.removeMcp("example-mcp");
    await f.connections.setMcpEnabled("example-mcp", true);
    expect(result).toEqual({ ok: false, error: desktopRestrictionNotice("allowManageExtensions") });
    expect(f.connections.getSnapshot().mcpStatus).toBe(desktopRestrictionNotice("allowManageExtensions"));
    expect(f.writes()).toBe(1);
    f.restrict(false);
    await f.connections.removeMcp("example-mcp");
    expect(f.writes()).toBe(2);
  });

  test("existing MCP sign-in remains available while local installation is blocked", async () => {
    const f = fixture();
    f.restrict(true);
    await f.connections.authorizeMcp({
      name: "approved-mcp", config: { type: "remote", url: "https://example.com/mcp", oauth: {} },
    });
    expect(f.connections.getSnapshot().mcpAuthModalOpen).toBe(true);
    expect(f.connections.getSnapshot().mcpAuthEntry?.url).toBe("https://example.com/mcp");
    expect(f.writes()).toBe(0);
  });

  test("built-in configuration obeys its own permission while custom installation is blocked", async () => {
    const f = fixture();
    const builtIn = MCP_QUICK_CONNECT.find(isBuiltInOpenWorkExtension);
    if (!builtIn) throw new Error("Expected a built-in MCP in the catalog");
    f.restrict(true);
    await f.connections.setMcpEnabled(getMcpServerName(builtIn), true);
    expect(f.writes()).toBe(1);
    const forged = await f.connections.connectMcp({
      ...builtIn, name: "Forged built-in", serverName: "custom-mcp", url: "https://example.com/mcp",
    });
    expect(forged).toEqual({ ok: false, error: desktopRestrictionNotice("allowManageExtensions") });
    f.restrictBuiltIns(true);
    const result = await f.connections.connectMcp(builtIn);
    await f.connections.removeMcp(getMcpServerName(builtIn));
    await f.connections.setMcpEnabled(getMcpServerName(builtIn), true);
    expect(result).toEqual({ ok: false, error: desktopRestrictionNotice("allowBuiltInExtensions") });
    expect(f.writes()).toBe(1);
  });
});
