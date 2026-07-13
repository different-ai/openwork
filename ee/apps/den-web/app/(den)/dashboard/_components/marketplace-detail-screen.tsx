"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useEffect } from "react";
import { Archive, ArrowLeft, BookOpen, Check, GitBranch, Github, Globe, Loader2, Pencil, Plus, Puzzle, Server, ShieldCheck, Users, X } from "lucide-react";
import { PaperMeshGradient, StaticSeededGradient } from "@openwork/ui/react";
import {
  getGithubIntegrationSetupRoute,
  getMarketplacesRoute,
  getPluginRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import {
  type DenMarketplace,
  formatMarketplaceTimestamp,
  isSystemMarketplace,
  type MarketplacePluginSummary,
  useAddPluginToMarketplace,
  useArchiveMarketplace,
  useGrantMarketplaceAccess,
  useMarketplace,
  useMarketplaceAccess,
  useRemovePluginFromMarketplace,
  useRevokeMarketplaceAccess,
  useUpdateMarketplace,
} from "./marketplace-data";
import { usePlugins } from "./plugin-data";
import { MarketplaceLogo } from "./marketplace-logo";
import {
  type PluginMcpConfigField,
  type PluginMcpServerInstance,
  type PluginMcpServerTemplate,
  useConfigurePluginServerInstance,
  usePluginServerTemplates,
  useRemovePluginServerInstance,
  useSetConfigObjectStatus,
} from "./plugin-server-data";

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
  // Seeded marketplaces are looked up by name and re-provisioned lazily, so
  // renaming or archiving them would just respawn a copy — their identity is
  // managed. "Your organization" additionally accepts custom composition.
  const managedIdentity = isSystemMarketplace(marketplace);
  const managedCatalog = managedIdentity && marketplace.name !== "Your organization";

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
        <MarketplaceIdentityActions managedIdentity={managedIdentity} marketplace={marketplace} />
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

        <MarketplacePluginsSection
          managedCatalog={managedCatalog}
          marketplaceId={marketplace.id}
          orgSlug={orgSlug}
          plugins={plugins}
        />
      </div>
    </div>
  );
}

function MarketplaceIdentityActions({
  managedIdentity,
  marketplace,
}: {
  managedIdentity: boolean;
  marketplace: DenMarketplace;
}) {
  const router = useRouter();
  const { orgSlug } = useOrgDashboard();
  const archiveMutation = useArchiveMarketplace();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  if (managedIdentity) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-50 px-3 py-1 text-[12px] font-medium text-gray-500">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
        Managed by OpenWork
      </span>
    );
  }

  async function archive() {
    await archiveMutation.mutateAsync(marketplace.id);
    router.push(getMarketplacesRoute(orgSlug));
  }

  return (
    <div className="flex items-center gap-2">
      {confirmArchive ? (
        <>
          <span className="text-[12.5px] text-gray-500">Archive this marketplace?</span>
          <DenButton
            size="sm"
            variant="secondary"
            disabled={archiveMutation.isPending}
            onClick={() => setConfirmArchive(false)}
          >
            Keep
          </DenButton>
          <DenButton size="sm" loading={archiveMutation.isPending} onClick={() => void archive()}>
            Archive
          </DenButton>
        </>
      ) : (
        <>
          <DenButton size="sm" variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>
            Edit
          </DenButton>
          <DenButton size="sm" variant="secondary" icon={Archive} onClick={() => setConfirmArchive(true)}>
            Archive
          </DenButton>
        </>
      )}
      {archiveMutation.error ? (
        <span className="text-[12px] text-red-600">
          {archiveMutation.error instanceof Error ? archiveMutation.error.message : "Failed to archive."}
        </span>
      ) : null}

      <EditMarketplaceDialog
        open={editOpen}
        marketplace={marketplace}
        onClose={() => setEditOpen(false)}
      />
    </div>
  );
}

