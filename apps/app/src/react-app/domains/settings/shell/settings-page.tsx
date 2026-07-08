/** @jsxImportSource react */
import type * as React from "react";
import {
  ArrowLeft,
  BrainCircuit,
  Bug,
  Cable,
  ChevronDown,
  CloudCog,
  Cog,
  FolderLock,
  Info,
  Layout,
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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import { cn } from "@/lib/utils";
import { useOrgRestrictions } from "../../cloud/desktop-config-provider";
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
import { WorkspaceIcon } from "../../../design-system/workspace-icon";
import { useFeatureFlagsPreferences } from "../state/feature-flags-preferences";

export function getSettingsTabIcon(tab: SettingsTab) {
  switch (tab) {
    case "ai":
      return Zap;
    case "preferences":
      return SlidersHorizontal;
    case "shell":
      return Layout;
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
    case "memory":
      return BrainCircuit;
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
    case "shell":
      return "Customization";
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
    case "memory":
      return t("memory.tab_label");
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
    case "shell":
      return "Branding, visibility, and shell controls";
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
    case "memory":
      return t("memory.tab_description");
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

export function getGlobalSettingsTabs(developerMode: boolean): SettingsTab[] {
  const tabs: SettingsTab[] = ["ai", "shell", "appearance", "environment", "updates", "recovery"];
  if (developerMode) tabs.push("debug");
  return tabs;
}

export const CLOUD_SETTINGS_TABS: SettingsTab[] = [
  "cloud-account",
  "connect",
];

export function isSettingsTabBeta(tab: SettingsTab) {
  return tab === "connect";
}

export function SettingsBetaBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border border-amber-6/40 bg-amber-3/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-11",
        className,
      )}
    >
      {t("common.alpha")}
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

/**
 * Cloud settings tabs, gated by client-only preview flags. The Memory tab is
 * surfaced only when `featureFlags.memory` is on (C-4). Both settings nav
 * surfaces (sidebar + compact section menu) must use this so they can't drift.
 */
export function getCloudSettingsTabs(memoryEnabled: boolean): SettingsTab[] {
  return memoryEnabled ? [...CLOUD_SETTINGS_TABS, "memory"] : CLOUD_SETTINGS_TABS;
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

export function SettingsSidebar(props: SettingsSidebarProps) {
  const { memoryEnabled } = useFeatureFlagsPreferences();
  const workspaceTabs = getWorkspaceSettingsTabs();
  const globalTabs = getGlobalSettingsTabs(props.developerMode);
  const cloudTabs = getCloudSettingsTabs(memoryEnabled);

  return (
    <Sidebar className="mac:**:data-[sidebar=sidebar]:bg-transparent">
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
                    <WorkspaceIcon workspaceId={props.selectedWorkspaceId} sizeClass="size-4" />
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
                    <WorkspaceIcon workspaceId={workspace.id} sizeClass="size-4" />
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
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  type="button"
                  isActive={props.activeTab === "general"}
                  onClick={() => props.onSelectTab("general")}
                >
                  <Cog />
                  <span>{getSettingsTabLabel("general")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

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
                      <SettingsSidebarTabLabel tab={tab} />
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
                      <SettingsSidebarTabLabel tab={tab} />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>{t("settings.group_cloud")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {cloudTabs.map((tab) => {
                const Icon = getSettingsTabIcon(tab);
                return (
                  <SidebarMenuItem key={tab}>
                    <SidebarMenuButton
                      type="button"
                      isActive={props.activeTab === tab}
                      onClick={() => props.onSelectTab(tab)}
                    >
                      <Icon />
                      <SettingsSidebarTabLabel tab={tab} />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function DesktopPolicyBanner() {
  const config = useOrgRestrictions();

  // Show the banner when the org has any active desktop policy restriction
  // (a boolean set to false) or any white-label branding override.
  const hasRestriction = Object.entries(config).some(
    ([key, value]) => typeof value === "boolean" && value === false && key !== "allowedDesktopVersions",
  );
  const hasBranding = Boolean(config.brandLogoUrl ?? config.brandAccentColor);

  if (!hasRestriction && !hasBranding) return null;

  return (
    <div
      data-testid="desktop-policy-banner"
      className="flex items-start gap-2.5 rounded-xl border border-indigo-6/30 bg-indigo-2/50 px-3.5 py-2.5 text-sm dark:border-indigo-7/25 dark:bg-indigo-3/30"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-indigo-11" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-indigo-12">
          {t("settings.desktop_policy_active_title")}
        </p>
        <p className="mt-0.5 text-xs text-indigo-11">
          {t("settings.desktop_policy_active_body")}
        </p>
      </div>
    </div>
  );
}

export function SettingsPage(props: SettingsPageProps) {
  return (
    <SettingsContent>
      <SettingsPanel>
        <SettingsPanelHeading>
          <SettingsPanelTitle>{getSettingsTabLabel(props.activeTab)}</SettingsPanelTitle>
          <SettingsPanelDescription>{getSettingsTabDescription(props.activeTab)}</SettingsPanelDescription>
        </SettingsPanelHeading>
        <DesktopPolicyBanner />

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
