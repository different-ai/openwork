import { describe, expect, test } from "bun:test";

import { ADVANCED_SETTINGS_SECTIONS } from "../src/react-app/domains/settings/advanced-sections";
import { rankPaletteItems } from "../src/react-app/shell/command-palette-search";
import { buildCommandPaletteSettingsItems } from "../src/react-app/shell/command-palette-settings";

function build(developerMode: boolean, autoUpdate: boolean) {
  return buildCommandPaletteSettingsItems({
    developerMode,
    capabilities: { autoUpdate },
    onOpenSettings: () => {},
    onOpenExtensions: () => {},
  });
}

describe("command palette settings", () => {
  test("gates Debug and Updates by their existing settings conditions", () => {
    const regularIds = build(false, false).map((item) => item.id);
    const enabledIds = build(true, true).map((item) => item.id);

    expect(regularIds).not.toContain("settings:debug");
    expect(regularIds).not.toContain("settings:updates");
    expect(enabledIds).toContain("settings:debug");
    expect(enabledIds).toContain("settings:updates");
  });

  test("uses stable ids for tabs, Advanced sections, and Library sections", () => {
    expect(build(false, true).map((item) => item.id)).toEqual([
      "settings:general",
      "settings:preferences",
      "settings:permissions",
      "settings:extensions",
      "settings:advanced",
      "settings:ai",
      "settings:appearance",
      "settings:environment",
      "settings:updates",
      "settings:cloud-account",
      "settings:advanced/organization-server",
      "settings:advanced/runtime",
      "settings:advanced/agent-access",
      "settings:advanced/config-sources",
      "settings:advanced/experimental-engine",
      "settings:advanced/workspace-run-mode",
      "settings:advanced/developer",
      "settings:extensions/skills",
      "settings:extensions/mcps",
      "settings:extensions/connections",
      "settings:extensions/plugins",
      "settings:extensions/agents",
      "settings:extensions/commands",
    ]);
  });

  test("lists every Advanced section in the empty developer-mode palette", () => {
    const groups = rankPaletteItems("", build(true, true), []);
    const settings = groups.find((group) => group.value === "settings");

    expect(settings?.items.map((item) => item.id)).toEqual(expect.arrayContaining(
      ADVANCED_SETTINGS_SECTIONS.map((section) => `settings:advanced/${section.id}`),
    ));
  });

  test("finds recovery tools under Advanced", () => {
    const items = build(false, true);

    expect(items.find((item) => item.id === "settings:advanced")?.keywords).toContain("recovery");
    expect(rankPaletteItems("reset", items, [])[0]?.items.slice(0, 2).map((item) => item.id)).toEqual([
      "settings:advanced/organization-server",
      "settings:advanced",
    ]);
  });
});
