/** @jsxImportSource react */
import type * as React from "react";
import {
  Bug,
  Cloud,
  Cog,
  Paintbrush,
  Puzzle,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import {
  SettingsContent,
  SettingsPanel,
  SettingsPanelDescription,
  SettingsPanelHeading,
  SettingsPanelTitle,
  SettingsPanelToolbar,
  SettingsPanelToolbarActions,
  SettingsPanelToolbarButton,
  SettingsPanelToolbarMessage,
  SettingsPanelToolbarStatus,
} from "./panel";

export function getSettingsTabIcon(tab: SettingsTab) {
  switch (tab) {
    case "den":
      return Cloud;
    case "skills":
      return Sparkles;
    case "extensions":
      return Puzzle;
    case "environment":
      return Terminal;
    case "advanced":
      return Wrench;
    case "appearance":
      return Paintbrush;
    case "updates":
      return RefreshCcw;
    case "recovery":
      return ShieldCheck;
    case "debug":
      return Bug;
    default:
      return Cog;
  }
}

export function getSettingsTabLabel(tab: SettingsTab) {
  switch (tab) {
    case "den":
      return t("settings.tab_cloud");
    case "skills":
      return t("settings.tab_skills");
    case "extensions":
      return t("settings.tab_extensions");
    case "environment":
      return t("settings.tab_environment");
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
    case "skills":
      return t("settings.tab_description_skills");
    case "extensions":
      return t("settings.tab_description_extensions");
    case "environment":
      return t("settings.tab_description_environment");
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
  return ["general", "skills", "extensions", "advanced"];
}

export function getGlobalSettingsTabs(developerMode: boolean): SettingsTab[] {
  const tabs: SettingsTab[] = ["den", "appearance", "environment", "updates", "recovery"];
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
  children: React.ReactNode;
};

export function SettingsPage(props: SettingsPageProps) {
  const workspaceTabs = getWorkspaceSettingsTabs();
  const globalTabs = getGlobalSettingsTabs(props.developerMode);

  return (
    <SidebarProvider className="relative min-h-full min-w-0">
        <Sidebar collapsible="none" className="absolute inset-0">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>{t("settings.group_workspace")}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {workspaceTabs.map((tab) => {
                    const Icon = getSettingsTabIcon(tab);
                    return (
                      <SidebarMenuItem key={tab}>
                        <SidebarMenuButton
                          type="button"
                          isActive={props.activeTab === tab}
                          onClick={() => props.onSelectTab(tab)}
                        >
                          <Icon />
                          <span>{getSettingsTabLabel(tab)}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupLabel>{t("settings.group_global")}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {globalTabs.map((tab) => {
                    const Icon = getSettingsTabIcon(tab);
                    return (
                      <SidebarMenuItem key={tab}>
                        <SidebarMenuButton
                          type="button"
                          isActive={props.activeTab === tab}
                          onClick={() => props.onSelectTab(tab)}
                        >
                          <Icon />
                          <span>{getSettingsTabLabel(tab)}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>

        <SidebarInset className="h-full min-w-0 w-full max-w-full overflow-hidden">
        <SettingsContent>
          <SettingsPanel>
            <SettingsPanelHeading>
              <SettingsPanelTitle>{getSettingsTabLabel(props.activeTab)}</SettingsPanelTitle>
              <SettingsPanelDescription>{getSettingsTabDescription(props.activeTab)}</SettingsPanelDescription>
            </SettingsPanelHeading>

            {props.showUpdateToolbar && props.activeTab === "general" ? (
              <SettingsPanelToolbar>
                <SettingsPanelToolbarActions>
                  <SettingsPanelToolbarStatus
                    tone={props.updateToolbarTone}
                    title={props.updateToolbarTitle}
                    spinning={props.updateToolbarSpinning}
                  >
                    {props.updateToolbarLabel}
                  </SettingsPanelToolbarStatus>
                  {props.updateToolbarActionLabel ? (
                    <SettingsPanelToolbarButton
                      onClick={props.onUpdateToolbarAction}
                      disabled={props.updateToolbarDisabled}
                      title={props.updateRestartBlockedMessage ?? ""}
                    >
                      {props.updateToolbarActionLabel}
                    </SettingsPanelToolbarButton>
                  ) : null}
                </SettingsPanelToolbarActions>
                {props.updateRestartBlockedMessage ? (
                  <SettingsPanelToolbarMessage>{props.updateRestartBlockedMessage}</SettingsPanelToolbarMessage>
                ) : null}
              </SettingsPanelToolbar>
            ) : null}
          </SettingsPanel>

          {props.children}
        </SettingsContent>
        </SidebarInset>
    </SidebarProvider>
  );
}
