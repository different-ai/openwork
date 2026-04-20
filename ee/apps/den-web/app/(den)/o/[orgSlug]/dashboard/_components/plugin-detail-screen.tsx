"use client";

import Link from "next/link";
import { ArrowLeft, FileText, Puzzle, Server, Terminal, Users, Webhook } from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";
import { buttonVariants } from "../../../../_components/ui/button";
import { getPluginsRoute } from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  type DenPlugin,
  type PluginHook,
  type PluginMcp,
  type PluginSkill,
  type PluginAgent,
  type PluginCommand,
  formatPluginTimestamp,
  getPluginCategoryLabel,
  getPluginPartsSummary,
  usePlugin,
} from "./plugin-data";

export function PluginDetailScreen({ pluginId }: { pluginId: string }) {
  const { orgSlug } = useOrgDashboard();
  const { data: plugin, isLoading, error } = usePlugin(pluginId);

  if (isLoading && !plugin) {
    return (
      <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">
        <div className="rounded-xl border border-gray-100 bg-white px-5 py-8 text-[13px] text-gray-400">
          Loading plugin details...
        </div>
      </div>
    );
  }

  if (!plugin) {
    return (
      <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">
        <div className="rounded-xl border border-red-100 bg-red-50 px-5 py-3.5 text-[13px] text-red-600">
          {error instanceof Error ? error.message : "That plugin could not be found."}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">
      {/* Nav */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link
          href={getPluginsRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>

        <button
          type="button"
          className={buttonVariants({ variant: plugin.installed ? "secondary" : "primary", size: "sm" })}
          disabled
          aria-disabled="true"
          title="Install/uninstall is not wired up yet in this preview."
        >
          {plugin.installed ? "Installed" : "Install"}
        </button>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_240px]">
        {/* ── Main card ── */}
        <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
          {/* Gradient header — seeded by plugin id to match the list card */}
          <div className="relative h-40 overflow-hidden border-b border-gray-100">
            <div className="absolute inset-0">
              <PaperMeshGradient seed={plugin.id} speed={0} />
            </div>
            <div className="absolute bottom-[-20px] left-6 flex h-14 w-14 items-center justify-center rounded-[18px] border border-white/60 bg-white shadow-[0_12px_24px_-12px_rgba(15,23,42,0.3)]">
              <Puzzle className="h-6 w-6 text-gray-700" />
            </div>
          </div>

          <div className="px-6 pb-6 pt-10">
            {/* Title + description + meta */}
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[18px] font-semibold text-gray-900">{plugin.name}</h1>
              <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-500">
                v{plugin.version}
              </span>
              <span className="text-[12px] text-gray-400">by {plugin.author}</span>
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-gray-500">{plugin.description}</p>
            <p className="mt-2 text-[12px] text-gray-300">
              {getPluginPartsSummary(plugin)} · Updated {formatPluginTimestamp(plugin.updatedAt)}
            </p>

            {/* Skills */}
            <PrimitiveSection
              icon={FileText}
              label="Skills"
              emptyLabel="This plugin does not ship any skills."
              items={plugin.skills}
              render={(skill) => renderSkillRow(skill)}
            />

            {/* Hooks */}
            <PrimitiveSection
              icon={Webhook}
              label="Hooks"
              emptyLabel="This plugin does not register any hooks."
              items={plugin.hooks}
              render={(hook) => renderHookRow(hook)}
            />

            {/* MCP Servers */}
            <PrimitiveSection
              icon={Server}
              label="MCP Servers"
              emptyLabel="This plugin does not bundle any MCP servers."
              items={plugin.mcps}
              render={(mcp) => renderMcpRow(mcp)}
            />

            {/* Agents */}
            <PrimitiveSection
              icon={Users}
              label="Agents"
              emptyLabel="This plugin does not define any sub-agents."
              items={plugin.agents}
              render={(agent) => renderAgentRow(agent)}
            />

            {/* Commands */}
            <PrimitiveSection
              icon={Terminal}
              label="Commands"
              emptyLabel="This plugin does not add any slash-commands."
              items={plugin.commands}
              render={(command) => renderCommandRow(command)}
            />
          </div>
        </section>

        {/* ── Sidebar ── */}
        <aside className="grid gap-3 self-start">
          {/* Category */}
          <div className="rounded-xl border border-gray-100 bg-white p-4">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">Category</p>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-[12px] text-gray-500">
              {getPluginCategoryLabel(plugin.category)}
            </span>
          </div>

          {/* Source */}
          <div className="rounded-xl border border-gray-100 bg-white p-4">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">Source</p>
            <p className="text-[13px] font-medium text-gray-900">
              {plugin.source.type === "marketplace"
                ? "Marketplace"
                : plugin.source.type === "github"
                  ? "GitHub"
                  : "Local"}
            </p>
            <p className="mt-0.5 break-words text-[12px] text-gray-400">
              {plugin.source.type === "marketplace"
                ? plugin.source.marketplace
                : plugin.source.type === "github"
                  ? plugin.source.repo
                  : plugin.source.path}
            </p>
          </div>

          {/* Status */}
          <div className="rounded-xl border border-gray-100 bg-white p-4">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">Status</p>
            <p className="text-[13px] font-medium text-gray-900">
              {plugin.installed ? "Installed" : "Not installed"}
            </p>
            <p className="mt-0.5 text-[12px] text-gray-400">
              Install and enable management will land in a follow-up.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── Section + row renderers ──────────────────────────────────────────────────

function PrimitiveSection<T>({
  icon: Icon,
  label,
  items,
  emptyLabel,
  render,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  items: T[];
  emptyLabel: string;
  render: (item: T) => React.ReactNode;
}) {
  return (
    <div className="mt-6 border-t border-gray-100 pt-5">
      <p className="mb-3 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
        <Icon className="h-3.5 w-3.5" />
        {items.length === 0 ? label : `${items.length} ${label}`}
      </p>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-100 px-5 py-4 text-[13px] text-gray-400">
          {emptyLabel}
        </div>
      ) : (
        <div className="grid gap-1.5">{items.map((item) => render(item))}</div>
      )}
    </div>
  );
}

function renderSkillRow(skill: PluginSkill) {
  return (
    <div
      key={skill.id}
      className="flex items-center justify-between gap-4 rounded-xl border border-gray-100 px-4 py-3"
    >
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-gray-900">{skill.name}</p>
        <p className="mt-0.5 truncate text-[12px] text-gray-400">{skill.description}</p>
      </div>
      <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] text-gray-400">Skill</span>
    </div>
  );
}

function renderHookRow(hook: PluginHook) {
  return (
    <div
      key={hook.id}
      className="flex items-center justify-between gap-4 rounded-xl border border-gray-100 px-4 py-3"
    >
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-gray-900">{hook.event}</p>
        <p className="mt-0.5 truncate text-[12px] text-gray-400">{hook.description}</p>
      </div>
      <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] text-gray-400">
        {hook.matcher ? `matcher: ${hook.matcher}` : "any"}
      </span>
    </div>
  );
}

