"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Laptop, Compass, Layers, ScrollText, ShieldCheck, SquareTerminal } from "lucide-react";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { getMembersTeamsRoute, getOrgAccessFlags, getPermissionSetRoute } from "../../_lib/den-org";
import { desktopPolicyScreenRemoved } from "../_lib/desktop-policy-screen-rollout";
import { DesktopSuggestionsPanel } from "./desktop-suggestions-panel";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { AgentsPanel, agentsTabVisible } from "./agent-permissions-editor";
import { ItemPanel, ItemRow } from "./item-list";
import { ModelsPanel, modelsTabVisible } from "./team-models-panel";
import { PromptsPanel, promptsTabVisible } from "./prompts-panel";
import { usePermissionSets } from "./permissions-data";
import { useFeatureIntroRuntime, useFeatureIntroUnseen } from "../_features/feature-intros";
import type { TeamDetailFacts } from "../_features/feature-intros/intros/team-detail";
import { useAiGatewayIntroFacts } from "./ai-gateway-intro-facts";
import { TEAM_DETAIL_TAB_INTROS, TeamTabIntro } from "./team-detail-screen";

export type EveryoneTab = "role" | "agents" | "browser" | "models" | "prompts" | "desktop";

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
    ...(showPrompts ? [{ value: "prompts" as const, label: "Prompts", icon: ScrollText }] : []),
    ...(showDesktop ? [{ value: "desktop" as const, label: "Desktop", icon: Laptop }] : []),
  ];

  return (
    <div className="mx-auto max-w-[860px] px-6 py-8 md:px-8" data-testid="everyone-screen">
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link
          href={getMembersTeamsRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-500 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
      </div>

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-950">Everyone</h1>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[12px] font-medium text-gray-600">
          {memberCount} {memberCount === 1 ? "member" : "members"}
        </span>
      </header>

      <UnderlineTabs className="mt-6" tabs={tabs.map((item) => ({ ...item, unseen: introUnseen(TEAM_DETAIL_TAB_INTROS[item.value]) }))} activeTab={activeTab} onChange={chooseTab} />

      <div className="mt-6">
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
        ) : activeTab === "prompts" ? (
          <div role="tabpanel" aria-label="Prompts">
            <PromptsPanel team={null} />
          </div>
        ) : (
          <div role="tabpanel" aria-label="Agents">
            <TeamTabIntro tab="agents" facts={introFacts}><AgentsPanel team={null} area="agents" /></TeamTabIntro>
          </div>
        )}
      </div>
    </div>
  );
}
