import { describe, expect, test } from "bun:test";

import { parseSettingsPath } from "../src/react-app/shell/settings-route";
import {
  getWorkspaceSettingsTabs,
  isSettingsTabActive,
} from "../src/react-app/domains/settings/shell/settings-page";

describe("settings route parsing", () => {
  test("selects the Extensions destination for direct workspace navigation and reloads", () => {
    const pathname = "/workspace/workspace_1/settings/extensions";
    const route = parseSettingsPath(pathname);

    expect(route).toEqual({ tab: "extensions", redirectPath: null, extensionsSection: "all" });
    expect(parseSettingsPath(pathname)).toEqual(route);
    expect(isSettingsTabActive(route.tab, "extensions")).toBe(true);
    expect(isSettingsTabActive(route.tab, "general")).toBe(false);
    expect(getWorkspaceSettingsTabs()).toEqual(["preferences", "permissions", "extensions", "advanced"]);
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
