/** @jsxImportSource react */
import { useMemo, type ReactNode } from "react";
import { Cpu } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";

import type { ExtensionInventoryFilter, ExtensionInventoryState } from "../extension-taxonomy";
import { PluginsView, type PluginsExtensionsStore } from "./plugins-view";

export type ExtensionsSection =
  | "all"
  | "apps"
  | "connections"
  | "mcps"
  | "skills"
  | "plugins"
  | "needs-sign-in"
  | "needs-admin-setup"
  | "ready";

/** Sections are the URL spelling of the inventory filters. */
function filterForSection(section: ExtensionsSection | undefined): ExtensionInventoryFilter {
  switch (section) {
    case "apps":
      return "app";
    case "connections":
      return "connection";
    case "mcps":
      return "mcp";
    case "skills":
      return "skill";
    case "plugins":
      return "plugin";
    default:
      return "all";
  }
}

function sectionForFilter(filter: ExtensionInventoryFilter): ExtensionsSection {
  switch (filter) {
    case "app":
      return "apps";
    case "connection":
      return "connections";
    case "mcp":
      return "mcps";
    case "skill":
      return "skills";
    case "plugin":
      return "plugins";
    case "all":
      return "all";
  }
}

function stateForSection(section: ExtensionsSection | undefined): ExtensionInventoryState {
  if (section === "needs-sign-in") return "needs_signin";
  if (section === "needs-admin-setup") return "needs_admin_setup";
  if (section === "ready") return "ready";
  return "all";
}

function sectionForState(state: Exclude<ExtensionInventoryState, "all">): ExtensionsSection {
  if (state === "needs_signin") return "needs-sign-in";
  if (state === "needs_admin_setup") return "needs-admin-setup";
  return "ready";
}

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
  /** Hide the view's own description line (the settings shell already shows the tab description in-pane). */
  hideDescription?: boolean;
  selectedWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  canEditPlugins: boolean;
  canUseGlobalScope: boolean;
  accessHint?: string | null;
  suggestedPlugins: SuggestedPlugin[];
  extensions: PluginsExtensionsStore;
  /** The MCP view (quick-connect grid + configured servers). Skills are injected into it. */
  mcpView: (routing: {
    initialFilter: ExtensionInventoryFilter;
    onFilterChange: (filter: ExtensionInventoryFilter) => void;
    initialState: ExtensionInventoryState;
    onStateChange: (state: ExtensionInventoryState, filter: ExtensionInventoryFilter) => void;
    detailId: string | null;
    onDetailIdChange?: (id: string | null) => void;
  }) => ReactNode;
  onRefresh: () => void;
  initialSection?: ExtensionsSection;
  setSectionRoute?: (tab: ExtensionsSection) => void;
  showHeader?: boolean;
  detailId?: string | null;
  onDetailIdChange?: (id: string | null) => void;
};

export function ExtensionsView(props: ExtensionsViewProps) {
  const pluginCount = useMemo(
    () => props.extensions.pluginList().length,
    [props.extensions],
  );
  const initialFilter = filterForSection(props.initialSection);
  const initialState = stateForSection(props.initialSection);
  const setFilterRoute = (filter: ExtensionInventoryFilter) => {
    if (initialState !== "all") return;
    props.setSectionRoute?.(sectionForFilter(filter));
  };
  const setStateRoute = (state: ExtensionInventoryState, filter: ExtensionInventoryFilter) => {
    props.setSectionRoute?.(state === "all" ? sectionForFilter(filter) : sectionForState(state));
  };
  const detailId = props.detailId ?? null;
  const mcpRouting = {
    initialFilter,
    onFilterChange: setFilterRoute,
    initialState,
    onStateChange: setStateRoute,
    detailId,
    onDetailIdChange: props.onDetailIdChange,
  };

  if (detailId) {
    return <>{props.mcpView(mcpRouting)}</>;
  }

  return (
    <section className="space-y-6 max-w-3xl w-full animate-in fade-in duration-300">
      <div className="flex items-center justify-between">
        {props.hideDescription === true ? <div /> : (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm text-dls-secondary">
              {t("extensions.inventory_description")}
            </p>
          </div>
        )}
        <Button variant="outline" onClick={props.onRefresh}>
          {t("common.refresh")}
        </Button>
      </div>

      {/* Runtime extensions and organization-assigned capabilities share one inventory. */}
      {props.mcpView(mcpRouting)}

      {/* OpenCode plugins -- advanced, collapsed */}
      {pluginCount > 0 && initialState === "all" ? (
        <details className="group" open={props.initialSection === "plugins"}>
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
