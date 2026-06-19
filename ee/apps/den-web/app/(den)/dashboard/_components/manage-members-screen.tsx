"use client";

import { type ElementType, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Link,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Settings,
  Shield,
  Trash2,
  User,
  Users,
} from "lucide-react";
import {
  DEN_ROLE_PERMISSION_OPTIONS,
  formatRoleLabel,
  getJoinOrgRoute,
  getOrgAccessFlags,
  getMembersRoute,
  splitRoleString,
} from "../../_lib/den-org";
import { type OrgLimitError, type OrgPaymentRequiredError, getOrgLimitError, getOrgPaymentRequiredError } from "../../_lib/den-flow";
import { buildDenFeedbackUrl } from "../../_lib/feedback";
import { OrgLimitDialog } from "../../_components/org-limit-dialog";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { UnderlineTabs } from "../../_components/ui/tabs";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { OrgMemberIdentity } from "./org-member-identity";

type MembersTab = "members" | "teams" | "roles";

function clonePermissionRecord(value: Record<string, string[]>) {
  return Object.fromEntries(
    Object.entries(value).map(([resource, actions]) => [
      resource,
      [...actions],
    ]),
  );
}

function toggleAction(
  value: Record<string, string[]>,
  resource: string,
  action: string,
  enabled: boolean,
) {
  const next = clonePermissionRecord(value);
  const current = new Set(next[resource] ?? []);

  if (enabled) {
    current.add(action);
  } else {
    current.delete(action);
  }

  next[resource] = [...current];
  return next;
}

function ActionButton({
  children,
  tone = "default",
  size = "sm",
  icon,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  tone?: "default" | "danger";
  size?: "md" | "sm";
  icon?: ElementType<{ size?: number; className?: string }>;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <DenButton
      variant={tone === "danger" ? "destructive" : "secondary"}
      size={size}
      icon={icon}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </DenButton>
  );
}

function SummaryCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "dark";
}) {
  return (
    <div
      className={`rounded-[24px] border px-5 py-4 ${tone === "dark" ? "border-[#0f172a] bg-[#0f172a] text-white" : "border-gray-200 bg-white text-gray-900"}`}
    >
      <p
        className={`text-[12px] font-semibold uppercase tracking-[0.16em] ${tone === "dark" ? "text-white/60" : "text-gray-400"}`}
      >
        {label}
      </p>
      <p className="mt-3 text-[24px] font-semibold tracking-[-0.05em]">
        {value}
      </p>
    </div>
  );
}

