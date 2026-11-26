import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { getSettingsNavGroups } = await import("../src/react-app/domains/settings/shell/settings-page");
const { buildCommandPaletteSettingsItems } = await import("../src/react-app/shell/command-palette-settings");

afterEach(() => {
  Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
});

afterAll(async () => {
  if (ownedDom) await GlobalRegistrator.unregister();
});

function paletteSettingsIds() {
  return buildCommandPaletteSettingsItems({
    developerMode: false,
    capabilities: { autoUpdate: false },
    onOpenSettings: () => {},
    onOpenExtensions: () => {},
  }).map((item) => item.id);
}

test("on desktop, Cmd+K offers every settings page the sidebar shows, including Computer use", () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const nav = getSettingsNavGroups({ developerMode: false, capabilities: { autoUpdate: false }, checkRestriction: () => false });
  const ids = paletteSettingsIds();
  for (const tab of [...nav.hub, ...nav.workspace, ...nav.global, ...nav.cloud]) {
    expect(ids).toContain(`settings:${tab}`);
  }
  expect(ids).toContain("settings:computer");
  expect(ids).toContain("settings:devices");
});

test("in a browser, Cmd+K leaves out Computer use like the sidebar does", () => {
  expect(paletteSettingsIds()).not.toContain("settings:computer");
});
