"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowLeft, Check, FileText, MoreHorizontal, Pencil, Plus, Puzzle, Server, Store, Terminal, Users, Webhook, X } from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";

import { getMarketplaceRoute, getNewPluginSkillRoute, getOrgAccessFlags, getPluginSkillRoute, getPluginsRoute } from "../../_lib/den-org";
import { buttonVariants, DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { DenTextarea } from "../../_components/ui/textarea";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  type DenMarketplace,
  useAssignMarketplacePlugin,
  useMarketplaces,
  useRemoveMarketplacePlugin,
} from "./marketplace-data";
import { MarketplaceLogo } from "./marketplace-logo";
import {
  type DenPlugin,
  type PluginHook,
  type PluginMcp,
  type PluginSkill,
  type PluginAgent,
  type PluginCommand,
  formatPluginTimestamp,
  useArchivePlugin,
  usePlugin,
  useUpdatePlugin,
} from "./plugin-data";

type PluginDetailTab = "contents" | "marketplaces";

export function PluginDetailScreen({ pluginId }: { pluginId: string }) {
  const router = useRouter();
  const { orgContext, orgSlug } = useOrgDashboard();
  const { data: plugin, isLoading, error, refetch } = usePlugin(pluginId);
  const archivePlugin = useArchivePlugin();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<PluginDetailTab>("contents");
  const [editPlugin, setEditPlugin] = useState<{ name: string; description: string } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles ?? [],
  );

  useEffect(() => {
    if (!actionsOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (actionsRef.current && !event.composedPath().includes(actionsRef.current)) {
        setActionsOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [actionsOpen]);

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
  if (plugin.agents.length === 0) missingLabels.push("agents");
  if (plugin.commands.length === 0) missingLabels.push("commands");
  if (plugin.hooks.length === 0) missingLabels.push("hooks");
  if (plugin.mcps.length === 0) missingLabels.push("MCP servers");
  const tabs: readonly TabItem<PluginDetailTab>[] = [
    { value: "contents", label: "Contents", icon: Puzzle },
    { value: "marketplaces", label: "Marketplaces", icon: Store, count: marketplaces.length },
  ];

  async function handleArchivePlugin() {
    try {
      await archivePlugin.mutateAsync(pluginId);
      setArchiveOpen(false);
      router.push(getPluginsRoute(orgSlug));
      router.refresh();
    } catch {
      // The mutation error is rendered in the confirmation dialog.
    }
  }

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
        {access.isAdmin ? (
          <div ref={actionsRef} className="relative">
            <button
              type="button"
              onClick={() => setActionsOpen((current) => !current)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900"
              aria-label={`More actions for ${plugin.name}`}
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              data-testid="plugin-actions-trigger"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </button>
            {actionsOpen ? (
              <div
                role="menu"
                aria-label={`Actions for ${plugin.name}`}
                className="absolute right-0 top-10 z-30 w-44 overflow-hidden rounded-2xl border border-gray-100 bg-white p-1.5 text-[13px] shadow-xl shadow-gray-900/10"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionsOpen(false);
                    setEditPlugin({ name: plugin.name, description: plugin.description });
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-gray-600 transition hover:bg-gray-50 hover:text-gray-900"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  Edit
                </button>
                <div className="my-1 border-t border-gray-100" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionsOpen(false);
                    archivePlugin.reset();
                    setArchiveOpen(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-red-600 transition hover:bg-red-50"
                  data-testid="archive-plugin-action"
                >
                  <Archive className="h-3.5 w-3.5" aria-hidden />
                  Archive
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
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

            <p className="mt-3 text-[11.5px] text-gray-400">
              Updated {formatPluginTimestamp(plugin.updatedAt)}
            </p>
          </div>
        </div>
      </article>

      <UnderlineTabs className="mt-6" tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === "contents" ? (
        <div role="tabpanel" aria-label="Contents">
          <div className="mt-6 space-y-6">
            <SkillsSection orgSlug={orgSlug} plugin={plugin} />
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
      ) : null}

      {activeTab === "marketplaces" ? (
        <div role="tabpanel" aria-label="Marketplaces" className="mt-6">
          <PluginMarketplacesSection
            orgSlug={orgSlug}
            plugin={plugin}
            canManage={access.isAdmin}
            onChanged={() => refetch()}
          />
        </div>
      ) : null}

      {editPlugin ? (
        <EditPluginDialog
          pluginId={plugin.id}
          initialName={editPlugin.name}
          initialDescription={editPlugin.description}
          onClose={() => setEditPlugin(null)}
          onSaved={() => {
            setEditPlugin(null);
            void refetch();
          }}
        />
      ) : null}
      <ArchivePluginDialog
        open={archiveOpen}
        pluginName={plugin.name}
        busy={archivePlugin.isPending}
        error={archivePlugin.error}
        onClose={() => {
          if (!archivePlugin.isPending) setArchiveOpen(false);
        }}
        onConfirm={() => void handleArchivePlugin()}
      />
    </div>
  );
}

function PluginMarketplacesSection({
  orgSlug,
  plugin,
  canManage,
  onChanged,
}: {
  orgSlug: string | null;
  plugin: DenPlugin;
  canManage: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const { data: allMarketplaces = [], isLoading, error } = useMarketplaces();
  const assignMarketplace = useAssignMarketplacePlugin();
  const removeMarketplace = useRemoveMarketplacePlugin();
  const [marketplaceToRemove, setMarketplaceToRemove] = useState<DenMarketplace | null>(null);
  const assignedIds = new Set((plugin.marketplaces ?? []).map((marketplace) => marketplace.id));
  const assignedMarketplaces = (plugin.marketplaces ?? []).map((marketplace) => (
    allMarketplaces.find((candidate) => candidate.id === marketplace.id) ?? {
      id: marketplace.id,
      name: marketplace.name,
      description: null,
      logoUrl: null,
      pluginCount: 0,
      createdAt: "",
      updatedAt: "",
    }
  ));
  const availableMarketplaces = allMarketplaces.filter((marketplace) => !assignedIds.has(marketplace.id));
  const busy = assignMarketplace.isPending || removeMarketplace.isPending;

  async function handleAdd(marketplaceId: string) {
    try {
      await assignMarketplace.mutateAsync({ marketplaceId, pluginId: plugin.id });
      await onChanged();
    } catch {
      // The mutation error is rendered in the section.
    }
  }

  async function handleRemove() {
    if (!marketplaceToRemove) return;
    try {
      await removeMarketplace.mutateAsync({ marketplaceId: marketplaceToRemove.id, pluginId: plugin.id });
      setMarketplaceToRemove(null);
      await onChanged();
    } catch {
      // The mutation error is rendered in the confirmation dialog.
    }
  }

  return (
    <section>
      <div className="mb-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
          Marketplace access
        </h2>
        <p className="mt-1 text-[12.5px] text-gray-500">
          Choose the Marketplaces where members can discover this plugin.
        </p>
      </div>

      <div className="overflow-visible rounded-2xl border border-gray-100 bg-white" data-testid="plugin-marketplace-assignment-controls">
        <div className="px-5 py-4">
          <div className="mb-2 flex items-center gap-2">
            <Store className="h-3.5 w-3.5 text-gray-400" aria-hidden />
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Marketplaces</p>
          </div>

          {assignedMarketplaces.length === 0 ? (
            <p className="text-[12.5px] text-gray-400">This plugin is not in a Marketplace yet.</p>
          ) : (
            <div className="space-y-2">
              {assignedMarketplaces.map((marketplace) => (
                <div key={marketplace.id} className="flex items-center gap-3 rounded-xl bg-gray-50 px-3 py-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white">
                    <MarketplaceLogo
                      logoUrl={marketplace.logoUrl}
                      name={marketplace.name}
                      imgClassName="h-4 w-4"
                      iconClassName="h-4 w-4"
                    />
                  </div>
                  <Link href={getMarketplaceRoute(orgSlug, marketplace.id)} className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-gray-900">{marketplace.name}</p>
                    {marketplace.description ? (
                      <p className="truncate text-[11.5px] text-gray-500">{marketplace.description}</p>
                    ) : null}
                  </Link>
                  {canManage ? (
                    <button
                      type="button"
                      aria-label={`Remove ${marketplace.name}`}
                      disabled={busy}
                      onClick={() => {
                        removeMarketplace.reset();
                        setMarketplaceToRemove(marketplace);
                      }}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-200 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid={`remove-plugin-marketplace-${marketplace.id}`}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {canManage ? (
            <MarketplaceAddPicker
              options={availableMarketplaces}
              loading={isLoading}
              disabled={busy}
              onAdd={(marketplaceId) => void handleAdd(marketplaceId)}
            />
          ) : null}

          {error ? <p className="mt-2 text-[12px] text-red-600">Failed to load available Marketplaces.</p> : null}
          {assignMarketplace.error ? (
            <p className="mt-2 text-[12px] text-red-600">
              {assignMarketplace.error instanceof Error ? assignMarketplace.error.message : "Failed to add Marketplace."}
            </p>
          ) : null}
        </div>
      </div>

      <RemovePluginMarketplaceDialog
        marketplace={marketplaceToRemove}
        pluginName={plugin.name}
        busy={removeMarketplace.isPending}
        error={removeMarketplace.error}
        onClose={() => {
          if (!removeMarketplace.isPending) setMarketplaceToRemove(null);
        }}
        onConfirm={() => void handleRemove()}
      />
    </section>
  );
}

function MarketplaceAddPicker({
  options,
  loading,
  disabled,
  onAdd,
}: {
  options: DenMarketplace[];
  loading: boolean;
  disabled: boolean;
  onAdd: (marketplaceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((marketplace) => (
      marketplace.name.toLowerCase().includes(normalized)
      || marketplace.description?.toLowerCase().includes(normalized)
    ));
  }, [options, query]);

  if (!loading && options.length === 0) {
    return <p className="mt-3 text-[11.5px] text-gray-400">Added to every available Marketplace.</p>;
  }

  return (
    <div ref={ref} className="relative mt-3 inline-block">
      <button
        type="button"
        disabled={disabled || loading}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-200 px-2.5 py-1 text-[11.5px] text-gray-500 transition hover:border-gray-400 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="add-plugin-marketplace"
      >
        <Plus className="h-3 w-3" aria-hidden />
        {loading ? "Loading Marketplaces…" : "Add Marketplace"}
      </button>

      {open ? (
        <div className="absolute left-0 top-[calc(100%+4px)] z-20 w-[280px] overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-[0_20px_40px_-16px_rgba(15,23,42,0.18)]">
          <div className="border-b border-gray-100 px-3 py-2">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Marketplaces..."
              className="w-full bg-transparent text-[12.5px] text-gray-900 placeholder:text-gray-400 focus:outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-[240px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-gray-400">No matches</p>
            ) : (
              filtered.map((marketplace) => (
                <button
                  key={marketplace.id}
                  type="button"
                  onClick={() => {
                    onAdd(marketplace.id);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-gray-50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium text-gray-900">{marketplace.name}</p>
                    <p className="truncate text-[11px] text-gray-500">{marketplace.description ?? "Organization Marketplace"}</p>
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

function RemovePluginMarketplaceDialog({
  marketplace,
  pluginName,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  marketplace: DenMarketplace | null;
  pluginName: string;
  busy: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!marketplace) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={busy ? undefined : onClose}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-plugin-marketplace-title"
        aria-describedby="remove-plugin-marketplace-description"
        className="w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="remove-plugin-marketplace-title" className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
          Remove {marketplace.name}?
        </h2>
        <p id="remove-plugin-marketplace-description" className="mt-2 text-[13px] leading-6 text-gray-600">
          This removes {pluginName} from {marketplace.name} only. The Plugin and Marketplace remain available.
        </p>
        {error ? (
          <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-[12.5px] text-red-600">
            {error instanceof Error ? error.message : "Failed to remove Marketplace."}
          </p>
        ) : null}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose} disabled={busy}>Cancel</DenButton>
          <DenButton variant="destructive" loading={busy} onClick={onConfirm} data-testid="confirm-remove-plugin-marketplace">
            Remove Marketplace
          </DenButton>
        </div>
      </div>
    </div>
  );
}

function EditPluginDialog({
  pluginId,
  initialName,
  initialDescription,
  onClose,
  onSaved,
}: {
  pluginId: string;
  initialName: string;
  initialDescription: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const updatePlugin = useUpdatePlugin();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const unchanged = trimmedName === initialName && trimmedDescription === initialDescription;

  async function handleSave() {
    try {
      await updatePlugin.mutateAsync({
        pluginId,
        name: trimmedName,
        description: trimmedDescription || null,
      });
      onSaved();
    } catch {
      // The mutation error is rendered in the dialog.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={updatePlugin.isPending ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-plugin-title"
        className="w-full max-w-[440px] rounded-2xl border border-gray-100 bg-white p-6 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.4)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="edit-plugin-title" className="text-[16px] font-semibold tracking-[-0.01em] text-gray-950">
          Edit plugin
        </h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-500">
          Update the name and description shown throughout Den.
        </p>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Name</span>
          <DenInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={updatePlugin.isPending}
            data-testid="plugin-edit-name"
            autoFocus
          />
        </label>
        <label className="mt-3 block">
          <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Description (optional)</span>
          <DenTextarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={updatePlugin.isPending}
            rows={3}
            data-testid="plugin-edit-description"
          />
        </label>
        {updatePlugin.error ? (
          <p className="mt-3 text-[12.5px] text-red-600">
            {updatePlugin.error instanceof Error ? updatePlugin.error.message : "Failed to update plugin."}
          </p>
        ) : null}
        <div className="mt-5 flex items-center justify-end gap-2">
          <DenButton variant="secondary" onClick={onClose} disabled={updatePlugin.isPending}>
            Cancel
          </DenButton>
          <DenButton
            loading={updatePlugin.isPending}
            disabled={!trimmedName || unchanged}
            onClick={() => void handleSave()}
            data-testid="plugin-edit-save"
          >
            Save changes
          </DenButton>
        </div>
      </div>
    </div>
  );
}

function ArchivePluginDialog({
  open,
  pluginName,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  pluginName: string;
  busy: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={busy ? undefined : onClose}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="archive-plugin-title"
        aria-describedby="archive-plugin-description"
        className="w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="archive-plugin-title" className="text-[17px] font-semibold tracking-[-0.02em] text-gray-950">
          Archive “{pluginName}”?
        </h2>
        <p id="archive-plugin-description" className="mt-2 text-[13px] leading-6 text-gray-500">
          This removes the plugin from active Den lists without deleting its historical skills, marketplace relationships, or audit trail.
        </p>
        {error ? (
          <p className="mt-3 text-[12.5px] text-red-600">
            {error instanceof Error ? error.message : "Failed to archive plugin."}
          </p>
        ) : null}
        <div className="mt-5 flex items-center justify-end gap-2">
          <DenButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </DenButton>
          <DenButton variant="destructive" loading={busy} onClick={onConfirm} data-testid="archive-plugin-confirm">
            Archive plugin
          </DenButton>
        </div>
      </div>
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

function SkillsSection({ orgSlug, plugin }: { orgSlug: string | null; plugin: DenPlugin }) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
            <FileText className="h-3.5 w-3.5" />
            Skills
          </h2>
          <p className="mt-1 text-[12px] text-gray-400">Reusable instructions included in this plugin.</p>
        </div>
        <Link href={getNewPluginSkillRoute(orgSlug, plugin.id)} className={buttonVariants({ size: "sm" })}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add skill
        </Link>
      </div>
      {plugin.skills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white px-5 py-8 text-center">
          <p className="text-[14px] font-medium text-gray-900">No skills in this plugin yet.</p>
          <p className="mt-1 text-[12.5px] text-gray-500">Add reusable guidance without leaving this plugin.</p>
        </div>
      ) : (
        <div className="grid gap-2">
          {plugin.skills.map((skill) => (
            <SkillRow key={skill.id} orgSlug={orgSlug} pluginId={plugin.id} skill={skill} />
          ))}
        </div>
      )}
    </section>
  );
}

function SkillRow({ orgSlug, pluginId, skill }: { orgSlug: string | null; pluginId: string; skill: PluginSkill }) {
  return (
    <Link
      href={getPluginSkillRoute(orgSlug, pluginId, skill.id)}
      className="block rounded-xl border border-gray-100 bg-white px-4 py-3 transition hover:border-gray-200"
    >
      <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900">{skill.name}</p>
      {skill.description ? (
        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">{skill.description}</p>
      ) : null}
    </Link>
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
        {mcp.transport === "stdio" ? "Desktop only" : "Remote"} · {mcp.toolCount} tool{mcp.toolCount === 1 ? "" : "s"}
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
