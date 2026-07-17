"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useEffect } from "react";
import { ArrowLeft, Check, ChevronDown, GitBranch, Github, Globe, Loader2, Plug, Plus, Puzzle, Users, X } from "lucide-react";
import { PaperMeshGradient, StaticSeededGradient } from "@openwork/ui/react";
import { buttonVariants, DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import {
  getGithubIntegrationSetupRoute,
  getMarketplacesRoute,
  getOrgAccessFlags,
  getPluginRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  formatMarketplaceTimestamp,
  type ConfiguredPluginMcpConnection,
  type MarketplacePluginCloudReadinessConnection,
  type MarketplacePluginCloudReadinessState,
  type MarketplacePluginSummary,
  useConfigurePluginMcpConnection,
  useGrantMarketplaceAccess,
  useMarketplace,
  useMarketplaceAccess,
  useRevokeMarketplaceAccess,
} from "./marketplace-data";
import { IntegrationIcon } from "./integration-icon";
import { type ExternalMcpAuthType, type ExternalMcpCredentialMode, type ExternalMcpPreset, useMcpConnectionPresets } from "./mcp-connections-data";
import {
  findPresetForRequirement,
  pluginReadinessConnectionAction,
  pluginRequirementNeedsAdminSetup,
  pluginSetupAuthLabel,
  pluginSetupCredentialMode,
  pluginSetupInitialState,
  pluginSetupRequest,
  pluginSetupSuccessCopy,
  serviceNameForRequirement,
} from "./marketplace-mcp-setup";
import { MarketplaceLogo } from "./marketplace-logo";
import { useMcpAccountAuthorization } from "./use-mcp-account-authorization";

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

export type PluginMcpSetupTarget = {
  plugin: Pick<MarketplacePluginSummary, "id" | "name">;
  connection: MarketplacePluginCloudReadinessConnection;
};

type MarketplaceDetailTab = "plugins" | "members" | "configure";

function authTypeFromSelect(value: string): ExternalMcpAuthType {
  if (value === "apikey" || value === "none") return value;
  return "oauth";
}

export function MarketplaceDetailScreen({ marketplaceId }: { marketplaceId: string }) {
  const { orgContext, orgSlug } = useOrgDashboard();
  const { data, isLoading, error, refetch } = useMarketplace(marketplaceId);
  const { data: presets = [] } = useMcpConnectionPresets();
  const [setupTarget, setSetupTarget] = useState<PluginMcpSetupTarget | null>(null);
  const [activeTab, setActiveTab] = useState<MarketplaceDetailTab>("plugins");
  const authorization = useMcpAccountAuthorization(() => {
    void refetch();
  });
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles ?? [],
  );
  const configurationTargets = useMemo(() => (
    data?.plugins.flatMap((plugin) => (
      plugin.cloudReadiness?.connections
        .filter((connection) => (
          pluginRequirementNeedsAdminSetup(connection)
          || pluginReadinessConnectionAction(connection, access.isAdmin) !== null
        ))
        .map((connection) => ({ plugin, connection })) ?? []
    )) ?? []
  ), [access.isAdmin, data]);

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
  const tabs: Array<{
    id: MarketplaceDetailTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: "plugins", label: "Plugins", icon: Puzzle },
    { id: "members", label: "Members", icon: Users },
    { id: "configure", label: "Configure", icon: Plug },
  ];

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
                <MarketplaceLogo
                  logoUrl={marketplace.logoUrl}
                  name={marketplace.name}
                  imgClassName="h-9 w-9"
                  iconClassName="h-6 w-6"
                />
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

      <div className="mt-6">
        <div
          className="grid w-full grid-cols-3 gap-1 rounded-2xl border border-gray-100 bg-gray-50/80 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.03)] sm:w-fit"
          role="tablist"
          aria-label="Marketplace sections"
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`marketplace-${tab.id}-tab`}
                aria-controls={`marketplace-${tab.id}-panel`}
                aria-selected={active}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-[12.5px] font-medium transition-all ${
                  active
                    ? "border border-gray-100 bg-white text-gray-950 shadow-[0_2px_8px_-3px_rgba(15,23,42,0.18)]"
                    : "border border-transparent text-gray-500 hover:bg-white/70 hover:text-gray-800"
                }`}
              >
                <Icon className={`h-3.5 w-3.5 ${active ? "text-gray-700" : "text-gray-400"}`} />
                <span>{tab.label}</span>
                {tab.id === "configure" ? (
                  <span
                    className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      configurationTargets.length > 0
                        ? "bg-amber-50 text-amber-700"
                        : active
                          ? "bg-gray-100 text-gray-500"
                          : "bg-white text-gray-400"
                    }`}
                  >
                    {configurationTargets.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-6">
        {activeTab === "plugins" ? (
          <div id="marketplace-plugins-panel" role="tabpanel" aria-labelledby="marketplace-plugins-tab" className="space-y-6">
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
                <div className="grid items-start gap-3 md:grid-cols-2">
                  {plugins.map((plugin) => (
                    <MarketplacePluginCard key={plugin.id} orgSlug={orgSlug} plugin={plugin} />
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : null}

        {activeTab === "members" ? (
          <div id="marketplace-members-panel" role="tabpanel" aria-labelledby="marketplace-members-tab">
            <MarketplaceAccessSection marketplaceId={marketplace.id} />
          </div>
        ) : null}

        {activeTab === "configure" ? (
          <div id="marketplace-configure-panel" role="tabpanel" aria-labelledby="marketplace-configure-tab">
            <MarketplaceConfigureSection
              targets={configurationTargets}
              presets={presets}
              isAdmin={access.isAdmin}
              connectingConnectionId={authorization.connectingConnectionId}
              connectError={authorization.error}
              pollingConnectionId={authorization.pollingConnectionId}
              onConnect={(connectionId) => void authorization.connect(connectionId)}
              onSetup={setSetupTarget}
            />
          </div>
        ) : null}
      </div>

      <PluginMcpSetupDialog
        target={setupTarget}
        presets={presets}
        onClose={() => setSetupTarget(null)}
      />
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

function MarketplaceConfigureSection({
  connectError,
  connectingConnectionId,
  isAdmin,
  onConnect,
  pollingConnectionId,
  targets,
  presets,
  onSetup,
}: {
  connectError: { connectionId: string; message: string } | null;
  connectingConnectionId: string | null;
  isAdmin: boolean;
  onConnect: (connectionId: string) => void;
  pollingConnectionId: string | null;
  targets: PluginMcpSetupTarget[];
  presets: ExternalMcpPreset[];
  onSetup: (target: PluginMcpSetupTarget) => void;
}) {
  if (targets.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-100 bg-white px-5 py-10 text-center">
        <p className="text-[14px] font-semibold tracking-[-0.01em] text-gray-900">Everything is configured</p>
        <p className="mx-auto mt-1.5 max-w-[420px] text-[13px] leading-6 text-gray-500">
          This marketplace has no MCP configuration actions waiting.
        </p>
      </div>
    );
  }

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
            Actions required
          </h2>
          <p className="mt-1 text-[12.5px] text-gray-500">
            Configure services that need setup, or connect accounts that are ready.
          </p>
        </div>
        <p className="shrink-0 text-[11px] font-medium text-amber-700">
          {targets.length} needed
        </p>
      </div>

      <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white">
        {targets.map((target) => {
          const preset = findPresetForRequirement(presets, target.connection);
          const serviceName = serviceNameForRequirement(target.connection, preset);
          const needsAdminSetup = pluginRequirementNeedsAdminSetup(target.connection);
          const readinessAction = needsAdminSetup
            ? null
            : pluginReadinessConnectionAction(target.connection, isAdmin);

          return (
            <div key={`${target.plugin.id}:${target.connection.configObjectId}:${target.connection.serverName}`} className="px-4 py-3.5">
              <div className="flex items-center gap-3">
                <IntegrationIcon
                  name={serviceName}
                  serviceUrl={target.connection.url}
                  className="h-9 w-9 rounded-[10px]"
                  imageClassName="h-4 w-4"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-gray-900">{serviceName}</p>
                  <p className="mt-0.5 truncate text-[11.5px] text-gray-500">Required by {target.plugin.name}</p>
                </div>
                {needsAdminSetup ? (
                  isAdmin ? (
                    <DenButton
                      variant="secondary"
                      size="sm"
                      icon={Plug}
                      className="h-8 shrink-0 px-3 text-[11.5px]"
                      onClick={() => onSetup(target)}
                    >
                      Configure
                    </DenButton>
                  ) : (
                    <span className="shrink-0 text-[11px] font-medium text-gray-500">Admin setup needed</span>
                  )
                ) : readinessAction ? (
                  <DenButton
                    variant="secondary"
                    size="sm"
                    icon={Plug}
                    className="h-8 shrink-0 px-3 text-[11.5px]"
                    loading={connectingConnectionId === readinessAction.connectionId || pollingConnectionId === readinessAction.connectionId}
                    onClick={() => onConnect(readinessAction.connectionId)}
                  >
                    Connect
                  </DenButton>
                ) : null}
              </div>

              {connectError && connectError.connectionId === readinessAction?.connectionId ? (
                <p className="ml-12 mt-1.5 text-[11px] leading-4 text-red-600">{connectError.message}</p>
              ) : null}

              <details className="group/connection ml-12 mt-1.5">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[10.5px] text-gray-400 transition hover:text-gray-600 [&::-webkit-details-marker]:hidden">
                  Details
                  <ChevronDown className="h-2.5 w-2.5 transition-transform group-open/connection:rotate-180" aria-hidden="true" />
                </summary>
                <div className="mt-1.5 rounded-lg bg-gray-50 px-2.5 py-2">
                  <p className="break-all font-mono text-[10px] leading-4 text-gray-500">
                    Plugin-declared URL (read-only): {target.connection.url}
                  </p>
                  {readinessAction ? (
                    <p className="mt-1 text-[11px] leading-4 text-gray-600">{readinessAction.note}</p>
                  ) : null}
                </div>
              </details>
            </div>
          );
        })}
      </div>
    </section>
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
    <div id={`plugin-${plugin.id}`} className="group block self-start scroll-mt-6 overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.12)]">
      <div className="flex items-stretch">
        <div className="relative w-[64px] shrink-0 overflow-hidden">
          <StaticSeededGradient seed={plugin.id} className="absolute inset-0" />
          <div className="relative flex h-full items-center justify-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-[12px] border border-white/60 bg-white shadow-[0_8px_20px_-8px_rgba(15,23,42,0.3)]">
              <Puzzle className="h-4 w-4 text-gray-700" aria-hidden />
            </div>
          </div>
        </div>
        <div className="min-w-0 flex-1 px-4 py-3">
          <Link href={getPluginRoute(orgSlug, plugin.id)} className="block transition hover:text-gray-700">
            <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
              {plugin.name}
            </p>
          </Link>
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
          ) : plugin.memberCount > 0 ? (
            <p className="mt-2 text-[11.5px] text-gray-400">
              {plugin.memberCount} imported object{plugin.memberCount === 1 ? "" : "s"}
            </p>
          ) : (
            <p className="mt-2 text-[11.5px] text-gray-400">
              {plugin.sourceFormat === "openwork-builtin"
                ? "Built into the OpenWork desktop app"
                : "Content imports when the source repository is connected"}
            </p>
          )}

          {plugin.cloudReadiness && plugin.cloudReadiness.state !== "needs_admin_setup" && plugin.cloudReadiness.state !== "needs_signin" ? (
            <div className="mt-3 border-t border-gray-50 pt-3">
              <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${plugin.cloudReadiness.state === "ready" ? "bg-emerald-50 text-emerald-700" : "bg-gray-50 text-gray-600"}`}>
                {cloudReadinessLabel(plugin.cloudReadiness.state)}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function cloudReadinessLabel(state: MarketplacePluginCloudReadinessState) {
  switch (state) {
    case "ready":
      return "Cloud ready";
    case "needs_signin":
      return "Members need sign-in";
    case "needs_admin_setup":
      return "Needs connection";
    case "desktop_only":
      return "Desktop only";
    case "not_synced":
      return "Sync pending";
  }
}

export function PluginMcpSetupDialog({
  target,
  presets,
  onClose,
}: {
  target: PluginMcpSetupTarget | null;
  presets: ExternalMcpPreset[];
  onClose: () => void;
}) {
  const configureConnection = useConfigurePluginMcpConnection();
  const [authType, setAuthType] = useState<ExternalMcpAuthType>("oauth");
  const [credentialMode, setCredentialMode] = useState<ExternalMcpCredentialMode>("per_member");
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [result, setResult] = useState<ConfiguredPluginMcpConnection | null>(null);

  const preset = target ? findPresetForRequirement(presets, target.connection) : null;
  const authAssumed = pluginSetupInitialState(preset).authAssumed;
  const serviceName = target ? serviceNameForRequirement(target.connection, preset) : "MCP server";
  const requiresOAuthClient = authType === "oauth" && preset?.requiresOAuthClient === true;
  const resolvedCredentialMode = pluginSetupCredentialMode(authType, credentialMode);
  const successCopy = target ? pluginSetupSuccessCopy({
    authType,
    credentialMode: resolvedCredentialMode,
    pluginName: target.plugin.name,
    serviceName,
  }) : null;

  useEffect(() => {
    if (!target) return;
    const initialState = pluginSetupInitialState(preset);
    setAuthType(initialState.authType);
    setCredentialMode(initialState.credentialMode);
    setApiKey("");
    setClientId("");
    setClientSecret("");
    setResult(null);
  }, [preset, target]);

  if (!target) return null;

  const activeTarget = target;
  const trimmedApiKey = apiKey.trim();
  const trimmedClientId = clientId.trim();
  const trimmedClientSecret = clientSecret.trim();
  const saveDisabled = configureConnection.isPending
    || (authType === "apikey" && !trimmedApiKey)
    || (requiresOAuthClient && (!trimmedClientId || !trimmedClientSecret));

  async function submit() {
    try {
      const oauthClient = requiresOAuthClient
        ? { clientId: trimmedClientId, clientSecret: trimmedClientSecret }
        : undefined;
      const setupRequest = pluginSetupRequest({
        apiKey: trimmedApiKey,
        authType,
        credentialMode,
        ...(oauthClient ? { oauthClient } : {}),
      });
      const configured = await configureConnection.mutateAsync({
        pluginId: activeTarget.plugin.id,
        configObjectId: activeTarget.connection.configObjectId,
        serverName: activeTarget.connection.serverName,
        ...setupRequest,
      });
      setApiKey("");
      setResult(configured);
    } catch {
      setApiKey("");
      // The mutation error is rendered below.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        className="max-h-[calc(100vh-3rem)] w-full max-w-xl overflow-y-auto rounded-[24px] border border-gray-200 bg-white p-5 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)] sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        {result ? (
          <>
            <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">Connection configured</h2>
            <p className="mt-2 text-[13px] leading-6 text-gray-600">
              {successCopy?.body}
            </p>
            <div className="mt-6 flex justify-end">
              <DenButton variant="primary" onClick={onClose}>Done</DenButton>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">Configure {serviceName}</h2>
                <p className="mt-1 text-[12.5px] leading-5 text-gray-500">
                  Required by {target.plugin.name}. Access follows this marketplace.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                onClick={onClose}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-100 bg-gray-50">
                <div className="flex items-center gap-3 px-3.5 py-2.5">
                  <span className="w-[92px] shrink-0 text-[11.5px] font-medium text-gray-500">MCP server</span>
                  <span className="min-w-0 truncate font-mono text-[11.5px] text-gray-700" title={target.connection.url}>
                    {target.connection.url}
                  </span>
                </div>
                {!authAssumed ? (
                  <div className="flex items-center gap-3 px-3.5 py-2.5">
                    <span className="w-[92px] shrink-0 text-[11.5px] font-medium text-gray-500">Authentication</span>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-gray-700 ring-1 ring-gray-200">
                      {pluginSetupAuthLabel(authType)}
                    </span>
                  </div>
                ) : null}
              </div>

              {authAssumed ? (
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Authentication method</label>
                  <DenSelect
                    value={authType}
                    onChange={(event) => {
                      const nextAuthType = authTypeFromSelect(event.target.value);
                      setAuthType(nextAuthType);
                      setCredentialMode(pluginSetupCredentialMode(nextAuthType, credentialMode));
                    }}
                  >
                    <option value="oauth">OAuth</option>
                    <option value="apikey">API key</option>
                    <option value="none">No authentication</option>
                  </DenSelect>
                  <p className="mt-1.5 text-[11.5px] leading-4 text-gray-500">
                    No matching preset. Confirm how this server authenticates.
                  </p>
                </div>
              ) : null}

              {authType === "apikey" ? (
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">{serviceName} API key</label>
                  <DenInput type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="API key" autoComplete="off" />
                  <p className="mt-1.5 text-[11.5px] leading-4 text-gray-500">
                    Stored securely as a shared marketplace credential.
                  </p>
                </div>
              ) : null}

              {authType === "oauth" ? (
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Account access</label>
                  <DenSelect value={credentialMode} onChange={(event) => setCredentialMode(event.target.value === "shared" ? "shared" : "per_member")}>
                    <option value="per_member">Each user connects their own account</option>
                    <option value="shared">Organization-shared account</option>
                  </DenSelect>
                  <p className="mt-1.5 text-[11.5px] leading-4 text-gray-500">
                    {credentialMode === "per_member"
                      ? "Each assigned member connects their own account."
                      : "An admin connects one account for the organization."}
                  </p>
                </div>
              ) : authType === "none" ? (
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-3.5 py-2.5 text-[12px] text-gray-600">
                  No credentials are required.
                </div>
              ) : null}

              {requiresOAuthClient ? (
                <div className="rounded-xl border border-gray-100 bg-gray-50 p-3.5">
                  <p className="text-[12.5px] font-semibold text-gray-900">OAuth credentials</p>
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Client ID</label>
                      <DenInput value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Client ID" />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Client secret</label>
                      <DenInput type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder="Client secret" />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {configureConnection.error ? (
              <p className="mt-3 text-[13px] text-red-600">{configureConnection.error instanceof Error ? configureConnection.error.message : "Failed to configure connection."}</p>
            ) : null}

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <DenButton variant="secondary" onClick={onClose} disabled={configureConnection.isPending}>Cancel</DenButton>
              <DenButton variant="primary" loading={configureConnection.isPending} disabled={saveDisabled} onClick={() => void submit()}>
                Configure
              </DenButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
