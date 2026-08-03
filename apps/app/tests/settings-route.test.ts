import { describe, expect, test } from "bun:test";

import {
  extensionsPathForRoute,
  parseExtensionsPath,
  parseSettingsPath,
  settingsPathForRoute,
} from "../src/react-app/shell/settings-route";
import {
  getSettingsTabLabel,
  getWorkspaceSettingsTabs,
  isSettingsTabActive,
} from "../src/react-app/domains/settings/shell/settings-page";

describe("settings route parsing", () => {
  test("parses the first-class Extensions route for direct workspace navigation and reloads", () => {
    const pathname = "/workspace/workspace_1/extensions";
    const route = parseExtensionsPath(pathname);

    expect(route).toEqual({ tab: "extensions", redirectPath: null, extensionsSection: "all" });
    expect(parseExtensionsPath(pathname)).toEqual(route);
    expect(isSettingsTabActive(route.tab, "extensions")).toBe(true);
    expect(isSettingsTabActive(route.tab, "general")).toBe(false);
  });

  test("preserves top-level Extensions section and detail deep links", () => {
    expect(parseExtensionsPath("/extensions/apps")).toEqual({ tab: "extensions", redirectPath: null, extensionsSection: "apps" });
    expect(parseExtensionsPath("/workspace/workspace_1/extensions/mcps")).toEqual({ tab: "extensions", redirectPath: null, extensionsSection: "mcps" });
    expect(parseExtensionsPath("/workspace/workspace_1/extensions/skill%3Abriefing")).toEqual({
      tab: "extensions",
      redirectPath: null,
      extensionsSection: "all",
      extensionDetailId: "skill:briefing",
    });
  });

  test("redirects Connect settings into Extensions", () => {
    expect(parseSettingsPath("/settings/connect")).toEqual({
      tab: "extensions",
      redirectPath: "extensions",
      extensionsSection: "all",
    });
    expect(parseSettingsPath("/workspace/workspace_1/settings/connect")).toEqual({
      tab: "extensions",
      redirectPath: "extensions",
      extensionsSection: "all",
    });
  });

  test("preserves extension section deep links", () => {
    expect(parseSettingsPath("/settings/extensions/apps")).toEqual({ tab: "extensions", redirectPath: null, extensionsSection: "apps" });
    expect(parseSettingsPath("/settings/extensions/connections")).toEqual({ tab: "extensions", redirectPath: null, extensionsSection: "connections" });
    expect(parseSettingsPath("/settings/extensions/mcps")).toEqual({ tab: "extensions", redirectPath: null, extensionsSection: "mcps" });
    expect(parseSettingsPath("/settings/extensions/skills")).toEqual({ tab: "extensions", redirectPath: null, extensionsSection: "skills" });
    expect(parseSettingsPath("/settings/extensions/plugins")).toEqual({ tab: "extensions", redirectPath: null, extensionsSection: "plugins" });
  });

  test("round-trips Library state sections through settings and first-class route writers", () => {
    const sections: Array<"needs-sign-in" | "needs-admin-setup"> = ["needs-sign-in", "needs-admin-setup"];
    for (const section of sections) {
      const settingsRoute = parseSettingsPath(`/settings/extensions/${section}`);
      expect(settingsRoute).toEqual({ tab: "extensions", redirectPath: null, extensionsSection: section });
      expect(settingsPathForRoute(settingsRoute)).toBe(`extensions/${section}`);
      expect(parseSettingsPath(`/settings/${settingsPathForRoute(settingsRoute)}`)).toEqual(settingsRoute);

      const extensionsRoute = parseExtensionsPath(`/extensions/${section}`);
      expect(extensionsPathForRoute(extensionsRoute)).toBe(section);
      expect(parseExtensionsPath(`/extensions/${extensionsPathForRoute(extensionsRoute)}`)).toEqual(extensionsRoute);
    }
  });

  test("redirects the old mcp section to the MCPs filter", () => {
    expect(parseSettingsPath("/settings/extensions/mcp")).toEqual({
      tab: "extensions",
      redirectPath: "extensions/mcps",
      extensionsSection: "mcps",
    });
    expect(parseSettingsPath("/settings/mcp")).toEqual({
      tab: "extensions",
      redirectPath: "extensions/mcps",
      extensionsSection: "mcps",
    });
  });

  test("treats non-section extension tails as detail ids", () => {
    expect(parseSettingsPath("/settings/extensions/notion")).toEqual({
      tab: "extensions",
      redirectPath: null,
      extensionsSection: "all",
      extensionDetailId: "notion",
    });
    expect(parseSettingsPath("/settings/extensions/skill%3Abriefing")).toEqual({
      tab: "extensions",
      redirectPath: null,
      extensionsSection: "all",
      extensionDetailId: "skill:briefing",
    });
  });
});

describe("settings navigation", () => {
  test("includes Library in workspace settings", () => {
    expect(getWorkspaceSettingsTabs()).toEqual(["preferences", "permissions", "extensions", "advanced"]);
    expect(getSettingsTabLabel("extensions")).toBe("Library");
  });
});
