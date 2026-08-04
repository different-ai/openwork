"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Globe, Plus, Users } from "lucide-react";

import { getOrgAccessFlags } from "../../_lib/den-org";
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

type PluginAccessSectionProps = {
  pluginId: string;
  pluginCreatedByOrgMembershipId: string | null;
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
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gray-100 text-gray-500">
        <Users className="h-4 w-4" aria-hidden />
      </div>
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
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (ref.current && !event.composedPath().includes(ref.current)) {
        setOpen(false);
        setQuery("");
        setSelectedId(null);
        setRole("viewer");
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

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
    if (!selectedId) return;
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
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled || candidates.length === 0}
        onClick={() => {
          if (open) {
            resetAndClose();
          } else {
            setOpen(true);
          }
        }}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-3 py-1.5 text-[11.5px] text-gray-500 transition hover:border-gray-500 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-3 w-3" aria-hidden />
        Add {label}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6 md:absolute md:inset-auto md:left-0 md:top-[calc(100%+6px)] md:z-20 md:block md:bg-transparent md:p-0"
          onClick={(event) => {
            if (event.target === event.currentTarget) resetAndClose();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Add ${label} access`}
            className="w-full max-w-[340px] rounded-2xl border border-gray-200 bg-white md:w-[340px]"
          >
            <div className="border-b border-gray-100 p-3">
              <DenInput
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${kind === "person" ? "people" : "teams"}...`}
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
                  disabled={submitting}
                >
                  <option value="viewer">Can view (use in chat)</option>
                  <option value="editor">Can edit</option>
                </DenSelect>
                <DenButton
                  size="sm"
                  loading={submitting}
                  disabled={!selectedId}
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
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PluginAccessSection({
  pluginId,
  pluginCreatedByOrgMembershipId,
  grants,
  isLoading,
  error,
}: PluginAccessSectionProps) {
  const { orgContext } = useOrgDashboard();
  const grantMutation = useGrantPluginAccess();
  const revokeMutation = useRevokePluginAccess();
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles ?? [],
  );
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
    try {
      await revokeMutation.mutateAsync({ pluginId, grantId });
    } catch {
      // The mutation error is rendered below the access container.
    }
  }

  function grantPerson(memberId: string, role: "viewer" | "editor") {
    return grantMutation.mutateAsync({
      pluginId,
      body: { orgMembershipId: memberId, role },
    }).then(() => undefined);
  }

  function grantTeam(teamId: string, role: "viewer" | "editor") {
    return grantMutation.mutateAsync({
      pluginId,
      body: { teamId, role },
    }).then(() => undefined);
  }

  const mutationError = grantMutation.error ?? revokeMutation.error;

  return (
    <section>
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
        Who can access this
      </h2>

      {error ? (
        <DenNotice
          tone="error"
          message={error instanceof Error ? error.message : "Failed to load plugin access."}
        />
      ) : (
        <div className="rounded-2xl border border-gray-100 bg-white">
          {isLoading ? (
            <p className="px-6 py-4 text-[13px] text-gray-400">Loading access…</p>
          ) : (
            <>
              {access.isAdmin ? (
                <button
                  type="button"
                  onClick={() => void handleToggleOrgWide()}
                  disabled={busy}
                  className="flex w-full items-center gap-4 rounded-t-2xl px-6 py-4 text-left transition hover:bg-gray-50/60 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${orgWideGrant ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-500"}`}>
                    <Globe className="h-4 w-4" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
                      Everyone in the organization
                    </p>
                    <p className="mt-0.5 text-[12.5px] leading-[1.55] text-gray-500">
                      {orgWideGrant
                        ? "All organization members can use this plugin in chat."
                        : "Only people and teams you add below can use this plugin in chat."}
                    </p>
                  </div>
                  <div
                    role="switch"
                    aria-checked={Boolean(orgWideGrant)}
                    className={`relative inline-flex h-6 w-[42px] shrink-0 items-center rounded-full transition-colors ${orgWideGrant ? "bg-[#0f172a]" : "bg-gray-200"}`}
                  >
                    <span className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${orgWideGrant ? "translate-x-[18px]" : "translate-x-0.5"}`} />
                  </div>
                </button>
              ) : null}

              <div className={`${access.isAdmin ? "border-t" : ""} divide-y divide-gray-100 border-gray-100`}>
                {memberGrants.map((grant) => {
                  const member = grant.orgMembershipId ? membersById.get(grant.orgMembershipId) : null;
                  const creatorGrant = grant.orgMembershipId === pluginCreatedByOrgMembershipId;
                  const sharedBy = grant.createdByOrgMembershipId === orgContext?.currentMember.id
                    ? "you"
                    : membersById.get(grant.createdByOrgMembershipId)?.user.name ?? "an organization member";
                  return (
                    <div key={grant.id} className="flex flex-col gap-3 px-4 py-4 md:flex-row md:flex-wrap md:items-center md:px-6 md:py-3.5">
                      <div className="flex w-full min-w-0 items-start gap-3 md:w-auto md:min-w-[220px] md:flex-1 md:items-center">
                        <div className="min-w-0 flex-1">
                          {member ? (
                            <OrgMemberIdentity member={member} />
                          ) : (
                            <p className="text-[13px] font-medium text-gray-500">Removed member</p>
                          )}
                        </div>
                        <AccessRolePill role={grant.role} />
                      </div>
                      {creatorGrant ? (
                        <span className="text-[12px] font-medium text-gray-400">creator</span>
                      ) : (
                        <>
                          <p className="text-[11.5px] text-gray-400">
                            shared by {sharedBy} · {formatAccessDate(grant.createdAt)}
                          </p>
                          <div className="flex w-full justify-end md:w-auto">
                            <DenButton
                              size="sm"
                              variant="destructive"
                              disabled={busy}
                              onClick={() => void handleRevoke(grant.id)}
                            >
                              Revoke
                            </DenButton>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}

                {teamGrants.map((grant) => {
                  const team = grant.teamId ? teamsById.get(grant.teamId) : null;
                  const sharedBy = grant.createdByOrgMembershipId === orgContext?.currentMember.id
                    ? "you"
                    : membersById.get(grant.createdByOrgMembershipId)?.user.name ?? "an organization member";
                  return (
                    <div key={grant.id} className="flex flex-col gap-3 px-4 py-4 md:flex-row md:flex-wrap md:items-center md:px-6 md:py-3.5">
                      <div className="flex w-full min-w-0 items-start gap-3 md:w-auto md:min-w-[220px] md:flex-1 md:items-center">
                        <div className="min-w-0 flex-1">
                          {team ? (
                            <TeamIdentity name={team.name} memberCount={team.memberIds.length} />
                          ) : (
                            <p className="text-[13px] font-medium text-gray-500">Removed team</p>
                          )}
                        </div>
                        <AccessRolePill role={grant.role} />
                      </div>
                      <p className="text-[11.5px] text-gray-400">
                        shared by {sharedBy} · {formatAccessDate(grant.createdAt)}
                      </p>
                      <div className="flex w-full justify-end md:w-auto">
                        <DenButton
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => void handleRevoke(grant.id)}
                        >
                          Revoke
                        </DenButton>
                      </div>
                    </div>
                  );
                })}

                {!hasGrantsBeyondCreator ? (
                  <div className="px-6 py-3.5">
                    <div className="rounded-xl border border-dashed border-gray-200 px-5 py-5 text-center">
                      <p className="text-[13px] font-medium text-gray-900">Only you can use this plugin</p>
                      <p className="mt-1 text-[12px] text-gray-500">
                        Share it with a person or a team to give them instant access in chat.
                      </p>
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2 px-6 py-3.5">
                  <AccessAddPicker
                    kind="person"
                    candidates={memberCandidates}
                    disabled={busy}
                    onGrant={grantPerson}
                  />
                  <AccessAddPicker
                    kind="team"
                    candidates={teamCandidates}
                    disabled={busy}
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
