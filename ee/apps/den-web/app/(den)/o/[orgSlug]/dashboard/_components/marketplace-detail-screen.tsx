"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useEffect } from "react";
import { ArrowLeft, Check, GitBranch, Github, Globe, Loader2, Plus, Puzzle, Store, Users, X } from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";
import {
  getGithubIntegrationSetupRoute,
  getMarketplacesRoute,
  getPluginRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  formatMarketplaceTimestamp,
  type MarketplacePluginSummary,
  useGrantMarketplaceAccess,
  useMarketplace,
  useMarketplaceAccess,
  useRevokeMarketplaceAccess,
} from "./marketplace-data";

const COMPONENT_TYPE_LABELS: Record<string, { singular: string; plural: string }> = {
  skill: { singular: "skill", plural: "skills" },
  agent: { singular: "agent", plural: "agents" },
  command: { singular: "command", plural: "commands" },
  hook: { singular: "hook", plural: "hooks" },
  mcp: { singular: "MCP server", plural: "MCP servers" },
  mcp_server: { singular: "MCP server", plural: "MCP servers" },
  lsp_server: { singular: "LSP server", plural: "LSP servers" },
  monitor: { singular: "monitor", plural: "monitors" },
  settings: { singular: "setting", plural: "settings" },
};

function componentTypeLabel(type: string, count: number) {
  const label = COMPONENT_TYPE_LABELS[type] ?? {
    singular: type.replace(/_/g, " "),
    plural: `${type.replace(/_/g, " ")}s`,
  };
  return count === 1 ? label.singular : label.plural;
}

