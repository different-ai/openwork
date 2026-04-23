/** @jsxImportSource react */
import type { ReactNode } from "react";
import { RefreshCcw } from "lucide-react";

import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import { Button } from "../../../design-system/button";

const settingsRailClass = "rounded-[24px] border border-dls-border bg-dls-sidebar p-3";
const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

export function getSettingsTabLabel(tab: SettingsTab) {
  switch (tab) {
    case "den":
      return t("settings.tab_cloud");
    case "automations":
      return t("settings.tab_automations");
    case "skills":
      return t("settings.tab_skills");
    case "extensions":
      return t("settings.tab_extensions");
    case "messaging":
      return t("settings.tab_messaging");
    case "advanced":
      return t("settings.tab_advanced");
    case "appearance":
      return t("settings.tab_appearance");
    case "updates":
      return t("settings.tab_updates");
    case "recovery":
      return t("settings.tab_recovery");
    case "debug":
      return t("settings.tab_debug");
    default:
      return t("settings.tab_general");
  }
}

export function getSettingsTabDescription(tab: SettingsTab) {
  switch (tab) {
    case "den":
      return t("settings.tab_description_den");
    case "automations":
      return t("settings.tab_description_automations");
    case "skills":
      return t("settings.tab_description_skills");
    case "extensions":
      return t("settings.tab_description_extensions");
    case "messaging":
      return t("settings.tab_description_messaging");
    case "advanced":
      return t("settings.tab_description_advanced");
    case "appearance":
      return t("settings.tab_description_appearance");
    case "updates":
      return t("settings.tab_description_updates");
    case "recovery":
      return t("settings.tab_description_recovery");
    case "debug":
      return t("settings.tab_description_debug");
    default:
      return t("settings.tab_description_general");
  }
}

export function getWorkspaceSettingsTabs(): SettingsTab[] {
  return ["general", "automations", "skills", "extensions", "messaging", "advanced"];
}

export function getGlobalSettingsTabs(developerMode: boolean): SettingsTab[] {
  const tabs: SettingsTab[] = ["den", "appearance", "updates", "recovery"];
  if (developerMode) tabs.push("debug");
  return tabs;
}

type SettingsPageProps = {
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
  developerMode: boolean;
  showUpdateToolbar?: boolean;
  updateToolbarTone?: string;
  updateToolbarTitle?: string;
  updateToolbarSpinning?: boolean;
  updateToolbarLabel?: string;
  updateToolbarActionLabel?: string | null;
  updateToolbarDisabled?: boolean;
  updateRestartBlockedMessage?: string | null;
  onUpdateToolbarAction?: () => void;
  children: ReactNode;
};

export function SettingsPage(props: SettingsPageProps) {
  const workspaceTabs = getWorkspaceSettingsTabs();
  const globalTabs = getGlobalSettingsTabs(props.developerMode);

  return (
    <section className="space-y-6 md:grid md:grid-cols-[220px_minmax(0,1fr)] md:gap-8 md:space-y-0">
      <aside className="space-y-6 md:sticky md:top-4 md:self-start">
        <div className={settingsRailClass}>
          <div className="mb-2 px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-gray-8">
            {t("settings.group_workspace")}
          </div>
          <div className="space-y-1">
            {workspaceTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors ${
                  props.activeTab === tab
                    ? "bg-dls-surface text-dls-text shadow-sm"
                    : "text-gray-10 hover:bg-dls-surface/50 hover:text-dls-text"
                }`}
                onClick={() => props.onSelectTab(tab)}
              >
                <span>{getSettingsTabLabel(tab)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={settingsRailClass}>
          <div className="mb-2 px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-gray-8">
            {t("settings.group_global")}
          </div>
          <div className="space-y-1">
            {globalTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors ${
                  props.activeTab === tab
                    ? "bg-dls-surface text-dls-text shadow-sm"
                    : "text-gray-10 hover:bg-dls-surface/50 hover:text-dls-text"
                }`}
                onClick={() => props.onSelectTab(tab)}
              >
                <span>{getSettingsTabLabel(tab)}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <div className="min-w-0 space-y-6">
        <div className={`${settingsPanelClass} flex flex-col gap-3 md:flex-row md:items-center md:justify-between`}>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold tracking-tight text-gray-12">
              {getSettingsTabLabel(props.activeTab)}
            </h2>
            <p className="text-sm text-gray-9">
              {getSettingsTabDescription(props.activeTab)}
            </p>
          </div>

          {props.showUpdateToolbar && props.activeTab === "general" ? (
            <div className="mt-4 space-y-2 md:mt-0 md:max-w-sm md:text-right">
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <div
                  className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm ${props.updateToolbarTone ?? "bg-gray-4/60 text-gray-11 border-gray-7/50"}`}
                  title={props.updateToolbarTitle}
                >
                  {props.updateToolbarSpinning ? <RefreshCcw size={12} className="animate-spin" /> : null}
                  <span className="tabular-nums whitespace-nowrap">{props.updateToolbarLabel}</span>
                </div>
                {props.updateToolbarActionLabel ? (
                  <Button
                    variant="outline"
                    className="h-8 rounded-full border-gray-6/60 bg-gray-1/70 px-3 py-0 text-xs hover:bg-gray-2/70"
                    onClick={props.onUpdateToolbarAction}
                    disabled={props.updateToolbarDisabled}
                    title={props.updateRestartBlockedMessage ?? ""}
                  >
                    {props.updateToolbarActionLabel}
                  </Button>
                ) : null}
              </div>
              {props.updateRestartBlockedMessage ? (
                <div className="text-xs leading-relaxed text-amber-11/90 md:max-w-sm">
                  {props.updateRestartBlockedMessage}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {props.children}
      </div>
    </section>
  );
}
