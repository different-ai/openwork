"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { Laptop, Compass, KeyRound, Layers, MessageCircle, ScrollText, ShieldCheck, SquareTerminal, Users } from "lucide-react";
import type { TabItem } from "../../_components/ui/tabs";
import { getMembersRoute, getMembersTeamsRoute, getOrgAccessFlags, orgFeatureEnabled, permissionLockReason } from "../../_lib/den-org";
import { markFeatureUsed } from "../../_lib/feature-usage";
import { DenButton } from "../../_components/ui/button";
import { desktopPolicyScreenRemoved } from "../_lib/desktop-policy-screen-rollout";
import { DesktopSuggestionsPanel } from "./desktop-suggestions-panel";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { AgentsPanel, agentsTabVisible } from "./agent-permissions-editor";
import { TeamPluginAccessPanel } from "./team-plugin-access-panel";
import { ModelsPanel, modelsTabVisible, teamModelsAccess } from "./team-models-panel";
import { directoryAccess } from "./gateway-directory-data";
import { useGatewayAccessProviders } from "./gateway-subject-access-data";
import { PromptsPanel, promptsTabVisible } from "./prompts-panel";
import { teamScopeOf } from "./team-scope";
import { TeamPageFrame, TeamSections, teamSectionsSidebarEnabled } from "./team-sections";
import { WorkbotPanel, workbotTabVisible } from "./team-workbot-panel";
import { ListRow, RowLane, RowLaneLabel, RowList, RowListHeader } from "../_features/computers/computer-rows";
import { PersonLead } from "../_features/computers/computer-parts";
import { BUILT_IN_ROLES } from "../../_lib/role-catalog";
import { LinkButton } from "./item-list";
import { SharedTeamRolePanel } from "./shared-team-role-panel";
import { MemberTeamRoles } from "./member-team-roles";
import { useOrganizationRoles } from "./permissions-data";
import { FeatureIntroGate, useFeatureIntroRuntime, useFeatureIntroUnseen, type FeatureIntroKey } from "../_features/feature-intros";
import type { TeamDetailFacts } from "../_features/feature-intros/intros/team-detail";
import { useAiGatewayIntroFacts } from "./ai-gateway-intro-facts";

/** The role lane of the team's Members list. */
const TEAM_MEMBER_ROLE_LANE = "flex w-40 @2xl:w-56";

export type TeamDetailTab = "role" | "overview" | "access" | "agents" | "browser" | "models" | "workbot" | "prompts" | "desktop";

/** Each tab's feature intro, for `?` and its unseen dot (DESIGN.md I9). Everyone's page shares them. */
export const TEAM_DETAIL_TAB_INTROS: Record<TeamDetailTab, FeatureIntroKey> = {
  role: "team-detail.role",
  overview: "team-detail.members",
  access: "team-detail.access",
  agents: "team-detail.agents",
  browser: "team-detail.browser",
  models: "team-detail.models",
  workbot: "team-detail.workbot",
  prompts: "team-detail.prompts",
  desktop: "team-detail.desktop",
};

/** A tab's body behind its feature intro: a box replaces it while the tab has nothing set up. */
export function TeamTabIntro({ tab, facts, children }: { tab: TeamDetailTab; facts: TeamDetailFacts | null; children: ReactNode }) {
  return <FeatureIntroGate introKey={TEAM_DETAIL_TAB_INTROS[tab]} facts={facts}>{children}</FeatureIntroGate>;
}

