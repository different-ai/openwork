"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  FileText,
  Puzzle,
  Search,
  Server,
  Webhook,
} from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";
import { UnderlineTabs } from "../../../../_components/ui/tabs";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { DenInput } from "../../../../_components/ui/input";
import { getPluginRoute } from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  getPluginCategoryLabel,
  getPluginPartsSummary,
  usePlugins,
} from "./plugin-data";

type PluginView = "plugins" | "skills" | "hooks" | "mcps";

const PLUGIN_TABS = [
  { value: "plugins" as const, label: "Plugins", icon: Puzzle },
  { value: "skills" as const, label: "All Skills", icon: FileText },
  { value: "hooks" as const, label: "All Hooks", icon: Webhook },
  { value: "mcps" as const, label: "All MCPs", icon: Server },
];

export function PluginsScreen() {
  const { orgSlug } = useOrgDashboard();
  const { data: plugins = [], isLoading, error } = usePlugins();
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

  const allSkills = useMemo(
    () =>
      plugins.flatMap((plugin) =>
        plugin.skills.map((skill) => ({ ...skill, pluginId: plugin.id, pluginName: plugin.name })),
      ),
    [plugins],
  );

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

  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return allSkills;
    return allSkills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(normalizedQuery) ||
        skill.description.toLowerCase().includes(normalizedQuery) ||
        skill.pluginName.toLowerCase().includes(normalizedQuery),
    );
  }, [normalizedQuery, allSkills]);

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

  const searchPlaceholder =
    activeView === "plugins"
      ? "Search plugins..."
      : activeView === "skills"
        ? "Search skills..."
        : activeView === "hooks"
          ? "Search hooks..."
          : "Search MCPs...";

  return (
    <DashboardPageTemplate
      icon={Puzzle}
      badgeLabel="Preview"
      title="Plugins"
      description="Discover and manage plugins — bundles of skills, hooks, MCP servers, agents, and commands that extend your workers."
      colors={["#EDE9FE", "#4C1D95", "#7C3AED", "#C4B5FD"]}
    >
      <div className="mb-8 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-col gap-4">
          <UnderlineTabs tabs={PLUGIN_TABS} activeTab={activeView} onChange={setActiveView} />
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
      </div>

      {error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error instanceof Error ? error.message : "Failed to load plugins."}
        </div>
      ) : null}

      {isLoading ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading plugin catalog...
        </div>
      ) : activeView === "plugins" ? (
        filteredPlugins.length === 0 ? (
          <EmptyState
            title={plugins.length === 0 ? "No plugins available yet." : "No plugins match that search."}
            description={
              plugins.length === 0
                ? "Once you connect a marketplace, discovered plugins will appear here."
                : "Try a different search term or browse the skills, hooks, or MCPs tabs."
            }
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {filteredPlugins.map((plugin) => (
              <Link
                key={plugin.id}
                href={getPluginRoute(orgSlug, plugin.id)}
                className="block overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-8px_rgba(15,23,42,0.1)]"
              >
                {/* Gradient header */}
                <div className="relative h-36 overflow-hidden border-b border-gray-100">
                  <div className="absolute inset-0">
                    <PaperMeshGradient seed={plugin.id} speed={0} />
                  </div>
                  <div className="absolute bottom-[-20px] left-6 flex h-14 w-14 items-center justify-center rounded-[18px] border border-white/60 bg-white shadow-[0_12px_24px_-12px_rgba(15,23,42,0.3)]">
                    <Puzzle className="h-6 w-6 text-gray-700" />
                  </div>
                  {plugin.installed ? (
                    <span className="absolute right-4 top-4 rounded-full border border-white/30 bg-white/20 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[1px] text-white backdrop-blur-md">
                      Installed
                    </span>
                  ) : null}
                </div>

                {/* Body */}
                <div className="px-6 pb-5 pt-9">
                  <div className="mb-1.5 flex items-center gap-2">
                    <h2 className="text-[15px] font-semibold text-gray-900">{plugin.name}</h2>
                    <span className="text-[11px] font-medium text-gray-400">v{plugin.version}</span>
                  </div>
                  <p className="line-clamp-2 text-[13px] leading-[1.6] text-gray-400">{plugin.description}</p>

                  <div className="mt-5 flex items-center gap-2 border-t border-gray-100 pt-4">
                    <span className="inline-flex rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-500">
                      {getPluginPartsSummary(plugin)}
                    </span>
                    <span className="ml-auto text-[13px] font-medium text-gray-500">View plugin</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )
      ) : activeView === "skills" ? (
        <PrimitiveList
          emptyLabel="No skills in this catalog yet."
          emptyDescriptionEmpty="Once plugins contribute skills, they will show up here."
          emptyDescriptionFiltered="No skills match that search."
          unfilteredCount={allSkills.length}
          rows={filteredSkills.map((skill) => ({
            id: skill.id,
            title: skill.name,
            description: skill.description,
            tag: skill.pluginName,
            href: getPluginRoute(orgSlug, skill.pluginId),
          }))}
        />
      ) : activeView === "hooks" ? (
        <PrimitiveList
          emptyLabel="No hooks in this catalog yet."
          emptyDescriptionEmpty="Hooks declared by plugins will show up here."
          emptyDescriptionFiltered="No hooks match that search."
          unfilteredCount={allHooks.length}
          rows={filteredHooks.map((hook) => ({
            id: hook.id,
            title: hook.event,
            description: hook.description,
            tag: hook.pluginName,
            href: getPluginRoute(orgSlug, hook.pluginId),
          }))}
        />
      ) : (
        <PrimitiveList
          emptyLabel="No MCP servers in this catalog yet."
          emptyDescriptionEmpty="MCP servers exposed by plugins will show up here."
          emptyDescriptionFiltered="No MCPs match that search."
          unfilteredCount={allMcps.length}
          rows={filteredMcps.map((mcp) => ({
            id: mcp.id,
            title: mcp.name,
            description: mcp.description,
            tag: `${mcp.pluginName} · ${mcp.transport}`,
            href: getPluginRoute(orgSlug, mcp.pluginId),
          }))}
        />
      )}
    </DashboardPageTemplate>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[32px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
      <p className="text-[16px] font-medium tracking-[-0.03em] text-gray-900">{title}</p>
      <p className="mx-auto mt-3 max-w-[520px] text-[15px] leading-8 text-gray-500">{description}</p>
    </div>
  );
}

type PrimitiveRow = {
  id: string;
  title: string;
  description: string;
  tag: string;
  href: string;
};

function PrimitiveList({
  rows,
  unfilteredCount,
  emptyLabel,
  emptyDescriptionEmpty,
  emptyDescriptionFiltered,
}: {
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
    <div className="grid gap-1.5">
      {rows.map((row) => (
        <Link
          key={row.id}
          href={row.href}
          className="flex items-center justify-between gap-4 rounded-xl border border-gray-100 bg-white px-4 py-3 transition hover:border-gray-200 hover:bg-gray-50/60"
        >
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-gray-900">{row.title}</p>
            {row.description ? (
              <p className="mt-0.5 truncate text-[12px] text-gray-400">{row.description}</p>
            ) : null}
          </div>
          <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] text-gray-400">
            {row.tag}
          </span>
        </Link>
      ))}
    </div>
  );
}