function renderMcpRow(mcp: PluginMcp) {
  return (
    <div
      key={mcp.id}
      className="flex items-center justify-between gap-4 rounded-xl border border-gray-100 px-4 py-3"
    >
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-gray-900">{mcp.name}</p>
        <p className="mt-0.5 truncate text-[12px] text-gray-400">{mcp.description}</p>
      </div>
      <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] text-gray-400">
        {mcp.transport} · {mcp.toolCount} tools
      </span>
    </div>
  );
}

function renderAgentRow(agent: PluginAgent) {
  return (
    <div
      key={agent.id}
      className="flex items-center justify-between gap-4 rounded-xl border border-gray-100 px-4 py-3"
    >
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-gray-900">{agent.name}</p>
        <p className="mt-0.5 truncate text-[12px] text-gray-400">{agent.description}</p>
      </div>
      <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] text-gray-400">Agent</span>
    </div>
  );
}

function renderCommandRow(command: PluginCommand) {
  return (
    <div
      key={command.id}
      className="flex items-center justify-between gap-4 rounded-xl border border-gray-100 px-4 py-3"
    >
      <div className="min-w-0">
        <p className="truncate font-mono text-[13px] font-medium text-gray-900">{command.name}</p>
        <p className="mt-0.5 truncate text-[12px] text-gray-400">{command.description}</p>
      </div>
      <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] text-gray-400">Command</span>
    </div>
  );
}

// Satisfy the type parameter of DenPlugin import even if unused at runtime.
// (Keeps the file importable when you wire in edit forms later.)
export type { DenPlugin };
