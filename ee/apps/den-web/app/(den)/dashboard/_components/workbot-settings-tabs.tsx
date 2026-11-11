"use client";

import { UnderlineTabs } from "../../_components/ui/tabs";
import { orgFeatureEnabled, type DenOrgContext } from "../../_lib/den-org";
import { WORKBOT_SETTINGS_TAB_PURPOSE, WORKBOT_SETTINGS_TABS, type WorkbotSettingsTab } from "./workbot-settings-tabs-model";

/** Workbot's settings are split into tabs with `workbotSettingsTabs` on. */
export function workbotSettingsTabsEnabled(orgContext: DenOrgContext | null | undefined): boolean {
  return Boolean(orgContext) && orgFeatureEnabled(orgContext ?? null, "workbotSettingsTabs");
}

/** General, Proactive Mode and Connectors, with one sentence on what the open tab is for: on Manage › Workbot and on a team's (or Everyone's) Workbot section. */
export function WorkbotSettingsTabs({ activeTab, onChange }: { activeTab: WorkbotSettingsTab; onChange: (tab: WorkbotSettingsTab) => void }) {
  return (
    <div data-testid="workbot-settings-tabs">
      <UnderlineTabs tabs={WORKBOT_SETTINGS_TABS} activeTab={activeTab} onChange={onChange} />
      <p className="mt-4 px-1 text-[13px] leading-5 text-gray-600" data-testid="workbot-settings-tab-purpose">{WORKBOT_SETTINGS_TAB_PURPOSE[activeTab]}</p>
    </div>
  );
}
