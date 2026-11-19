"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, Globe, LockKeyhole, Plus, Users } from "lucide-react";

import { getOrgAccessFlags, permissionLockReason } from "../../_lib/den-org";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  type PluginAccessGrant,
  type PluginAccessRole,
  useGrantPluginAccess,
  useRevokePluginAccess,
} from "./plugin-access-data";
import { OrgMemberIdentity } from "./org-member-identity";
import { useLibrary } from "./library-data";
import { SectionTitle } from "./item-header";
import { DenSwitch } from "../../_components/ui/switch";
import { AccessRow, IconTile, RemoveButton, accessAddButtonClassName } from "./access-rows";

type PluginAccessSectionProps = {
  pluginId: string;
  pluginCreatedByOrgMembershipId: string | null;
  canManage?: boolean;
  grants: PluginAccessGrant[];
  isLoading: boolean;
  error: unknown;
};

type AccessCandidate = {
  id: string;
  searchText: string;
  content: ReactNode;
};

function formatAccessDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function roleLabel(role: PluginAccessRole) {
  if (role === "viewer") return "Viewer";
  if (role === "editor") return "Editor";
  return "Manager";
}

function AccessRolePill({ role }: { role: PluginAccessRole }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${
        role === "editor"
          ? "border border-amber-200 bg-amber-50 text-amber-700"
          : "bg-gray-100 text-gray-600"
      }`}
    >
      {roleLabel(role)}
    </span>
  );
}

function TeamIdentity({ name, memberCount }: { name: string; memberCount: number }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <IconTile icon={Users} />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-gray-900">{name}</p>
        <p className="truncate text-[12px] text-gray-400">
          {memberCount} {memberCount === 1 ? "member" : "members"}, future members included
        </p>
      </div>
    </div>
  );
}

function AccessAddPicker({
  kind,
  candidates,
  disabled,
  onGrant,
}: {
  kind: "person" | "team";
  candidates: AccessCandidate[];
  disabled: boolean;
  onGrant: (id: string, role: "viewer" | "editor") => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [submitting, setSubmitting] = useState(false);

  const filteredCandidates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return candidates;
    return candidates.filter((candidate) => candidate.searchText.includes(normalized));
  }, [candidates, query]);

  function resetAndClose() {
    setOpen(false);
    setQuery("");
    setSelectedId(null);
    setRole("viewer");
  }

  async function handleGrant() {
    if (disabled || submitting || !selectedId || !candidates.some((candidate) => candidate.id === selectedId)) return;
    setSubmitting(true);
    try {
      await onGrant(selectedId, role);
      resetAndClose();
    } catch {
      // The mutation error is rendered below the access container.
    } finally {
      setSubmitting(false);
    }
  }

  const label = kind === "person" ? "person" : "team";

  return (
    <Popover.Root open={open} onOpenChange={(next) => next ? setOpen(true) : resetAndClose()}>
      <Popover.Trigger
        disabled={disabled || submitting || candidates.length === 0}
        className={accessAddButtonClassName}
        data-testid={`plugin-access-add-${kind}`}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-50">
          <Popover.Popup
            className="w-[340px] max-w-[var(--available-width)] max-h-[var(--available-height)] overflow-y-auto rounded-2xl border border-gray-200 bg-white"
          >
            <Popover.Title className="sr-only">Add {label} access</Popover.Title>
            <div className="border-b border-gray-100 p-3">
              <DenInput
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${kind === "person" ? "people" : "teams"}...`}
                aria-label={`Search ${kind === "person" ? "people" : "teams"}`}
                disabled={disabled || submitting}
                autoFocus
              />
            </div>
            <div className="max-h-[220px] divide-y divide-gray-100 overflow-y-auto">
              {filteredCandidates.length === 0 ? (
                <p className="px-4 py-5 text-center text-[12px] text-gray-400">No matches</p>
              ) : (
                filteredCandidates.map((candidate) => {
                  const selected = candidate.id === selectedId;
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      disabled={disabled || submitting}
                      aria-pressed={selected}
                      onClick={() => setSelectedId(candidate.id)}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${selected ? "bg-gray-50" : "hover:bg-gray-50/70"}`}
                    >
                      <div className="min-w-0 flex-1">{candidate.content}</div>
                      <Check className={`h-4 w-4 shrink-0 ${selected ? "text-emerald-600" : "text-transparent"}`} aria-hidden />
                    </button>
                  );
                })
              )}
            </div>
            <div className="border-t border-gray-100 p-3">
              <div className="flex items-center gap-2">
                <DenSelect
                  aria-label={`Access role for ${label}`}
                  value={role}
                  onChange={(event) => setRole(event.target.value === "editor" ? "editor" : "viewer")}
                  className="min-w-0 flex-1"
                  disabled={disabled || submitting}
                >
                  <option value="viewer">Can view (use in chat)</option>
                  <option value="editor">Can edit</option>
                </DenSelect>
                <DenButton
                  size="sm"
                  loading={submitting}
                  disabled={disabled || !selectedId}
                  onClick={() => void handleGrant()}
                >
                  Grant
                </DenButton>
              </div>
              {role === "editor" ? (
                <p className="mt-2 text-[11.5px] leading-5 text-amber-700">
                  Can change this skill for everyone who has it.
                </p>
              ) : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function PluginAccessSection({
  pluginId,
  pluginCreatedByOrgMembershipId,
  canManage: canManageOverride,
  grants,
  isLoading,
  error,
}: PluginAccessSectionProps) {
  const { orgContext } = useOrgDashboard();
  const library = useLibrary();
  const grantMutation = useGrantPluginAccess();
  const revokeMutation = useRevokePluginAccess();
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.currentMember.permissions,
  );
  const libraryItem = library.data?.find((item) => item.type === "plugin" && item.id === pluginId);
  // Workflows also embed this editor: their own edit role does not authorize
  // changing the parent plugin's audience.
  const canManage = canManageOverride ?? ((pluginCreatedByOrgMembershipId !== null
    && pluginCreatedByOrgMembershipId === orgContext?.currentMember.id)
    || (libraryItem?.type === "plugin" && libraryItem.role === "manager")
    || access.canManageAllShared);
  const members = orgContext?.members ?? [];
  const teams = orgContext?.teams ?? [];
  const membersById = new Map(members.map((member) => [member.id, member]));
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const orgWideGrant = grants.find((grant) => grant.orgWide) ?? null;
  const memberGrants = grants.filter((grant) => grant.orgMembershipId !== null);
  const teamGrants = grants.filter((grant) => grant.teamId !== null);
  const hasGrantsBeyondCreator = grants.some(
    (grant) => grant.orgMembershipId !== pluginCreatedByOrgMembershipId,
  );
  const busy = grantMutation.isPending || revokeMutation.isPending;
  const disabled = busy || !canManage || isLoading || Boolean(error);
  // Turning org-wide sharing on needs `sharing.share_org_wide`; turning it off does not.
  const orgWideLocked = !orgWideGrant && !access.canShareWithEveryone;

  const memberCandidates: AccessCandidate[] = members
    .filter((member) => !memberGrants.some((grant) => grant.orgMembershipId === member.id))
    .map((member) => ({
      id: member.id,
      searchText: `${member.user.name} ${member.user.email}`.toLowerCase(),
      content: <OrgMemberIdentity member={member} />,
    }));
  const teamCandidates: AccessCandidate[] = teams
    .filter((team) => !teamGrants.some((grant) => grant.teamId === team.id))
    .map((team) => ({
      id: team.id,
      searchText: team.name.toLowerCase(),
      content: <TeamIdentity name={team.name} memberCount={team.memberIds.length} />,
    }));

  async function handleToggleOrgWide() {
    if (disabled || orgWideLocked) return;
    try {
      if (orgWideGrant) {
        await revokeMutation.mutateAsync({ pluginId, grantId: orgWideGrant.id });
      } else {
        await grantMutation.mutateAsync({ pluginId, body: { orgWide: true, role: "viewer" } });
      }
    } catch {
      // The mutation error is rendered below the access container.
    }
  }

  async function handleRevoke(grantId: string) {
    if (disabled) return;
    const grant = grants.find((entry) => entry.id === grantId);
    if (!grant || (grant.orgMembershipId !== null && grant.orgMembershipId === pluginCreatedByOrgMembershipId)) return;
    try {
      await revokeMutation.mutateAsync({ pluginId, grantId });
    } catch {
      // The mutation error is rendered below the access container.
    }
  }

  function grantPerson(memberId: string, role: "viewer" | "editor") {
    if (disabled) return Promise.reject(new Error("Only a plugin manager can change access."));
    return grantMutation.mutateAsync({
      pluginId,
      body: { orgMembershipId: memberId, role },
    }).then(() => undefined);
  }

  function grantTeam(teamId: string, role: "viewer" | "editor") {
    if (disabled) return Promise.reject(new Error("Only a plugin manager can change access."));
    return grantMutation.mutateAsync({
      pluginId,
      body: { teamId, role },
    }).then(() => undefined);
  }

  const mutationError = grantMutation.error ?? revokeMutation.error;

  return (
    <section>
      <div className="mb-3"><SectionTitle title="Who can use it" /></div>
      {!canManage ? (
        <p className="mb-3 flex items-center gap-2 text-[13px] text-[var(--dls-text-secondary)]" data-testid="plugin-access-read-only">
          <LockKeyhole className="size-4 shrink-0" aria-hidden />
          Read only. Only a plugin manager or someone with Manage all shared items can change access.
        </p>
      ) : null}

      {error ? (
        <DenNotice
          tone="error"
          message={error instanceof Error ? error.message : "Failed to load plugin access."}
        />
      ) : (
        <div className="border-y border-[var(--den-list-line)]">
          {isLoading ? (
            <p className="py-3 text-[13px] text-[var(--dls-text-secondary)]">Loading access…</p>
          ) : (
            <>
              <AccessRow
                lead={<IconTile icon={Globe} />}
                title="Everyone in the organization"
                description={orgWideGrant
                  ? "On. Everyone in the organization can use it."
                  : orgWideLocked
                    ? permissionLockReason("sharing.share_org_wide")
                    : "Off. Only the people and teams below can use it."}
                trailing={<DenSwitch
                  checked={Boolean(orgWideGrant)}
                  disabled={disabled || orgWideLocked}
                  onChange={() => void handleToggleOrgWide()}
                  aria-label="Everyone in the organization"
                  testId="plugin-access-everyone"
                />}
              />

              <div className="divide-y divide-gray-100 border-t border-gray-100">
                {memberGrants.map((grant) => {
                  const member = grant.orgMembershipId ? membersById.get(grant.orgMembershipId) : null;
                  const creatorGrant = grant.orgMembershipId === pluginCreatedByOrgMembershipId;
                  const sharedBy = grant.createdByOrgMembershipId === orgContext?.currentMember.id
                    ? "you"
                    : membersById.get(grant.createdByOrgMembershipId)?.user.name ?? "an organization member";
                  return (
                    <AccessRow
                      key={grant.id}
                      title={member ? <OrgMemberIdentity member={member} /> : "Removed member"}
                      description={creatorGrant ? undefined : `Shared by ${sharedBy} · ${formatAccessDate(grant.createdAt)}`}
                      trailing={(
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          <AccessRolePill role={grant.role} />
                          {creatorGrant ? (
                            <span className="text-[13px] text-[var(--dls-text-secondary)]">Creator</span>
                          ) : (
                            <RemoveButton
                              label={`Revoke access for ${member?.user.name || member?.user.email || "removed member"}`}
                              actionLabel="Revoke"
                              disabled={disabled}
                              onClick={() => void handleRevoke(grant.id)}
                            />
                          )}
                        </div>
                      )}
                      testId="plugin-access-person"
                    />
                  );
                })}

                {teamGrants.map((grant) => {
                  const team = grant.teamId ? teamsById.get(grant.teamId) : null;
                  const sharedBy = grant.createdByOrgMembershipId === orgContext?.currentMember.id
                    ? "you"
                    : membersById.get(grant.createdByOrgMembershipId)?.user.name ?? "an organization member";
                  return (
                    <AccessRow
                      key={grant.id}
                      title={team ? <TeamIdentity name={team.name} memberCount={team.memberIds.length} /> : "Removed team"}
                      description={`Shared by ${sharedBy} · ${formatAccessDate(grant.createdAt)}`}
                      trailing={(
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          <AccessRolePill role={grant.role} />
                          <RemoveButton
                            label={`Revoke access for ${team?.name || "removed team"}`}
                            actionLabel="Revoke"
                            disabled={disabled}
                            onClick={() => void handleRevoke(grant.id)}
                          />
                        </div>
                      )}
                      testId="plugin-access-team"
                    />
                  );
                })}

                {!hasGrantsBeyondCreator ? (
                  <div className="py-3">
                    <div className="rounded-xl border border-dashed border-gray-200 px-5 py-5 text-center">
                      <p className="text-[13px] font-medium text-gray-900">Only you can use this plugin</p>
                      <p className="mt-1 text-[12px] text-gray-500">
                        Share it with a person or a team to give them instant access in chat.
                      </p>
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2 py-3">
                  <AccessAddPicker
                    kind="person"
                    candidates={memberCandidates}
                    disabled={disabled}
                    onGrant={grantPerson}
                  />
                  <AccessAddPicker
                    kind="team"
                    candidates={teamCandidates}
                    disabled={disabled}
                    onGrant={grantTeam}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {mutationError ? (
        <DenNotice
          tone="error"
          className="mt-3"
          message={mutationError instanceof Error ? mutationError.message : "Failed to update plugin access."}
        />
      ) : null}
    </section>
  );
}
