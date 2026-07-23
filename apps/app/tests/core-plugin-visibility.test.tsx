import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PluginsView,
  type PluginsExtensionsStore,
} from "../src/react-app/domains/settings/pages/plugins-view";
import {
  toProjectPluginListEntries,
  type PluginListEntry,
} from "../src/react-app/domains/settings/state/extensions-store";

const corePlugin: PluginListEntry = {
  name: "opencode-chrome-devtools",
  source: "core",
  removable: false,
};

function extensionsWithPlugins(pluginList: PluginListEntry[]): PluginsExtensionsStore {
  return {
    pluginScope: "project",
    setPluginScope: () => undefined,
    refreshPlugins: () => undefined,
    pluginConfigPath: () => "opencode.json (openwork server)",
    pluginConfig: () => null,
    pluginList: () => pluginList,
    pluginInput: () => "",
    setPluginInput: () => undefined,
    pluginStatus: () => null,
    addPlugin: () => undefined,
    removePlugin: () => undefined,
    isPluginInstalledByName: () => false,
    activePluginGuide: () => null,
    setActivePluginGuide: () => undefined,
  };
}

describe("OpenWork core plugin visibility", () => {
  test("projects core API entries as non-removable and preserves core ownership on duplicates", () => {
    const projected = toProjectPluginListEntries([
      { spec: corePlugin.name, source: "config" },
      { spec: corePlugin.name, source: "core" },
      { spec: "runtime-plugin", source: "config" },
    ]);

    expect(projected).toEqual([
      corePlugin,
      { name: "runtime-plugin", source: "config", removable: true },
    ]);
  });

  test("renders core ownership without offering a remove action", () => {
    const html = renderToStaticMarkup(
      <PluginsView
        extensions={extensionsWithPlugins([corePlugin])}
        busy={false}
        selectedWorkspaceRoot="/workspace"
        canEditPlugins
        canUseGlobalScope
        suggestedPlugins={[]}
      />,
    );

    expect(html).toContain(corePlugin.name);
    expect(html).toContain("Managed by OpenWork.");
    expect(html).not.toContain(">Remove</button>");
  });
});
