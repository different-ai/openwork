"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Archive, ArrowLeft, Code2, FileText, MoreHorizontal, Pencil, Plus, Server, Store, Terminal, Users, Webhook } from "lucide-react";

import { getNewPluginSkillRoute, getOrgAccessFlags, getPluginSkillRoute, getPluginsRoute } from "../../_lib/den-org";
import { buttonVariants, DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenTextarea } from "../../_components/ui/textarea";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  type DenPlugin,
  type PluginHook,
  type PluginMcp,
  type PluginWorkflow,
  type PluginSkill,
  type PluginAgent,
  type PluginCommand,
  formatPluginTimestamp,
  useArchivePlugin,
  useAttachWorkflowToPlugin,
  usePlugin,
  useUpdatePlugin,
} from "./plugin-data";
import { CatalogIdentityTile } from "./catalog-identity-tile";
import { ItemHeader, SectionTitle } from "./item-header";
import { DetailRows, ItemMenu, ItemPanel, ItemRow, removeEntry } from "./item-list";
import { ConnectorLogo, KindTile, PluginLogo } from "./item-logo";
import { useLibraryIntegrated } from "./use-library-integrated";
import { skillTitle } from "./plugin-page-screen";
import { type PluginAccessGrant, usePluginAccess } from "./plugin-access-data";
import { PluginAccessSection } from "./plugin-access-section";
import { WorkflowDetailPanel } from "./workflow-detail-panel";
import { useLibrary, type LibraryWorkflowItem } from "./library-data";

