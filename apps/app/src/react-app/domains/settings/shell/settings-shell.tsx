/** @jsxImportSource react */
import type * as React from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { t } from "../../../../i18n";
import { SettingsPage, SettingsSidebar, getSettingsTabLabel } from "./settings-page";

type SettingsPageChromeProps = Omit<React.ComponentProps<typeof SettingsPage>, "children">;

export type SettingsShellProps = SettingsPageChromeProps & {
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
  error?: string | null;
  errorSlot?: React.ReactNode;
  modalSlot?: React.ReactNode;
  footer?: React.ReactNode;
};

export function SettingsShell(props: SettingsShellProps) {
  const title = getSettingsTabLabel(props.activeTab);

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
            <header className="shrink-0 flex h-10 items-center justify-between border-b border-dls-border px-4 md:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <SidebarTrigger className="md:hidden" />
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
              <div className="flex items-center text-gray-10 md:hidden">
                <Button
                  variant="ghost"
                  type="button"
                  className="flex h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
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

              {props.error ? (
                <div className="mx-auto max-w-5xl px-6 pb-24 md:px-10 md:pb-10">
                  <div className="flex flex-col gap-y-3 rounded-2xl border border-red-7/20 bg-red-1/40 px-5 py-4 text-sm text-red-12">
                    <div>{props.error}</div>
                    {props.errorSlot}
                  </div>
                </div>
              ) : null}

              {props.modalSlot}
            </div>

            {props.footer}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
