import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { buildCommandPaletteSettingsItems } = await import("../src/react-app/shell/command-palette-settings");
const { rankPaletteItems } = await import("../src/react-app/shell/command-palette-search");
const { getSettingsSearchEntries } = await import("../src/react-app/domains/settings/settings-search-index");
const { isSettingAnchor } = await import("../src/react-app/domains/settings/settings-anchor");
const { parseSettingsPath, settingsPathForRoute } = await import("../src/react-app/shell/settings-route");

afterAll(async () => {
  if (ownedDom) await GlobalRegistrator.unregister();
});

type Os = "macos" | "windows" | "linux";

function settingsItems(os: Os | undefined, opened: string[] = []) {
  return buildCommandPaletteSettingsItems({
    developerMode: false,
    capabilities: { autoUpdate: true },
    os,
    onOpenSettings: (route) => opened.push(route),
    onOpenExtensions: () => {},
  });
}

function search(query: string, os: Os | undefined = "macos") {
  return rankPaletteItems(query, settingsItems(os), []).flatMap((group) => group.items.map((item) => item.id));
}

test("the name of one setting finds that setting and opens the page at it", () => {
  const opened: string[] = [];
  const [first, ...rest] = rankPaletteItems("show workspace run mode", settingsItems("macos", opened), [])
    .flatMap((group) => group.items);
  expect(first?.id).toBe("settings:advanced/show-workspace-run-mode");
  expect(first?.breadcrumb).toBe("Settings › Advanced › Workspace run mode");
  expect(rest).toEqual([]);
  first?.action();
  expect(opened).toEqual(["/settings/advanced/show-workspace-run-mode"]);
});

test("a menu path copied from a chat finds the setting it names", () => {
  expect(search("Settings → Advanced → Workspace run mode → Show workspace run mode"))
    .toEqual(["settings:advanced/show-workspace-run-mode"]);
  expect(search("Settings > Preferences > Keep awake")).toEqual(["settings:preferences/keep-awake"]);
});

test("settings inside a page are found by their own words", () => {
  const expected: Array<[query: string, id: string]> = [
    ["keep awake", "settings:preferences/keep-awake"],
    ["notifications", "settings:preferences/desktop-notifications"],
    ["enter sends", "settings:preferences/follow-up"],
    ["open links in", "settings:preferences/open-links-in"],
    ["telemetry", "settings:preferences/usage-data"],
    ["language", "settings:appearance/language"],
    ["titlebar", "settings:appearance/hide-titlebar"],
    ["release channel", "settings:updates/release-channel"],
    ["download automatically", "settings:updates/download-automatically"],
    ["chat engine", "settings:advanced/chat-engine"],
  ];
  for (const [query, id] of expected) expect([query, search(query)[0]]).toEqual([query, id]);
});

test("a real match is not buried under items that only share scattered letters", () => {
  expect(search("sleep")).toEqual(["settings:preferences/keep-awake"]);
  expect(search("devices")).toEqual(["settings:devices"]);
  expect(search("alpha")).toEqual(["settings:updates/release-channel"]);
});

test("a typo still finds the nearest setting", () => {
  expect(search("wokspace run mode")[0]).toBe("settings:advanced/workspace-run-mode");
  expect(search("notifcations")[0]).toBe("settings:preferences/desktop-notifications");
});

test("search lists the same pages as the settings sidebar", () => {
  const desktop = settingsItems("macos").map((item) => item.id);
  const web = settingsItems(undefined).map((item) => item.id);
  expect(desktop).toContain("settings:computer");
  expect(desktop).toContain("settings:devices");
  expect(web).not.toContain("settings:computer");
  expect(web).toContain("settings:devices");
  expect(search("computer use")[0]).toBe("settings:computer");
});

test("a setting is offered only where its page shows it", () => {
  const ids = (os: Os | undefined) => settingsItems(os).map((item) => item.id);
  expect(ids(undefined)).not.toContain("settings:preferences/keep-awake");
  expect(ids("windows")).toContain("settings:preferences/keep-awake");
  expect(ids("macos")).not.toContain("settings:appearance/menu-bar");
  expect(ids("linux")).toContain("settings:appearance/menu-bar");
  expect(ids("windows")).not.toContain("settings:updates/release-channel");
  expect(ids("macos")).toContain("settings:updates/release-channel");
  const withoutUpdates = buildCommandPaletteSettingsItems({
    developerMode: false,
    capabilities: { autoUpdate: false },
    os: "macos",
    onOpenSettings: () => {},
    onOpenExtensions: () => {},
  }).map((item) => item.id);
  expect(withoutUpdates).not.toContain("settings:updates/check-automatically");
});

test("the empty palette still previews pages, not settings inside them", () => {
  const preview = rankPaletteItems("", settingsItems("macos"), [])
    .flatMap((group) => group.items.map((item) => item.id));
  expect(preview.length).toBeGreaterThan(0);
  expect(preview.filter((id) => /^settings:[a-z-]+\/[a-z-]+$/.test(id) && !id.startsWith("settings:advanced/") && !id.startsWith("settings:extensions/"))).toEqual([]);
});

test("a settings link keeps the setting it names when the workspace is added to the path", () => {
  const route = parseSettingsPath("/settings/preferences/keep-awake");
  expect([route.tab, route.anchor]).toEqual(["preferences", "keep-awake"]);
  expect(settingsPathForRoute(route)).toBe("preferences/keep-awake");

  const advanced = parseSettingsPath("/workspace/w1/settings/advanced/show-workspace-run-mode");
  expect(advanced.anchor).toBe("show-workspace-run-mode");
  expect(settingsPathForRoute(advanced)).toBe("advanced/show-workspace-run-mode");

  expect(parseSettingsPath("/settings/preferences/Not%20a%20setting").anchor).toBeUndefined();
  expect(settingsPathForRoute(parseSettingsPath("/settings/preferences"))).toBe("preferences");
});

function settingsSources(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return settingsSources(path);
      return entry.name.endsWith(".tsx") ? readFileSync(path, "utf8") : "";
    })
    .join("\n");
}

test("every indexed setting has its anchor on a settings page", () => {
  const source = settingsSources(join(import.meta.dir, "../src/react-app/domains/settings"));
  const entries = getSettingsSearchEntries();
  const missing = entries.filter((entry) => !isSettingAnchor(entry.anchor) || !source.includes(`anchor="${entry.anchor}"`));
  expect(missing.map((entry) => `${entry.tab}/${entry.anchor}`)).toEqual([]);
  const keys = entries.map((entry) => `${entry.tab}/${entry.anchor}`);
  expect(new Set(keys).size).toBe(keys.length);
});
