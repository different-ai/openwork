/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Cpu } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";

import { PluginsView, type PluginsExtensionsStore } from "./plugins-view";

export type ExtensionsSection = "all" | "mcp" | "skills" | "plugins";

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
  /** The MCP view (quick-connect grid + configured servers). Skills are injected into it. */
  mcpView: ReactNode;
  onRefresh: () => void;
  initialSection?: ExtensionsSection;
  setSectionRoute?: (tab: "mcp" | "skills" | "plugins") => void;
  showHeader?: boolean;
};

export function ExtensionsView(props: ExtensionsViewProps) {
  const pluginCount = useMemo(
    () => props.extensions.pluginList().length,
    [props.extensions],
  );

  return (
    <section className="space-y-6 max-w-3xl w-full animate-in fade-in duration-300">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {props.mcpConnectedAppsCount > 0 ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-green-3 px-3 py-1">
              <div className="size-2 rounded-full bg-green-9" />
              <span className="text-xs font-medium text-green-11">
                {t("extensions.app_count", { count: props.mcpConnectedAppsCount })}
              </span>
            </div>
          ) : null}
        </div>
        <Button variant="outline" onClick={props.onRefresh}>
          {t("common.refresh")}
        </Button>
      </div>

      {/* All extensions: MCPs + skills in one view */}
      {props.mcpView}

      {/* OpenCode plugins -- advanced, collapsed */}
      {pluginCount > 0 ? (
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-2 rounded-lg px-1 py-2 text-sm font-medium text-dls-secondary transition-colors hover:text-dls-text">
            <Cpu size={14} />
            <span>OpenCode Plugins</span>
            <span className="text-[11px] text-dls-secondary">({pluginCount})</span>
          </summary>
          <div className="mt-3">
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
        </details>
      ) : null}
    </section>
  );
}
