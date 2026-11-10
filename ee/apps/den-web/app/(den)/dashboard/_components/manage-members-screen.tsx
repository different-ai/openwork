"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useSearchParams } from "next/navigation";
import { type ElementType, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Globe,
  Lock,
  Plus,
  ShieldCheck,
  User,
  Users,
} from "lucide-react";
import {
  canRefreshInvitationRole,
  assignableOrgRole,
  getOrgAccessFlags,
  getMembersRoute,
  getEveryoneRoute,
  getNewRoleRoute,
  getTeamRoute,
  type DenOrgMember,
  orgFeatureEnabled,
  permissionLockReason,
} from "../../_lib/den-org";
import { type OrgLimitError, type OrgPaymentRequiredError, getOrgLimitError, getOrgPaymentRequiredError } from "../../_lib/den-flow";
import { buildDenFeedbackUrl } from "../../_lib/feedback";
import { OrgLimitDialog } from "../../_components/org-limit-dialog";
import { desktopPolicyScreenRemoved } from "../_lib/desktop-policy-screen-rollout";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { FeatureIntroGate, useFeatureIntro, useFeatureIntroUnseen, type FeatureIntroResolution } from "../_features/feature-intros";
import type { MembersFacts } from "../_features/feature-intros/intros/members";
import { UnderlineTabs } from "../../_components/ui/tabs";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenSwitch } from "../../_components/ui/switch";
import { installPageUrl } from "../../_lib/install-download";
import { OrgMemberIdentity } from "./org-member-identity";
import { MemberEffectivePermissions, canViewMemberPermissions } from "./member-effective-permissions";
import { RolesTab, canCreateRole } from "./roles-tab";
import { PeopleField } from "./access-rows";
import { ItemMenu } from "./item-list";
import { MemberListToolbar } from "./member-list-toolbar";
import { formatAddedDate } from "./item-dates";
import { TeamsListHeader, TeamsListLane, TeamsListLocked, TeamsListOpenLink, TeamsListRow, teamsListColumns } from "./teams-list-row";
import { teamOverrideSummary, useAgentPermissions } from "./agent-permissions-data";
import { useOrganizationRoles, useRoleGrantLocks, useSetMemberRole } from "./permissions-data";
import { BUILT_IN_ROLES } from "../../_lib/role-catalog";
import { SUPER_ADMIN_ROLE_LOCK_REASON, memberRoleEntry, memberRoleOptions, memberRoleStateAfter, teamRoleLabel, teamRoleLabels, teamRoleOptions } from "./team-roles";
import { RolePicker } from "./role-picker";
import { useGiveRole } from "./use-give-role";
import { useDenToast } from "./den-toast";

type MembersTab = "members" | "teams" | "roles";

/**
 * Copies text that is still being fetched. Safari only allows clipboard writes
 * started inside the click, so the pending text is handed to a ClipboardItem;
 * where that is unsupported, write it once it arrives.
 */
async function copyTextWhenReady(text: Promise<string>) {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) }),
    ]);
  } catch {
    // Rethrows the fetch error when the text itself failed.
    await navigator.clipboard.writeText(await text);
  }
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

