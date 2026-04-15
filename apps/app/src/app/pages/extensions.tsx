import { Show, createEffect, createMemo, createSignal, on } from "solid-js";

import { Box, Cpu } from "lucide-solid";

import Button from "../components/button";
import McpView from "../connections/mcp-view";
import { useConnections } from "../connections/provider";
import { useExtensions } from "../extensions/provider";
import PluginsView, { type PluginsViewProps } from "./plugins";
import { t } from "../../i18n";

export type ExtensionsSection = "all" | "mcp" | "plugins";

export type ExtensionsViewProps = PluginsViewProps & {
  isRemoteWorkspace: boolean;
  initialSection?: ExtensionsSection;
  setSectionRoute?: (tab: "mcp" | "plugins") => void;
  showHeader?: boolean;
};

export default function ExtensionsView(props: ExtensionsViewProps) {
  const connections = useConnections();
  const extensions = useExtensions();
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
    connections.mcpServers().filter((entry) => {
      if (entry.config.enabled === false) return false;
      const status = connections.mcpStatuses()[entry.name];
      return status?.status === "connected";
    }).length,
  );

  const pluginCount = createMemo(() => extensions.pluginList().length);

  const refreshAll = () => {
    void connections.refreshMcpServers();
    void extensions.refreshPlugins();
  };

  const selectSection = (nextSection: ExtensionsSection) => {
    setSection(nextSection);
    if (nextSection === "mcp" || nextSection === "plugins") {
      props.setSectionRoute?.(nextSection);
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
          <Show when={props.showHeader !== false}>
            <h2 class="text-3xl font-bold text-dls-text">{t("extensions.title")}</h2>
            <p class="text-sm text-dls-secondary mt-1.5">
              {t("extensions.subtitle")}
            </p>
          </Show>
          <div class={`${props.showHeader === false ? "" : "mt-3"} flex flex-wrap items-center gap-2`}>
            <Show when={connectedAppsCount() > 0}>
              <div class="inline-flex items-center gap-2 rounded-full bg-green-3 px-3 py-1">
                <div class="w-2 h-2 rounded-full bg-green-9" />
                <span class="text-xs font-medium text-green-11">
                  {t(connectedAppsCount() === 1 ? "extensions.app_count_one" : "extensions.app_count_many", undefined, { count: connectedAppsCount() })}
                </span>
              </div>
            </Show>
            <Show when={pluginCount() > 0}>
              <div class="inline-flex items-center gap-2 rounded-full bg-gray-3 px-3 py-1">
                <Cpu size={14} class="text-gray-11" />
                <span class="text-xs font-medium text-gray-11">
                  {t(pluginCount() === 1 ? "extensions.plugin_count_one" : "extensions.plugin_count_many", undefined, { count: pluginCount() })}
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
              {t("extensions.filter_all")}
            </button>
            <button
              type="button"
              class={pillClass(section() === "mcp")}
              aria-pressed={section() === "mcp"}
              onClick={() => selectSection("mcp")}
            >
              <Box size={14} />
              {t("extensions.filter_apps")}
            </button>
            <button
              type="button"
              class={pillClass(section() === "plugins")}
              aria-pressed={section() === "plugins"}
              onClick={() => selectSection("plugins")}
            >
              <Cpu size={14} />
              {t("extensions.filter_plugins")}
            </button>
          </div>
          <Button variant="ghost" onClick={refreshAll}>
            {t("common.refresh")}
          </Button>
        </div>
      </div>

      <Show when={section() === "all" || section() === "mcp"}>
        <div class="space-y-4">
          <div class="flex items-center gap-2 text-sm font-medium text-gray-12">
            <Box size={16} class="text-gray-11" />
            <span>{t("extensions.apps_mcp_header")}</span>
          </div>
          <McpView
            showHeader={false}
            busy={props.busy}
            selectedWorkspaceRoot={props.selectedWorkspaceRoot}
            isRemoteWorkspace={props.isRemoteWorkspace}
          />
        </div>
      </Show>

      <Show when={section() === "all" || section() === "plugins"}>
        <div class="space-y-4">
          <div class="flex items-center gap-2 text-sm font-medium text-gray-12">
            <Cpu size={16} class="text-gray-11" />
            <span>{t("extensions.plugins_opencode_header")}</span>
          </div>
          <PluginsView
            busy={props.busy}
            selectedWorkspaceRoot={props.selectedWorkspaceRoot}
            canEditPlugins={props.canEditPlugins}
            canUseGlobalScope={props.canUseGlobalScope}
            accessHint={props.accessHint}
            suggestedPlugins={props.suggestedPlugins}
          />
        </div>
      </Show>
    </section>
  );
}
