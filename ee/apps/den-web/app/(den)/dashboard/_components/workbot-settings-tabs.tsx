"use client";

import { UnderlineTabs } from "../../_components/ui/tabs";
import { orgFeatureEnabled, type DenOrgContext } from "../../_lib/den-org";
import { WORKBOT_SETTINGS_TABS, type WorkbotSettingsTab } from "./workbot-settings-tabs-model";

/** Workbot's settings are split into tabs with `workbotSettingsTabs` on. */
export function workbotSettingsTabsEnabled(orgContext: DenOrgContext | null | undefined): boolean {
  return Boolean(orgContext) && orgFeatureEnabled(orgContext ?? null, "workbotSettingsTabs");
}

/** General, Members' agents and What agents read: on Manage › Workbot and on a team's (or Everyone's) Workbot section. */
export function WorkbotSettingsTabs({ activeTab, onChange }: { activeTab: WorkbotSettingsTab; onChange: (tab: WorkbotSettingsTab) => void }) {
  return (
    <div data-testid="workbot-settings-tabs">
      <UnderlineTabs tabs={WORKBOT_SETTINGS_TABS} activeTab={activeTab} onChange={onChange} />
    </div>
  );
}
