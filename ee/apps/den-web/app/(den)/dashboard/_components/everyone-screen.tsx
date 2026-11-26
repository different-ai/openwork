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

export type EveryoneTab = "role" | "agents" | "browser" | "models" | "workbot" | "prompts" | "desktop";

export function EveryoneScreen({ initialTab }: { initialTab: EveryoneTab | null }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const access = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions)
    : null;
  const showAgents = agentsTabVisible(orgContext);

  const showBrowser = showAgents;
  const showDesktop = desktopPolicyScreenRemoved(orgContext);
  const showModels = modelsTabVisible(orgContext);
  const showPrompts = promptsTabVisible(orgContext);
  const showWorkbot = workbotTabVisible(orgContext);
  const [chosenTab, setChosenTab] = useState<EveryoneTab | null>(initialTab);
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
      <TeamSections tabs={tabs} activeTab={activeTab} onChange={chooseTab}>
        {activeTab === "desktop" ? (<div role="tabpanel" aria-label="Desktop"><DesktopSuggestionsPanel team={null} /></div>) : activeTab === "role" ? (
          <div role="tabpanel" aria-label="Role">
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
          </div>
        ) : activeTab === "browser" ? (
          <div role="tabpanel" aria-label="Browser">
            <AgentsPanel team={null} area="browser" />
          </div>
        ) : activeTab === "models" ? (
          <div role="tabpanel" aria-label="Models">
            <ModelsPanel team={null} />
          </div>
        ) : activeTab === "workbot" ? (
          <div role="tabpanel" aria-label="Workbot">
            <WorkbotPanel scope={EVERYONE_SCOPE} />
          </div>
        ) : activeTab === "prompts" ? (
          <div role="tabpanel" aria-label="Prompts">
            <PromptsPanel team={null} />
          </div>
        ) : (
          <div role="tabpanel" aria-label="Agents">
            <AgentsPanel team={null} area="agents" />
          </div>
        )}
      </TeamSections>
    </TeamPageFrame>
  );
}
