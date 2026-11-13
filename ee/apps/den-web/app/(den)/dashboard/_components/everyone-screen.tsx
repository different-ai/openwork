"use client";

import { useState } from "react";
import { Laptop, Compass, Layers, MessageCircle, ScrollText, ShieldCheck, SquareTerminal } from "lucide-react";
import type { TabItem } from "../../_components/ui/tabs";
import { getMembersTeamsRoute, getOrgAccessFlags, getPermissionSetRoute } from "../../_lib/den-org";
import { desktopPolicyScreenRemoved } from "../_lib/desktop-policy-screen-rollout";
import { DesktopSuggestionsPanel } from "./desktop-suggestions-panel";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { AgentsPanel, agentsTabVisible } from "./agent-permissions-editor";
import { ItemPanel, ItemRow } from "./item-list";
import { ModelsPanel, modelsTabVisible } from "./team-models-panel";
import { PromptsPanel, promptsTabVisible } from "./prompts-panel";
import { EVERYONE_SCOPE } from "./team-scope";
import { TeamPageFrame, TeamSections } from "./team-sections";
import { WorkbotPanel, workbotTabVisible } from "./team-workbot-panel";
import { usePermissionSets } from "./permissions-data";
import { useFeatureIntroRuntime, useFeatureIntroUnseen } from "../_features/feature-intros";
import type { TeamDetailFacts } from "../_features/feature-intros/intros/team-detail";
import { useAiGatewayIntroFacts } from "./ai-gateway-intro-facts";
import { TEAM_DETAIL_TAB_INTROS, TeamTabIntro } from "./team-detail-screen";

export type EveryoneTab = "role" | "agents" | "browser" | "models" | "workbot" | "prompts" | "desktop";

/**
 * Members › Teams › Everyone: every member, including people in no team.
 * Its Agents tab is the base every team's Agents tab changes.
 */
export function EveryoneScreen({ initialTab }: { initialTab: EveryoneTab | null }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const access = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions)
    : null;
  const showAgents = agentsTabVisible(orgContext);
  // Browser and Models hold the organization's defaults, as each team's page does.

  const showBrowser = showAgents;
  const showDesktop = desktopPolicyScreenRemoved(orgContext);
  const showModels = modelsTabVisible(orgContext);
  const showPrompts = promptsTabVisible(orgContext);
  // Workbot holds Everyone's settings (on or off, model, name), which a team's Workbot tab can change for its members.
  const showWorkbot = workbotTabVisible(orgContext);
  const [chosenTab, setChosenTab] = useState<EveryoneTab | null>(initialTab);
  // The tab is in the address, so a reload or a shared link opens it again.
  const chooseTab = (tab: EveryoneTab) => {
    setChosenTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url);
  };
  const activeTab: EveryoneTab = chosenTab === "agents" && showAgents ? "agents"
    : chosenTab === "browser" && showBrowser ? "browser"
      : chosenTab === "models" && showModels ? "models"
      : chosenTab === "workbot" && showWorkbot ? "workbot"
      : chosenTab === "prompts" && showPrompts ? "prompts"
        : chosenTab === "desktop" && showDesktop ? "desktop" : "role";
  const memberCount = orgContext?.members.length ?? 0;
  // Everyone shares the team tabs' intros (DESIGN.md I10); only Models and Prompts can show a box here.
  const introUnseen = useFeatureIntroUnseen();
  const introsEnabled = useFeatureIntroRuntime().enabled;
  const introFacts: TeamDetailFacts | null = orgContext ? {} : null;
  const modelsFacts = useAiGatewayIntroFacts(introsEnabled && activeTab === "models");
  const canViewSets = Boolean(orgContext && access?.canViewPermissions);
  const setsQuery = usePermissionSets(orgId, canViewSets);
  const memberSet = setsQuery.data?.find((set) => set.kind === "member_default");
  const tabs: readonly TabItem<EveryoneTab>[] = [
    { value: "role", label: "Role", icon: ShieldCheck },
    ...(showAgents ? [{ value: "agents" as const, label: "Agents", icon: SquareTerminal }] : []),
    ...(showBrowser ? [{ value: "browser" as const, label: "Browser", icon: Compass }] : []),
    ...(showModels ? [{ value: "models" as const, label: "Models", icon: Layers }] : []),
    ...(showWorkbot ? [{ value: "workbot" as const, label: "Workbot", icon: MessageCircle }] : []),
    ...(showPrompts ? [{ value: "prompts" as const, label: "Prompts", icon: ScrollText }] : []),
    ...(showDesktop ? [{ value: "desktop" as const, label: "Desktop", icon: Laptop }] : []),
  ];

  return (
    <TeamPageFrame title="Everyone" memberCount={memberCount} backHref={getMembersTeamsRoute(orgSlug)} testId="everyone-screen">
      <TeamSections tabs={tabs.map((item) => ({ ...item, unseen: introUnseen(TEAM_DETAIL_TAB_INTROS[item.value]) }))} activeTab={activeTab} onChange={chooseTab}>
        {activeTab === "desktop" ? (<div role="tabpanel" aria-label="Desktop"><TeamTabIntro tab="desktop" facts={introFacts}><DesktopSuggestionsPanel team={null} /></TeamTabIntro></div>) : activeTab === "role" ? (
          <div role="tabpanel" aria-label="Role">
            <TeamTabIntro tab="role" facts={introFacts}>
            <ItemPanel>
              <ItemRow
                logo={<IconTile icon={ShieldCheck} />}
                title="Member"
                description="What everyone can do"
                status="Built-in role"
                href={memberSet ? getPermissionSetRoute(orgSlug, memberSet.id) : undefined}
                testId="everyone-role-member"
              />
            </ItemPanel>
            </TeamTabIntro>
          </div>
        ) : activeTab === "browser" ? (
          <div role="tabpanel" aria-label="Browser">
            <TeamTabIntro tab="browser" facts={introFacts}><AgentsPanel team={null} area="browser" /></TeamTabIntro>
          </div>
        ) : activeTab === "models" ? (
          <div role="tabpanel" aria-label="Models">
            <TeamTabIntro tab="models" facts={modelsFacts ? { providers: modelsFacts.providers, openworkModels: modelsFacts.openworkModels } : null}>
              <ModelsPanel team={null} />
            </TeamTabIntro>
          </div>
        ) : activeTab === "workbot" ? (
          <div role="tabpanel" aria-label="Workbot">
            <TeamTabIntro tab="workbot" facts={introFacts}><WorkbotPanel scope={EVERYONE_SCOPE} /></TeamTabIntro>
          </div>
        ) : activeTab === "prompts" ? (
          <div role="tabpanel" aria-label="Prompts">
            <PromptsPanel team={null} />
          </div>
        ) : (
          <div role="tabpanel" aria-label="Agents">
            <TeamTabIntro tab="agents" facts={introFacts}><AgentsPanel team={null} area="agents" /></TeamTabIntro>
          </div>
        )}
      </TeamSections>
    </TeamPageFrame>
  );
}
