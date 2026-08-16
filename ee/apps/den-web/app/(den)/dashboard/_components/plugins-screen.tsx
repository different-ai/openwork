"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Cable,
  Plus,
  Puzzle,
  Search,
  Server,
  Store,
  Terminal,
  Users,
  Webhook,
} from "lucide-react";
import { UnderlineTabs } from "../../_components/ui/tabs";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenInput } from "../../_components/ui/input";
import { buttonVariants } from "../../_components/ui/button";
import { getIntegrationsRoute, getNewPluginRoute, getPluginRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useHasAnyIntegration } from "./integration-data";
import {
  type DenPlugin,
  getPluginCategoryLabel,
  getPluginComponentCount,
  getPluginPartsSummary,
  usePlugins,
} from "./plugin-data";
import { DenCatalogList, DenCatalogRow } from "../../_components/ui/catalog-row";
import { CatalogIdentityTile } from "./catalog-identity-tile";

type PluginView = "plugins" | "agents" | "commands" | "hooks" | "mcps";

const PLUGIN_TABS = [
  { value: "plugins" as const, label: "Plugins", icon: Puzzle },
  { value: "agents" as const, label: "Agents", icon: Users },
  { value: "commands" as const, label: "Commands", icon: Terminal },
  { value: "hooks" as const, label: "Hooks", icon: Webhook },
  { value: "mcps" as const, label: "MCPs", icon: Server },
];