export function MarketplaceDetailScreen({ marketplaceId }: { marketplaceId: string }) {
  const { orgSlug } = useOrgDashboard();
  const { data, isLoading, error } = useMarketplace(marketplaceId);

  if (isLoading && !data) {
    return (
      <div className="mx-auto max-w-[860px] px-6 py-8 md:px-8">
        <div className="rounded-2xl border border-gray-100 bg-white px-5 py-8 text-[13px] text-gray-400">
          Loading marketplace…
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-[860px] px-6 py-8 md:px-8">
        <div className="rounded-2xl border border-red-100 bg-red-50 px-5 py-3.5 text-[13px] text-red-600">
          {error instanceof Error ? error.message : "That marketplace could not be found."}
        </div>
      </div>
    );
  }

  const { marketplace, plugins, source } = data;

  return (
    <div className="mx-auto max-w-[860px] px-6 py-8 md:px-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link
          href={getMarketplacesRoute(orgSlug)}
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
              <PaperMeshGradient seed={marketplace.id} speed={0} />
            </div>
            <div className="relative flex h-full items-center justify-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-[16px] border border-white/60 bg-white shadow-[0_10px_24px_-10px_rgba(15,23,42,0.3)]">
                <Store className="h-6 w-6 text-gray-700" aria-hidden />
              </div>
            </div>
          </div>

          <div className="min-w-0 flex-1 px-6 py-5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
                {marketplace.name}
              </h1>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                {plugins.length} plugin{plugins.length === 1 ? "" : "s"}
              </span>
            </div>
            {marketplace.description ? (
              <p className="mt-1 text-[13px] leading-[1.55] text-gray-500">{marketplace.description}</p>
            ) : null}
            <p className="mt-3 text-[11.5px] text-gray-400">
              Added {formatMarketplaceTimestamp(marketplace.createdAt)}
            </p>
          </div>
        </div>
      </article>

      <div className="mt-6 space-y-6">
        {source ? (
          <section>
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
              Source
            </h2>
            <Link
              href={getGithubIntegrationSetupRoute(orgSlug, source.connectorInstanceId)}
              className="group flex items-center gap-4 rounded-2xl border border-gray-100 bg-white px-4 py-3 transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.08)]"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-gray-50 text-gray-600 group-hover:bg-gray-100 group-hover:text-gray-800">
                <Github className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
                  {source.repositoryFullName}
                </p>
                <p className="mt-0.5 truncate text-[12.5px] text-gray-500">
                  {source.accountLogin ? `@${source.accountLogin}` : "GitHub connector"}
                  {source.branch ? (
                    <>
                      <span className="mx-1.5 text-gray-300">·</span>
                      <GitBranch className="mr-1 inline h-3 w-3 text-gray-400" aria-hidden />
                      {source.branch}
                    </>
                  ) : null}
                </p>
              </div>
            </Link>
          </section>
        ) : null}

        <MarketplaceAccessSection marketplaceId={marketplace.id} />

        <section>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
              Plugins
            </h2>
            <p className="text-[11px] text-gray-400">
              {plugins.length} plugin{plugins.length === 1 ? "" : "s"}
            </p>
          </div>

          {plugins.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-5 py-10 text-center">
              <p className="text-[14px] font-medium tracking-[-0.02em] text-gray-800">
                No plugins in this marketplace yet
              </p>
              <p className="mx-auto mt-2 max-w-[420px] text-[13px] leading-6 text-gray-500">
                Plugins appear here as they're imported from the source repository.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {plugins.map((plugin) => (
                <MarketplacePluginCard key={plugin.id} orgSlug={orgSlug} plugin={plugin} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function MarketplaceAccessSection({ marketplaceId }: { marketplaceId: string }) {
  const { orgContext } = useOrgDashboard();
  const accessQuery = useMarketplaceAccess(marketplaceId);
  const grantMutation = useGrantMarketplaceAccess();
  const revokeMutation = useRevokeMarketplaceAccess();

  const grants = accessQuery.data ?? [];
  const orgWideGrant = grants.find((grant) => grant.orgWide) ?? null;
  const teamGrants = grants.filter((grant) => Boolean(grant.teamId));
  const memberGrants = grants.filter((grant) => Boolean(grant.orgMembershipId));

  const teamsById = useMemo(
    () => new Map((orgContext?.teams ?? []).map((team) => [team.id, team])),
    [orgContext?.teams],
  );
  const membersById = useMemo(
    () => new Map((orgContext?.members ?? []).map((member) => [member.id, member])),
    [orgContext?.members],
  );

  const teamsAvailable = (orgContext?.teams ?? []).filter(
    (team) => !teamGrants.some((grant) => grant.teamId === team.id),
  );
  const membersAvailable = (orgContext?.members ?? []).filter(
    (member) => !memberGrants.some((grant) => grant.orgMembershipId === member.id),
  );

  async function handleToggleOrgWide() {
    if (orgWideGrant) {
      await revokeMutation.mutateAsync({ marketplaceId, grantId: orgWideGrant.id });
    } else {
      await grantMutation.mutateAsync({
        marketplaceId,
        body: { orgWide: true, role: "viewer" },
      });
    }
  }

  async function handleAddTeam(teamId: string) {
    await grantMutation.mutateAsync({
      marketplaceId,
      body: { teamId, role: "viewer" },
    });
  }

  async function handleAddMember(memberId: string) {
    await grantMutation.mutateAsync({
      marketplaceId,
      body: { orgMembershipId: memberId, role: "viewer" },
    });
  }

  async function handleRevoke(grantId: string) {
    await revokeMutation.mutateAsync({ marketplaceId, grantId });
  }

  const busy = accessQuery.isLoading || grantMutation.isPending || revokeMutation.isPending;

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
          Who can access this
        </h2>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" aria-hidden /> : null}
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
        <button
          type="button"
          onClick={() => void handleToggleOrgWide()}
          disabled={grantMutation.isPending || revokeMutation.isPending}
          className="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-gray-50/60 disabled:opacity-60"
        >
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${orgWideGrant ? "bg-emerald-50 text-emerald-600" : "bg-gray-50 text-gray-500"}`}>
            <Globe className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
              Everyone in {orgContext?.organization.name ?? "this organization"}
            </p>
            <p className="mt-0.5 text-[12.5px] leading-[1.55] text-gray-500">
              {orgWideGrant
                ? "All org members can see this marketplace."
                : "Only admins and people you add below can see this marketplace."}
            </p>
          </div>
          <div
            role="switch"
            aria-checked={Boolean(orgWideGrant)}
            className={`relative inline-flex h-6 w-[42px] shrink-0 items-center rounded-full transition-colors ${
              orgWideGrant ? "bg-[#0f172a]" : "bg-gray-200"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-[0_2px_6px_-1px_rgba(15,23,42,0.3)] transition-transform ${
                orgWideGrant ? "translate-x-[18px]" : "translate-x-0.5"
              }`}
            />
          </div>
        </button>

        <AccessRowGroup
          label="Teams"
          icon={Users}
          emptyLabel="No team access yet"
          items={teamGrants.map((grant) => {
            const team = grant.teamId ? teamsById.get(grant.teamId) : null;
            return {
              grantId: grant.id,
              title: team?.name ?? "Removed team",
              subtitle: team ? `${team.memberIds.length} member${team.memberIds.length === 1 ? "" : "s"}` : null,
            };
          })}
          availableOptions={teamsAvailable.map((team) => ({
            id: team.id,
            label: team.name,
            subtitle: `${team.memberIds.length} member${team.memberIds.length === 1 ? "" : "s"}`,
          }))}
          availableEmptyLabel="All teams already have access"
          onAdd={(id) => void handleAddTeam(id)}
          onRemove={(id) => void handleRevoke(id)}
          disabled={grantMutation.isPending || revokeMutation.isPending}
        />

        <AccessRowGroup
          label="People"
          icon={Users}
          emptyLabel="No individual access yet"
          items={memberGrants.map((grant) => {
            const member = grant.orgMembershipId ? membersById.get(grant.orgMembershipId) : null;
            return {
              grantId: grant.id,
              title: member?.user.name ?? "Removed member",
              subtitle: member?.user.email ?? null,
            };
          })}
          availableOptions={membersAvailable.map((member) => ({
            id: member.id,
            label: member.user.name,
            subtitle: member.user.email,
          }))}
          availableEmptyLabel="Everyone already has access"
          onAdd={(id) => void handleAddMember(id)}
          onRemove={(id) => void handleRevoke(id)}
          disabled={grantMutation.isPending || revokeMutation.isPending}
        />
      </div>

      {accessQuery.error ? (
        <p className="mt-2 text-[12px] text-red-600">
          {accessQuery.error instanceof Error ? accessQuery.error.message : "Failed to load access."}
        </p>
      ) : null}
      {grantMutation.error ? (
        <p className="mt-2 text-[12px] text-red-600">
          {grantMutation.error instanceof Error ? grantMutation.error.message : "Failed to grant access."}
        </p>
      ) : null}
      {revokeMutation.error ? (
        <p className="mt-2 text-[12px] text-red-600">
          {revokeMutation.error instanceof Error ? revokeMutation.error.message : "Failed to revoke access."}
        </p>
      ) : null}
    </section>
  );
}

function AccessRowGroup({
  label,
  icon: Icon,
  emptyLabel,
  items,
  availableOptions,
  availableEmptyLabel,
  onAdd,
  onRemove,
  disabled,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  emptyLabel: string;
  items: Array<{ grantId: string; title: string; subtitle: string | null }>;
  availableOptions: Array<{ id: string; label: string; subtitle: string }>;
  availableEmptyLabel: string;
  onAdd: (id: string) => void;
  onRemove: (grantId: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="border-t border-gray-100 px-5 py-4">
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-gray-400" aria-hidden />
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">{label}</p>
      </div>

      {items.length === 0 ? (
        <p className="text-[12.5px] text-gray-400">{emptyLabel}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((entry) => (
            <span
              key={entry.grantId}
              className="group inline-flex items-center gap-1.5 rounded-full bg-gray-50 py-1 pl-3 pr-1 text-[12px] text-gray-700"
            >
              <span className="truncate max-w-[180px]">{entry.title}</span>
              {entry.subtitle ? (
                <span className="truncate max-w-[140px] text-gray-400">· {entry.subtitle}</span>
              ) : null}
              <button
                type="button"
                aria-label={`Remove ${entry.title}`}
                disabled={disabled}
                onClick={() => onRemove(entry.grantId)}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-200 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}

      <AccessAddPicker
        label={label}
        options={availableOptions}
        emptyLabel={availableEmptyLabel}
        disabled={disabled}
        onAdd={onAdd}
      />
    </div>
  );
}

function AccessAddPicker({
  label,
  options,
  emptyLabel,
  disabled,
  onAdd,
}: {
  label: string;
  options: Array<{ id: string; label: string; subtitle: string }>;
  emptyLabel: string;
  disabled: boolean;
  onAdd: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handle(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(normalized) ||
        option.subtitle.toLowerCase().includes(normalized),
    );
  }, [options, query]);

  if (options.length === 0) {
    return (
      <p className="mt-2 text-[11.5px] text-gray-400">{emptyLabel}</p>
    );
  }

  return (
    <div ref={ref} className="relative mt-2 inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-200 px-2.5 py-1 text-[11.5px] text-gray-500 transition hover:border-gray-400 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-3 w-3" aria-hidden />
        Add {label.toLowerCase().replace(/s$/, "")}
      </button>

      {open ? (
        <div className="absolute left-0 top-[calc(100%+4px)] z-10 w-[260px] overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-[0_20px_40px_-16px_rgba(15,23,42,0.18)]">
          <div className="border-b border-gray-100 px-3 py-2">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${label.toLowerCase()}...`}
              className="w-full bg-transparent text-[12.5px] text-gray-900 placeholder:text-gray-400 focus:outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-[240px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-gray-400">No matches</p>
            ) : (
              filtered.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    onAdd(option.id);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-gray-50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium text-gray-900">{option.label}</p>
                    <p className="truncate text-[11px] text-gray-500">{option.subtitle}</p>
                  </div>
                  <Check className="h-3.5 w-3.5 shrink-0 text-transparent" aria-hidden />
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MarketplacePluginCard({
  orgSlug,
  plugin,
}: {
  orgSlug: string | null;
  plugin: MarketplacePluginSummary;
}) {
  const orderedCountEntries = Object.entries(plugin.componentCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <Link
      href={getPluginRoute(orgSlug, plugin.id)}
      className="group block overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.12)]"
    >
      <div className="flex items-stretch">
        <div className="relative w-[64px] shrink-0 overflow-hidden">
          <div className="absolute inset-0">
            <PaperMeshGradient seed={plugin.id} speed={0} />
          </div>
          <div className="relative flex h-full items-center justify-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-[12px] border border-white/60 bg-white shadow-[0_8px_20px_-8px_rgba(15,23,42,0.3)]">
              <Puzzle className="h-4 w-4 text-gray-700" aria-hidden />
            </div>
          </div>
        </div>
        <div className="min-w-0 flex-1 px-4 py-3">
          <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
            {plugin.name}
          </p>
          {plugin.description ? (
            <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">
              {plugin.description}
            </p>
          ) : null}

          {orderedCountEntries.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-gray-50 pt-2.5">
              {orderedCountEntries.map(([type, count]) => (
                <span
                  key={type}
                  className="inline-flex items-center gap-1 rounded-full bg-gray-50 px-2 py-0.5 text-[11.5px] text-gray-600"
                >
                  <span className="font-semibold text-gray-900">{count}</span>
                  <span className="text-gray-500">{componentTypeLabel(type, count)}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[11.5px] text-gray-400">
              {plugin.memberCount} imported object{plugin.memberCount === 1 ? "" : "s"}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}
