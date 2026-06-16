/** @jsxImportSource react */
import type * as React from "react";
import { ChevronDown, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { t } from "../../../../i18n";
import { NotificationBell } from "../../../shell/notification-center";
import type { SettingsTab } from "../../../../app/types";
import {
  CLOUD_SETTINGS_TABS,
  SettingsPage,
  SettingsSidebar,
  getGlobalSettingsTabs,
  getSettingsTabIcon,
  getSettingsTabLabel,
  getWorkspaceSettingsTabs,
} from "./settings-page";
import { WorkspaceIcon } from "../../../design-system/workspace-icon";

type SettingsPageFrameProps = Omit<React.ComponentProps<typeof SettingsPage>, "children">;

export type SettingsShellProps = SettingsPageFrameProps & {
  selectedWorkspaceId: string;
  selectedWorkspaceName: string;
  selectedWorkspaceColor: string;
  workspaces: Array<{ id: string; name: string; color: string }>;
  headerStatus?: string;
  busyHint?: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onClose: () => void;
  headerLeadingSlot?: React.ReactNode;
  children: React.ReactNode;
  modalSlot?: React.ReactNode;
  footer?: React.ReactNode;
  compact?: boolean;
};

export function SettingsShell(props: SettingsShellProps) {
  const title = getSettingsTabLabel(props.activeTab);

  if (props.compact) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
        <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-dls-border px-3 mac:titlebar-drag">
          <div className="flex min-w-0 items-center gap-2 mac:titlebar-no-drag">
            <SettingsSectionMenu
              activeTab={props.activeTab}
              developerMode={props.developerMode}
              onSelectTab={props.onSelectTab}
            />
            <WorkspaceMenu
              selectedWorkspaceId={props.selectedWorkspaceId}
              selectedWorkspaceName={props.selectedWorkspaceName}
              workspaces={props.workspaces}
              onSelectWorkspace={props.onSelectWorkspace}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1 mac:titlebar-no-drag">
            <NotificationBell />
            <Button
              variant="ghost"
              type="button"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
              onClick={props.onClose}
              title={t("dashboard.close_settings")}
              aria-label={t("dashboard.close_settings")}
            >
              <X size={17} />
            </Button>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col">
            <SettingsPage {...props}>{props.children}</SettingsPage>

            {props.modalSlot}
          </div>

          {props.footer}
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-screen w-full overflow-hidden">
      <SidebarProvider open={true} className="relative min-h-0 flex-1">
        <SettingsSidebar
          activeTab={props.activeTab}
          onSelectTab={props.onSelectTab}
          developerMode={props.developerMode}
          onClose={props.onClose}
          selectedWorkspaceId={props.selectedWorkspaceId}
          selectedWorkspaceName={props.selectedWorkspaceName}
          selectedWorkspaceColor={props.selectedWorkspaceColor}
          workspaces={props.workspaces}
          onSelectWorkspace={props.onSelectWorkspace}
        />
        <SidebarInset className="min-h-0 overflow-hidden bg-background mac:bg-background/80 mac:[&_header]:transition-[padding-left] mac:[&_header]:duration-200 mac:[&_header]:ease-linear mac:peer-data-[state=collapsed]:[&_header]:pl-16 [&_header]:pl-16 md:[&_header]:pl-6">
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <header className="shrink-0 flex h-10 items-center justify-between border-b border-dls-border px-4 md:px-6 mac:titlebar-drag">
              <div className="flex min-w-0 items-center gap-3">
                <SidebarTrigger className="mac:titlebar-no-drag md:hidden" />
                {props.headerLeadingSlot}
                <h1 className="truncate text-[15px] font-semibold text-dls-text">{title}</h1>
                <span className="hidden truncate text-[13px] text-dls-secondary lg:inline">
                  {props.selectedWorkspaceName}
                </span>
                {props.developerMode && props.headerStatus ? (
                  <span className="hidden text-[12px] text-dls-secondary lg:inline">
                    {props.headerStatus}
                  </span>
                ) : null}
                {props.busyHint ? (
                  <span className="hidden text-[12px] text-dls-secondary lg:inline">
                    {props.busyHint}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5 text-gray-10 mac:titlebar-no-drag">
                <NotificationBell />
                <Button
                  variant="ghost"
                  type="button"
                  className="flex size-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text md:hidden"
                  onClick={props.onClose}
                  title={t("dashboard.close_settings")}
                  aria-label={t("dashboard.close_settings")}
                >
                  <X size={18} />
                </Button>
              </div>
            </header>

            <div className="flex min-h-0 flex-1 flex-col">
              <SettingsPage {...props}>{props.children}</SettingsPage>

              {props.modalSlot}
            </div>

            {props.footer}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

function SettingsSectionMenu(props: Pick<SettingsPageFrameProps, "activeTab" | "developerMode" | "onSelectTab">) {
  const sections: Array<{ label: string | null; tabs: SettingsTab[] }> = [
    { label: null, tabs: ["general"] },
    { label: t("settings.group_workspace"), tabs: getWorkspaceSettingsTabs() },
    { label: t("settings.group_global"), tabs: getGlobalSettingsTabs(props.developerMode) },
    { label: t("settings.group_cloud"), tabs: CLOUD_SETTINGS_TABS },
  ];
  const ActiveIcon = getSettingsTabIcon(props.activeTab);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button variant="outline" size="sm" className="min-w-0 max-w-46 justify-start gap-2">
            <ActiveIcon className="size-4 shrink-0" />
            <span className="truncate">{getSettingsTabLabel(props.activeTab)}</span>
            <ChevronDown className="ml-auto size-4 shrink-0" />
          </Button>
        )}
      />
      <DropdownMenuContent className="w-64">
        {sections.map((section, index) => (
          <DropdownMenuGroup key={section.label ?? "root"}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {section.label ? <DropdownMenuLabel>{section.label}</DropdownMenuLabel> : null}
            {section.tabs.map((tab) => {
              const Icon = getSettingsTabIcon(tab);
              return (
                <DropdownMenuItem
                  key={tab}
                  onClick={() => props.onSelectTab(tab)}
                  className={props.activeTab === tab ? "bg-foreground/10 text-accent-foreground" : undefined}
                >
                  <Icon />
                  <span>{getSettingsTabLabel(tab)}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceMenu(props: Pick<SettingsShellProps, "selectedWorkspaceId" | "selectedWorkspaceName" | "workspaces" | "onSelectWorkspace">) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button variant="ghost" size="sm" className="min-w-0 max-w-36 justify-start gap-2 text-dls-secondary">
            <WorkspaceIcon workspaceId={props.selectedWorkspaceId} sizeClass="size-4" />
            <span className="truncate">{props.selectedWorkspaceName}</span>
            <ChevronDown className="ml-auto size-4 shrink-0" />
          </Button>
        )}
      />
      <DropdownMenuContent className="w-56">
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
  );
}