export function PluginsScreen() {
  const { orgSlug } = useOrgDashboard();
  const { data: plugins = [], isLoading, error } = usePlugins();
  const { hasAny: hasAnyIntegration, isLoading: integrationsLoading } = useHasAnyIntegration();
  const [activeView, setActiveView] = useState<PluginView>("plugins");
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();

  const filteredPlugins = useMemo(() => {
    if (!normalizedQuery) {
      return plugins;
    }

    return plugins.filter((plugin) => {
      return (
        plugin.name.toLowerCase().includes(normalizedQuery) ||
        plugin.description.toLowerCase().includes(normalizedQuery) ||
        plugin.author.toLowerCase().includes(normalizedQuery) ||
        getPluginCategoryLabel(plugin.category).toLowerCase().includes(normalizedQuery)
      );
    });
  }, [normalizedQuery, plugins]);

  const allHooks = useMemo(
    () =>
      plugins.flatMap((plugin) =>
        plugin.hooks.map((hook) => ({ ...hook, pluginId: plugin.id, pluginName: plugin.name })),
      ),
    [plugins],
  );

  const allMcps = useMemo(
    () =>
      plugins.flatMap((plugin) =>
        plugin.mcps.map((mcp) => ({ ...mcp, pluginId: plugin.id, pluginName: plugin.name })),
      ),
    [plugins],
  );

  const allAgents = useMemo(
    () =>
      plugins.flatMap((plugin) =>
        plugin.agents.map((agent) => ({ ...agent, pluginId: plugin.id, pluginName: plugin.name })),
      ),
    [plugins],
  );

  const allCommands = useMemo(
    () =>
      plugins.flatMap((plugin) =>
        plugin.commands.map((command) => ({ ...command, pluginId: plugin.id, pluginName: plugin.name })),
      ),
    [plugins],
  );

  const filteredHooks = useMemo(() => {
    if (!normalizedQuery) return allHooks;
    return allHooks.filter(
      (hook) =>
        hook.event.toLowerCase().includes(normalizedQuery) ||
        hook.description.toLowerCase().includes(normalizedQuery) ||
        hook.pluginName.toLowerCase().includes(normalizedQuery),
    );
  }, [normalizedQuery, allHooks]);

  const filteredMcps = useMemo(() => {
    if (!normalizedQuery) return allMcps;
    return allMcps.filter(
      (mcp) =>
        mcp.name.toLowerCase().includes(normalizedQuery) ||
        mcp.description.toLowerCase().includes(normalizedQuery) ||
        mcp.pluginName.toLowerCase().includes(normalizedQuery),
    );
  }, [normalizedQuery, allMcps]);

  const filteredAgents = useMemo(() => {
    if (!normalizedQuery) return allAgents;
    return allAgents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(normalizedQuery) ||
        agent.description.toLowerCase().includes(normalizedQuery) ||
        agent.pluginName.toLowerCase().includes(normalizedQuery),
    );
  }, [normalizedQuery, allAgents]);

  const filteredCommands = useMemo(() => {
    if (!normalizedQuery) return allCommands;
    return allCommands.filter(
      (command) =>
        command.name.toLowerCase().includes(normalizedQuery) ||
        command.description.toLowerCase().includes(normalizedQuery) ||
        command.pluginName.toLowerCase().includes(normalizedQuery),
    );
  }, [normalizedQuery, allCommands]);

  const tabCounts: Record<PluginView, number> = {
    plugins: plugins.length,
    agents: allAgents.length,
    commands: allCommands.length,
    hooks: allHooks.length,
    mcps: allMcps.length,
  };

  const searchPlaceholder =
    activeView === "plugins"
      ? "Search plugins..."
      : activeView === "agents"
          ? "Search agents..."
          : activeView === "commands"
            ? "Search commands..."
            : activeView === "hooks"
              ? "Search hooks..."
              : "Search MCPs...";

  return (
    <DashboardPageTemplate
      icon={Puzzle}
      title="Plugin Directory"
      description="Discover and manage plugins — bundles of skills, hooks, MCP servers, agents, and commands that extend your workers."
      colors={["#EDE9FE", "#4C1D95", "#7C3AED", "#C4B5FD"]}
    >
      <div className="mb-8 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-col gap-4">
          <UnderlineTabs
            tabs={PLUGIN_TABS.map((tab) => ({ ...tab, count: tabCounts[tab.value] }))}
            activeTab={activeView}
            onChange={setActiveView}
            showZeroCounts
          />
          <div>
            <DenInput
              type="search"
              icon={Search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
            />
          </div>
        </div>
        <Link href={getNewPluginRoute(orgSlug)} className={buttonVariants({ variant: "primary" })}>
          <Plus size={15} />
          Create plugin
        </Link>
      </div>

      {error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error instanceof Error ? error.message : "Failed to load plugins."}
        </div>
      ) : null}

      {isLoading || integrationsLoading ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading plugin catalog...
        </div>
      ) : !hasAnyIntegration && plugins.length === 0 ? (
        <ConnectIntegrationEmptyState integrationsHref={getIntegrationsRoute(orgSlug)} />
      ) : activeView === "plugins" ? (
        filteredPlugins.length === 0 ? (
          <EmptyState
            title={plugins.length === 0 ? "No plugins available yet." : "No plugins match that search."}
            description={
              plugins.length === 0
                ? "Imported plugins and connected integration plugins will show up here when they are available."
                : "Try a different search term or browse the hooks or MCPs tabs."
            }
          />
        ) : (
          <DenCatalogList
            label={describePluginScope(filteredPlugins)}
            valueLabel="Components"
            valueWidth="150px"
          >
            {filteredPlugins.map((plugin) => {
              const componentCount = getPluginComponentCount(plugin);
              return (
                <DenCatalogRow
                  key={plugin.id}
                  href={getPluginRoute(orgSlug, plugin.id)}
                  leading={<CatalogIdentityTile name={plugin.name} />}
                  title={plugin.name}
                  description={plugin.description}
                  meta={(plugin.marketplaces ?? []).map((marketplace) => marketplace.name).join(" · ")}
                  value={String(componentCount)}
                  valueMuted={componentCount === 0}
                  valueCaption={componentCount > 0 ? getPluginPartsSummary(plugin) : undefined}
                  valueWidth="150px"
                />
              );
            })}
          </DenCatalogList>
        )
      ) : activeView === "agents" ? (
        <PrimitiveList
          icon={Users}
          emptyLabel="No agents in this catalog yet."
          emptyDescriptionEmpty="Agents declared by plugins will show up here."
          emptyDescriptionFiltered="No agents match that search."
          unfilteredCount={allAgents.length}
          rows={filteredAgents.map((agent) => ({
            id: agent.id,
            title: agent.name,
            description: agent.description,
            pluginName: agent.pluginName,
            href: getPluginRoute(orgSlug, agent.pluginId),
          }))}
        />
      ) : activeView === "commands" ? (
        <PrimitiveList
          icon={Terminal}
          emptyLabel="No commands in this catalog yet."
          emptyDescriptionEmpty="Slash-commands declared by plugins will show up here."
          emptyDescriptionFiltered="No commands match that search."
          unfilteredCount={allCommands.length}
          rows={filteredCommands.map((command) => ({
            id: command.id,
            title: command.name,
            description: command.description,
            pluginName: command.pluginName,
            monospacedTitle: true,
            href: getPluginRoute(orgSlug, command.pluginId),
          }))}
        />
      ) : activeView === "hooks" ? (
        <PrimitiveList
          icon={Webhook}
          emptyLabel="No hooks in this catalog yet."
          emptyDescriptionEmpty="Hooks declared by plugins will show up here."
          emptyDescriptionFiltered="No hooks match that search."
          unfilteredCount={allHooks.length}
          rows={filteredHooks.map((hook) => ({
            id: hook.id,
            title: hook.event,
            description: hook.description,
            pluginName: hook.pluginName,
            monospacedTitle: true,
            meta: hook.matcher ? `matcher: ${hook.matcher}` : undefined,
            href: getPluginRoute(orgSlug, hook.pluginId),
          }))}
        />
      ) : (
        <PrimitiveList
          icon={Server}
          emptyLabel="No MCP servers in this catalog yet."
          emptyDescriptionEmpty="MCP servers exposed by plugins will show up here."
          emptyDescriptionFiltered="No MCPs match that search."
          unfilteredCount={allMcps.length}
          rows={filteredMcps.map((mcp) => ({
            id: mcp.id,
            title: mcp.name,
            description: mcp.description,
            pluginName: mcp.pluginName,
            meta: `${mcp.transport} · ${mcp.toolCount} tool${mcp.toolCount === 1 ? "" : "s"}`,
            href: getPluginRoute(orgSlug, mcp.pluginId),
          }))}
        />
      )}
    </DashboardPageTemplate>
  );
}

