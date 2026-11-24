"use client";

import { UnderlineTabs } from "../../_components/ui/tabs";
import { WORKBOT_SETTINGS_TAB_PURPOSE, WORKBOT_SETTINGS_TABS, type WorkbotSettingsTab } from "./workbot-settings-tabs-model";

export function WorkbotSettingsTabs({ activeTab, onChange }: { activeTab: WorkbotSettingsTab; onChange: (tab: WorkbotSettingsTab) => void }) {
  return (
    <div data-testid="workbot-settings-tabs">
      <UnderlineTabs tabs={WORKBOT_SETTINGS_TABS} activeTab={activeTab} onChange={onChange} />
      <p className="mt-4 px-1 text-[13px] leading-5 text-gray-600" data-testid="workbot-settings-tab-purpose">{WORKBOT_SETTINGS_TAB_PURPOSE[activeTab]}</p>
    </div>
  );
}
