import { describe, expect, test } from "bun:test";

import { buildCommandPaletteSettingsItems } from "../src/react-app/shell/command-palette-settings";

function build(developerMode: boolean, autoUpdate: boolean) {
  return buildCommandPaletteSettingsItems({
    developerMode,
    capabilities: { autoUpdate, localRuntimeControl: true },
    memoryEnabled: true,
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

  test("uses stable ids for tabs and Library sections", () => {
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
      "settings:recovery",
      "settings:cloud-account",
      "settings:memory",
      "settings:extensions/skills",
      "settings:extensions/mcps",
      "settings:extensions/connections",
      "settings:extensions/plugins",
      "settings:extensions/agents",
      "settings:extensions/commands",
    ]);
  });
});