function EditMarketplaceDialog({
  open,
  marketplace,
  onClose,
}: {
  open: boolean;
  marketplace: DenMarketplace;
  onClose: () => void;
}) {
  const updateMutation = useUpdateMarketplace();
  const [name, setName] = useState(marketplace.name);
  const [description, setDescription] = useState(marketplace.description ?? "");

  useEffect(() => {
    if (!open) return;
    setName(marketplace.name);
    setDescription(marketplace.description ?? "");
  }, [open, marketplace.name, marketplace.description]);

  if (!open) {
    return null;
  }

  const trimmedName = name.trim();

  async function submit() {
    await updateMutation.mutateAsync({
      marketplaceId: marketplace.id,
      name: trimmedName,
      description: description.trim() || null,
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        className="w-full max-w-[440px] rounded-2xl border border-gray-100 bg-white p-6 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.4)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-gray-950">Edit marketplace</h2>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Name</span>
          <DenInput value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <label className="mt-3 block">
          <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Description</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            className="w-full resize-none rounded-xl border border-gray-200 px-3 py-2 text-[13px] text-gray-900 outline-none transition placeholder:text-gray-300 focus:border-gray-400"
          />
        </label>

        {updateMutation.error ? (
          <p className="mt-3 text-[12.5px] text-red-600">
            {updateMutation.error instanceof Error ? updateMutation.error.message : "Failed to update marketplace."}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <DenButton variant="secondary" onClick={onClose} disabled={updateMutation.isPending}>
            Cancel
          </DenButton>
          <DenButton disabled={!trimmedName || updateMutation.isPending} onClick={() => void submit()}>
            {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Save changes
          </DenButton>
        </div>
      </div>
    </div>
  );
}

function MarketplacePluginsSection({
  managedCatalog,
  marketplaceId,
  orgSlug,
  plugins,
}: {
  managedCatalog: boolean;
  marketplaceId: string;
  orgSlug: string | null;
  plugins: MarketplacePluginSummary[];
}) {
  const pluginsQuery = usePlugins();
  const addMutation = useAddPluginToMarketplace();
  const removeMutation = useRemovePluginFromMarketplace();

  const currentIds = useMemo(() => new Set(plugins.map((plugin) => plugin.id)), [plugins]);
  const addable = (pluginsQuery.data ?? []).filter((plugin) => !currentIds.has(plugin.id));

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
          Plugins
        </h2>
        {managedCatalog ? (
          <p className="text-[11px] text-gray-400">
            {plugins.length} plugin{plugins.length === 1 ? "" : "s"} · curated by OpenWork
          </p>
        ) : (
          <AccessAddPicker
            label="Plugins"
            options={addable.map((plugin) => ({
              id: plugin.id,
              label: plugin.name,
              subtitle: plugin.description ?? "Plugin",
            }))}
            emptyLabel="Every plugin in your library is already here"
            disabled={addMutation.isPending}
            onAdd={(pluginId) => void addMutation.mutateAsync({ marketplaceId, pluginId })}
          />
        )}
      </div>

      {addMutation.error ? (
        <p className="mb-3 text-[12px] text-red-600">
          {addMutation.error instanceof Error ? addMutation.error.message : "Failed to add the plugin."}
        </p>
      ) : null}
      {removeMutation.error ? (
        <p className="mb-3 text-[12px] text-red-600">
          {removeMutation.error instanceof Error ? removeMutation.error.message : "Failed to remove the plugin."}
        </p>
      ) : null}

      {plugins.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-5 py-10 text-center">
          <p className="text-[14px] font-medium tracking-[-0.02em] text-gray-800">
            No plugins in this marketplace yet
          </p>
          <p className="mx-auto mt-2 max-w-[420px] text-[13px] leading-6 text-gray-500">
            Add plugins from your library with the picker above, import from GitHub, or connect a source repository.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {plugins.map((plugin) => (
            <MarketplacePluginCard
              key={plugin.id}
              orgSlug={orgSlug}
              plugin={plugin}
              onRemove={managedCatalog
                ? undefined
                : () => void removeMutation.mutateAsync({ marketplaceId, pluginId: plugin.id })}
              removing={removeMutation.isPending}
            />
          ))}
        </div>
      )}
    </section>
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
  onRemove,
  removing,
}: {
  orgSlug: string | null;
  plugin: MarketplacePluginSummary;
  onRemove?: () => void;
  removing?: boolean;
}) {
  const orderedCountEntries = Object.entries(plugin.componentCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <article className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
      <Link
        href={getPluginRoute(orgSlug, plugin.id)}
        className="group block transition hover:bg-gray-50/60"
      >
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
          </div>
        </div>
      </Link>
      <MarketplacePluginResourceSummary pluginId={plugin.id} />
      {onRemove ? (
        <div className="flex justify-end border-t border-gray-50 px-4 py-2">
          <button
            type="button"
            disabled={removing}
            onClick={onRemove}
            className="rounded-full px-2.5 py-1 text-[11.5px] font-medium text-gray-400 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Remove from marketplace
          </button>
        </div>
      ) : null}
    </article>
  );
}

function MarketplacePluginResourceSummary({ pluginId }: { pluginId: string }) {
  const templatesQuery = usePluginServerTemplates(pluginId);
  const statusMutation = useSetConfigObjectStatus();

  if (templatesQuery.isLoading) {
    return <div className="border-t border-gray-100 px-4 py-3 text-[12px] text-gray-400">Loading resources...</div>;
  }

  if (templatesQuery.error || !templatesQuery.data) {
    return null;
  }

  const { instances, mcpTemplates, skills } = templatesQuery.data;
  if (instances.length === 0 && mcpTemplates.length === 0 && skills.length === 0) {
    return null;
  }

  async function toggleSkill(configObjectId: string, active: boolean) {
    await statusMutation.mutateAsync({
      configObjectId,
      pluginId,
      status: active ? "inactive" : "active",
    });
  }

  return (
    <div className="space-y-3 border-t border-gray-100 px-4 py-3">
      {mcpTemplates.length > 0 ? (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">
            <Server className="h-3.5 w-3.5" aria-hidden />
            MCP servers
          </div>
          <div className="space-y-1.5">
            {mcpTemplates.map((template) => {
              const templateInstances = instances.filter((instance) => instance.serverKey === template.serverKey);
              return (
                <McpTemplateRow
                  key={`${template.configObjectId}:${template.serverKey}`}
                  instances={templateInstances}
                  pluginId={pluginId}
                  template={template}
                />
              );
            })}
          </div>
        </div>
      ) : null}

      {skills.length > 0 ? (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">
            <BookOpen className="h-3.5 w-3.5" aria-hidden />
            Skills
          </div>
          <div className="space-y-1.5">
            {skills.map((skill) => {
              const active = skill.status === "active";
              return (
                <button
                  key={skill.configObjectId}
                  type="button"
                  disabled={statusMutation.isPending}
                  onClick={() => void toggleSkill(skill.configObjectId, active)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl bg-gray-50 px-3 py-2 text-left transition hover:bg-gray-100 disabled:opacity-60"
                >
                  <span className="min-w-0">
                    <span className={`block truncate text-[12.5px] font-medium ${active ? "text-gray-900" : "text-gray-400"}`}>
                      {skill.title}
                    </span>
                    {skill.description ? (
                      <span className="mt-0.5 block truncate text-[11.5px] text-gray-400">{skill.description}</span>
                    ) : null}
                  </span>
                  <span className={`relative inline-flex h-6 w-[42px] shrink-0 items-center rounded-full transition-colors ${active ? "bg-[#0f172a]" : "bg-gray-200"}`}>
                    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-[0_2px_6px_-1px_rgba(15,23,42,0.3)] transition-transform ${active ? "translate-x-[18px]" : "translate-x-0.5"}`} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function mcpAuthLabel(authType: "oauth" | "apikey" | "none") {
  if (authType === "apikey") return "API key";
  if (authType === "none") return "No auth";
  return "OAuth";
}

function configFieldApplies(field: PluginMcpConfigField, authType: "oauth" | "apikey" | "none") {
  if (field.placement === "bearer") return authType === "apikey";
  if (field.placement === "oauth_client_id" || field.placement === "oauth_client_secret") return authType === "oauth";
  return true;
}

function configFieldInputType(field: PluginMcpConfigField) {
  if (field.kind === "secret") return "password";
  if (field.kind === "url") return "url";
  return "text";
}

function currentFieldValue(values: Array<{ key: string; value: string }>, key: string) {
  return values.find((entry) => entry.key === key)?.value ?? "";
}

function updateFieldValues(values: Array<{ key: string; value: string }>, key: string, value: string) {
  const next = values.filter((entry) => entry.key !== key);
  return value ? [...next, { key, value }] : next;
}

function McpTemplateRow({
  instances,
  pluginId,
  template,
}: {
  instances: PluginMcpServerInstance[];
  pluginId: string;
  template: PluginMcpServerTemplate;
}) {
  const configureMutation = useConfigurePluginServerInstance();
  const removeMutation = useRemovePluginServerInstance();
  const [configureOpen, setConfigureOpen] = useState(false);
  const [instanceLabel, setInstanceLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [authType, setAuthType] = useState<"oauth" | "apikey" | "none">(template.authType);
  const [credentialMode, setCredentialMode] = useState<"shared" | "per_member">(template.credentialModeDefault);
  const [fieldValues, setFieldValues] = useState<Array<{ key: string; value: string }>>([]);

  const busy = configureMutation.isPending || removeMutation.isPending;
  const trimmedLabel = instanceLabel.trim();
  const instanceName = trimmedLabel ? `${template.name} (${trimmedLabel})` : template.name;
  const visibleConfigFields = template.configFields.filter((field) => configFieldApplies(field, authType));
  const hasBearerField = visibleConfigFields.some((field) => field.placement === "bearer");
  const missingRequiredField = visibleConfigFields.some((field) => field.required && !currentFieldValue(fieldValues, field.key).trim());
  const apiKeyMissing = authType === "apikey" && !hasBearerField && !apiKey.trim();
  const canConfigure = !busy && !missingRequiredField && !apiKeyMissing;

  async function configure() {
    await configureMutation.mutateAsync({
      access: { orgWide: true, memberIds: [], teamIds: [] },
      apiKey: authType === "apikey" && !hasBearerField ? apiKey.trim() : undefined,
      authType,
      configObjectId: template.configObjectId,
      credentialMode: authType === "oauth" ? credentialMode : "shared",
      fieldValues: fieldValues
        .filter((entry) => entry.value.trim())
        .map((entry) => ({ key: entry.key, value: entry.value.trim() })),
      instanceLabel: trimmedLabel || null,
      name: instanceName,
      pluginId,
      serverKey: template.serverKey,
    });
    setConfigureOpen(false);
    setApiKey("");
    setFieldValues([]);
    setInstanceLabel("");
  }

  async function remove(instanceId: string) {
    await removeMutation.mutateAsync({ deleteConnection: true, instanceId, pluginId });
  }

  return (
    <div className="rounded-xl bg-gray-50 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-gray-900">{template.name}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-gray-400">{template.url}</p>
        </div>
        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11.5px] text-gray-500">
          {instances.length} configured
        </span>
      </div>

      {instances.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {instances.map((instance) => (
            <div
              key={instance.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-gray-100 bg-white px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11.5px] font-medium text-gray-800">
                  {instance.instanceLabel || instance.connection?.name || "Configured server"}
                </p>
                <p className="mt-0.5 truncate text-[10.5px] text-gray-400">
                  {instance.connection?.credentialMode === "shared" ? "One org account" : "Individual accounts"}
                  <span className="px-1 text-gray-300">·</span>
                  {instance.connection ? mcpAuthLabel(instance.connection.authType) : "Configured"}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(instance.id)}
                className="rounded-full px-2 py-1 text-[11px] font-medium text-gray-500 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {configureOpen ? (
        <div className="mt-2 rounded-lg border border-gray-100 bg-white px-3 py-3">
          <div className="grid gap-2 md:grid-cols-3">
            <label className="min-w-0">
              <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-gray-400">
                Label
              </span>
              <input
                value={instanceLabel}
                onChange={(event) => setInstanceLabel(event.target.value)}
                placeholder="Prod"
                className="h-8 w-full rounded-lg border border-gray-200 px-2 text-[12px] text-gray-900 outline-none transition placeholder:text-gray-300 focus:border-gray-400"
              />
            </label>
            <label className="min-w-0">
              <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-gray-400">
                Authentication
              </span>
              <select
                value={authType}
                onChange={(event) => {
                  const next = event.target.value === "apikey" ? "apikey" : event.target.value === "none" ? "none" : "oauth";
                  setAuthType(next);
                  if (next !== "oauth") setCredentialMode("shared");
                }}
                className="h-8 w-full rounded-lg border border-gray-200 bg-white px-2 text-[12px] text-gray-900 outline-none transition focus:border-gray-400"
              >
                <option value="oauth">OAuth</option>
                <option value="apikey">API key</option>
                <option value="none">No auth</option>
              </select>
            </label>
            <label className="min-w-0">
              <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-gray-400">
                Account
              </span>
              <select
                value={authType === "oauth" ? credentialMode : "shared"}
                disabled={authType !== "oauth"}
                onChange={(event) => setCredentialMode(event.target.value === "shared" ? "shared" : "per_member")}
                className="h-8 w-full rounded-lg border border-gray-200 bg-white px-2 text-[12px] text-gray-900 outline-none transition focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-400"
              >
                <option value="per_member">Individual accounts</option>
                <option value="shared">One org account</option>
              </select>
            </label>
          </div>
          {authType === "apikey" && !hasBearerField ? (
            <label className="mt-2 block min-w-0">
              <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-gray-400">
                API key
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Paste key"
                className="h-8 w-full rounded-lg border border-gray-200 px-2 text-[12px] text-gray-900 outline-none transition placeholder:text-gray-300 focus:border-gray-400"
              />
            </label>
          ) : null}
          {visibleConfigFields.length > 0 ? (
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {visibleConfigFields.map((field) => (
                <label key={field.key} className="min-w-0">
                  <span className="mb-1 block truncate text-[10.5px] font-semibold uppercase tracking-[0.12em] text-gray-400">
                    {field.label}{field.required ? "" : " (optional)"}
                  </span>
                  <input
                    type={configFieldInputType(field)}
                    value={currentFieldValue(fieldValues, field.key)}
                    onChange={(event) => setFieldValues((current) => updateFieldValues(current, field.key, event.target.value))}
                    placeholder={field.kind === "secret" ? "Paste secret" : field.label}
                    className="h-8 w-full rounded-lg border border-gray-200 px-2 text-[12px] text-gray-900 outline-none transition placeholder:text-gray-300 focus:border-gray-400"
                  />
                  {field.description ? (
                    <span className="mt-1 block text-[10.5px] leading-4 text-gray-400">{field.description}</span>
                  ) : null}
                </label>
              ))}
            </div>
          ) : null}
          <p className="mt-2 text-[11.5px] leading-5 text-gray-400">
            Access defaults to everyone in the organization. Credentials are stored only on the External MCP Connection.
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfigureOpen(false)}
              className="rounded-full px-3 py-1.5 text-[11.5px] font-medium text-gray-500 transition hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canConfigure}
              onClick={() => void configure()}
              className="inline-flex items-center gap-1.5 rounded-full bg-gray-950 px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {configureMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Plus className="h-3 w-3" aria-hidden />}
              Configure
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfigureOpen(true)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[11.5px] font-medium text-gray-700 shadow-[inset_0_0_0_1px_rgba(229,231,235,1)] transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-3 w-3" aria-hidden />
          {instances.length === 0 ? "Configure" : "Add configuration"}
        </button>
      )}

      {configureMutation.error ? (
        <p className="mt-2 text-[11.5px] leading-5 text-red-600">
          {configureMutation.error instanceof Error ? configureMutation.error.message : "Failed to configure MCP server."}
        </p>
      ) : null}
      {removeMutation.error ? (
        <p className="mt-2 text-[11.5px] leading-5 text-red-600">
          {removeMutation.error instanceof Error ? removeMutation.error.message : "Failed to remove MCP server."}
        </p>
      ) : null}
    </div>
  );
}