export function TeamDetailScreen({ teamId, initialTab = null }: { teamId: string; initialTab?: TeamDetailTab | null }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const router = useRouter();
  const searchParams = useSearchParams();
  const introUnseen = useFeatureIntroUnseen();
  const introsEnabled = useFeatureIntroRuntime().enabled;
  const viewerAccess = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions)
    : null;
  // Revoking a team's plugin grant needs manager access to the plugin (`sharing.manage_all`).
  const canRevokeAccess = viewerAccess?.canManageAllShared ?? false;
  // Members list each person's team roles the same way the Members page does.
  const organizationRoles = useOrganizationRoles(orgId, Boolean(orgContext) && (viewerAccess?.canViewPermissions ?? false));
  // The team's Agents tab holds what it changes from Everyone.
  const showAgents = agentsTabVisible(orgContext);
  // Open websites moves from Agents to its own Browser tab, and
  // the team's AI providers, spend limits and default model get a Models tab.

  const showBrowser = showAgents;
  const showDesktop = desktopPolicyScreenRemoved(orgContext);
  const showModels = modelsTabVisible(orgContext);
  const showPrompts = promptsTabVisible(orgContext);
  // What the team changes from Everyone's Workbot settings, with settings per team on.
  const showWorkbot = workbotTabVisible(orgContext);
  // The sections in a sidebar on the left instead of a row of tabs.
  const sidebar = teamSectionsSidebarEnabled(orgContext);
  const [chosenTab, setChosenTab] = useState<TeamDetailTab | null>(initialTab);
  const defaultTab: TeamDetailTab = "role";
  // The tab is in the address (?tab=agents), so a reload or a shared link opens it again.
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
  // The team's name and people are edited in the same form as on Members › Teams.
  const consistentInteractions = orgFeatureEnabled(orgContext, "denPageConsistency");
  const canEditTeam = Boolean(team && viewerAccess?.canManageTeams && !team.managedByScim && (!team.grantsOrganizationAdmin || viewerAccess.canManageAdminTeams));
  const editTeamLockedReason = team?.managedByScim
    ? "Managed by your identity provider. Ask your identity provider administrator to change this team."
    : team?.grantsOrganizationAdmin && !viewerAccess?.canManageAdminTeams
      ? permissionLockReason("teams.manage_admin")
      : permissionLockReason("teams.manage");
  // Facts the tabs' intros read; tab-specific ones are added where each tab loads them.
  const teamFacts: TeamDetailFacts | null = team && orgContext
    ? { teamMembers: team.memberIds.length, managedByScim: team.managedByScim, adminTeam: team.grantsOrganizationAdmin }
    : null;
  // The Models intro reads the same providers and OpenWork Models as the AI Gateway's, only on that tab.
  const modelsFacts = useAiGatewayIntroFacts(introsEnabled && activeTab === "models");
  // Same query (and request) as the tab's "Can use" list: how many providers this team can use.
  const providerAccess = useGatewayAccessProviders(orgId ?? "", introsEnabled && activeTab === "models" && Boolean(orgId) && Boolean(teamModelsAccess(orgContext ?? null)?.providers));
  const sharedProviders = providerAccess.data ? directoryAccess(providerAccess.data, { type: "team", teamId }).length : undefined;

  // "Add people to this team" from the Members tab intro opens this team's edit form on Members › Teams (DESIGN.md I5).
  const addPeopleRequested = searchParams.get("addPeople") === "1";
  useEffect(() => {
    if (addPeopleRequested) router.replace(`${getMembersRoute(orgSlug)}?tab=teams&editTeam=${encodeURIComponent(teamId)}`);
  }, [addPeopleRequested, router, orgSlug, teamId]);
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
    <TeamPageFrame sidebar={sidebar} title={team?.name ?? "Team"} memberCount={memberCount} backHref={getMembersTeamsRoute(orgSlug)}
      action={consistentInteractions && team ? canEditTeam
        ? <LinkButton size="sm" variant="secondary" href={`${getMembersRoute(orgSlug)}?tab=teams&editTeam=${encodeURIComponent(teamId)}`} onClick={() => markFeatureUsed("denPageConsistency")} data-testid="team-edit">Edit team</LinkButton>
        : <span className="flex flex-col items-end gap-1"><DenButton size="sm" variant="secondary" disabled title={editTeamLockedReason} data-testid="team-edit-locked">Edit team</DenButton><span className="max-w-72 text-right text-[12px] text-[var(--dls-text-secondary)]">{editTeamLockedReason}</span></span>
        : undefined}>
      <TeamSections
        sidebar={sidebar}
        tabs={tabs.map((item) => ({ ...item, unseen: introUnseen(TEAM_DETAIL_TAB_INTROS[item.value]) }))}
        activeTab={activeTab}
        onChange={setActiveTab}
      >
        {activeTab === "role" && team ? (
          <div role="tabpanel" aria-label="Role">
            <TeamTabIntro tab="role" facts={teamFacts}><SharedTeamRolePanel team={team} /></TeamTabIntro>
          </div>
        ) : null}

        {activeTab === "overview" ? (
          <div role="tabpanel" aria-label="Members">
            <TeamTabIntro tab="overview" facts={teamFacts}>
            {teamMembers.length === 0 ? (
              <p className="border-y border-[var(--den-list-line)] py-4 text-[13px] text-[var(--dls-text-secondary)]">This team has no members yet.</p>
            ) : (
              <RowList label={`People in ${team?.name ?? "this team"}`} testId="team-members-list" header={<RowListHeader lead="Member"><RowLaneLabel lane={TEAM_MEMBER_ROLE_LANE}>Role</RowLaneLabel></RowListHeader>}>
                {teamMembers.map((member) => {
                  const name = member.user.name || member.user.email;
                  const flags = getOrgAccessFlags(member.role, member.isOwner);
                  const role = flags.isOwner ? BUILT_IN_ROLES.owner.label : flags.isSuperAdmin ? BUILT_IN_ROLES["super-admin"].label : flags.canonicalRole === "admin" ? BUILT_IN_ROLES.admin.label : BUILT_IN_ROLES.member.label;
                  // Roles the person holds through other teams sit under the row, as on the Members page.
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
            </TeamTabIntro>
          </div>
        ) : null}

        {activeTab === "access" ? (
          <div role="tabpanel" aria-label="Access">
            <TeamPluginAccessPanel teamId={teamId} teamName={team?.name ?? "This team"} orgSlug={orgSlug} canRevoke={canRevokeAccess} />
          </div>
        ) : null}

        {activeTab === "agents" && team ? (
          <div role="tabpanel" aria-label="Agents">
            <TeamTabIntro tab="agents" facts={teamFacts}><AgentsPanel team={{ id: team.id, name: team.name }} area="agents" /></TeamTabIntro>
          </div>
        ) : null}

        {activeTab === "browser" && team ? (
          <div role="tabpanel" aria-label="Browser">
            <TeamTabIntro tab="browser" facts={teamFacts}><AgentsPanel team={{ id: team.id, name: team.name }} area="browser" /></TeamTabIntro>
          </div>
        ) : null}

        {activeTab === "desktop" && team ? (<div role="tabpanel" aria-label="Desktop"><TeamTabIntro tab="desktop" facts={teamFacts}><DesktopSuggestionsPanel team={{ id: team.id, name: team.name }} /></TeamTabIntro></div>) : null}

        {activeTab === "prompts" && team ? (
          <div role="tabpanel" aria-label="Prompts">
            <PromptsPanel team={{ id: team.id, name: team.name }} />
          </div>
        ) : null}

        {activeTab === "workbot" && team ? (
          <div role="tabpanel" aria-label="Workbot">
            <TeamTabIntro tab="workbot" facts={teamFacts}><WorkbotPanel scope={teamScopeOf(team)} /></TeamTabIntro>
          </div>
        ) : null}

        {activeTab === "models" && team ? (
          <div role="tabpanel" aria-label="Models">
            <TeamTabIntro tab="models" facts={teamFacts && modelsFacts ? { ...teamFacts, providers: modelsFacts.providers, openworkModels: modelsFacts.openworkModels, sharedProviders } : null}>
              <ModelsPanel team={{ id: team.id, name: team.name }} />
            </TeamTabIntro>
          </div>
        ) : null}
      </TeamSections>
    </TeamPageFrame>
  );
}