function describePluginScope(plugins: DenPlugin[]): string {
  const marketplaceCount = new Set(
    plugins.flatMap((plugin) => (plugin.marketplaces ?? []).map((marketplace) => marketplace.id)),
  ).size;
  const pluginLabel = `${plugins.length} plugin${plugins.length === 1 ? "" : "s"}`;
  if (marketplaceCount === 0) return pluginLabel;
  return `${pluginLabel} across ${marketplaceCount} collection${marketplaceCount === 1 ? "" : "s"}`;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[32px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
      <p className="text-[16px] font-medium tracking-[-0.03em] text-gray-900">{title}</p>
      <p className="mx-auto mt-3 max-w-[520px] text-[15px] leading-8 text-gray-500">{description}</p>
    </div>
  );
}

function ConnectIntegrationEmptyState({ integrationsHref }: { integrationsHref: string }) {
  return (
    <div className="rounded-[32px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] bg-gray-100 text-gray-500">
        <Cable className="h-6 w-6" />
      </div>
      <p className="text-[16px] font-medium tracking-[-0.03em] text-gray-900">
        Connect an integration to discover plugins
      </p>
      <p className="mx-auto mt-3 max-w-[520px] text-[15px] leading-8 text-gray-500">
        Plugins, skills, hooks, and MCP servers are sourced from the repositories you connect on the
        Integrations page. Connect GitHub or Bitbucket to see your catalog populate.
      </p>
      <div className="mt-6 flex justify-center">
        <Link
          href={integrationsHref}
          className={buttonVariants({ variant: "primary" })}
        >
          <Cable className="h-4 w-4" aria-hidden="true" />
          Open Integrations
        </Link>
      </div>
    </div>
  );
}

type PrimitiveRow = {
  id: string;
  title: string;
  description: string;
  pluginName: string;
  meta?: string;
  monospacedTitle?: boolean;
  href: string;
};

function PrimitiveList({
  icon: Icon,
  rows,
  unfilteredCount,
  emptyLabel,
  emptyDescriptionEmpty,
  emptyDescriptionFiltered,
}: {
  icon: React.ComponentType<{ className?: string }>;
  rows: PrimitiveRow[];
  unfilteredCount: number;
  emptyLabel: string;
  emptyDescriptionEmpty: string;
  emptyDescriptionFiltered: string;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title={unfilteredCount === 0 ? emptyLabel : "Nothing matches that search."}
        description={unfilteredCount === 0 ? emptyDescriptionEmpty : emptyDescriptionFiltered}
      />
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {rows.map((row) => (
        <Link
          key={row.id}
          href={row.href}
          className="group flex min-w-0 flex-col gap-3 rounded-2xl border border-gray-100 bg-white px-4 py-4 transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.08)]"
        >
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-gray-50 text-gray-500 group-hover:bg-gray-100 group-hover:text-gray-700">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p
                className={`truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900 ${
                  row.monospacedTitle ? "font-mono" : ""
                }`}
              >
                {row.title}
              </p>
              {row.description ? (
                <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">
                  {row.description}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 border-t border-gray-50 pt-2.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-50 px-2 py-0.5 text-[11px] text-gray-500">
              <Puzzle className="h-3 w-3 text-gray-400" aria-hidden />
              <span className="max-w-[160px] truncate">{row.pluginName}</span>
            </span>
            {row.meta ? (
              <span className="rounded-full bg-gray-50 px-2 py-0.5 text-[11px] text-gray-500">
                {row.meta}
              </span>
            ) : null}
          </div>
        </Link>
      ))}
    </div>
  );
}