export function ManageMembersScreen() {
  const {
    activeOrg,
    orgContext,
    orgBusy,
    orgError,
    mutationBusy,
    inviteMember,
    startSeatCheckout,
    cancelInvitation,
    updateMemberRole,
    removeMember,
    createTeam,
    updateTeam,
    deleteTeam,
    createRole,
    updateRole,
    deleteRole,
  } = useOrgDashboard();
  const [activeTab, setActiveTab] = useState<MembersTab>("members");
  const [pageError, setPageError] = useState<string | null>(null);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [openMemberMenuId, setOpenMemberMenuId] = useState<string | null>(null);
  const [memberRoleDraft, setMemberRoleDraft] = useState("member");
  const [showTeamForm, setShowTeamForm] = useState(false);
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [teamNameDraft, setTeamNameDraft] = useState("");
  const [teamMemberDraft, setTeamMemberDraft] = useState<string[]>([]);
  const [showRoleForm, setShowRoleForm] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [roleNameDraft, setRoleNameDraft] = useState("");
  const [rolePermissionDraft, setRolePermissionDraft] = useState<
    Record<string, string[]>
  >({});
  const [limitDialogError, setLimitDialogError] = useState<OrgLimitError | null>(null);
  const [seatBillingDialogError, setSeatBillingDialogError] = useState<OrgPaymentRequiredError | null>(null);

  const assignableRoles = useMemo(
    () => (orgContext?.roles ?? []).filter((role) => !role.protected),
    [orgContext?.roles],
  );

  const access = useMemo(
    () =>
      getOrgAccessFlags(
        orgContext?.currentMember.role ?? "member",
        orgContext?.currentMember.isOwner ?? false,
        orgContext?.roles,
      ),
    [orgContext?.currentMember.isOwner, orgContext?.currentMember.role, orgContext?.roles],
  );
  const canStartSeatCheckout = orgContext?.currentMember.isOwner === true;

  const tabCounts: Record<MembersTab, number> = {
    members: orgContext?.members.length ?? 0,
    teams: orgContext?.teams.length ?? 0,
    roles: orgContext?.roles.length ?? 0,
  };

  const teamMemberNames = useMemo(() => {
    const membersById = new Map(
      (orgContext?.members ?? []).map((member) => [
        member.id,
        member.user.name,
      ]),
    );
    return new Map(
      (orgContext?.teams ?? []).map((team) => [
        team.id,
        team.memberIds
          .map((memberId) => membersById.get(memberId))
          .filter((value): value is string => Boolean(value)),
      ]),
    );
  }, [orgContext?.members, orgContext?.teams]);

  const invitationsById = useMemo(
    () => new Map((orgContext?.invitations ?? []).map((invitation) => [invitation.id, invitation])),
    [orgContext?.invitations],
  );

  const feedbackHref = useMemo(
    () =>
      buildDenFeedbackUrl({
        pathname: activeOrg ? getMembersRoute(activeOrg.slug) : "/organization",
        orgSlug: activeOrg?.slug ?? null,
        topic: "workspace-limits",
      }),
    [activeOrg],
  );

  function resetInviteForm() {
    setInviteEmail("");
    setInviteRole(assignableRoles[0]?.role ?? "member");
    setShowInviteForm(false);
  }

  function resetMemberEditor() {
    setEditingMemberId(null);
    setMemberRoleDraft(assignableRoles[0]?.role ?? "member");
  }

  function resetTeamEditor() {
    setEditingTeamId(null);
    setTeamNameDraft("");
    setTeamMemberDraft([]);
    setShowTeamForm(false);
  }

  function resetRoleEditor() {
    setEditingRoleId(null);
    setRoleNameDraft("");
    setRolePermissionDraft({});
    setShowRoleForm(false);
  }

  useEffect(() => {
    if (!assignableRoles[0]) {
      return;
    }

    setInviteRole((current) =>
      assignableRoles.some((role) => role.role === current)
        ? current
        : assignableRoles[0].role,
    );
    setMemberRoleDraft((current) =>
      assignableRoles.some((role) => role.role === current)
        ? current
        : assignableRoles[0].role,
    );
  }, [assignableRoles]);

  if (orgBusy && !orgContext) {
    return (
      <div className="mx-auto max-w-[1200px] px-6 py-8 md:px-8">
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading organization details...
        </div>
      </div>
    );
  }

  if (!orgContext || !activeOrg) {
    return (
      <div className="mx-auto max-w-[1200px] px-6 py-8 md:px-8">
        <div className="rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[15px] text-red-700">
          {orgError ?? "Organization details are unavailable."}
        </div>
      </div>
    );
  }

  const inviteForm =
    showInviteForm && access.canInviteMembers ? (
      <DenCard className="mb-6">
        <form
          className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_220px_auto] lg:items-end"
          onSubmit={async (event) => {
            event.preventDefault();
            setPageError(null);
            try {
              await inviteMember({ email: inviteEmail, role: inviteRole });
              resetInviteForm();
            } catch (error) {
              const paymentRequiredError = getOrgPaymentRequiredError(error);
              if (paymentRequiredError) {
                setSeatBillingDialogError(paymentRequiredError);
                return;
              }

              const limitError = getOrgLimitError(error);
              if (limitError) {
                setLimitDialogError(limitError);
                return;
              }

              setPageError(
                error instanceof Error
                  ? error.message
                  : "Could not invite member.",
              );
            }
          }}
        >
          <label className="grid gap-3">
            <span className="text-[14px] font-medium text-gray-700">Email</span>
            <DenInput
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="teammate@example.com"
              required
            />
          </label>
          <label className="grid gap-3">
            <span className="text-[14px] font-medium text-gray-700">Role</span>
            <DenSelect value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
              {assignableRoles.map((role) => (
                <option key={role.id} value={role.role}>
                  {formatRoleLabel(role.role)}
                </option>
              ))}
            </DenSelect>
          </label>
          <div className="flex gap-2 lg:justify-end">
            <ActionButton size="md" onClick={resetInviteForm}>Cancel</ActionButton>
            <DenButton type="submit" loading={mutationBusy === "invite-member"}>
              Send invite
            </DenButton>
          </div>
        </form>
      </DenCard>
    ) : null;

  const editMemberForm =
    editingMemberId && access.canManageMembers ? (
      <DenCard className="mb-6">
        <form
          className="grid gap-4 lg:grid-cols-[240px_auto] lg:items-end"
          onSubmit={async (event) => {
            event.preventDefault();
            setPageError(null);
            try {
              await updateMemberRole(editingMemberId, memberRoleDraft);
              resetMemberEditor();
            } catch (error) {
              setPageError(
                error instanceof Error
                  ? error.message
                  : "Could not update member role.",
              );
            }
          }}
        >
          <label className="grid gap-3">
            <span className="text-[14px] font-medium text-gray-700">Role</span>
            <DenSelect value={memberRoleDraft} onChange={(event) => setMemberRoleDraft(event.target.value)}>
              {assignableRoles.map((role) => (
                <option key={role.id} value={role.role}>
                  {formatRoleLabel(role.role)}
                </option>
              ))}
            </DenSelect>
          </label>
          <div className="flex gap-2 lg:justify-end">
            <ActionButton size="md" onClick={resetMemberEditor}>Cancel</ActionButton>
            <DenButton type="submit" loading={mutationBusy === "update-member-role"}>
              Save member
            </DenButton>
          </div>
        </form>
      </DenCard>
    ) : null;

  const teamForm =
    (showTeamForm || editingTeamId) && access.canManageTeams ? (
      <DenCard className="mb-6">
        <form
          className="grid gap-6"
          onSubmit={async (event) => {
            event.preventDefault();
            setPageError(null);
            try {
              if (editingTeamId) {
                await updateTeam(editingTeamId, {
                  name: teamNameDraft,
                  memberIds: teamMemberDraft,
                });
              } else {
                await createTeam({
                  name: teamNameDraft,
                  memberIds: teamMemberDraft,
                });
              }
              resetTeamEditor();
            } catch (error) {
              setPageError(
                error instanceof Error ? error.message : "Could not save team.",
              );
            }
          }}
        >
          <label className="grid gap-3 lg:max-w-[420px]">
            <span className="text-[14px] font-medium text-gray-700">
              Team name
            </span>
            <DenInput
              type="text"
              value={teamNameDraft}
              onChange={(event) => setTeamNameDraft(event.target.value)}
              placeholder="Core Engineering"
              required
            />
          </label>

          <div>
            <p className="mb-3 text-[14px] font-medium text-gray-700">
              Team members
            </p>
            {orgContext.members.length === 0 ? (
              <div className="rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[14px] text-gray-500">
                Invite a member before assigning people to this team.
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {orgContext.members.map((member) => {
                  const selected = teamMemberDraft.includes(member.id);
                  return (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => {
                        setTeamMemberDraft((current) =>
                          current.includes(member.id)
                            ? current.filter((entry) => entry !== member.id)
                            : [...current, member.id],
                        );
                      }}
                      className={`flex items-start gap-3 rounded-[22px] border px-4 py-4 text-left transition ${
                        selected
                          ? "border-[#0f172a] bg-[#0f172a] text-white"
                          : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                      }`}
                    >
                      {selected ? (
                        <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0" />
                      ) : (
                        <Circle className="mt-0.5 h-6 w-6 shrink-0 text-gray-300" />
                      )}
                      <OrgMemberIdentity member={member} inverted={selected} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <ActionButton size="md" onClick={resetTeamEditor}>Cancel</ActionButton>
            <DenButton
              type="submit"
              loading={mutationBusy === "create-team" || mutationBusy === "update-team"}
            >
              {editingTeamId ? "Save team" : "Create team"}
            </DenButton>
          </div>
        </form>
      </DenCard>
    ) : null;

  const roleForm =
    (showRoleForm || editingRoleId) && access.canManageRoles ? (
      <DenCard className="mb-6">
        <form
          className="grid gap-6"
          onSubmit={async (event) => {
            event.preventDefault();
            setPageError(null);
            try {
              if (editingRoleId) {
                await updateRole(editingRoleId, {
                  roleName: roleNameDraft,
                  permission: rolePermissionDraft,
                });
              } else {
                await createRole({
                  roleName: roleNameDraft,
                  permission: rolePermissionDraft,
                });
              }
              resetRoleEditor();
            } catch (error) {
              setPageError(
                error instanceof Error ? error.message : "Could not save role.",
              );
            }
          }}
        >
          <label className="grid gap-3 lg:max-w-[420px]">
            <span className="text-[14px] font-medium text-gray-700">
              Role name
            </span>
            <DenInput
              type="text"
              value={roleNameDraft}
              onChange={(event) => setRoleNameDraft(event.target.value)}
              placeholder="qa-reviewer"
              required
            />
          </label>

          <div className="grid gap-4 xl:grid-cols-3">
            {Object.entries(DEN_ROLE_PERMISSION_OPTIONS).map(
              ([resource, actions]) => (
                <div
                  key={resource}
                  className="rounded-[24px] border border-gray-200 bg-[#f8fafc] p-4"
                >
                  <p className="mb-3 text-[15px] font-semibold text-gray-900">
                    {formatRoleLabel(resource)}
                  </p>
                  <div className="grid gap-2">
                    {actions.map((action) => {
                      const checked = (
                        rolePermissionDraft[resource] ?? []
                      ).includes(action);
                      return (
                        <label
                          key={`${resource}-${action}`}
                          className="inline-flex items-center gap-2 text-[14px] text-gray-600"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) =>
                              setRolePermissionDraft((current) =>
                                toggleAction(
                                  current,
                                  resource,
                                  action,
                                  event.target.checked,
                                ),
                              )
                            }
                          />
                          <span>{formatRoleLabel(action)}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ),
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <ActionButton size="md" onClick={resetRoleEditor}>Cancel</ActionButton>
            <DenButton
              type="submit"
              loading={mutationBusy === "create-role" || mutationBusy === "update-role"}
            >
              {editingRoleId ? "Save role" : "Create role"}
            </DenButton>
          </div>
        </form>
      </DenCard>
    ) : null;

  const toolbarAction = (() => {
    if (activeTab === "members" && access.canInviteMembers) {
      return {
        label: "Add member",
        onClick: () => {
          resetMemberEditor();
          setShowInviteForm((current) => !current);
        },
      };
    }
    if (activeTab === "teams" && access.canManageTeams) {
      return {
        label: "Create Team",
        onClick: () => {
          resetTeamEditor();
          setShowTeamForm((current) => !current);
        },
      };
    }
    if (activeTab === "roles" && access.canManageRoles) {
      return {
        label: "Add role",
        onClick: () => {
          setShowRoleForm((current) => !current);
          setEditingRoleId(null);
          setRoleNameDraft("");
          setRolePermissionDraft({});
        },
      };
    }
    return null;
  })();

  return (
    <DashboardPageTemplate
      icon={Users}
      title="Members"
      description="Invite teammates, adjust roles, and keep access clean."
      colors={["#F3EEFF", "#4A1D96", "#7C3AED", "#C4B5FD"]}
    >
      <OrgLimitDialog
        open={Boolean(limitDialogError)}
        title={limitDialogError?.limitType === "members" ? "Member limit reached" : "Worker limit reached"}
        message={limitDialogError?.message ?? "This workspace reached its current plan limit."}
        detail={
          limitDialogError
            ? `${limitDialogError.currentCount} of ${limitDialogError.limit} ${limitDialogError.limitType} are already in use.`
            : null
        }
        feedbackHref={feedbackHref}
        onClose={() => setLimitDialogError(null)}
      />
      <OrgLimitDialog
        open={Boolean(seatBillingDialogError)}
        eyebrow="Seat billing"
        title="Subscribe to add more users"
        message="The first 5 users in your organization are free, additional users are charged at $10 per user per month"
        detail={canStartSeatCheckout ? null : "Only workspace owners can start billing checkout."}
        closeLabel="Cancel"
        actionLabel="Subscribe"
        actionLoading={mutationBusy === "seat-checkout"}
        actionDisabled={!canStartSeatCheckout}
        onClose={() => setSeatBillingDialogError(null)}
        onAction={() => {
          if (!canStartSeatCheckout) {
            return;
          }
          void startSeatCheckout().catch((error) => {
            setPageError(error instanceof Error ? error.message : "Could not start seat billing checkout.");
          });
        }}
      />

      {pageError ? (
        <div className="mb-6 rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[14px] text-red-700">
          {pageError}
        </div>
      ) : null}

      <UnderlineTabs
        className="mb-6"
        activeTab={activeTab}
        onChange={setActiveTab}
        tabs={[
          { value: "members", label: "Members", icon: User, count: tabCounts.members },
          { value: "teams", label: "Teams", icon: Users, count: tabCounts.teams },
          { value: "roles", label: "Roles", icon: Shield, count: tabCounts.roles },
        ]}
      />

      {activeTab === "members" ? inviteForm : null}
      {activeTab === "members" ? editMemberForm : null}
      {activeTab === "teams" ? teamForm : null}
      {activeTab === "roles" ? roleForm : null}

      {activeTab === "members" ? (
        <div>
          <div className="mb-6 flex items-center justify-between gap-4">
            <p className="text-[15px] text-gray-400">
              {access.canManageMembers
                ? "Invite people, update their role, or remove them from the organization."
                : access.canRemoveMembers
                  ? "Invite people or remove non-owner members from the organization."
                : "View who is in the organization and what role they currently hold."}
            </p>
            {toolbarAction ? (
              <DenButton icon={Plus} onClick={toolbarAction.onClick}>
                {toolbarAction.label}
              </DenButton>
            ) : null}
          </div>

          <div className="overflow-visible rounded-2xl border border-gray-100 bg-white">
            <div className="grid grid-cols-[minmax(0,1fr)_180px_140px_160px] gap-4 border-b border-gray-100 px-6 py-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              <span>Member</span>
              <span>Role</span>
              <span>Joined</span>
              <span />
            </div>

            {orgContext.members.map((member) => {
              const isInvited = !member.joinedAt;
              const inviteId = member.inviteId;
              const inviteToken = inviteId ? invitationsById.get(inviteId)?.inviteToken : null;
              const canOpenActions = member.isOwner
                ? false
                : isInvited
                  ? access.canInviteMembers || access.canCancelInvitations
                  : access.canManageMembers || access.canRemoveMembers;

              return (
                <div
                  key={member.id}
                  className="grid grid-cols-[minmax(0,1fr)_180px_140px_160px] items-center gap-4 border-b border-gray-100 px-6 py-3.5 transition hover:bg-gray-50/60 last:border-b-0"
                >
                  <OrgMemberIdentity member={member} />
                  <span className="text-[13px] text-gray-500">
                    {splitRoleString(member.role).map(formatRoleLabel).join(", ")}
                  </span>
                  <span className="text-[13px] text-gray-400">
                    {member.joinedAt
                      ? new Date(member.joinedAt).toLocaleDateString()
                      : "Pending"}
                  </span>
                  <div className="relative flex items-center justify-end gap-2">
                    {member.isOwner ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-[12px] text-gray-400">
                        <Lock className="h-3 w-3" />
                        Locked
                      </span>
                    ) : canOpenActions ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setOpenMemberMenuId((current) => current === member.id ? null : member.id)}
                          className="rounded-full p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                          aria-label={`Open actions for ${member.user.name}`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                        {openMemberMenuId === member.id ? (
                          <div className="absolute right-0 top-9 z-10 w-44 overflow-hidden rounded-2xl border border-gray-100 bg-white p-1.5 text-[13px] shadow-xl shadow-gray-900/10">
                            {isInvited && inviteToken ? (
                              <button
                                type="button"
                                onClick={async () => {
                                  const inviteUrl = new URL(getJoinOrgRoute(inviteToken), window.location.origin).toString();
                                  await navigator.clipboard.writeText(inviteUrl);
                                  setOpenMemberMenuId(null);
                                }}
                                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-gray-600 transition hover:bg-gray-50"
                              >
                                <Link className="h-3.5 w-3.5" />
                                Copy invite link
                              </button>
                            ) : null}
                            {isInvited && access.canInviteMembers ? (
                              <button
                                type="button"
                                onClick={async () => {
                                  setPageError(null);
                                  try {
                                    await inviteMember({ email: member.user.email, role: member.role });
                                    setOpenMemberMenuId(null);
                                  } catch (error) {
                                    setPageError(error instanceof Error ? error.message : "Could not resend invitation.");
                                  }
                                }}
                                disabled={mutationBusy === "invite-member"}
                                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                <Send className="h-3.5 w-3.5" />
                                Resend invite
                              </button>
                            ) : null}
                            {isInvited && access.canCancelInvitations && inviteId ? (
                              <button
                                type="button"
                                onClick={async () => {
                                  setPageError(null);
                                  try {
                                    await cancelInvitation(inviteId);
                                    setOpenMemberMenuId(null);
                                  } catch (error) {
                                    setPageError(error instanceof Error ? error.message : "Could not cancel invitation.");
                                  }
                                }}
                                disabled={mutationBusy === "cancel-invitation"}
                                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Cancel invite
                              </button>
                            ) : null}
                            {!isInvited && access.canManageMembers ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMemberId(member.id);
                                  setMemberRoleDraft(member.role);
                                  setShowInviteForm(false);
                                  setOpenMemberMenuId(null);
                                }}
                                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-gray-600 transition hover:bg-gray-50"
                              >
                                <Settings className="h-3.5 w-3.5" />
                                Edit role
                              </button>
                            ) : null}
                            {!isInvited && access.canRemoveMembers ? (
                              <button
                                type="button"
                                onClick={async () => {
                                  setPageError(null);
                                  try {
                                    await removeMember(member.id);
                                    if (editingMemberId === member.id) {
                                      resetMemberEditor();
                                    }
                                    setOpenMemberMenuId(null);
                                  } catch (error) {
                                    setPageError(error instanceof Error ? error.message : "Could not remove member.");
                                  }
                                }}
                                disabled={mutationBusy === "remove-member"}
                                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Remove member
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-[13px] text-gray-400">Read only</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {activeTab === "teams" ? (
        <div>
          <div className="mb-6 flex items-center justify-between gap-4">
            <p className="text-[15px] text-gray-400">Manage teams and their members.</p>
            {toolbarAction ? (
              <DenButton icon={Plus} onClick={toolbarAction.onClick}>
                {toolbarAction.label}
              </DenButton>
            ) : null}
          </div>

          <div className="overflow-x-auto overflow-y-visible rounded-2xl border border-gray-100 bg-white">
            <div className="grid grid-cols-[minmax(0,1fr)_160px_200px] gap-4 border-b border-gray-100 px-6 py-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              <span>Team</span>
              <span>Members</span>
              <span />
            </div>

            {orgContext.teams.length === 0 ? (
              <div className="px-6 py-8 text-center text-[13px] text-gray-400">
                No teams yet.
              </div>
            ) : (
              orgContext.teams.map((team) => (
                <div
                  key={team.id}
                  className="grid grid-cols-[minmax(0,1fr)_160px_200px] items-center gap-4 border-b border-gray-100 px-6 py-3.5 transition hover:bg-gray-50/60 last:border-b-0"
                >
                  <div>
                    <span className="text-[13px] font-medium text-gray-900">
                      {team.name}
                    </span>
                    <p className="mt-0.5 text-[12px] text-gray-400">
                      {teamMemberNames.get(team.id)?.slice(0, 3).join(", ") ||
                        "No members assigned yet"}
                      {(teamMemberNames.get(team.id)?.length ?? 0) > 3
                        ? ` +${(teamMemberNames.get(team.id)?.length ?? 0) - 3}`
                        : ""}
                    </p>
                  </div>
                  <span className="text-[13px] text-gray-400">{`${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}`}</span>
                  <div className="flex items-center justify-end gap-3">
                    {access.canManageTeams ? (
                      <>
                        <ActionButton
                          icon={Pencil}
                          onClick={() => {
                            setShowTeamForm(false);
                            setEditingTeamId(team.id);
                            setTeamNameDraft(team.name);
                            setTeamMemberDraft(team.memberIds);
                          }}
                        >
                          Edit
                        </ActionButton>
                        <ActionButton
                          tone="danger"
                          icon={Trash2}
                          disabled={mutationBusy === "delete-team"}
                          onClick={async () => {
                            setPageError(null);
                            try {
                              await deleteTeam(team.id);
                              if (editingTeamId === team.id) {
                                resetTeamEditor();
                              }
                            } catch (error) {
                              setPageError(
                                error instanceof Error
                                  ? error.message
                                  : "Could not delete team.",
                              );
                            }
                          }}
                        >
                          {mutationBusy === "delete-team" ? "Deleting..." : "Delete"}
                        </ActionButton>
                      </>
                    ) : (
                      <span className="text-[13px] text-gray-400">
                        Read only
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}

      {activeTab === "roles" ? (
        <div>
          <div className="mb-6 flex items-center justify-between gap-4">
            <p className="text-[15px] text-gray-400">
              {access.canManageRoles
                ? "Default roles stay available, and owners can add, edit, or remove custom roles here."
                : "Role definitions are visible here, but only owners can change them."}
            </p>
            {toolbarAction ? (
              <DenButton icon={Plus} onClick={toolbarAction.onClick}>
                {toolbarAction.label}
              </DenButton>
            ) : null}
          </div>

          <div className="overflow-x-auto overflow-y-visible rounded-2xl border border-gray-100 bg-white">
            <div className="grid grid-cols-[minmax(0,1fr)_120px_200px] gap-4 border-b border-gray-100 px-6 py-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              <span>Role</span>
              <span>Type</span>
              <span />
            </div>

            {orgContext.roles.map((role) => (
              <div
                key={role.id}
                className="grid grid-cols-[minmax(0,1fr)_120px_200px] items-center gap-4 border-b border-gray-100 px-6 py-3.5 transition hover:bg-gray-50/60 last:border-b-0"
              >
                <span className="text-[13px] font-medium text-gray-900">
                  {formatRoleLabel(role.role)}
                </span>
                <span className="text-[13px] text-gray-400">
                  {role.protected
                    ? "System"
                    : role.builtIn
                      ? "Default"
                      : "Custom"}
                </span>
                <div className="flex items-center justify-end gap-3">
                  {access.canManageRoles && !role.protected ? (
                    <>
                      <ActionButton
                        icon={Pencil}
                        onClick={() => {
                          setShowRoleForm(false);
                          setEditingRoleId(role.id);
                          setRoleNameDraft(role.role);
                          setRolePermissionDraft(
                            clonePermissionRecord(role.permission),
                          );
                        }}
                      >
                        Edit
                      </ActionButton>
                      <ActionButton
                        tone="danger"
                        icon={Trash2}
                        disabled={mutationBusy === "delete-role"}
                        onClick={async () => {
                          setPageError(null);
                          try {
                            await deleteRole(role.id);
                            if (editingRoleId === role.id) {
                              resetRoleEditor();
                            }
                          } catch (error) {
                            setPageError(
                              error instanceof Error
                                ? error.message
                                : "Could not delete role.",
                            );
                          }
                        }}
                      >
                        {mutationBusy === "delete-role" ? "Deleting..." : "Delete"}
                      </ActionButton>
                    </>
                  ) : (
                    <span className="text-[13px] text-gray-400">Read only</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </DashboardPageTemplate>
  );
}