export function PluginDetailScreen({
  pluginId,
  backHref,
}: {
  pluginId: string;
  backHref?: string;
}) {
  const router = useRouter();
  const { orgContext, orgSlug } = useOrgDashboard();
  const integrated = useLibraryIntegrated();
  const { data: plugin, isLoading, error, refetch } = usePlugin(pluginId);
  const pluginAccessQuery = usePluginAccess(pluginId);
  const archivePlugin = useArchivePlugin();
  const attachWorkflow = useAttachWorkflowToPlugin(pluginId);
  const libraryQuery = useLibrary();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [editPlugin, setEditPlugin] = useState<{ name: string; description: string } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [addWorkflowOpen, setAddWorkflowOpen] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.currentMember.permissions,
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

  if (selectedWorkflowId) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        <WorkflowDetailPanel configObjectId={selectedWorkflowId} onClose={() => setSelectedWorkflowId(null)} />
      </div>
    );
  }

  const marketplaces = plugin.marketplaces ?? [];
  const libraryItem = libraryQuery.data?.find((item) => item.type === "plugin" && item.id === plugin.id);
  // Creator, a manager on this plugin, or `sharing.manage_all` (manager on everything shared).
  const canManagePlugin = (plugin.createdByOrgMembershipId !== null && plugin.createdByOrgMembershipId === orgContext?.currentMember.id)
    || (libraryItem?.type === "plugin" && libraryItem.role === "manager")
    || access.canManageAllShared;
  const creator = orgContext?.members.find((member) => member.id === plugin.createdByOrgMembershipId) ?? null;
  const accessBlastRadius = getPluginAccessBlastRadius(
    pluginAccessQuery.data ?? [],
    orgContext?.teams ?? [],
    orgContext?.currentMember.id ?? null,
  );
  const missingLabels: string[] = [];
  if (plugin.agents.length === 0) missingLabels.push("agents");
  if (plugin.commands.length === 0) missingLabels.push("commands");
  if (plugin.hooks.length === 0) missingLabels.push("hooks");
  if (plugin.mcps.length === 0) missingLabels.push("MCP servers");
  if (plugin.workflows.length === 0) missingLabels.push("Workflows");

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
    <div className={integrated ? "mx-auto flex w-full max-w-[896px] flex-col gap-7 px-6 py-10 md:px-12" : "mx-auto max-w-[860px] px-6 py-8 md:px-8"}>
      {integrated ? <>
        <ItemHeader compact back={{ href: backHref ?? getPluginsRoute(orgSlug), label: "Plugins" }} logo={<PluginLogo name={plugin.name} size="lg" />} title={plugin.name} actions={canManagePlugin ? <ItemMenu size="md" label={`More actions for ${plugin.name}`} entries={[
          { label: "Edit", onSelect: () => setEditPlugin({ name: plugin.name, description: plugin.description }) },
          removeEntry(plugin.name, async () => { await archivePlugin.mutateAsync(pluginId); router.push(getPluginsRoute(orgSlug)); router.refresh(); }),
        ]} /> : undefined} />
        <DetailRows rows={[
          ...(plugin.description ? [{ label: "About", value: plugin.description, wrap: true }] : []),
          { label: "Made by", value: creator?.user.name ?? "Your organization" },
          { label: "Updated", value: formatPluginTimestamp(plugin.updatedAt) },
          ...(plugin.version ? [{ label: "Version", value: plugin.version }] : []),
        ]} />
      </> : <>
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link
          href={backHref ?? getPluginsRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        {canManagePlugin ? (
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

      <article className="flex items-start gap-4">
        <CatalogIdentityTile name={plugin.name} size="lg" />
        <div className="min-w-0 flex-1">
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
          <p className="mt-1.5 text-[11.5px] text-gray-400">
            Added by {creator?.user.name ?? "Unknown member"} · {formatPluginTimestamp(plugin.createdAt)}
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-gray-400">
            {marketplaces.length > 0 ? (
              <>
                <Store className="h-3 w-3" aria-hidden />
                <span className="truncate">
                  {marketplaces.map((marketplace) => marketplace.name).join(" · ")}
                </span>
                <span>·</span>
              </>
            ) : null}
            <span>Updated {formatPluginTimestamp(plugin.updatedAt)}</span>
          </p>
        </div>
      </article>
      </>}

      <div className={integrated ? "flex flex-col gap-6" : "mt-6 space-y-6"}>
        <PluginAccessSection
          pluginId={plugin.id}
          pluginCreatedByOrgMembershipId={plugin.createdByOrgMembershipId}
          grants={pluginAccessQuery.data ?? []}
          isLoading={pluginAccessQuery.isLoading}
          error={pluginAccessQuery.error}
        />
        <SkillsSection orgSlug={orgSlug} plugin={plugin} canEdit={canManagePlugin} />
        <WorkflowsSection
          plugin={plugin}
          canEdit={canManagePlugin}
          onAdd={() => {
            attachWorkflow.reset();
            setAddWorkflowOpen(true);
          }}
          onOpen={(workflowId) => setSelectedWorkflowId(workflowId)}
        />
        <PrimitiveSection icon={Users} label="Agents" items={plugin.agents} render={(item) => renderAgentRow(item, integrated)} />
        <PrimitiveSection icon={Terminal} label="Commands" items={plugin.commands} render={(item) => renderCommandRow(item, integrated)} />
        <PrimitiveSection icon={Webhook} label="Hooks" items={plugin.hooks} render={(item) => renderHookRow(item, integrated)} />
        <PrimitiveSection icon={Server} label="MCP Servers" items={plugin.mcps} render={(item) => renderMcpRow(item, integrated)} />
      </div>

      {!integrated && missingLabels.length > 0 ? (
        <p className="mt-6 text-center text-[12px] text-gray-400">
          No {formatMissingList(missingLabels)} detected in this plugin.
        </p>
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
        affectedPeopleCount={accessBlastRadius.peopleCount}
        affectedTeamCount={accessBlastRadius.teamCount}
        busy={archivePlugin.isPending}
        error={archivePlugin.error}
        onClose={() => {
          if (!archivePlugin.isPending) setArchiveOpen(false);
        }}
        onConfirm={() => void handleArchivePlugin()}
      />
      <AddWorkflowDialog
        open={addWorkflowOpen}
        plugin={plugin}
        workflows={(libraryQuery.data ?? []).filter((item): item is LibraryWorkflowItem => item.type === "workflow")}
        busy={attachWorkflow.isPending}
        error={attachWorkflow.error}
        onClose={() => {
          if (!attachWorkflow.isPending) setAddWorkflowOpen(false);
        }}
        onAttach={(workflowId) => {
          void attachWorkflow.mutateAsync(workflowId).then(() => setAddWorkflowOpen(false)).catch(() => undefined);
        }}
      />
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
  affectedPeopleCount,
  affectedTeamCount,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  pluginName: string;
  affectedPeopleCount: number;
  affectedTeamCount: number;
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
        {affectedPeopleCount > 0 ? (
          <p className="mt-3 text-[12.5px] font-medium text-amber-700">
            This removes it for {affectedPeopleCount} people across {affectedTeamCount} {affectedTeamCount === 1 ? "team" : "teams"}.
          </p>
        ) : null}
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

function getPluginAccessBlastRadius(
  grants: PluginAccessGrant[],
  teams: Array<{ id: string; memberIds: string[] }>,
  currentMemberId: string | null,
) {
  const people = new Set<string>();
  const teamIds = new Set<string>();
  const teamsById = new Map(teams.map((team) => [team.id, team]));

  for (const grant of grants) {
    if (grant.orgMembershipId) people.add(grant.orgMembershipId);
    if (grant.teamId) teamIds.add(grant.teamId);
  }
  for (const teamId of teamIds) {
    for (const memberId of teamsById.get(teamId)?.memberIds ?? []) {
      people.add(memberId);
    }
  }
  if (currentMemberId) people.delete(currentMemberId);

  return { peopleCount: people.size, teamCount: teamIds.size };
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
  const integrated = useLibraryIntegrated();
  if (items.length === 0) {
    return null;
  }
  if (integrated) return <section className="flex flex-col gap-3"><SectionTitle title={label} /><ItemPanel>{items.map((item) => render(item))}</ItemPanel></section>;

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

function SkillsSection({ orgSlug, plugin, canEdit }: { orgSlug: string | null; plugin: DenPlugin; canEdit: boolean }) {
  const integrated = useLibraryIntegrated();
  if (integrated) return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3"><SectionTitle title="Skills" />{canEdit ? <DenButton size="sm" href={getNewPluginSkillRoute(orgSlug, plugin.id)} icon={Plus}>Add skill</DenButton> : null}</div>
      <ItemPanel>
        {plugin.skills.length === 0 ? <p className="px-3 py-4 text-[13px] text-[var(--dls-text-secondary)]">No skills yet.</p> : plugin.skills.map((skill) => <ItemRow compact key={skill.id} logo={<KindTile kind="skill" />} title={skillTitle(skill.name)} description={skill.description} href={canEdit ? getPluginSkillRoute(orgSlug, plugin.id, skill.id) : undefined} />)}
      </ItemPanel>
    </section>
  );
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
        {canEdit ? (
          <Link href={getNewPluginSkillRoute(orgSlug, plugin.id)} className={buttonVariants({ size: "sm" })}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add skill
          </Link>
        ) : null}
      </div>
      {plugin.skills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white px-5 py-8 text-center">
          <p className="text-[14px] font-medium text-gray-900">No skills in this plugin yet.</p>
          <p className="mt-1 text-[12.5px] text-gray-500">Add reusable guidance without leaving this plugin.</p>
        </div>
      ) : (
        <div className="grid gap-2">
          {plugin.skills.map((skill) => (
            <SkillRow key={skill.id} orgSlug={orgSlug} pluginId={plugin.id} skill={skill} href={canEdit} />
          ))}
        </div>
      )}
    </section>
  );
}

function SkillRow({
  orgSlug,
  pluginId,
  skill,
  href,
}: {
  orgSlug: string | null;
  pluginId: string;
  skill: PluginSkill;
  href: boolean;
}) {
  const className = "block rounded-xl border border-gray-100 bg-white px-4 py-3 transition hover:border-gray-200";
  const body = (
    <>
      <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900">{skill.name}</p>
      {skill.description ? (
        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">{skill.description}</p>
      ) : null}
    </>
  );
  if (href) {
    return (
      <Link href={getPluginSkillRoute(orgSlug, pluginId, skill.id)} className={className}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}

function renderHookRow(hook: PluginHook, integrated = false) {
  if (integrated) return <div key={hook.id}><ItemRow compact title={hook.event} description={hook.description} />{hook.matcher ? <details className="px-3 pb-3 text-[13px] text-[var(--dls-text-secondary)]"><summary>Technical details</summary><DetailRows rows={[{ label: "Matcher", value: hook.matcher, wrap: true }]} /></details> : null}</div>;
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

function renderMcpRow(mcp: PluginMcp, integrated = false) {
  if (integrated) return <div key={mcp.id}><ItemRow compact logo={<ConnectorLogo name={mcp.name} url={mcp.url} />} title={mcp.name} description={mcp.description} /><details className="px-3 pb-3 text-[13px] text-[var(--dls-text-secondary)]"><summary>Technical details</summary><DetailRows rows={[{ label: "Transport", value: mcp.transport }, { label: "Tools", value: mcp.toolCount }]} /></details></div>;
  const label = mcp.connectionId ? "Connector" : mcp.transport === "stdio" ? "Desktop only" : "Remote";
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
        {label}{mcp.toolCount > 0 ? ` · ${mcp.toolCount} tool${mcp.toolCount === 1 ? "" : "s"}` : ""}
      </span>
    </div>
  );
}

function renderAgentRow(agent: PluginAgent, integrated = false) {
  if (integrated) return <ItemRow compact key={agent.id} logo={<PluginLogo name={agent.name} />} title={agent.name} description={agent.description} />;
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

function renderCommandRow(command: PluginCommand, integrated = false) {
  if (integrated) return <ItemRow compact key={command.id} logo={<KindTile kind="command" />} title={command.name} description={command.description} />;
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

function WorkflowsSection({
  plugin,
  canEdit,
  onAdd,
  onOpen,
}: {
  plugin: DenPlugin;
  canEdit: boolean;
  onAdd: () => void;
  onOpen: (workflowId: string) => void;
}) {
  const integrated = useLibraryIntegrated();
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        {integrated ? <SectionTitle title="Workflows" /> : <div>
          <h2 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
            <Code2 className="h-3.5 w-3.5" />
            Workflows
          </h2>
          <p className="mt-1 text-[12px] text-gray-400">Reusable Workflows shared with this Plugin and its collection audiences.</p>
        </div>}
        {canEdit ? (
          <DenButton size="sm" onClick={onAdd}><Plus className="h-3.5 w-3.5" aria-hidden />Add Workflow</DenButton>
        ) : null}
      </div>
      {plugin.workflows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white px-5 py-8 text-center">
          <p className="text-[14px] font-medium text-gray-900">No Workflows in this Plugin yet.</p>
          <p className="mt-1 text-[12.5px] text-gray-500">Create a Workflow from a successful Code Mode run and choose this Plugin, or attach an existing Workflow.</p>
        </div>
      ) : (
        <div className="grid gap-2">{plugin.workflows.map((workflow) => renderWorkflowRow(workflow, () => onOpen(workflow.id)))}</div>
      )}
    </section>
  );
}

function AddWorkflowDialog({
  open,
  plugin,
  workflows,
  busy,
  error,
  onClose,
  onAttach,
}: {
  open: boolean;
  plugin: DenPlugin;
  workflows: LibraryWorkflowItem[];
  busy: boolean;
  error: unknown;
  onClose: () => void;
  onAttach: (workflowId: string) => void;
}) {
  const existing = new Set(plugin.workflows.map((workflow) => workflow.id));
  const available = workflows.filter((workflow) => !existing.has(workflow.id) && workflow.role === "manager");
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={busy ? undefined : onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="add-workflow-title" className="w-full max-w-[520px] rounded-2xl border border-gray-100 bg-white p-6 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.4)]" onClick={(event) => event.stopPropagation()}>
        <h2 id="add-workflow-title" className="text-[16px] font-semibold tracking-[-0.01em] text-gray-950">Add a Workflow to {plugin.name}</h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-500">Workflows in this Plugin are visible to the same people and teams as the Plugin, including collection audiences.</p>
        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto">
          {available.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-[13px] text-gray-500">No unattached Workflows you manage are available. Create one from a successful Code Mode run and choose this Plugin when saving.</div>
          ) : available.map((workflow) => (
            <button key={workflow.id} type="button" disabled={busy} onClick={() => onAttach(workflow.id)} className="w-full rounded-xl border border-gray-100 px-4 py-3 text-left transition hover:border-gray-200 hover:bg-gray-50 disabled:opacity-60">
              <p className="text-[14px] font-semibold text-gray-900">{workflow.name}</p>
              <p className="mt-0.5 text-[12.5px] text-gray-500">{workflow.plugin ? `Currently in ${workflow.plugin.name}` : "Shared directly"}{workflow.description ? ` · ${workflow.description}` : ""}</p>
            </button>
          ))}
        </div>
        {error ? <p className="mt-3 text-[12.5px] text-red-600">{error instanceof Error ? error.message : "Failed to add Workflow."}</p> : null}
        <div className="mt-5 flex justify-end"><DenButton variant="secondary" onClick={onClose} disabled={busy}>Close</DenButton></div>
      </div>
    </div>
  );
}

function renderWorkflowRow(workflow: PluginWorkflow, onOpen: () => void) {
  return (
    <button
      key={workflow.id}
      type="button"
      onClick={onOpen}
      className="w-full rounded-xl border border-gray-100 bg-white px-4 py-3 text-left transition hover:border-gray-200 hover:bg-gray-50"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900">{workflow.name}</p>
        <span className="rounded-full bg-gray-50 px-2 py-0.5 text-[11px] text-gray-500">
          {workflow.requiredCapabilityCount} read-only capabilit{workflow.requiredCapabilityCount === 1 ? "y" : "ies"}
        </span>
      </div>
      {workflow.description ? (
        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">{workflow.description}</p>
      ) : null}
      <p className="mt-2 text-[11px] text-gray-400">
        {workflow.versionId ? `Current version ${workflow.versionId.slice(0, 8)}` : "No published version"}
        {workflow.outputSchema ? " · Validated output" : ""}
      </p>
    </button>
  );
}

export type { DenPlugin };
