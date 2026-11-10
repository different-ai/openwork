"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { ArrowLeft, Laptop, Compass, KeyRound, Layers, MessageCircle, ScrollText, ShieldCheck, SquareTerminal, Users } from "lucide-react";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { getMembersRoute, getOrgAccessFlags } from "../../_lib/den-org";
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
import { WorkbotPanel, workbotTabVisible } from "./team-workbot-panel";
import { OrgMemberIdentity } from "./org-member-identity";
import { SharedTeamRolePanel } from "./shared-team-role-panel";
import { MemberTeamRoles } from "./member-team-roles";
import { useCustomRoleTeams } from "./permissions-data";
import { FeatureIntroGate, useFeatureIntroRuntime, useFeatureIntroUnseen, type FeatureIntroKey } from "../_features/feature-intros";
import type { TeamDetailFacts } from "../_features/feature-intros/intros/team-detail";
import { useAiGatewayIntroFacts } from "./ai-gateway-intro-facts";

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
  const customRoles = useCustomRoleTeams(orgId, Boolean(orgContext) && (viewerAccess?.canViewPermissions ?? false));
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
    <div className="mx-auto max-w-[860px] px-6 py-8 md:px-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link
          href={getMembersRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-500 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
      </div>

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-950">
          {team?.name ?? "Team"}
        </h1>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[12px] font-medium text-gray-600">
          {memberCount} {memberCount === 1 ? "member" : "members"}
        </span>
      </header>

      <UnderlineTabs
        className="mt-6"
        tabs={tabs.map((item) => ({ ...item, unseen: introUnseen(TEAM_DETAIL_TAB_INTROS[item.value]) }))}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      <div className="mt-6">
        {activeTab === "role" && team ? (
          <div role="tabpanel" aria-label="Role">
            <TeamTabIntro tab="role" facts={teamFacts}><SharedTeamRolePanel team={team} /></TeamTabIntro>
          </div>
        ) : null}

        {activeTab === "overview" ? (
          <div role="tabpanel" aria-label="Overview">
            <TeamTabIntro tab="overview" facts={teamFacts}>
            {teamMembers.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
                <p className="text-[14px] font-medium text-gray-800">This team has no members yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white">
                {teamMembers.map((member) => (
                  <div key={member.id} className="px-6 py-4">
                    <OrgMemberIdentity member={member} />
                    {orgContext ? (
                      <MemberTeamRoles member={member} teams={orgContext.teams} customTeamIds={customRoles.teamIds} customRoleNameByTeam={customRoles.nameByTeam} exceptTeamId={teamId} />
                    ) : member.adminTeams.length > 0 ? (
                      <p className="mt-2 text-[12px] text-gray-500">Admin via {member.adminTeams.map((entry) => entry.name).join(", ")}</p>
                    ) : null}
                  </div>
                ))}
              </div>
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
      </div>
    </div>
  );
}
