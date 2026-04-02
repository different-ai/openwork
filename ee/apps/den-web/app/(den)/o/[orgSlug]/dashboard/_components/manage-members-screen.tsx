"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Lock,
  Mail,
  Pencil,
  Plus,
  Settings,
  Shield,
  Trash2,
  User,
  Users,
} from "lucide-react";
import {
  DEN_ROLE_PERMISSION_OPTIONS,
  formatRoleLabel,
  getOrgAccessFlags,
  splitRoleString,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type MembersTab = "members" | "teams" | "roles" | "invitations";

function clonePermissionRecord(value: Record<string, string[]>) {
  return Object.fromEntries(Object.entries(value).map(([resource, actions]) => [resource, [...actions]]));
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
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  tone?: "default" | "danger";
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
        tone === "danger"
          ? "border-red-200 text-red-600 hover:bg-red-50"
          : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900"
      }`}
    >
      {children}
    </button>
  );
}

function SummaryCard({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "dark" }) {
  return (
    <div className={`rounded-[24px] border px-5 py-4 ${tone === "dark" ? "border-[#0f172a] bg-[#0f172a] text-white" : "border-gray-200 bg-white text-gray-900"}`}>
      <p className={`text-[12px] font-semibold uppercase tracking-[0.16em] ${tone === "dark" ? "text-white/60" : "text-gray-400"}`}>{label}</p>
      <p className="mt-3 text-[24px] font-semibold tracking-[-0.05em]">{value}</p>
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
  const [memberRoleDraft, setMemberRoleDraft] = useState("member");
  const [showTeamForm, setShowTeamForm] = useState(false);
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [teamNameDraft, setTeamNameDraft] = useState("");
  const [teamMemberDraft, setTeamMemberDraft] = useState<string[]>([]);
  const [showRoleForm, setShowRoleForm] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [roleNameDraft, setRoleNameDraft] = useState("");
  const [rolePermissionDraft, setRolePermissionDraft] = useState<Record<string, string[]>>({});

  const assignableRoles = useMemo(
    () => (orgContext?.roles ?? []).filter((role) => !role.protected),
    [orgContext?.roles],
  );

  const access = useMemo(
    () => getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false),
    [orgContext?.currentMember.isOwner, orgContext?.currentMember.role],
  );

  const pendingInvitations = useMemo(
    () => (orgContext?.invitations ?? []).filter((invitation) => invitation.status === "pending"),
    [orgContext?.invitations],
  );

  const tabCounts: Record<MembersTab, number> = {
    members: orgContext?.members.length ?? 0,
    teams: orgContext?.teams.length ?? 0,
    roles: orgContext?.roles.length ?? 0,
    invitations: pendingInvitations.length,
  };

  const teamMemberNames = useMemo(() => {
    const membersById = new Map((orgContext?.members ?? []).map((member) => [member.id, member.user.name]));
    return new Map(
      (orgContext?.teams ?? []).map((team) => [
        team.id,
        team.memberIds.map((memberId) => membersById.get(memberId)).filter((value): value is string => Boolean(value)),
      ]),
    );
  }, [orgContext?.members, orgContext?.teams]);

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
      assignableRoles.some((role) => role.role === current) ? current : assignableRoles[0].role,
    );
    setMemberRoleDraft((current) =>
      assignableRoles.some((role) => role.role === current) ? current : assignableRoles[0].role,
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

  const inviteForm = showInviteForm && access.canInviteMembers ? (
    <div className="mb-6 rounded-[30px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.22)]">
      <form
        className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_220px_auto] lg:items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          setPageError(null);
          try {
            await inviteMember({ email: inviteEmail, role: inviteRole });
            resetInviteForm();
          } catch (error) {
            setPageError(error instanceof Error ? error.message : "Could not invite member.");
          }
        }}
      >
        <label className="grid gap-3">
          <span className="text-[14px] font-medium text-gray-700">Email</span>
          <input
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="teammate@example.com"
            required
            className="h-14 rounded-[20px] border border-gray-200 bg-[#f8fafc] px-4 text-[15px] text-gray-900 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
          />
        </label>
        <label className="grid gap-3">
          <span className="text-[14px] font-medium text-gray-700">Role</span>
          <select
            value={inviteRole}
            onChange={(event) => setInviteRole(event.target.value)}
            className="h-14 rounded-[20px] border border-gray-200 bg-[#f8fafc] px-4 text-[15px] text-gray-900 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
          >
            {assignableRoles.map((role) => (
              <option key={role.id} value={role.role}>
                {formatRoleLabel(role.role)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2 lg:justify-end">
          <ActionButton onClick={resetInviteForm}>Cancel</ActionButton>
          <button
            type="submit"
            disabled={mutationBusy === "invite-member"}
            className="inline-flex h-12 items-center justify-center rounded-full bg-[#0f172a] px-5 text-[14px] font-medium text-white transition hover:bg-[#111c33] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {mutationBusy === "invite-member" ? "Sending..." : "Send invite"}
          </button>
        </div>
      </form>
    </div>
  ) : null;

  const editMemberForm = editingMemberId && access.canManageMembers ? (
    <div className="mb-6 rounded-[30px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.22)]">
      <form
        className="grid gap-4 lg:grid-cols-[240px_auto] lg:items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          setPageError(null);
          try {
            await updateMemberRole(editingMemberId, memberRoleDraft);
            resetMemberEditor();
          } catch (error) {
            setPageError(error instanceof Error ? error.message : "Could not update member role.");
          }
        }}
      >
        <label className="grid gap-3">
          <span className="text-[14px] font-medium text-gray-700">Role</span>
          <select
            value={memberRoleDraft}
            onChange={(event) => setMemberRoleDraft(event.target.value)}
            className="h-14 rounded-[20px] border border-gray-200 bg-[#f8fafc] px-4 text-[15px] text-gray-900 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
          >
            {assignableRoles.map((role) => (
              <option key={role.id} value={role.role}>
                {formatRoleLabel(role.role)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2 lg:justify-end">
          <ActionButton onClick={resetMemberEditor}>Cancel</ActionButton>
          <button
            type="submit"
            disabled={mutationBusy === "update-member-role"}
            className="inline-flex h-12 items-center justify-center rounded-full bg-[#0f172a] px-5 text-[14px] font-medium text-white transition hover:bg-[#111c33] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {mutationBusy === "update-member-role" ? "Saving..." : "Save member"}
          </button>
        </div>
      </form>
    </div>
  ) : null;

  const teamForm = (showTeamForm || editingTeamId) && access.canManageTeams ? (
    <div className="mb-6 rounded-[30px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.22)]">
      <form
        className="grid gap-6"
        onSubmit={async (event) => {
          event.preventDefault();
          setPageError(null);
          try {
            if (editingTeamId) {
              await updateTeam(editingTeamId, { name: teamNameDraft, memberIds: teamMemberDraft });
            } else {
              await createTeam({ name: teamNameDraft, memberIds: teamMemberDraft });
            }
            resetTeamEditor();
          } catch (error) {
            setPageError(error instanceof Error ? error.message : "Could not save team.");
          }
        }}
      >
        <label className="grid gap-3 lg:max-w-[420px]">
          <span className="text-[14px] font-medium text-gray-700">Team name</span>
          <input
            type="text"
            value={teamNameDraft}
            onChange={(event) => setTeamNameDraft(event.target.value)}
            placeholder="Core Engineering"
            required
            className="h-14 rounded-[20px] border border-gray-200 bg-[#f8fafc] px-4 text-[15px] text-gray-900 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
          />
        </label>

        <div>
          <p className="mb-3 text-[14px] font-medium text-gray-700">Team members</p>
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
                    <div>
                      <p className="text-[15px] font-medium tracking-[-0.03em]">{member.user.name}</p>
                      <p className={`mt-1 text-[13px] ${selected ? "text-white/70" : "text-gray-400"}`}>
                        {member.user.email}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <ActionButton onClick={resetTeamEditor}>Cancel</ActionButton>
          <button
            type="submit"
            disabled={mutationBusy === "create-team" || mutationBusy === "update-team"}
            className="inline-flex h-12 items-center justify-center rounded-full bg-[#0f172a] px-5 text-[14px] font-medium text-white transition hover:bg-[#111c33] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {mutationBusy === "create-team" || mutationBusy === "update-team"
              ? "Saving..."
              : editingTeamId
                ? "Save team"
                : "Create team"}
          </button>
        </div>
      </form>
    </div>
  ) : null;

  const roleForm = (showRoleForm || editingRoleId) && access.canManageRoles ? (
    <div className="mb-6 rounded-[30px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.22)]">
      <form
        className="grid gap-6"
        onSubmit={async (event) => {
          event.preventDefault();
          setPageError(null);
          try {
            if (editingRoleId) {
              await updateRole(editingRoleId, { roleName: roleNameDraft, permission: rolePermissionDraft });
            } else {
              await createRole({ roleName: roleNameDraft, permission: rolePermissionDraft });
            }
            resetRoleEditor();
          } catch (error) {
            setPageError(error instanceof Error ? error.message : "Could not save role.");
          }
        }}
      >
        <label className="grid gap-3 lg:max-w-[420px]">
          <span className="text-[14px] font-medium text-gray-700">Role name</span>
          <input
            type="text"
            value={roleNameDraft}
            onChange={(event) => setRoleNameDraft(event.target.value)}
            placeholder="qa-reviewer"
            required
            className="h-14 rounded-[20px] border border-gray-200 bg-[#f8fafc] px-4 text-[15px] text-gray-900 outline-none transition focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
          />
        </label>

        <div className="grid gap-4 xl:grid-cols-3">
          {Object.entries(DEN_ROLE_PERMISSION_OPTIONS).map(([resource, actions]) => (
            <div key={resource} className="rounded-[24px] border border-gray-200 bg-[#f8fafc] p-4">
              <p className="mb-3 text-[15px] font-semibold text-gray-900">{formatRoleLabel(resource)}</p>
              <div className="grid gap-2">
                {actions.map((action) => {
                  const checked = (rolePermissionDraft[resource] ?? []).includes(action);
                  return (
                    <label key={`${resource}-${action}`} className="inline-flex items-center gap-2 text-[14px] text-gray-600">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          setRolePermissionDraft((current) =>
                            toggleAction(current, resource, action, event.target.checked),
                          )
                        }
                      />
                      <span>{formatRoleLabel(action)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <ActionButton onClick={resetRoleEditor}>Cancel</ActionButton>
          <button
            type="submit"
            disabled={mutationBusy === "create-role" || mutationBusy === "update-role"}
            className="inline-flex h-12 items-center justify-center rounded-full bg-[#0f172a] px-5 text-[14px] font-medium text-white transition hover:bg-[#111c33] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {mutationBusy === "create-role" || mutationBusy === "update-role"
              ? "Saving..."
              : editingRoleId
                ? "Save role"
                : "Create role"}
          </button>
        </div>
      </form>
    </div>
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
    if (activeTab === "invitations" && access.canInviteMembers) {
      return {
        label: "Invite member",
        onClick: () => {
          resetMemberEditor();
          setShowInviteForm((current) => !current);
        },
      };
    }
    return null;
  })();

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-8 md:px-8">
      <div className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-gray-400">{activeOrg.name}</p>
          <h1 className="text-[28px] font-semibold tracking-[-0.05em] text-gray-950">Members</h1>
          <p className="mt-2 text-[15px] leading-7 text-gray-400">Invite teammates, adjust roles, and keep access clean.</p>
        </div>

        {toolbarAction ? (
          <button
            type="button"
            onClick={toolbarAction.onClick}
            className="inline-flex h-14 items-center justify-center gap-2 rounded-full bg-[#0f172a] px-6 text-[15px] font-medium text-white transition hover:bg-[#111c33]"
          >
            <Plus className="h-4 w-4" />
            {toolbarAction.label}
          </button>
        ) : null}
      </div>

      <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Workspace members" value={`${orgContext.members.length}`} tone="dark" />
        <SummaryCard label="Teams" value={`${orgContext.teams.length}`} />
        <SummaryCard label="Roles" value={`${orgContext.roles.length}`} />
        <SummaryCard label="Pending invites" value={`${pendingInvitations.length}`} />
      </div>

      {pageError ? (
        <div className="mb-6 rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[14px] text-red-700">
          {pageError}
        </div>
      ) : null}

      <div className="mb-8 inline-flex flex-wrap rounded-[30px] border border-gray-200 bg-white p-1 shadow-[0_8px_20px_-16px_rgba(15,23,42,0.3)]">
        {([
          ["members", "Members", User],
          ["teams", "Teams", Users],
          ["roles", "Roles", Shield],
          ["invitations", "Invitations", Mail],
        ] as const).map(([value, label, Icon]) => {
          const selected = activeTab === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setActiveTab(value)}
              className={`inline-flex items-center gap-3 rounded-[24px] px-5 py-3 text-[15px] font-medium tracking-[-0.02em] transition-all ${
                selected
                  ? "bg-white text-gray-950 shadow-[0_8px_20px_-18px_rgba(15,23,42,0.4)]"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${selected ? "bg-gray-100 text-gray-600" : "bg-gray-100 text-gray-500"}`}>
                {tabCounts[value]}
              </span>
            </button>
          );
        })}
      </div>

      {activeTab === "members" ? inviteForm : null}
      {activeTab === "members" ? editMemberForm : null}
      {activeTab === "teams" ? teamForm : null}
      {activeTab === "roles" ? roleForm : null}
      {activeTab === "invitations" ? inviteForm : null}

      {activeTab === "members" ? (
        <div>
          <p className="mb-6 text-[15px] text-gray-400">
            {access.canInviteMembers
              ? "Invite people, update their role, or remove them from the organization."
              : "View who is in the organization and what role they currently hold."}
          </p>

          <div className="overflow-hidden rounded-[30px] border border-gray-200 bg-white shadow-[0_18px_48px_-34px_rgba(15,23,42,0.2)]">
            <div className="grid grid-cols-[minmax(0,1fr)_180px_140px_160px] gap-4 border-b border-gray-100 bg-[#fbfcfe] px-6 py-4 text-[14px] text-gray-400">
              <span>Member</span>
              <span>Role</span>
              <span>Joined</span>
              <span />
            </div>

            {orgContext.members.map((member) => (
              <div
                key={member.id}
                className="grid grid-cols-[minmax(0,1fr)_180px_140px_160px] gap-4 border-b border-gray-100 px-6 py-6 transition hover:bg-[#fbfcfe] last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#0f172a] text-[18px] font-medium uppercase text-white">
                    {member.user.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[16px] font-medium tracking-[-0.03em] text-gray-950">{member.user.name}</p>
                    <p className="truncate text-[14px] text-gray-400">{member.user.email}</p>
                  </div>
                </div>
                <span className="text-[15px] text-gray-600">{splitRoleString(member.role).map(formatRoleLabel).join(", ")}</span>
                <span className="text-[15px] text-gray-500">{member.createdAt ? new Date(member.createdAt).toLocaleDateString() : "-"}</span>
                <div className="flex items-center justify-end gap-3">
                  {member.isOwner ? (
                    <span className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-4 py-2 text-[13px] text-gray-500">
                      <Lock className="h-3.5 w-3.5" />
                      Locked
                    </span>
                  ) : access.canManageMembers ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMemberId(member.id);
                          setMemberRoleDraft(member.role);
                          setShowInviteForm(false);
                        }}
                        className="rounded-full p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                        aria-label={`Edit ${member.user.name}`}
                      >
                        <Settings className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          setPageError(null);
                          try {
                            await removeMember(member.id);
                            if (editingMemberId === member.id) {
                              resetMemberEditor();
                            }
                          } catch (error) {
                            setPageError(error instanceof Error ? error.message : "Could not remove member.");
                          }
                        }}
                        disabled={mutationBusy === "remove-member"}
                        className="rounded-full p-2 text-gray-400 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                        aria-label={`Remove ${member.user.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
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

      {activeTab === "teams" ? (
        <div>
          <p className="mb-6 text-[15px] text-gray-400">Manage teams and their members.</p>

          <div className="overflow-hidden rounded-[30px] border border-gray-200 bg-white shadow-[0_18px_48px_-34px_rgba(15,23,42,0.2)]">
            <div className="grid grid-cols-[minmax(0,1fr)_220px_220px] gap-4 border-b border-gray-100 bg-[#fbfcfe] px-6 py-4 text-[14px] text-gray-400">
              <span>Team</span>
              <span>Members</span>
              <span />
            </div>

            {orgContext.teams.length === 0 ? (
              <div className="px-6 py-10 text-center text-[15px] text-gray-400">No teams yet.</div>
            ) : (
              orgContext.teams.map((team) => (
                <div key={team.id} className="grid grid-cols-[minmax(0,1fr)_220px_220px] gap-4 border-b border-gray-100 px-6 py-6 transition hover:bg-[#fbfcfe] last:border-b-0">
                  <div>
                    <span className="text-[16px] font-medium tracking-[-0.03em] text-gray-950">{team.name}</span>
                    <p className="mt-2 text-[13px] text-gray-400">
                      {teamMemberNames.get(team.id)?.slice(0, 3).join(", ") || "No members assigned yet"}
                      {(teamMemberNames.get(team.id)?.length ?? 0) > 3 ? ` +${(teamMemberNames.get(team.id)?.length ?? 0) - 3}` : ""}
                    </p>
                  </div>
                  <span className="text-[15px] text-gray-500">{`${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}`}</span>
                  <div className="flex items-center justify-end gap-3">
                    {access.canManageTeams ? (
                      <>
                        <ActionButton
                          onClick={() => {
                            setShowTeamForm(false);
                            setEditingTeamId(team.id);
                            setTeamNameDraft(team.name);
                            setTeamMemberDraft(team.memberIds);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </ActionButton>
                        <ActionButton
                          tone="danger"
                          disabled={mutationBusy === "delete-team"}
                          onClick={async () => {
                            setPageError(null);
                            try {
                              await deleteTeam(team.id);
                              if (editingTeamId === team.id) {
                                resetTeamEditor();
                              }
                            } catch (error) {
                              setPageError(error instanceof Error ? error.message : "Could not delete team.");
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {mutationBusy === "delete-team" ? "Deleting..." : "Delete"}
                        </ActionButton>
                      </>
                    ) : (
                      <span className="text-[13px] text-gray-400">Read only</span>
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
          <p className="mb-6 text-[15px] text-gray-400">
            {access.canManageRoles
              ? "Default roles stay available, and owners can add, edit, or remove custom roles here."
              : "Role definitions are visible here, but only owners can change them."}
          </p>

          <div className="overflow-hidden rounded-[30px] border border-gray-200 bg-white shadow-[0_18px_48px_-34px_rgba(15,23,42,0.2)]">
            <div className="grid grid-cols-[minmax(0,1fr)_140px_220px] gap-4 border-b border-gray-100 bg-[#fbfcfe] px-6 py-4 text-[14px] text-gray-400">
              <span>Role</span>
              <span>Type</span>
              <span />
            </div>

            {orgContext.roles.map((role) => (
              <div key={role.id} className="grid grid-cols-[minmax(0,1fr)_140px_220px] gap-4 border-b border-gray-100 px-6 py-6 transition hover:bg-[#fbfcfe] last:border-b-0">
                <span className="text-[16px] font-medium tracking-[-0.03em] text-gray-950">{formatRoleLabel(role.role)}</span>
                <span className="text-[15px] text-gray-500">{role.protected ? "System" : role.builtIn ? "Default" : "Custom"}</span>
                <div className="flex items-center justify-end gap-3">
                  {access.canManageRoles && !role.protected ? (
                    <>
                      <ActionButton
                        onClick={() => {
                          setShowRoleForm(false);
                          setEditingRoleId(role.id);
                          setRoleNameDraft(role.role);
                          setRolePermissionDraft(clonePermissionRecord(role.permission));
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </ActionButton>
                      <ActionButton
                        tone="danger"
                        disabled={mutationBusy === "delete-role"}
                        onClick={async () => {
                          setPageError(null);
                          try {
                            await deleteRole(role.id);
                            if (editingRoleId === role.id) {
                              resetRoleEditor();
                            }
                          } catch (error) {
                            setPageError(error instanceof Error ? error.message : "Could not delete role.");
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
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

      {activeTab === "invitations" ? (
        <div>
          <p className="mb-6 text-[15px] text-gray-400">Admins and owners can revoke pending invites before they are accepted.</p>

          <div className="overflow-hidden rounded-[30px] border border-gray-200 bg-white shadow-[0_18px_48px_-34px_rgba(15,23,42,0.2)]">
            <div className="grid grid-cols-[minmax(0,1fr)_150px_150px_140px] gap-4 border-b border-gray-100 bg-[#fbfcfe] px-6 py-4 text-[14px] text-gray-400">
              <span>Email</span>
              <span>Role</span>
              <span>Expires</span>
              <span />
            </div>

            {pendingInvitations.length === 0 ? (
              <div className="px-6 py-10 text-center text-[15px] text-gray-400">You have no pending workspace invites.</div>
            ) : (
              pendingInvitations.map((invitation) => (
                <div key={invitation.id} className="grid grid-cols-[minmax(0,1fr)_150px_150px_140px] gap-4 border-b border-gray-100 px-6 py-6 transition hover:bg-[#fbfcfe] last:border-b-0">
                  <span className="truncate text-[15px] text-gray-900">{invitation.email}</span>
                  <span className="text-[15px] text-gray-500">{formatRoleLabel(invitation.role)}</span>
                  <span className="text-[15px] text-gray-500">{invitation.expiresAt ? new Date(invitation.expiresAt).toLocaleDateString() : "-"}</span>
                  <div className="flex justify-end">
                    {access.canCancelInvitations ? (
                      <ActionButton
                        disabled={mutationBusy === "cancel-invitation"}
                        onClick={async () => {
                          setPageError(null);
                          try {
                            await cancelInvitation(invitation.id);
                          } catch (error) {
                            setPageError(error instanceof Error ? error.message : "Could not cancel invitation.");
                          }
                        }}
                      >
                        {mutationBusy === "cancel-invitation" ? "Cancelling..." : "Cancel"}
                      </ActionButton>
                    ) : (
                      <span className="text-[13px] text-gray-400">Read only</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
