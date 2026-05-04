/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, Cpu } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";

import { PluginsView, type PluginsExtensionsStore } from "./plugins-view";

export type ExtensionsSection = "all" | "mcp" | "plugins";

type SuggestedPlugin = {
  name: string;
  packageName: string;
  description: string;
  tags: string[];
  aliases?: string[];
  installMode?: "simple" | "guided";
  steps?: Array<{
    title: string;
    description: string;
    command?: string;
    url?: string;
    path?: string;
    note?: string;
  }>;
};

// The Solid ExtensionsView pulled the MCP-connected count from
// useConnections(). In React we let the parent pass that plus an
// already-rendered MCP view so we can ship this page before the full
// connections provider is ported.
export type ExtensionsViewProps = {
  busy: boolean;
  selectedWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  canEditPlugins: boolean;
  canUseGlobalScope: boolean;
  accessHint?: string | null;
  suggestedPlugins: SuggestedPlugin[];
  extensions: PluginsExtensionsStore;
  mcpConnectedAppsCount: number;
  mcpView: ReactNode;
  onRefresh: () => void;
  initialSection?: ExtensionsSection;
  setSectionRoute?: (tab: "mcp" | "plugins") => void;
  showHeader?: boolean;
};

export function ExtensionsView(props: ExtensionsViewProps) {
  const [section, setSection] = useState<ExtensionsSection>(
    props.initialSection ?? "all",
  );

  useEffect(() => {
    if (!props.initialSection || props.initialSection === section) return;
    setSection(props.initialSection);
    // Intentional: only react to incoming prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initialSection]);

  const pluginCount = useMemo(
    () => props.extensions.pluginList().length,
    [props.extensions],
  );

  const selectSection = (nextSection: ExtensionsSection) => {
    setSection(nextSection);
    if (nextSection === "mcp" || nextSection === "plugins") {
      props.setSectionRoute?.(nextSection);
    }
  };

  const pillClass = (active: boolean) =>
    `px-3 py-1 rounded-full text-xs font-medium border transition-colors flex items-center gap-2 ${
      active
        ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
        : "text-gray-10 border-gray-6 hover:text-gray-12"
    }`;

  return (
    <section className="space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          {props.showHeader !== false ? (
            <>
              <h2 className="text-3xl font-bold text-dls-text">
                {t("extensions.title")}
              </h2>
              <p className="text-sm text-dls-secondary mt-1.5">
                {t("extensions.subtitle")}
              </p>
            </>
          ) : null}
          <div
            className={`${props.showHeader === false ? "" : "mt-3"} flex flex-wrap items-center gap-2`}
          >
            {props.mcpConnectedAppsCount > 0 ? (
              <div className="inline-flex items-center gap-2 rounded-full bg-green-3 px-3 py-1">
                <div className="w-2 h-2 rounded-full bg-green-9" />
                <span className="text-xs font-medium text-green-11">
                  {t(
                    props.mcpConnectedAppsCount === 1
                      ? "extensions.app_count_one"
                      : "extensions.app_count_many",
                    undefined,
                    { count: props.mcpConnectedAppsCount },
                  )}
                </span>
              </div>
            ) : null}
            {pluginCount > 0 ? (
              <div className="inline-flex items-center gap-2 rounded-full bg-gray-3 px-3 py-1">
                <Cpu size={14} className="text-gray-11" />
                <span className="text-xs font-medium text-gray-11">
                  {t(
                    pluginCount === 1
                      ? "extensions.plugin_count_one"
                      : "extensions.plugin_count_many",
                    undefined,
                    { count: pluginCount },
                  )}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={pillClass(section === "all")}
              aria-pressed={section === "all"}
              onClick={() => selectSection("all")}
            >
              {t("extensions.filter_all")}
            </button>
            <button
              type="button"
              className={pillClass(section === "mcp")}
              aria-pressed={section === "mcp"}
              onClick={() => selectSection("mcp")}
            >
              <Box size={14} />
              {t("extensions.filter_apps")}
            </button>
            <button
              type="button"
              className={pillClass(section === "plugins")}
              aria-pressed={section === "plugins"}
              onClick={() => selectSection("plugins")}
            >
              <Cpu size={14} />
              {t("extensions.filter_plugins")}
            </button>
          </div>
          <Button variant="ghost" onClick={props.onRefresh}>
            {t("common.refresh")}
          </Button>
        </div>
      </div>

      {section === "all" || section === "mcp" ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-12">
            <Box size={16} className="text-gray-11" />
            <span>{t("extensions.apps_mcp_header")}</span>
          </div>
          {props.mcpView}
        </div>
      ) : null}

      {section === "all" || section === "plugins" ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-12">
            <Cpu size={16} className="text-gray-11" />
            <span>{t("extensions.plugins_opencode_header")}</span>
          </div>
          <PluginsView
            extensions={props.extensions}
            busy={props.busy}
            selectedWorkspaceRoot={props.selectedWorkspaceRoot}
            canEditPlugins={props.canEditPlugins}
            canUseGlobalScope={props.canUseGlobalScope}
            accessHint={props.accessHint}
            suggestedPlugins={props.suggestedPlugins}
          />
        </div>
      ) : null}
    </section>
  );
}
