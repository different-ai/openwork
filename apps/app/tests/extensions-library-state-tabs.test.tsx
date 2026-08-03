import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ExtensionsView } from "../src/react-app/domains/settings/pages/extensions-view";
import type { PluginsExtensionsStore } from "../src/react-app/domains/settings/pages/plugins-view";
import type { ExtensionInventoryGroup } from "../src/react-app/domains/settings/extension-items";
import {
  countInventoryCardGroups,
  ExtensionStateTabs,
  filterInventoryCardsByState,
} from "../src/react-app/domains/settings/pages/mcp-view";

const extensions: PluginsExtensionsStore = {
  pluginScope: "project",
  setPluginScope: () => {},
  refreshPlugins: () => {},
  pluginConfigPath: () => null,
  pluginConfig: () => null,
  pluginList: () => [],
  pluginInput: () => "",
  setPluginInput: () => {},
  pluginStatus: () => null,
  addPlugin: () => {},
  removePlugin: () => {},
  isPluginInstalledByName: () => false,
  activePluginGuide: () => null,
  setActivePluginGuide: () => {},
};

describe("Library state tabs", () => {
  test("renders the Ready to use count without a connected-app chip", () => {
    const counts = countInventoryCardGroups([
      "ready",
      "needs_signin",
      "ready",
      "needs_admin_setup",
      "ready",
    ]);
    const html = renderToStaticMarkup(
      <ExtensionsView
        busy={false}
        selectedWorkspaceRoot="/workspace"
        isRemoteWorkspace={false}
        canEditPlugins
        canUseGlobalScope
        suggestedPlugins={[]}
        extensions={extensions}
        onRefresh={() => {}}
        mcpView={() => (
          <ExtensionStateTabs
            state="all"
            needsSigninCount={counts.needs_signin}
            needsAdminSetupCount={counts.needs_admin_setup}
            readyCount={counts.ready}
            onChange={() => {}}
          />
        )}
      />,
    );

    expect(html).toContain("Skills, connections, and tools your agent can use.");
    expect(html).toContain("Ready to use");
    expect(html).toContain(">3</span>");
    expect(html.toLowerCase()).not.toContain("app connected");
    expect(html.toLowerCase()).not.toContain("apps connected");
  });

  test("selecting Ready filters the assembled cards to ready rows", () => {
    const cards: Array<{ name: string; group: ExtensionInventoryGroup }> = [
      { name: "Local skill", group: "ready" },
      { name: "Calendar", group: "needs_signin" },
      { name: "Installed plugin", group: "ready" },
    ];

    expect(filterInventoryCardsByState(cards, "ready")).toEqual([
      cards[0],
      cards[2],
    ]);
  });
});
