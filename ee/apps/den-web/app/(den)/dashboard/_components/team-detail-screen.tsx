"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Laptop, Compass, KeyRound, Layers, ScrollText, ShieldCheck, SquareTerminal, Users } from "lucide-react";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { getMembersRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { desktopPolicyScreenRemoved } from "../_lib/desktop-policy-screen-rollout";
import { DesktopSuggestionsPanel } from "./desktop-suggestions-panel";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { AgentsPanel, agentsTabVisible } from "./agent-permissions-editor";
import { TeamPluginAccessPanel } from "./team-plugin-access-panel";
import { ModelsPanel, modelsTabVisible } from "./team-models-panel";
import { PromptsPanel, promptsTabVisible } from "./prompts-panel";
import { OrgMemberIdentity } from "./org-member-identity";
import { SharedTeamRolePanel } from "./shared-team-role-panel";
import { MemberTeamRoles } from "./member-team-roles";
import { useCustomRoleTeams } from "./permissions-data";

export type TeamDetailTab = "role" | "overview" | "access" | "agents" | "browser" | "models" | "prompts" | "desktop";

export function TeamDetailScreen({ teamId, initialTab = null }: { teamId: string; initialTab?: TeamDetailTab | null }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
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
  const agentsTab: readonly TabItem<TeamDetailTab>[] = [
    ...(showAgents ? [{ value: "agents" as const, label: "Agents", icon: SquareTerminal }] : []),
    ...(showBrowser ? [{ value: "browser" as const, label: "Browser", icon: Compass }] : []),
    ...(showModels ? [{ value: "models" as const, label: "Models", icon: Layers }] : []),
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
        tabs={tabs}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      <div className="mt-6">
        {activeTab === "role" && team ? (
          <div role="tabpanel" aria-label="Role">
            <SharedTeamRolePanel team={team} />
          </div>
        ) : null}

        {activeTab === "overview" ? (
          <div role="tabpanel" aria-label="Overview">
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

        {activeTab === "models" && team ? (
          <div role="tabpanel" aria-label="Models">
            <ModelsPanel team={{ id: team.id, name: team.name }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
