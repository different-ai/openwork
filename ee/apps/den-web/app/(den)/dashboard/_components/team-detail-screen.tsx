"use client";

import { useState } from "react";
import { Laptop, Compass, KeyRound, Layers, MessageCircle, ScrollText, ShieldCheck, SquareTerminal, Users } from "lucide-react";
import type { TabItem } from "../../_components/ui/tabs";
import { getMembersRoute, getMembersTeamsRoute, getOrgAccessFlags, permissionLockReason } from "../../_lib/den-org";
import { DenButton } from "../../_components/ui/button";
import { desktopPolicyScreenRemoved } from "../_lib/desktop-policy-screen-rollout";
import { DesktopSuggestionsPanel } from "./desktop-suggestions-panel";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { AgentsPanel, agentsTabVisible } from "./agent-permissions-editor";
import { TeamPluginAccessPanel } from "./team-plugin-access-panel";
import { ModelsPanel, modelsTabVisible } from "./team-models-panel";
import { PromptsPanel, promptsTabVisible } from "./prompts-panel";
import { teamScopeOf } from "./team-scope";
import { TeamPageFrame, TeamSections } from "./team-sections";
import { WorkbotPanel, workbotTabVisible } from "./team-workbot-panel";
import { ListRow, RowLane, RowLaneLabel, RowList, RowListHeader } from "../_features/computers/computer-rows";
import { PersonLead } from "../_features/computers/computer-parts";
import { BUILT_IN_ROLES } from "../../_lib/role-catalog";
import { LinkButton } from "./item-list";
import { SharedTeamRolePanel } from "./shared-team-role-panel";
import { MemberTeamRoles } from "./member-team-roles";
import { useOrganizationRoles } from "./permissions-data";

const TEAM_MEMBER_ROLE_LANE = "flex w-40 @2xl:w-56";

export type TeamDetailTab = "role" | "overview" | "access" | "agents" | "browser" | "models" | "workbot" | "prompts" | "desktop";

