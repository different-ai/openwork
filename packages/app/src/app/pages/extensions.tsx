import { Show, createEffect, createMemo, createSignal, on } from "solid-js";

import { Box, Cpu } from "lucide-solid";

import Button from "../components/button";
import McpView, { type McpViewProps } from "./mcp";
import PluginsView, { type PluginsViewProps } from "./plugins";

export type ExtensionsSection = "all" | "mcp" | "plugins";

export type ExtensionsViewProps = McpViewProps &
  PluginsViewProps & {
    refreshMcpServers: () => void;
    initialSection?: ExtensionsSection;
    setDashboardTab?: (tab: "mcp" | "plugins") => void;
  };

export default function ExtensionsView(props: ExtensionsViewProps) {
  const [section, setSection] = createSignal<ExtensionsSection>(props.initialSection ?? "all");

  createEffect(
    on(
      () => props.initialSection,
      (nextSection, previousSection) => {
        if (!nextSection || nextSection === previousSection) return;
        setSection(nextSection);
      },
    ),
  );

  const connectedAppsCount = createMemo(() =>
    props.mcpServers.filter((entry) => {
      if (entry.config.enabled === false) return false;
      const status = props.mcpStatuses[entry.name];
      return status?.status === "connected";
    }).length,
  );

  const pluginCount = createMemo(() => props.pluginList.length);

  const refreshAll = () => {
    props.refreshMcpServers();
    props.refreshPlugins();
  };

  const selectSection = (nextSection: ExtensionsSection) => {
    setSection(nextSection);
    if (nextSection === "mcp" || nextSection === "plugins") {
      props.setDashboardTab?.(nextSection);
    }
  };

  const pillClass = (active: boolean) =>
    `px-3 py-1 rounded-full text-xs font-medium border transition-colors flex items-center gap-2 ${
      active ? "bg-gray-12/10 text-gray-12 border-gray-6/20" : "text-gray-10 border-gray-6 hover:text-gray-12"
    }`;

  return (
    <section class="space-y-6 animate-in fade-in duration-300">
      <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div class="space-y-1">
          <h2 class="text-3xl font-bold text-dls-text">Extensions</h2>
          <p class="text-sm text-dls-secondary mt-1.5">
            Apps (MCP) and OpenCode plugins live in one place.
          </p>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <Show when={connectedAppsCount() > 0}>
              <div class="inline-flex items-center gap-2 rounded-full bg-green-3 px-3 py-1">
                <div class="w-2 h-2 rounded-full bg-green-9" />
                <span class="text-xs font-medium text-green-11">
                  {connectedAppsCount()} app{connectedAppsCount() === 1 ? "" : "s"} connected
                </span>
              </div>
            </Show>
            <Show when={pluginCount() > 0}>
              <div class="inline-flex items-center gap-2 rounded-full bg-gray-3 px-3 py-1">
                <Cpu size={14} class="text-gray-11" />
                <span class="text-xs font-medium text-gray-11">
                  {pluginCount()} plugin{pluginCount() === 1 ? "" : "s"}
                </span>
              </div>
            </Show>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class={pillClass(section() === "all")}
              aria-pressed={section() === "all"}
              onClick={() => selectSection("all")}
            >
              All
            </button>
            <button
              type="button"
              class={pillClass(section() === "mcp")}
              aria-pressed={section() === "mcp"}
              onClick={() => selectSection("mcp")}
            >
              <Box size={14} />
              Apps
            </button>
            <button
              type="button"
              class={pillClass(section() === "plugins")}
              aria-pressed={section() === "plugins"}
              onClick={() => selectSection("plugins")}
            >
              <Cpu size={14} />
              Plugins
            </button>
          </div>
          <Button variant="ghost" onClick={refreshAll}>
            Refresh
          </Button>
        </div>
      </div>

      <Show when={section() === "all" || section() === "mcp"}>
        <div class="space-y-4">
          <div class="flex items-center gap-2 text-sm font-medium text-gray-12">
            <Box size={16} class="text-gray-11" />
            <span>Apps (MCP)</span>
          </div>
          <McpView
            showHeader={false}
            busy={props.busy}
            activeWorkspaceRoot={props.activeWorkspaceRoot}
            mcpServers={props.mcpServers}
            mcpStatus={props.mcpStatus}
            mcpLastUpdatedAt={props.mcpLastUpdatedAt}
            mcpStatuses={props.mcpStatuses}
            mcpConnectingName={props.mcpConnectingName}
            selectedMcp={props.selectedMcp}
            setSelectedMcp={props.setSelectedMcp}
            quickConnect={props.quickConnect}
            connectMcp={props.connectMcp}
            logoutMcpAuth={props.logoutMcpAuth}
            removeMcp={props.removeMcp}
            showMcpReloadBanner={props.showMcpReloadBanner}
            reloadBlocked={props.reloadBlocked}
            reloadMcpEngine={props.reloadMcpEngine}
          />
        </div>
      </Show>

      <Show when={section() === "all" || section() === "plugins"}>
        <div class="space-y-4">
          <div class="flex items-center gap-2 text-sm font-medium text-gray-12">
            <Cpu size={16} class="text-gray-11" />
            <span>Plugins (OpenCode)</span>
          </div>
          <PluginsView
            busy={props.busy}
            activeWorkspaceRoot={props.activeWorkspaceRoot}
            canEditPlugins={props.canEditPlugins}
            canUseGlobalScope={props.canUseGlobalScope}
            accessHint={props.accessHint}
            pluginScope={props.pluginScope}
            setPluginScope={props.setPluginScope}
            pluginConfigPath={props.pluginConfigPath}
            pluginList={props.pluginList}
            pluginInput={props.pluginInput}
            setPluginInput={props.setPluginInput}
            pluginStatus={props.pluginStatus}
            activePluginGuide={props.activePluginGuide}
            setActivePluginGuide={props.setActivePluginGuide}
            isPluginInstalled={props.isPluginInstalled}
            suggestedPlugins={props.suggestedPlugins}
            refreshPlugins={props.refreshPlugins}
            addPlugin={props.addPlugin}
          />
        </div>
      </Show>
    </section>
  );
}
