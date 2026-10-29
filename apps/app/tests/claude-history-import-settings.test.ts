import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { getGlobalSettingsTabs, getWorkspaceSettingsTabs } = await import("../src/react-app/domains/settings/shell/settings-page");
const { buildCommandPaletteSettingsItems } = await import("../src/react-app/shell/command-palette-settings");

afterAll(async () => {
  if (ownedDom) await GlobalRegistrator.unregister();
});

test("workspace settings always offer Import without a feature lookup", () => {
  expect(getWorkspaceSettingsTabs()).toEqual(["preferences", "permissions", "extensions", "import", "advanced"]);
});

test("graduating Import keeps Computer use settings opt-in", () => {
  expect(getGlobalSettingsTabs(false, { autoUpdate: false })).not.toContain("computer");
  expect(getGlobalSettingsTabs(false, { autoUpdate: false }, { computerUse: false })).not.toContain("computer");
  expect(getGlobalSettingsTabs(false, { autoUpdate: false }, { computerUse: true })).toContain("computer");
});

test("the settings command palette offers the same Import destination", () => {
  const items = buildCommandPaletteSettingsItems({
    developerMode: false,
    capabilities: { autoUpdate: false },
    onOpenSettings: () => {},
    onOpenExtensions: () => {},
  });
  expect(items.some((item) => item.id === "settings:import")).toBe(true);
});
