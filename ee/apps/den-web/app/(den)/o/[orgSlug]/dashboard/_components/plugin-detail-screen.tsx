"use client";

import Link from "next/link";
import { ArrowLeft, FileText, Puzzle, Server, Store, Terminal, Users, Webhook } from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";

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
  usePlugin,
} from "./plugin-data";

export function PluginDetailScreen({ pluginId }: { pluginId: string }) {
  const { orgSlug } = useOrgDashboard();
  const { data: plugin, isLoading, error } = usePlugin(pluginId);

  if (isLoading && !plugin) {
    return (
      <div className="mx-auto max-w-[860px] px-6 py-8 md:px-8">
        <div className="rounded-2xl border border-gray-100 bg-white px-5 py-8 text-[13px] text-gray-400">
          Loading plugin details…
        </div>
      </div>
    );
  }

  if (!plugin) {
    return (
      <div className="mx-auto max-w-[860px] px-6 py-8 md:px-8">
        <div className="rounded-2xl border border-red-100 bg-red-50 px-5 py-3.5 text-[13px] text-red-600">
          {error instanceof Error ? error.message : "That plugin could not be found."}
        </div>
      </div>
    );
  }

  const marketplaces = plugin.marketplaces ?? [];
  const missingLabels: string[] = [];
  if (plugin.skills.length === 0) missingLabels.push("skills");
  if (plugin.agents.length === 0) missingLabels.push("agents");
  if (plugin.commands.length === 0) missingLabels.push("commands");
  if (plugin.hooks.length === 0) missingLabels.push("hooks");
  if (plugin.mcps.length === 0) missingLabels.push("MCP servers");

  return (
    <div className="mx-auto max-w-[860px] px-6 py-8 md:px-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link
          href={getPluginsRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
      </div>

      <article className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
        <div className="flex items-stretch">
          <div className="relative w-[96px] shrink-0 overflow-hidden">
            <div className="absolute inset-0">
              <PaperMeshGradient seed={plugin.id} speed={0} />
            </div>
            <div className="relative flex h-full items-center justify-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-[16px] border border-white/60 bg-white shadow-[0_10px_24px_-10px_rgba(15,23,42,0.3)]">
                <Puzzle className="h-6 w-6 text-gray-700" aria-hidden />
              </div>
            </div>
          </div>

          <div className="min-w-0 flex-1 px-6 py-5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
                {plugin.name}
              </h1>
              {plugin.version ? (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                  v{plugin.version}
                </span>
              ) : null}
            </div>
            {plugin.description ? (
              <p className="mt-1 text-[13px] leading-[1.55] text-gray-500">{plugin.description}</p>
            ) : null}

            {marketplaces.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {marketplaces.map((marketplace) => (
                  <span
                    key={marketplace.id}
                    className="inline-flex items-center gap-1 rounded-full bg-gray-50 px-2 py-0.5 text-[11px] text-gray-600"
                  >
                    <Store className="h-3 w-3 text-gray-400" aria-hidden />
                    <span className="truncate">{marketplace.name}</span>
                  </span>
                ))}
              </div>
            ) : null}

            <p className="mt-3 text-[11.5px] text-gray-400">
              Updated {formatPluginTimestamp(plugin.updatedAt)}
            </p>
          </div>
        </div>
      </article>

      <div className="mt-6 space-y-6">
        <PrimitiveSection icon={FileText} label="Skills" items={plugin.skills} render={renderSkillRow} />
        <PrimitiveSection icon={Users} label="Agents" items={plugin.agents} render={renderAgentRow} />
        <PrimitiveSection icon={Terminal} label="Commands" items={plugin.commands} render={renderCommandRow} />
        <PrimitiveSection icon={Webhook} label="Hooks" items={plugin.hooks} render={renderHookRow} />
        <PrimitiveSection icon={Server} label="MCP Servers" items={plugin.mcps} render={renderMcpRow} />
      </div>

      {missingLabels.length > 0 ? (
        <p className="mt-6 text-center text-[12px] text-gray-400">
          No {formatMissingList(missingLabels)} detected in this plugin.
        </p>
      ) : null}
    </div>
  );
}

function formatMissingList(labels: string[]) {
  if (labels.length === 0) return "";
  const lowered = labels.map((label) => label.toLowerCase());
  if (lowered.length === 1) return lowered[0];
  if (lowered.length === 2) return `${lowered[0]} or ${lowered[1]}`;
  return `${lowered.slice(0, -1).join(", ")}, or ${lowered[lowered.length - 1]}`;
}

function PrimitiveSection<T>({
  icon: Icon,
  label,
  items,
  render,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  items: T[];
  render: (item: T) => React.ReactNode;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </h2>
        <p className="text-[11px] text-gray-400">
          {items.length} {items.length === 1 ? "item" : "items"}
        </p>
      </div>
      <div className="grid gap-2">{items.map((item) => render(item))}</div>
    </section>
  );
}

function renderSkillRow(skill: PluginSkill) {
  return (
    <div
      key={skill.id}
      className="rounded-xl border border-gray-100 bg-white px-4 py-3 transition hover:border-gray-200"
    >
      <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900">{skill.name}</p>
      {skill.description ? (
        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">{skill.description}</p>
      ) : null}
    </div>
  );
}

function renderHookRow(hook: PluginHook) {
  return (
    <div
      key={hook.id}
      className="flex items-start justify-between gap-3 rounded-xl border border-gray-100 bg-white px-4 py-3 transition hover:border-gray-200"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[13px] font-semibold text-gray-900">{hook.event}</p>
        {hook.description ? (
          <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">{hook.description}</p>
        ) : null}
      </div>
      {hook.matcher ? (
        <span className="shrink-0 rounded-full bg-gray-50 px-2 py-0.5 text-[11px] text-gray-500">
          matcher: {hook.matcher}
        </span>
      ) : null}
    </div>
  );
}

function renderMcpRow(mcp: PluginMcp) {
  return (
    <div
      key={mcp.id}
      className="flex items-start justify-between gap-3 rounded-xl border border-gray-100 bg-white px-4 py-3 transition hover:border-gray-200"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900">{mcp.name}</p>
        {mcp.description ? (
          <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">{mcp.description}</p>
        ) : null}
      </div>
      <span className="shrink-0 rounded-full bg-gray-50 px-2 py-0.5 text-[11px] text-gray-500">
        {mcp.transport} · {mcp.toolCount} tool{mcp.toolCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function renderAgentRow(agent: PluginAgent) {
  return (
    <div
      key={agent.id}
      className="rounded-xl border border-gray-100 bg-white px-4 py-3 transition hover:border-gray-200"
    >
      <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900">{agent.name}</p>
      {agent.description ? (
        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">{agent.description}</p>
      ) : null}
    </div>
  );
}

function renderCommandRow(command: PluginCommand) {
  return (
    <div
      key={command.id}
      className="rounded-xl border border-gray-100 bg-white px-4 py-3 transition hover:border-gray-200"
    >
      <p className="truncate font-mono text-[13px] font-semibold text-gray-900">{command.name}</p>
      {command.description ? (
        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">{command.description}</p>
      ) : null}
    </div>
  );
}

export type { DenPlugin };