export function ManageMembersScreen() {
  const {
    activeOrg,
    orgSlug,
    orgContext,
    orgBusy,
    orgError,
    mutationBusy,
    inviteMember,
    startSeatCheckout,
    cancelInvitation,
    getInvitationLink,
    updateMemberRole,
    removeMember,
    setMemberOpenWorkWeb,
    transferOwnership,
    createTeam,
    updateTeam,
    deleteTeam,
  } = useOrgDashboard();
  const [activeTab, setActiveTab] = useState<MembersTab>("members");
  const [memberFilter, setMemberFilter] = useState("");
  const [teamFilter, setTeamFilter] = useState("");

  // Admins choose who gets OpenWork Web (and is billed for it) where the organization has Web.
  const webPerMember = orgFeatureEnabled(orgContext, "webPerMember") && (orgContext?.capabilities.openworkWeb ?? false);
  const webMemberCount = (orgContext?.members ?? []).filter((member) => member.openworkWeb).length;
  const memberGridColumns = webPerMember ? "lg:grid-cols-[minmax(0,1fr)_180px_140px_112px_28px]" : "lg:grid-cols-[minmax(0,1fr)_180px_140px_28px]";
  const visibleMembers = (orgContext?.members ?? []).filter((member) => `${member.user.name} ${member.user.email}`.toLocaleLowerCase().includes(memberFilter.trim().toLocaleLowerCase()));
  const visibleTeams = (orgContext?.teams ?? []).filter((team) => team.name.toLocaleLowerCase().includes(teamFilter.trim().toLocaleLowerCase()));
  const [pageError, setPageError] = useState<string | null>(null);
  // Shown inside Add member and Create team, where the person is looking.
  const [formError, setFormError] = useState<string | null>(null);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [teamRoleDraft, setTeamRoleDraft] = useState("member");
  const [editingMemberTeamsId, setEditingMemberTeamsId] = useState<string | null>(null);
  const [permissionsMemberId, setPermissionsMemberId] = useState<string | null>(null);
  const [memberTeamsDraft, setMemberTeamsDraft] = useState<Set<string>>(new Set());
  const [showTeamForm, setShowTeamForm] = useState(false);
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [teamNameDraft, setTeamNameDraft] = useState("");
  const [teamMemberDraft, setTeamMemberDraft] = useState<string[]>([]);
  const [limitDialogError, setLimitDialogError] = useState<OrgLimitError | null>(null);
  const [seatBillingDialogError, setSeatBillingDialogError] = useState<OrgPaymentRequiredError | null>(null);
  const [installLinkCopied, setInstallLinkCopied] = useState(false);
  const [installLinkShareUrl, setInstallLinkShareUrl] = useState<string | null>(null);
  const [installLinkShareCopied, setInstallLinkShareCopied] = useState(false);

  const access = useMemo(
    () =>
      getOrgAccessFlags(
        orgContext?.currentMember.role ?? "member",
        orgContext?.currentMember.isOwner ?? false,
        orgContext?.currentMember.permissions,
      ),
    [orgContext?.currentMember.isOwner, orgContext?.currentMember.role, orgContext?.currentMember.permissions],
  );
  const canStartSeatCheckout = access.canStartSeatCheckout;

  // Members gets a Roles tab (built-in roles and each team's custom role).

  const searchParams = useSearchParams();
  const introUnseen = useFeatureIntroUnseen();
  useEffect(() => {
    // ?tab=roles or ?tab=teams opens that tab, e.g. coming back from Create role or from a feature intro.
    const tab = searchParams.get("tab");
    if (tab === "roles" || tab === "teams") setActiveTab(tab);
  }, [searchParams]);
  // The tab is kept in the address, so `?` and a reload open the same tab.
  function chooseTab(tab: MembersTab) {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    if (tab === "members") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url);
  }
  const shownTab: MembersTab = activeTab;
  // custom roles show wherever roles do (people's rows, the invite picker, the Teams list).

  const toast = useDenToast();
  const organizationRoles = useOrganizationRoles(orgContext?.organization.id ?? null, access.canViewPermissions);
  // The same list the Roles tab and the team picker show.
  const { roles } = organizationRoles;
  const { givePerson, giveTeam } = useGiveRole(orgContext?.organization.id ?? null);
  const setMemberRole = useSetMemberRole(orgContext?.organization.id ?? "");
  // Giving anyone a role other than Member is a role change.
  const canChooseInviteRole = access.canManageRoles;
  // A role can only be given by someone who holds everything it grants.
  const grantLocks = useRoleGrantLocks(orgContext?.organization.id ?? null, organizationRoles.sets, orgContext?.currentMember.permissions ?? [], orgContext?.currentMember.isOwner ?? false);
  const roleLocks = {
    roles,
    lockReasons: grantLocks,
    adminLockReason: grantLocks.get(organizationRoles.sets.find((set) => set.kind === "admin_default")?.id ?? ""),
    superAdminLockReason: access.isOwner || access.isSuperAdmin ? null : SUPER_ADMIN_ROLE_LOCK_REASON,
  };
  const inviteRoles = memberRoleOptions(roleLocks);
  const { memberRoleState, teamRoleState } = organizationRoles;
  const newTeamRoles = teamRoleOptions({
    roles,
    state: { admin: false, setId: null },
    abilities: { canManageAdminTeams: access.canManageAdminTeams, canManagePermissions: access.canManagePermissions, hasOwnerAuthority: access.isOwner || access.isSuperAdmin },
    lockReasons: grantLocks,
  });
  const inviteTeamPicker = access.canManageTeams && (orgContext?.teams.length ?? 0) > 0;
  const [inviteTeamId, setInviteTeamId] = useState("");
  // Teams lists Everyone first, and what each team changes from it.
  const agentPermissionsColumn = Boolean(orgContext && access.canViewAgentPermissions);
  const agentPolicies = useAgentPermissions(orgContext?.organization.id ?? "", agentPermissionsColumn && Boolean(orgContext?.organization.id));
  const teamListColumns = teamsListColumns({ agentPermissions: agentPermissionsColumn });
  const tabCounts: Record<Exclude<MembersTab, "roles">, number> = {
    members: orgContext?.members.length ?? 0,
    teams: orgContext?.teams.length ?? 0,
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
    setFormError(null);
    setInviteEmail("");
    setInviteRole("member");
    setInviteTeamId("");
    setShowInviteForm(false);
  }

  function resetTeamEditor() {
    setFormError(null);
    setEditingTeamId(null);
    setTeamNameDraft("");
    setTeamMemberDraft([]);
    setTeamRoleDraft("member");
    setShowTeamForm(false);
  }

  function selectInstallLinkShareInput() {
    const input = document.getElementById("install-link-share-url");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  }

  async function handleInstallLinkShareCopy() {
    if (!installLinkShareUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(installLinkShareUrl);
      setInstallLinkShareCopied(true);
      window.setTimeout(() => setInstallLinkShareCopied(false), 1800);
    } catch {
      selectInstallLinkShareInput();
    }
  }

  async function handleCopyInstallLink() {
    const url = installPageUrl();
    setPageError(null);
    setInstallLinkShareUrl(null);
    setInstallLinkShareCopied(false);
    // Some browsers deny programmatic clipboard access entirely; fall back to
    // showing the address for a manual copy instead of a raw browser error.
    try {
      await navigator.clipboard.writeText(url);
      setInstallLinkCopied(true);
      window.setTimeout(() => setInstallLinkCopied(false), 1800);
    } catch {
      setInstallLinkShareUrl(url);
    }
  }

  async function handleTransferOwnership(member: DenOrgMember) {
    const targetName = member.user.name || member.user.email;
    const confirmed = window.confirm(
      `Transfer workspace ownership to ${targetName}? ${targetName} becomes the sole owner, and your account becomes an admin.`,
    );
    if (!confirmed) {
      return;
    }

    setPageError(null);
    try {
      await transferOwnership(member.id);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not transfer ownership.");
    }
  }

  useEffect(() => {
    if (!access.canManageRoles) {
      setInviteRole("member");
    }
  }, [access.canManageRoles]);

  // Feature intro actions land here (DESIGN.md I5): ?invite=1 opens the invite form, ?newTeam=1 the
  // Create team form and ?editTeam=<id> that team's form. Each is read once, then dropped from the address.
  const inviteRequested = searchParams.get("invite") === "1";
  const newTeamRequested = searchParams.get("newTeam") === "1";
  const editTeamRequested = searchParams.get("editTeam");
  const [focusInvite, setFocusInvite] = useState(false);
  useEffect(() => {
    if (!orgContext || (!inviteRequested && !newTeamRequested && !editTeamRequested)) return;
    if (inviteRequested && access.canInviteMembers) {
      setActiveTab("members");
      setShowInviteForm(true);
      setFocusInvite(true);
    }
    if (newTeamRequested && access.canManageTeams) {
      setActiveTab("teams");
      setEditingTeamId(null);
      setShowTeamForm(true);
    }
    const team = editTeamRequested ? orgContext.teams.find((entry) => entry.id === editTeamRequested) : undefined;
    if (team) {
      setActiveTab("teams");
      if (!team.managedByScim && access.canManageTeams && (!team.grantsOrganizationAdmin || access.canManageAdminTeams)) {
        setShowTeamForm(false);
        setEditingTeamId(team.id);
        setTeamNameDraft(team.name);
        setTeamMemberDraft(team.memberIds);
      }
    }
    const url = new URL(window.location.href);
    for (const param of ["invite", "newTeam", "editTeam"]) url.searchParams.delete(param);
    if (team || (newTeamRequested && access.canManageTeams)) url.searchParams.set("tab", "teams");
    window.history.replaceState(null, "", url);
  }, [orgContext, inviteRequested, newTeamRequested, editTeamRequested, access.canInviteMembers, access.canManageTeams, access.canManageAdminTeams]);
  useEffect(() => {
    if (!focusInvite || !showInviteForm) return;
    const input = document.querySelector<HTMLInputElement>('[data-testid="invite-email"]');
    if (!input) return;
    input.focus();
    setFocusInvite(false);
  }, [focusInvite, showInviteForm]);

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

  const inviteForm = (
    <MembersFormDialog open={showInviteForm && access.canInviteMembers} title="Add member" onClose={resetInviteForm} testId="invite-dialog">
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setFormError(null);
            try {
              // Member, Admin and Super admin travel with the invitation; any other role is given to the pending member.
              const chosen = roles.find((role) => role.value === (canChooseInviteRole ? inviteRole : "member"));
              const state = chosen ? memberRoleStateAfter(chosen) : { role: "member", setId: null };
              const memberId = await inviteMember({ email: inviteEmail, role: state.role, teamId: inviteTeamPicker ? inviteTeamId || null : undefined });
              if (chosen && state.setId) {
                if (!memberId) throw new Error(`${inviteEmail} was invited as a Member. Give them ${chosen.label} from their row once they show in the list.`);
                await setMemberRole.mutateAsync({ memberId, permissionSetId: state.setId });
              }
              resetInviteForm();
            } catch (error) {
              const paymentRequiredError = getOrgPaymentRequiredError(error);
              if (paymentRequiredError) {
                // The plan dialog takes over; the typed email stays for the next try.
                setShowInviteForm(false);
                setSeatBillingDialogError(paymentRequiredError);
                return;
              }

              const limitError = getOrgLimitError(error);
              if (limitError) {
                setShowInviteForm(false);
                setLimitDialogError(limitError);
                return;
              }

              setFormError(error instanceof Error ? error.message : "Could not invite member.");
            }
          }}
        >
          <label className="grid gap-3">
            <span className="text-[14px] font-medium text-gray-700">Email</span>
            <DenInput
              type="email"
              data-testid="invite-email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="teammate@example.com"
              required
            />
          </label>
          {canChooseInviteRole ? (
            <label className="grid gap-3">
              <span className="text-[14px] font-medium text-gray-700">Role</span>
              <RolePicker value={inviteRole} onChange={setInviteRole} options={inviteRoles} label="Role" testId="invite-role" />
            </label>
          ) : (
            <div className="grid gap-3">
              <span className="text-[14px] font-medium text-gray-700">Role</span>
              <DenInput value={BUILT_IN_ROLES.member.label} readOnly disabled aria-describedby="invite-role-locked" />
            </div>
          )}
          {inviteTeamPicker ? (
            <label className="grid gap-3">
              <span className="text-[14px] font-medium text-gray-700">Team</span>
              {/* Each team shows the role it gives, on top of the person's own. */}
              <DenSelect aria-label="Team" value={inviteTeamId} onChange={(event) => setInviteTeamId(event.target.value)} menuWidth="trigger">
                <option value="">No team</option>
                {orgContext.teams.filter((team) => !team.managedByScim && (!team.grantsOrganizationAdmin || access.canManageAdminTeams)).map((team) => (
                  <option key={team.id} value={team.id} title={team.name}>
                    {team.name}
                    <span className="ml-1.5 font-normal text-gray-500">{team.grantsOrganizationAdmin || access.canViewPermissions ? teamRoleLabel(teamRoleState(team), roles) ?? BUILT_IN_ROLES.member.label : ""}</span>
                  </option>
                ))}
              </DenSelect>
            </label>
          ) : null}
          {canChooseInviteRole ? null : (
            <p id="invite-role-locked" className="flex items-center gap-1.5 text-[13px] text-gray-500">
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {`Inviting someone with another role is locked. ${permissionLockReason("members.update")}`}
            </p>
          )}
          {formError ? <DenNotice tone="error" message={formError} /> : null}
          <div className="flex justify-end gap-2 pt-1">
            <ActionButton size="md" onClick={resetInviteForm}>Cancel</ActionButton>
            <DenButton type="submit" data-testid="invite-send" loading={mutationBusy === "invite-member" || setMemberRole.isPending}>
              Send invite
            </DenButton>
          </div>
        </form>
    </MembersFormDialog>
  );

  /** The role on a person's row is the control: changing it takes effect at once, with Undo (S2, P8). */
  async function changeMemberRole(member: DenOrgMember, value: string) {
    const current = memberRoleState(member);
    const previous = memberRoleEntry(current, roles);
    const next = roles.find((role) => role.value === value);
    if (!next || next.value === previous.value) return;
    const name = member.user.name || member.user.email;
    setPageError(null);
    try {
      await givePerson(member.id, current, next);
      toast({
        title: `${name} is now ${next.label}`,
        action: {
          label: "Undo",
          onClick: () => {
            void givePerson(member.id, memberRoleStateAfter(next), previous).catch((error) => {
              setPageError(error instanceof Error ? error.message : "Could not undo the role change.");
            });
          },
        },
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not update member role.");
    }
  }

  const teamForm = (
    <MembersFormDialog open={(showTeamForm || Boolean(editingTeamId)) && access.canManageTeams} title={editingTeamId ? "Edit team" : "Create team"} onClose={resetTeamEditor} testId="team-dialog">
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setFormError(null);
            try {
              if (editingTeamId) {
                await updateTeam(editingTeamId, {
                  name: teamNameDraft,
                  memberIds: teamMemberDraft,
                });
              } else {
                const teamId = await createTeam({
                  name: teamNameDraft,
                  memberIds: teamMemberDraft,
                });
                // The team's role is given once the team exists, the same way Change role gives it.
                const chosen = roles.find((role) => role.value === teamRoleDraft);
                if (chosen && chosen.value !== "member") {
                  if (!teamId) throw new Error(`${teamNameDraft} was created as Member. Give it ${chosen.label} from the team's Role tab.`);
                  await giveTeam(teamId, { admin: false, setId: null }, chosen);
                }
              }
              resetTeamEditor();
            } catch (error) {
              setFormError(error instanceof Error ? error.message : "Could not save team.");
            }
          }}
        >
          <label className="grid gap-3">
            <span className="text-[14px] font-medium text-gray-700">
              Team name
            </span>
            <DenInput
              type="text"
              data-testid="team-form-name"
              value={teamNameDraft}
              onChange={(event) => setTeamNameDraft(event.target.value)}
              placeholder="Core Engineering"
              required
            />
          </label>

          {/* A new team gets its role here; an existing team's role is changed on its Role tab. */}
          {editingTeamId ? null : (
            <label className="grid gap-3">
              <span className="text-[14px] font-medium text-gray-700">Role</span>
              <RolePicker value={teamRoleDraft} onChange={setTeamRoleDraft} options={newTeamRoles} label="Role for the team" testId="team-form-role" />
            </label>
          )}

          <div>
            <p className="mb-3 text-[14px] font-medium text-gray-700">
              Team members
            </p>
            {orgContext.members.length === 0 ? (
              <div className="rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[14px] text-gray-500">
                Invite a member before assigning people to this team.
              </div>
            ) : (
              // the same people rows and Add person picker as Create role.
              <PeopleField
                people={orgContext.members.map((member) => ({ id: member.id, name: member.user.name || member.user.email, email: member.user.email }))}
                chosenIds={teamMemberDraft}
                onChange={setTeamMemberDraft}
                rowTestId="team-form-person"
              />
            )}
          </div>

          {formError ? <DenNotice tone="error" message={formError} /> : null}
          <div className="flex justify-end gap-2 pt-1">
            <ActionButton size="md" onClick={resetTeamEditor}>Cancel</ActionButton>
            <DenButton
              type="submit"
              data-testid="team-form-save"
              loading={mutationBusy === "create-team" || mutationBusy === "update-team"}
            >
              {editingTeamId ? "Save team" : "Create team"}
            </DenButton>
          </div>
        </form>
    </MembersFormDialog>
  );

  // Section facts for the Members intro (DESIGN.md I2), all from `GET /v1/org` and the roles already loaded.
  const membersIntroFacts: MembersFacts = {
    people: orgContext.members.length,
    pendingInvites: orgContext.invitations.filter((invitation) => invitation.status === "pending").length,
    teams: orgContext.teams.length,
    ...(access.canViewPermissions && !organizationRoles.loading && !organizationRoles.error ? { customRoles: roles.filter((role) => role.kind === "custom").length } : {}),
  };
  const teamFormOpen = showTeamForm || Boolean(editingTeamId);

  const everyoneRow = (agentPermissionsColumn || desktopPolicyScreenRemoved(orgContext)) && ("everyone".includes(teamFilter.trim().toLocaleLowerCase())) ? (
    <TeamsListRow
      testId="team-row-everyone"
      columns={teamListColumns}
      icon={Globe}
      name="Everyone"
      href={getEveryoneRoute(orgSlug)}
      subtitle="Every member, including people in no team"
      lanes={(
        <>
          <TeamsListLane testId="team-row-role">Member</TeamsListLane>
          {agentPermissionsColumn ? <TeamsListLane testId="team-row-agent-permissions">Base for every team</TeamsListLane> : null}
          <TeamsListLane testId="team-row-members" tone="muted">{peopleCount(orgContext.members.length)}</TeamsListLane>
        </>
      )}
      action={<TeamsListOpenLink href={getEveryoneRoute(orgSlug)} name="Everyone" />}
    />
  ) : null;

  const page = (
    <DashboardPageTemplate
      icon={Users}
      title="Members"
      description={null}
    >
      <OrgLimitDialog
        open={Boolean(limitDialogError)}
        eyebrow={limitDialogError?.limitType === "members" ? null : "Workspace limit"}
        title={limitDialogError?.limitType === "workers" ? "Worker limit reached" : "Your plan is full"}
        message={limitDialogError?.message ?? "This workspace reached its current plan limit."}
        detail={
          limitDialogError
            ? `${limitDialogError.currentCount} of ${limitDialogError.limit} ${limitDialogError.limitType === "members" ? "users" : "workers"} are already in use.`
            : null
        }
        actionLabel={limitDialogError?.limitType === "members" ? undefined : "Contact support"}
        feedbackHref={limitDialogError?.limitType === "members" ? undefined : feedbackHref}
        onClose={() => setLimitDialogError(null)}
      />
      <OrgLimitDialog
        open={Boolean(seatBillingDialogError)}
        eyebrow="Free plan limit"
        title="Upgrade to the Team plan"
        message={`The Free plan is limited to ${seatBillingDialogError?.freeSeatCount ?? 5} users, counting pending invitations. Upgrade to the Team plan to invite more people. Team is $10 per user per month.`}
        detail={canStartSeatCheckout ? null : permissionLockReason("billing.manage")}
        closeLabel="Not now"
        actionLabel="Upgrade to Team"
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
        <DenNotice message={pageError} className="mb-6" />
      ) : null}

      <UnderlineTabs
        className="mb-6"
        activeTab={shownTab}
        onChange={chooseTab}
        tabs={[
          { value: "members", label: "Members", icon: User, count: tabCounts.members },
          { value: "teams", label: "Teams", icon: Users, count: tabCounts.teams, unseen: introUnseen("members.teams") },
          ...([{ value: "roles" as const, label: "Roles", icon: ShieldCheck, unseen: introUnseen("members.roles") }]),
        ]}
      />

      {shownTab === "roles" ? (
        <RolesTab
          showIntro
          action={orgContext && canCreateRole({ canManageTeams: access.canManageTeams, canManagePermissions: access.canManagePermissions })
            ? <DenButton size="sm" icon={Plus} href={getNewRoleRoute(orgSlug)} data-testid="roles-create">Create role</DenButton>
            : undefined}
        />
      ) : null}

      {/* Dialogs: the list stays where it is while someone is added or a team is made. */}
      {inviteForm}
      {teamForm}

      {shownTab === "members" ? (
        <div>
          <MemberListToolbar
            collection="members" value={memberFilter} onChange={setMemberFilter}
            action={<DenButton size="sm" icon={access.canInviteMembers ? Plus : Lock} disabled={!access.canInviteMembers} title={!access.canInviteMembers ? permissionLockReason("invitations.manage") : undefined} onClick={() => setShowInviteForm(true)}>Add member</DenButton>}
            secondary={access.canInviteMembers && orgContext.capabilities.installLinks ? <ItemMenu label="Member list actions" entries={[{ label: installLinkCopied ? "Copied" : "Copy install link", onSelect: handleCopyInstallLink }]} /> : undefined}
          />

          {installLinkShareUrl ? (
            <div className="mb-6 rounded-[24px] border border-gray-200 bg-white px-5 py-4">
              <p className="text-[13px] text-gray-500">
                Copy blocked by the browser — copy the link manually:
              </p>
              <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center">
                <DenInput
                  id="install-link-share-url"
                  data-testid="install-link-share-url"
                  value={installLinkShareUrl}
                  readOnly
                  aria-label="Install link"
                  className="font-mono text-[12px]"
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
                <div className="flex shrink-0 gap-2">
                  <DenButton
                    data-testid="install-link-share-copy"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleInstallLinkShareCopy()}
                  >
                    {installLinkShareCopied ? "Copied" : "Copy"}
                  </DenButton>
                  <DenButton
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setInstallLinkShareUrl(null);
                      setInstallLinkShareCopied(false);
                    }}
                  >
                    Done
                  </DenButton>
                </div>
              </div>
            </div>
          ) : null}

          {webPerMember ? (
            <p data-testid="members-openwork-web-summary" className="text-[13px] text-gray-500">
              {`${webMemberCount} of ${orgContext.members.length} ${orgContext.members.length === 1 ? "person has" : "people have"} OpenWork Web. Web is billed only for them; turning it on or off changes your next invoice.`}
            </p>
          ) : null}

          <div className="overflow-visible rounded-2xl border border-gray-100 bg-white">
            <div data-testid="members-column-header" className={`grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-gray-100 py-3 text-[12px] font-medium text-gray-500 px-5 ${memberGridColumns}`}>
              <span>Member</span>
              <span className="hidden lg:block">Role</span>
              <span className="hidden lg:block">Joined</span>
              {webPerMember ? <span className="hidden lg:block">OpenWork Web</span> : null}
              <span />
            </div>

            {visibleMembers.length === 0 ? <p className="px-5 py-6 text-[13px] text-gray-500" role="status">{memberFilter.trim() ? "No members match your filter." : "No members yet."}</p> : null}
            {visibleMembers.map((member) => {
              const roleState = memberRoleState(member);
              const ownRole = memberRoleEntry(roleState, roles);
              const viaTeams = teamRoleLabels({
                memberId: member.id,
                ownRole: member.isOwner ? "owner" : roleState.role === "member" ? "member" : "admin",
                teams: orgContext.teams,
                setIdByTeam: organizationRoles.setIdByTeam,
                roles,
              });
              const roleLabel = [ownRole.label, ...viaTeams].join(", ");
              const isInvited = !member.joinedAt;
              const inviteId = member.inviteId;
              const memberAccess = getOrgAccessFlags(member.effectiveRole, member.isOwner);
              const canManageMemberGrants = access.canManageAdminTeams || member.adminTeams.length === 0;
              const canResendInvitation = isInvited && canManageMemberGrants && canRefreshInvitationRole(member.role, access);
              const canTransferOwnershipToMember = access.canTransferOwnership && !isInvited && memberAccess.isAdmin;
              const canViewPermissions = !isInvited && canViewMemberPermissions(orgContext, member.id);
              const canOpenActions = member.isOwner
                ? false
                : isInvited
                  ? canResendInvitation || (access.canCancelInvitations && canManageMemberGrants)
                  : access.canManageTeams || access.canRemoveMembers || canTransferOwnershipToMember || canViewPermissions;
              // Nobody changes their own role, the owner's moves by transfer, and an invitation keeps the role it was sent with.
              const canChangeRole = access.canManageRoles && !member.isOwner && !isInvited && member.id !== orgContext.currentMember.id;

              const memberActions = [
                ...(canResendInvitation && inviteId ? [{ label: "Copy invite link", onSelect: async () => { setPageError(null); try { await copyTextWhenReady(getInvitationLink(inviteId)); } catch (error) { setPageError(error instanceof Error ? error.message : "Could not copy the invite link."); } } }] : []),
                ...(canResendInvitation ? [{ label: "Resend invite", disabled: mutationBusy === "invite-member", onSelect: async () => { try { await inviteMember({ email: member.user.email, role: assignableOrgRole(member.role) }); } catch (error) { setPageError(error instanceof Error ? error.message : "Could not resend invitation."); } } }] : []),
                ...(isInvited && access.canCancelInvitations && canManageMemberGrants && inviteId ? [{ label: "Cancel invite", destructive: true, onSelect: async () => { try { await cancelInvitation(inviteId); } catch (error) { setPageError(error instanceof Error ? error.message : "Could not cancel invitation."); } } }] : []),
                ...(canViewPermissions ? [{ label: permissionsMemberId === member.id ? "Hide permissions" : "View permissions", onSelect: () => setPermissionsMemberId((current) => current === member.id ? null : member.id) }] : []),
                ...(canTransferOwnershipToMember ? [{ label: "Transfer ownership", disabled: mutationBusy === "transfer-ownership", onSelect: () => handleTransferOwnership(member) }] : []),
                ...(!isInvited && access.canManageTeams ? [{ label: "Manage teams", onSelect: () => { setEditingMemberTeamsId(member.id); setMemberTeamsDraft(new Set(orgContext.teams.filter((team) => team.memberIds.includes(member.id)).map((team) => team.id))); } }] : []),
                ...(!isInvited && access.canRemoveMembers && canManageMemberGrants ? [{ label: "Remove member", destructive: true, confirm: { title: `Remove ${member.user.name || member.user.email}?`, description: "They lose access to this organization. You can invite them again.", action: "Remove member" }, onSelect: async () => { await removeMember(member.id); } }] : []),
              ];
              return (
                <div key={member.id}>
                <div
                  data-testid="member-row"
                  className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-gray-100 transition hover:bg-gray-50/60 last:border-b-0 lg:gap-4 min-h-16 px-5 py-3 ${memberGridColumns}`}
                >
                  <OrgMemberIdentity member={member} compact />
                  <span title={roleLabel} className={`col-start-1 row-start-2 min-w-0 pl-11 text-[13px] text-gray-500 lg:col-auto lg:row-auto lg:pl-0 ${canChangeRole ? "" : "truncate"}`} data-testid="member-role">
                    {canChangeRole ? (
                      <span className="flex min-w-0 flex-col gap-1">
                        <RolePicker
                          value={ownRole.value}
                          onChange={(value) => void changeMemberRole(member, value)}
                          options={memberRoleOptions({ ...roleLocks, current: ownRole })}
                          label={`Role for ${member.user.name || member.user.email}`}
                          testId={`member-role-${member.id}`}
                          disabled={mutationBusy === "update-member-role" || setMemberRole.isPending}
                        />
                        {viaTeams.length > 0 ? <span className="text-[12px] leading-snug" data-testid="member-team-roles">{`Also ${viaTeams.join(", ")}`}</span> : null}
                      </span>
                    ) : roleLabel}
                  </span>
                  <span data-testid="member-joined" className="col-start-1 row-start-3 pl-11 text-[13px] text-gray-500 lg:col-auto lg:row-auto lg:pl-0">
                    {member.joinedAt ? <span className="lg:hidden">Joined </span> : null}
                    {member.joinedAt
                      ? formatAddedDate(member.joinedAt)
                      : "Pending"}
                  </span>
                  {webPerMember ? (
                    <span
                      data-testid="member-openwork-web"
                      title={access.canStartSeatCheckout ? undefined : permissionLockReason("billing.manage")}
                      className="col-start-1 row-start-4 flex items-center gap-2 pl-11 text-[13px] text-gray-500 lg:col-auto lg:row-auto lg:pl-0"
                    >
                      <span className="lg:hidden">OpenWork Web</span>
                      <DenSwitch
                        size="sm"
                        checked={member.openworkWeb}
                        disabled={!access.canStartSeatCheckout || mutationBusy === "member-openwork-web"}
                        aria-label={`OpenWork Web for ${member.user.name || member.user.email}`}
                        testId="member-openwork-web-switch"
                        onChange={(enabled) => {
                          setPageError(null);
                          void setMemberOpenWorkWeb(member.id, enabled).catch((error) => {
                            setPageError(error instanceof Error ? error.message : "Could not update OpenWork Web.");
                          });
                        }}
                      />
                    </span>
                  ) : null}
                  <div data-testid="member-actions" className="relative col-start-2 row-span-3 row-start-1 flex items-center justify-end gap-2 lg:col-auto lg:row-span-1 lg:row-auto">
                    {(
                      member.isOwner ? <span data-testid="member-owner-locked"><TeamsListLocked reason="The owner cannot be edited here. Only the owner can transfer ownership to an admin." /></span> : canOpenActions ? <ItemMenu label={`Open actions for ${member.user.name || member.user.email}`} entries={memberActions} /> : <TeamsListLocked reason="You cannot change this member. Ask an organization admin for access." />
                    )}
                  </div>
                </div>
                {permissionsMemberId === member.id && canViewPermissions ? (
                  <div className="border-b border-gray-100 px-6 py-4" data-testid="member-permissions-panel">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-[13px] font-medium text-gray-900">Effective permissions</h3>
                      <button
                        type="button"
                        onClick={() => setPermissionsMemberId(null)}
                        className="rounded text-[12px] text-gray-500 transition hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
                      >
                        Hide
                      </button>
                    </div>
                    <MemberEffectivePermissions memberId={member.id} memberName={member.user.name} />
                  </div>
                ) : null}
                {editingMemberTeamsId === member.id ? (
                  <div className="col-span-full border-b border-gray-100 bg-gray-50/50 px-6 py-4">
                    <div className="flex flex-wrap items-start gap-4">
                      <div className="flex-1">
                        <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-gray-400">
                          Teams for {member.user.name}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {(orgContext?.teams ?? []).map((team) => {
                            const selected = memberTeamsDraft.has(team.id);
                            return (
                              <button
                                key={team.id}
                                type="button"
                                disabled={team.managedByScim || (team.grantsOrganizationAdmin && !access.canManageAdminTeams)}
                                onClick={() => {
                                  setMemberTeamsDraft((current) => {
                                    const next = new Set(current);
                                    if (next.has(team.id)) {
                                      next.delete(team.id);
                                    } else {
                                      next.add(team.id);
                                    }
                                    return next;
                                  });
                                }}
                                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition ${selected ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 bg-white text-gray-500 hover:border-gray-300"}`}
                              >
                                {selected ? (
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                ) : (
                                  <Circle className="h-3.5 w-3.5" />
                                )}
                                {team.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 pt-5">
                        <button
                          type="button"
                          onClick={() => setEditingMemberTeamsId(null)}
                          className="inline-flex h-8 items-center rounded-full border border-gray-200 bg-white px-3.5 text-[13px] font-medium text-gray-600 transition hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={mutationBusy === "update-team"}
                          onClick={async () => {
                            setPageError(null);
                            try {
                              // For each team, update its member list to add or remove this member.
                              for (const team of orgContext?.teams ?? []) {
                                const wasInTeam = team.memberIds.includes(member.id);
                                const shouldBeInTeam = memberTeamsDraft.has(team.id);
                                if (wasInTeam === shouldBeInTeam) continue;
                                const nextMemberIds = shouldBeInTeam
                                  ? [...team.memberIds, member.id]
                                  : team.memberIds.filter((id) => id !== member.id);
                                await updateTeam(team.id, { memberIds: nextMemberIds });
                              }
                              setEditingMemberTeamsId(null);
                            } catch (error) {
                              setPageError(error instanceof Error ? error.message : "Could not update teams.");
                            }
                          }}
                          className="inline-flex h-8 items-center rounded-full bg-gray-900 px-3.5 text-[13px] font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Save teams
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {activeTab === "teams" ? (
        // With feature intros on and no teams yet, the Teams intro takes the list's place (DESIGN.md I1); Everyone stays above it.
        <MembersTeamsIntroSlot facts={teamFormOpen ? null : { teams: orgContext.teams.length }}>
          {(intro) => intro.size === "box" ? (
            <div data-testid="teams-intro">
              {everyoneRow ? (
                <div className="rounded-2xl border border-gray-100 bg-white" data-testid="teams-list">
                  <TeamsListHeader columns={teamListColumns} agentPermissions={agentPermissionsColumn} />
                  {everyoneRow}
                </div>
              ) : null}
              {intro.element}
            </div>
          ) : (
            <div>
              <MemberListToolbar collection="teams" value={teamFilter} onChange={setTeamFilter} action={<DenButton size="sm" icon={access.canManageTeams ? Plus : Lock} disabled={!access.canManageTeams} title={!access.canManageTeams ? permissionLockReason("teams.manage") : undefined} onClick={() => { resetTeamEditor(); setShowTeamForm((current) => !current); }}>Create team</DenButton>} />

              <div className="rounded-2xl border border-gray-100 bg-white" data-testid="teams-list">
                <TeamsListHeader columns={teamListColumns} agentPermissions={agentPermissionsColumn} />

                {everyoneRow}

                {visibleTeams.length === 0 ? (
                  <div className="px-5 py-6 text-[13px] text-gray-500" role="status">
                    {teamFilter.trim() ? "No teams match your filter." : "No teams yet."}
                  </div>
                ) : (
                  visibleTeams.map((team) => {
                    const names = teamMemberNames.get(team.id) ?? [];
                    const role = team.grantsOrganizationAdmin || access.canViewPermissions
                        ? teamRoleLabel(teamRoleState(team), roles) ?? BUILT_IN_ROLES.member.label
                        : "—";
                    const canEdit = !team.managedByScim && access.canManageTeams && (!team.grantsOrganizationAdmin || access.canManageAdminTeams);
                    return (
                      <TeamsListRow
                        key={team.id}
                        testId="team-row"
                        columns={teamListColumns}
                        icon={Users}
                        name={team.name}
                        href={access.canViewTeams ? getTeamRoute(orgSlug, team.id) : undefined}
                        badge={team.managedByScim ? (
                          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">Managed by SCIM</span>
                        ) : null}
                        subtitle={names.length > 0 ? names.join(", ") : team.memberIds.length > 0 ? peopleCount(team.memberIds.length) : "No members yet"}
                        lanes={(
                          <>
                            <TeamsListLane testId="team-row-role" title={role}>{role}</TeamsListLane>
                            {agentPermissionsColumn ? <TeamAgentPermissionsCell summary={agentPolicies.isSuccess ? teamOverrideSummary(agentPolicies.data.teams.find((policy) => policy.scopeId === team.id)) : undefined} failed={agentPolicies.isError} /> : null}
                            <TeamsListLane testId="team-row-members" tone="muted">{peopleCount(team.memberIds.length)}</TeamsListLane>
                          </>
                        )}
                        action={canEdit ? (
                          <ItemMenu
                            label={`Actions for ${team.name}`}
                            entries={[
                              {
                                label: "Edit",
                                onSelect: () => {
                                  setShowTeamForm(false);
                                  setEditingTeamId(team.id);
                                  setTeamNameDraft(team.name);
                                  setTeamMemberDraft(team.memberIds);
                                },
                              },
                              {
                                label: "Delete",
                                destructive: true,
                                disabled: mutationBusy === "delete-team",
                                confirm: {
                                  title: `Delete ${team.name}?`,
                                  description: `${team.memberIds.length > 0 ? `${peopleCount(team.memberIds.length)} ${team.memberIds.length === 1 ? "loses" : "lose"}` : "Nobody loses"} this team's ${teamLosses({ agentPermissions: agentPermissionsColumn })}. This cannot be undone.`,
                                  action: "Delete team",
                                },
                                onSelect: async () => {
                                  setPageError(null);
                                  await deleteTeam(team.id);
                                  if (editingTeamId === team.id) resetTeamEditor();
                                },
                              },
                            ]}
                          />
                        ) : (
                          <TeamsListLocked
                            reason={team.managedByScim
                              ? "Managed by your identity provider"
                              : access.canManageTeams ? permissionLockReason("teams.manage_admin") : permissionLockReason("teams.manage")}
                          />
                        )}
                      />
                    );
                  })
                )}
              </div>
            </div>
          )}
        </MembersTeamsIntroSlot>
      ) : null}

    </DashboardPageTemplate>
  );

  // The invite and team forms are the setup step itself, so they show even while the intro would.
  if (showInviteForm || teamFormOpen) return page;
  // Nobody else here yet (no other members, invites or teams): the section intro replaces the page (DESIGN.md I2).
  return <FeatureIntroGate introKey="members" facts={membersIntroFacts}>{page}</FeatureIntroGate>;
}

/**
 * Add member and Create team: one dialog shell, as Den's other dialogs are
 * built, so the list underneath stays put (P11). Its content is mounted only
 * while open.
 */
function MembersFormDialog({ open, title, onClose, testId, children }: { open: boolean; title: string; onClose: () => void; testId: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
        <Dialog.Popup
          data-testid={testId}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-2xl border border-gray-100 bg-white p-5 outline-none"
        >
          <Dialog.Title className="text-[15px] font-semibold text-gray-950">{title}</Dialog.Title>
          {open ? children : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Teams tab body: lets the Teams intro (box) take the list's place while there are no teams. */
function MembersTeamsIntroSlot({ facts, children }: { facts: Pick<MembersFacts, "teams"> | null; children: (intro: FeatureIntroResolution) => ReactNode }) {
  return <>{children(useFeatureIntro("members.teams", facts))}</>;
}

/** A team's agent permissions in the Teams list: its own changes, or that it follows Everyone. */
function TeamAgentPermissionsCell({ summary, failed }: { summary: string | null | undefined; failed: boolean }) {
  if (failed) return <TeamsListLane testId="team-row-agent-permissions" title="Couldn't load agent permissions" tone="muted">—</TeamsListLane>;
  if (summary === undefined) return <span role="status" aria-label="Loading agent permissions" data-testid="team-row-agent-permissions" className="hidden lg:block"><DenSkeleton className="h-3 w-24" /></span>;
  return summary === null
    ? <TeamsListLane testId="team-row-agent-permissions" tone="muted">Follows Everyone</TeamsListLane>
    : <TeamsListLane testId="team-row-agent-permissions" title={summary}>{summary}</TeamsListLane>;
}

function peopleCount(count: number): string {
  return `${count} ${count === 1 ? "member" : "members"}`;
}

/** What a team's members stop getting when it is deleted, for the confirmation (DESIGN.md P9). */
function teamLosses({ agentPermissions }: { agentPermissions: boolean }): string {
  const parts = ["role", "access", agentPermissions ? "agent permissions" : null].filter((part): part is string => part !== null);
  return parts.length === 1 ? parts[0] ?? "" : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
