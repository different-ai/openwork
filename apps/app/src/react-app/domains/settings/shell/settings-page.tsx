/** @jsxImportSource react */
import { DesktopUpdateAction } from "../state/desktop-updater-provider";
import type * as React from "react";
import {
  ArrowLeft,
  Bug,
  Cable,
  ChevronDown,
  CloudCog,
  Cog,
  FolderLock,
  Paintbrush,
  Puzzle,
  RefreshCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Store,
  Terminal,
  UserCircle,
  Wrench,
  Zap,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "../../../../i18n";
import { isSettingsTabAllowed } from "../../../../app/cloud/desktop-app-restrictions";
import type { PlatformCapabilities } from "../../../../app/lib/platform-capabilities";
import type { SettingsTab } from "../../../../app/types";
import { cn } from "@/lib/utils";
import { usePlatform } from "../../../kernel/platform";
import { useCheckDesktopRestriction } from "../../cloud/desktop-config-provider";
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
import { SidebarDestination } from "../../session/sidebar/sidebar-destination";

export function getSettingsTabIcon(tab: SettingsTab) {
  switch (tab) {
    case "ai":
      return Zap;
    case "preferences":
      return SlidersHorizontal;
    case "permissions":
      return FolderLock;
    case "cloud-account":
      return UserCircle;
    case "connect":
      return Cable;
    case "cloud-marketplaces":
      return Store;
    case "cloud-providers":
      return CloudCog;
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
    case "ai":
      return "AI Providers";
    case "preferences":
      return "Preferences";
    case "permissions":
      return "Permissions";
    case "cloud-account":
      return t("settings.tab_cloud_account");
    case "connect":
      return t("settings.tab_connect");
    case "cloud-marketplaces":
      return t("settings.tab_cloud_marketplaces");
    case "cloud-providers":
      return t("settings.tab_cloud_providers");
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
    case "general":
      return "Settings";
    default:
      return t("settings.tab_general");
  }
}

export function getSettingsTabDescription(tab: SettingsTab) {
  switch (tab) {
    case "ai":
      return "Connect services that provide AI models";
    case "preferences":
      return "Default model, reasoning, and compaction";
    case "permissions":
      return "Authorized folders and file access";
    case "cloud-account":
      return t("settings.tab_description_cloud_account");
    case "connect":
      return t("settings.tab_description_connect");
    case "cloud-marketplaces":
      return t("settings.tab_description_cloud_marketplaces");
    case "cloud-providers":
      return t("settings.tab_description_cloud_providers");
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
    case "general":
      return "Overview of all settings";
    default:
      return t("settings.tab_description_general");
  }
}

export function getWorkspaceSettingsTabs(): SettingsTab[] {
  return ["preferences", "permissions", "extensions", "advanced"];
}

export function getGlobalSettingsTabs(
  developerMode: boolean,
  capabilities: Pick<PlatformCapabilities, "autoUpdate">,
): SettingsTab[] {
  const tabs: SettingsTab[] = ["ai", "appearance", "environment"];
  if (capabilities.autoUpdate) tabs.push("updates");
  if (developerMode) tabs.push("debug");
  return tabs;
}

export const CLOUD_SETTINGS_TABS: SettingsTab[] = [
  "cloud-account",
];

export function isSettingsTabBeta(_tab: SettingsTab) {
  return false;
}

export function isSettingsTabActive(activeTab: SettingsTab, tab: SettingsTab) {
  return activeTab === tab;
}

export function SettingsBetaBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border border-amber-6/40 bg-amber-3/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-11",
        className,
      )}
    >
      {t("common.beta")}
    </span>
  );
}

function SettingsSidebarTabLabel({ tab }: { tab: SettingsTab }) {
  return (
    <>
      <span>{getSettingsTabLabel(tab)}</span>
      {isSettingsTabBeta(tab) ? <SettingsBetaBadge className="ml-auto" /> : null}
    </>
  );
}

export type SettingsNavGroups = {
  hub: SettingsTab[];
  workspace: SettingsTab[];
  global: SettingsTab[];
  cloud: SettingsTab[];
};

/**
 * Every settings navigation surface (sidebar + compact section menu) reads its
 * tabs from here so platform capabilities, preview flags, and the
 * `allowControlSettings` desktop policy cannot drift between them. When the
 * organization blocks settings control, only the Cloud group remains.
 */