export function TeamDetailScreen({ teamId, initialTab = null }: { teamId: string; initialTab?: TeamDetailTab | null }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const viewerAccess = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions)
    : null;
  const canRevokeAccess = viewerAccess?.canManageAllShared ?? false;
  const organizationRoles = useOrganizationRoles(orgId, Boolean(orgContext) && (viewerAccess?.canViewPermissions ?? false));
  const showAgents = agentsTabVisible(orgContext);

  const showBrowser = showAgents;
  const showDesktop = desktopPolicyScreenRemoved(orgContext);
  const showModels = modelsTabVisible(orgContext);
  const showPrompts = promptsTabVisible(orgContext);
  const showWorkbot = workbotTabVisible(orgContext);
  const [chosenTab, setChosenTab] = useState<TeamDetailTab | null>(initialTab);
  const defaultTab: TeamDetailTab = "role";
  const setActiveTab = (tab: TeamDetailTab) => {
    setChosenTab(tab);
    const url = new URL(window.location.href);
    if (tab === defaultTab) url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url);
  };
  const available = (tab: TeamDetailTab) => tab === "role" ? true
    : tab === "agents" ? showAgents
      : tab === "browser" ? showBrowser
        : tab === "desktop" ? showDesktop
        : tab === "models" ? showModels
        : tab === "workbot" ? showWorkbot
        : tab === "prompts" ? showPrompts
          : true;
  const activeTab: TeamDetailTab = chosenTab && available(chosenTab) ? chosenTab : defaultTab;
  const team = orgContext?.teams.find((entry) => entry.id === teamId);
  const membersById = new Map((orgContext?.members ?? []).map((member) => [member.id, member]));
  const teamMembers = (team?.memberIds ?? []).flatMap((memberId) => {
    const member = membersById.get(memberId);
    return member ? [member] : [];
  });
  const memberCount = team?.memberIds.length ?? 0;
  const canEditTeam = Boolean(team && viewerAccess?.canManageTeams && !team.managedByScim && (!team.grantsOrganizationAdmin || viewerAccess.canManageAdminTeams));
  const editTeamLockedReason = team?.managedByScim
    ? "Managed by your identity provider. Ask your identity provider administrator to change this team."
    : team?.grantsOrganizationAdmin && !viewerAccess?.canManageAdminTeams
      ? permissionLockReason("teams.manage_admin")
      : permissionLockReason("teams.manage");
  const agentsTab: readonly TabItem<TeamDetailTab>[] = [
    ...(showAgents ? [{ value: "agents" as const, label: "Agents", icon: SquareTerminal }] : []),
    ...(showBrowser ? [{ value: "browser" as const, label: "Browser", icon: Compass }] : []),
    ...(showModels ? [{ value: "models" as const, label: "Models", icon: Layers }] : []),
    ...(showWorkbot ? [{ value: "workbot" as const, label: "Workbot", icon: MessageCircle }] : []),
    ...(showPrompts ? [{ value: "prompts" as const, label: "Prompts", icon: ScrollText }] : []),
    ...(showDesktop ? [{ value: "desktop" as const, label: "Desktop", icon: Laptop }] : []),
  ];
  const tabs: readonly TabItem<TeamDetailTab>[] = [
      { value: "role", label: "Role", icon: ShieldCheck },
      { value: "overview", label: "Members", icon: Users },
      { value: "access", label: "Access", icon: KeyRound },
      ...agentsTab,
    ];

  return (
    <TeamPageFrame title={team?.name ?? "Team"} memberCount={memberCount} backHref={getMembersTeamsRoute(orgSlug)}
      action={team ? canEditTeam
        ? <LinkButton size="sm" variant="secondary" href={`${getMembersRoute(orgSlug)}?tab=teams&editTeam=${encodeURIComponent(teamId)}`} data-testid="team-edit">Edit team</LinkButton>
        : <span className="flex flex-col items-end gap-1"><DenButton size="sm" variant="secondary" disabled title={editTeamLockedReason} data-testid="team-edit-locked">Edit team</DenButton><span className="max-w-72 text-right text-[12px] text-[var(--dls-text-secondary)]">{editTeamLockedReason}</span></span>
        : undefined}>
      <TeamSections
        tabs={tabs}
        activeTab={activeTab}
        onChange={setActiveTab}
      >
        {activeTab === "role" && team ? (
          <div role="tabpanel" aria-label="Role">
            <SharedTeamRolePanel team={team} />
          </div>
        ) : null}

        {activeTab === "overview" ? (
          <div role="tabpanel" aria-label="Members">
            {teamMembers.length === 0 ? (
              <p className="border-y border-[var(--den-list-line)] py-4 text-[13px] text-[var(--dls-text-secondary)]">This team has no members yet.</p>
            ) : (
              <RowList label={`People in ${team?.name ?? "this team"}`} testId="team-members-list" header={<RowListHeader lead="Member"><RowLaneLabel lane={TEAM_MEMBER_ROLE_LANE}>Role</RowLaneLabel></RowListHeader>}>
                {teamMembers.map((member) => {
                  const name = member.user.name || member.user.email;
                  const flags = getOrgAccessFlags(member.role, member.isOwner);
                  const role = flags.isOwner ? BUILT_IN_ROLES.owner.label : flags.isSuperAdmin ? BUILT_IN_ROLES["super-admin"].label : flags.canonicalRole === "admin" ? BUILT_IN_ROLES.admin.label : BUILT_IN_ROLES.member.label;
                  const viaTeams = orgContext
                    ? <MemberTeamRoles member={member} teams={orgContext.teams} setIdByTeam={organizationRoles.setIdByTeam} roles={organizationRoles.roles} exceptTeamId={teamId} />
                    : null;
                  return (
                    <ListRow key={member.id} rowTestId="team-member-row" lead={<PersonLead name={name} />} name={name}
                      secondLine={name !== member.user.email ? member.user.email : undefined}
                      lanes={<RowLane lane={TEAM_MEMBER_ROLE_LANE} className="flex-col justify-center">
                        <span className="truncate">{member.joinedAt ? role : `${role}, invited`}</span>
                        {viaTeams ? <span className="[&>span]:mt-0 [&>span]:truncate">{viaTeams}</span> : null}
                      </RowLane>} />
                  );
                })}
              </RowList>
            )}
          </div>
        ) : null}

        {activeTab === "access" ? (
          <div role="tabpanel" aria-label="Access">
            <TeamPluginAccessPanel teamId={teamId} teamName={team?.name ?? "This team"} orgSlug={orgSlug} canRevoke={canRevokeAccess} />
          </div>
        ) : null}

        {activeTab === "agents" && team ? (
          <div role="tabpanel" aria-label="Agents">
            <AgentsPanel team={{ id: team.id, name: team.name }} area="agents" />
          </div>
        ) : null}

        {activeTab === "browser" && team ? (
          <div role="tabpanel" aria-label="Browser">
            <AgentsPanel team={{ id: team.id, name: team.name }} area="browser" />
          </div>
        ) : null}

        {activeTab === "desktop" && team ? (<div role="tabpanel" aria-label="Desktop"><DesktopSuggestionsPanel team={{ id: team.id, name: team.name }} /></div>) : null}

        {activeTab === "prompts" && team ? (
          <div role="tabpanel" aria-label="Prompts">
            <PromptsPanel team={{ id: team.id, name: team.name }} />
          </div>
        ) : null}

        {activeTab === "workbot" && team ? (
          <div role="tabpanel" aria-label="Workbot">
            <WorkbotPanel scope={teamScopeOf(team)} />
          </div>
        ) : null}

        {activeTab === "models" && team ? (
          <div role="tabpanel" aria-label="Models">
            <ModelsPanel team={{ id: team.id, name: team.name }} />
          </div>
        ) : null}
      </TeamSections>
    </TeamPageFrame>
  );
}
