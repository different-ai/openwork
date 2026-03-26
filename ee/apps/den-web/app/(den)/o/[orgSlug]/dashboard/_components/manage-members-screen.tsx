"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEN_ROLE_PERMISSION_OPTIONS,
  formatRoleLabel,
  getOrgAccessFlags,
  splitRoleString,
  type DenOrgRole,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

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

function SectionCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="rounded-[28px] border border-[var(--dls-border)] bg-white p-5 shadow-[var(--dls-card-shadow)] md:p-6">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-[var(--dls-text-primary)]">{title}</h2>
          <p className="mt-1 text-sm text-[var(--dls-text-secondary)]">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </article>
  );
}

function SectionButton({
  children,
  onClick,
  tone = "default",
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
}) {
  const className = tone === "danger"
    ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
    : "border-[var(--dls-border)] bg-[var(--dls-surface)] text-[var(--dls-text-secondary)] hover:bg-[var(--dls-hover)] hover:text-[var(--dls-text-primary)]";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-2xl border px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {children}
    </button>
  );
}

function InlinePanel({ children }: { children: ReactNode }) {
  return <div className="mb-4 rounded-[24px] border border-[var(--dls-border)] bg-[var(--dls-sidebar)] p-4 md:p-5">{children}</div>;
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
    createRole,
    updateRole,
    deleteRole,
  } = useOrgDashboard();
  const [pageError, setPageError] = useState<string | null>(null);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [memberRoleDraft, setMemberRoleDraft] = useState("member");
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

  function resetInviteForm() {
    setInviteEmail("");
    setInviteRole(assignableRoles[0]?.role ?? "member");
    setShowInviteForm(false);
  }

  function resetMemberEditor() {
    setEditingMemberId(null);
    setMemberRoleDraft(assignableRoles[0]?.role ?? "member");
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

    setInviteRole((current) => (assignableRoles.some((role) => role.role === current) ? current : assignableRoles[0].role));
    setMemberRoleDraft((current) => (assignableRoles.some((role) => role.role === current) ? current : assignableRoles[0].role));
  }, [assignableRoles]);

  if (orgBusy && !orgContext) {
    return (
      <section className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-12">
        <div className="rounded-[28px] border border-[var(--dls-border)] bg-white p-6 shadow-[var(--dls-card-shadow)]">
          <p className="text-sm text-[var(--dls-text-secondary)]">Loading organization details...</p>
        </div>
      </section>
    );
  }

  if (!orgContext || !activeOrg) {
    return (
      <section className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-12">
        <div className="rounded-[28px] border border-[var(--dls-border)] bg-white p-6 shadow-[var(--dls-card-shadow)]">
          <p className="text-sm font-medium text-rose-600">{orgError ?? "Organization details are unavailable."}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:p-12">
      <div className="rounded-[32px] border border-[var(--dls-border)] bg-white p-6 shadow-[var(--dls-card-shadow)] md:p-8">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--dls-text-secondary)]">Manage Members</p>
            <h1 className="mt-2 text-[2.4rem] font-semibold leading-[0.95] tracking-[-0.06em] text-[var(--dls-text-primary)]">
              {activeOrg.name}
            </h1>
            <p className="mt-3 max-w-2xl text-[15px] leading-7 text-[var(--dls-text-secondary)]">
              See everyone in the organization, invite new people, and keep roles tidy without the permission matrix taking over the page.
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--dls-border)] bg-[var(--dls-sidebar)] px-4 py-3 text-sm text-[var(--dls-text-secondary)]">
            Your role: <span className="font-semibold text-[var(--dls-text-primary)]">{formatRoleLabel(orgContext.currentMember.role)}</span>
          </div>
        </div>
      </div>

      {pageError ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{pageError}</div> : null}

      <SectionCard
        title="Members"
        description={access.canInviteMembers ? "Invite people, update their role, or remove them from the organization." : "View who is in the organization and what role they currently hold."}
        action={access.canInviteMembers ? <SectionButton onClick={() => { resetMemberEditor(); setShowInviteForm((current) => !current); }}>{showInviteForm ? "Close invite form" : "Add member"}</SectionButton> : undefined}
      >
        {showInviteForm && access.canInviteMembers ? (
          <InlinePanel>
            <form
              className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(180px,0.7fr)_auto] md:items-end"
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
              <label className="grid gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">Email</span>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="teammate@example.com"
                  required
                  className="rounded-2xl border border-[var(--dls-border)] bg-white px-4 py-3 text-sm text-[var(--dls-text-primary)] outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-900/5"
                />
              </label>
              <label className="grid gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">Role</span>
                <select
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value)}
                  className="rounded-2xl border border-[var(--dls-border)] bg-white px-4 py-3 text-sm text-[var(--dls-text-primary)] outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-900/5"
                >
                  {assignableRoles.map((role) => (
                    <option key={role.id} value={role.role}>
                      {formatRoleLabel(role.role)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2 md:justify-end">
                <SectionButton onClick={resetInviteForm}>Cancel</SectionButton>
                <button
                  type="submit"
                  className="rounded-2xl bg-[#011627] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={mutationBusy === "invite-member"}
                >
                  {mutationBusy === "invite-member" ? "Sending..." : "Send invite"}
                </button>
              </div>
            </form>
          </InlinePanel>
        ) : null}

        {editingMemberId && access.canManageMembers ? (
          <InlinePanel>
            <form
              className="grid gap-3 md:grid-cols-[minmax(220px,0.9fr)_auto] md:items-end"
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
              <label className="grid gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">Role</span>
                <select
                  value={memberRoleDraft}
                  onChange={(event) => setMemberRoleDraft(event.target.value)}
                  className="rounded-2xl border border-[var(--dls-border)] bg-white px-4 py-3 text-sm text-[var(--dls-text-primary)] outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-900/5"
                >
                  {assignableRoles.map((role) => (
                    <option key={role.id} value={role.role}>
                      {formatRoleLabel(role.role)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2 md:justify-end">
                <SectionButton onClick={resetMemberEditor}>Cancel</SectionButton>
                <button
                  type="submit"
                  className="rounded-2xl bg-[#011627] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={mutationBusy === "update-member-role"}
                >
                  {mutationBusy === "update-member-role" ? "Saving..." : "Save member"}
                </button>
              </div>
            </form>
          </InlinePanel>
        ) : null}

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--dls-border)] text-left text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">
                <th className="px-3 py-3">Member</th>
                <th className="px-3 py-3">Role</th>
                <th className="px-3 py-3">Joined</th>
                <th className="px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orgContext.members.map((member) => (
                <tr key={member.id} className="border-b border-[var(--dls-border)] last:border-b-0">
                  <td className="px-3 py-4">
                    <div className="grid gap-1">
                      <span className="font-semibold text-[var(--dls-text-primary)]">{member.user.name}</span>
                      <span className="text-xs text-[var(--dls-text-secondary)]">{member.user.email}</span>
                    </div>
                  </td>
                  <td className="px-3 py-4 text-[var(--dls-text-secondary)]">{splitRoleString(member.role).map(formatRoleLabel).join(", ")}</td>
                  <td className="px-3 py-4 text-[var(--dls-text-secondary)]">{member.createdAt ? new Date(member.createdAt).toLocaleDateString() : "-"}</td>
                  <td className="px-3 py-4">
                    <div className="flex flex-wrap gap-2">
                      {member.isOwner ? (
                        <span className="text-xs font-medium text-[var(--dls-text-secondary)]">Locked</span>
                      ) : access.canManageMembers ? (
                        <>
                          <SectionButton
                            onClick={() => {
                              setEditingMemberId(member.id);
                              setMemberRoleDraft(member.role);
                              setShowInviteForm(false);
                            }}
                          >
                            Edit
                          </SectionButton>
                          <SectionButton
                            tone="danger"
                            disabled={mutationBusy === "remove-member"}
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
                          >
                            {mutationBusy === "remove-member" ? "Removing..." : "Remove"}
                          </SectionButton>
                        </>
                      ) : (
                        <span className="text-xs font-medium text-[var(--dls-text-secondary)]">Read only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="Pending invitations"
        description={access.canCancelInvitations ? "Admins and owners can revoke pending invites before they are accepted." : "Pending invites are visible here once they have been sent."}
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--dls-border)] text-left text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">
                <th className="px-3 py-3">Email</th>
                <th className="px-3 py-3">Role</th>
                <th className="px-3 py-3">Expires</th>
                <th className="px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pendingInvitations.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-sm text-[var(--dls-text-secondary)]">No pending invitations.</td>
                </tr>
              ) : pendingInvitations.map((invitation) => (
                <tr key={invitation.id} className="border-b border-[var(--dls-border)] last:border-b-0">
                  <td className="px-3 py-4 font-medium text-[var(--dls-text-primary)]">{invitation.email}</td>
                  <td className="px-3 py-4 text-[var(--dls-text-secondary)]">{formatRoleLabel(invitation.role)}</td>
                  <td className="px-3 py-4 text-[var(--dls-text-secondary)]">{invitation.expiresAt ? new Date(invitation.expiresAt).toLocaleDateString() : "-"}</td>
                  <td className="px-3 py-4">
                    {access.canCancelInvitations ? (
                      <SectionButton
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
                      </SectionButton>
                    ) : <span className="text-xs font-medium text-[var(--dls-text-secondary)]">Read only</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="Roles"
        description={access.canManageRoles ? "Default roles stay available, and owners can add, edit, or remove custom roles here." : "Role definitions are visible here, but only owners can change them."}
        action={access.canManageRoles ? <SectionButton onClick={() => { setShowRoleForm((current) => !current); setEditingRoleId(null); setRoleNameDraft(""); setRolePermissionDraft({}); }}>{showRoleForm ? "Close role form" : "Add role"}</SectionButton> : undefined}
      >
        {(showRoleForm || editingRoleId) && access.canManageRoles ? (
          <InlinePanel>
            <form
              className="grid gap-4"
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
                  setPageError(error instanceof Error ? error.message : "Could not save role.");
                }
              }}
            >
              <label className="grid gap-2 md:max-w-sm">
                <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">Role name</span>
                <input
                  type="text"
                  value={roleNameDraft}
                  onChange={(event) => setRoleNameDraft(event.target.value)}
                  placeholder="qa-reviewer"
                  required
                  className="rounded-2xl border border-[var(--dls-border)] bg-white px-4 py-3 text-sm text-[var(--dls-text-primary)] outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-900/5"
                />
              </label>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {Object.entries(DEN_ROLE_PERMISSION_OPTIONS).map(([resource, actions]) => (
                  <div key={resource} className="rounded-2xl border border-[var(--dls-border)] bg-white p-4">
                    <p className="mb-3 text-sm font-semibold text-[var(--dls-text-primary)]">{formatRoleLabel(resource)}</p>
                    <div className="grid gap-2">
                      {actions.map((action) => {
                        const checked = (rolePermissionDraft[resource] ?? []).includes(action);
                        return (
                          <label key={`${resource}-${action}`} className="inline-flex items-center gap-2 text-sm text-[var(--dls-text-secondary)]">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => setRolePermissionDraft((current) => toggleAction(current, resource, action, event.target.checked))}
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
                <SectionButton onClick={resetRoleEditor}>Cancel</SectionButton>
                <button
                  type="submit"
                  className="rounded-2xl bg-[#011627] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={mutationBusy === "create-role" || mutationBusy === "update-role"}
                >
                  {mutationBusy === "create-role" || mutationBusy === "update-role"
                    ? "Saving..."
                    : editingRoleId
                      ? "Save role"
                      : "Create role"}
                </button>
              </div>
            </form>
          </InlinePanel>
        ) : null}

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--dls-border)] text-left text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">
                <th className="px-3 py-3">Role</th>
                <th className="px-3 py-3">Type</th>
                <th className="px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orgContext.roles.map((role) => (
                <tr key={role.id} className="border-b border-[var(--dls-border)] last:border-b-0">
                  <td className="px-3 py-4 font-medium text-[var(--dls-text-primary)]">{formatRoleLabel(role.role)}</td>
                  <td className="px-3 py-4 text-[var(--dls-text-secondary)]">{role.protected ? "System" : role.builtIn ? "Default" : "Custom"}</td>
                  <td className="px-3 py-4">
                    {access.canManageRoles && !role.protected ? (
                      <div className="flex flex-wrap gap-2">
                        <SectionButton
                          onClick={() => {
                            setShowRoleForm(false);
                            setEditingRoleId(role.id);
                            setRoleNameDraft(role.role);
                            setRolePermissionDraft(clonePermissionRecord(role.permission));
                          }}
                        >
                          Edit
                        </SectionButton>
                        <SectionButton
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
                          {mutationBusy === "delete-role" ? "Deleting..." : "Delete"}
                        </SectionButton>
                      </div>
                    ) : <span className="text-xs font-medium text-[var(--dls-text-secondary)]">Read only</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </section>
  );
}