export function useSettingsNavGroups(developerMode: boolean): SettingsNavGroups {
  const platform = usePlatform();
  const checkRestriction = useCheckDesktopRestriction();
  const allowed = (tabs: SettingsTab[]) =>
    tabs.filter((tab) => isSettingsTabAllowed({ tab, checkRestriction }));
  return {
    hub: allowed(["general"]),
    workspace: allowed(getWorkspaceSettingsTabs()),
    global: allowed(getGlobalSettingsTabs(developerMode, platform.capabilities)),
    cloud: allowed(CLOUD_SETTINGS_TABS),
  };
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

type SettingsSidebarProps = Pick<SettingsPageProps, "activeTab" | "onSelectTab" | "developerMode"> & {
  onClose: () => void;
  selectedWorkspaceId: string;
  selectedWorkspaceName: string;
  selectedWorkspaceColor: string;
  workspaces: Array<{ id: string; name: string; color: string }>;
  onSelectWorkspace: (workspaceId: string) => void;
};

function SettingsSidebarGroup(props: {
  label: string;
  tabs: SettingsTab[];
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
}) {
  if (props.tabs.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{props.label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {props.tabs.map((tab) => {
            const Icon = getSettingsTabIcon(tab);
            return (
              <SidebarDestination
                key={tab}
                active={isSettingsTabActive(props.activeTab, tab)}
                icon={Icon}
                label={getSettingsTabLabel(tab)}
                labelContent={<SettingsSidebarTabLabel tab={tab} />}
                onSelect={() => props.onSelectTab(tab)}
              />
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function SettingsSidebar(props: SettingsSidebarProps) {
  const groups = useSettingsNavGroups(props.developerMode);

  return (
    <Sidebar collapsible="icon" className="mac:**:data-[sidebar=sidebar]:bg-transparent">
      <div className="hidden h-10 mac:block mac:titlebar-drag" />
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton type="button" onClick={props.onClose}>
              <ArrowLeft size={14} />
              <span>{t("dashboard.back_to_app")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton type="button">
                    <span className="truncate">{props.selectedWorkspaceName}</span>
                    <ChevronDown className="ml-auto" />
                  </SidebarMenuButton>
                }
              />
              <DropdownMenuContent className="w-(--anchor-width)">
                {props.workspaces.map((workspace) => (
                  <DropdownMenuItem
                    key={workspace.id}
                    onClick={() => props.onSelectWorkspace(workspace.id)}
                    disabled={workspace.id === props.selectedWorkspaceId}
                  >
                    <span className="truncate">{workspace.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/* Top-level hub entry */}
        {groups.hub.length > 0 ? (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    type="button"
                    isActive={isSettingsTabActive(props.activeTab, "general")}
                    aria-current={isSettingsTabActive(props.activeTab, "general") ? "page" : undefined}
                    tooltip={getSettingsTabLabel("general")}
                    onClick={() => props.onSelectTab("general")}
                  >
                    <Cog />
                    <span>{getSettingsTabLabel("general")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}

        <SettingsSidebarGroup
          label={t("settings.group_workspace")}
          tabs={groups.workspace}
          activeTab={props.activeTab}
          onSelectTab={props.onSelectTab}
        />
        <SettingsSidebarGroup
          label={t("settings.group_global")}
          tabs={groups.global}
          activeTab={props.activeTab}
          onSelectTab={props.onSelectTab}
        />
        <SettingsSidebarGroup
          label={t("settings.group_cloud")}
          tabs={groups.cloud}
          activeTab={props.activeTab}
          onSelectTab={props.onSelectTab}
        />
      </SidebarContent>
      <SidebarFooter className="empty:hidden">
        <DesktopUpdateAction />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export function SettingsPageHeading({ activeTab }: Pick<SettingsPageProps, "activeTab">) {
  return (
    <SettingsPanelHeading>
      <SettingsPanelTitle>{getSettingsTabLabel(activeTab)}</SettingsPanelTitle>
      <SettingsPanelDescription>{getSettingsTabDescription(activeTab)}</SettingsPanelDescription>
    </SettingsPanelHeading>
  );
}

export function SettingsPage(props: SettingsPageProps) {
  return (
    <SettingsContent>
      <SettingsPanel>
        <SettingsPageHeading activeTab={props.activeTab} />

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
  );
}
