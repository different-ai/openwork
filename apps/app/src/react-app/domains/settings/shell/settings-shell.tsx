/** @jsxImportSource react */
import type { ComponentProps, PointerEventHandler, ReactNode } from "react";
import { ChevronRight, X } from "lucide-react";

import { t } from "../../../../i18n";
import { WORKSPACE_LEFT_SIDEBAR_WIDTH_TRANSITION } from "../../../shell/workspace-shell-layout";
import { SettingsPage, getSettingsTabLabel } from "./settings-page";
import { WorkspaceSessionList } from "../../session/sidebar/workspace-session-list";

type SettingsPageChromeProps = Omit<ComponentProps<typeof SettingsPage>, "children">;

export type SettingsShellProps = SettingsPageChromeProps & {
  selectedWorkspaceName: string;
  headerStatus?: string;
  busyHint?: string | null;
  workspaceSessionListProps: ComponentProps<typeof WorkspaceSessionList>;
  onClose: () => void;
  sidebarCollapsed?: boolean;
  onToggleSidebarCollapsed?: () => void;
  /** When true, width transition is disabled (user is dragging the resize handle). */
  sidebarResizeActive?: boolean;
  sidebarTopSlot?: ReactNode;
  headerLeadingSlot?: ReactNode;
  sidebarWidth?: number;
  onSidebarResizeStart?: PointerEventHandler<HTMLDivElement>;
  children: ReactNode;
  error?: string | null;
  errorSlot?: ReactNode;
  modalSlot?: ReactNode;
  footer?: ReactNode;
};

export function SettingsShell(props: SettingsShellProps) {
  const title = getSettingsTabLabel(props.activeTab);
  const sidebarCollapsed = Boolean(props.sidebarCollapsed);
  const sidebarWidthPx = props.sidebarWidth;
  const sidebarResizeActive = Boolean(props.sidebarResizeActive);

  return (
    <div className="h-[100dvh] min-h-screen w-full overflow-hidden bg-[var(--dls-app-bg)] p-3 text-gray-12 md:p-4">
      <div className="flex h-full w-full gap-3 md:gap-4">
        <aside
          className={`relative hidden shrink-0 overflow-hidden rounded-[24px] border border-dls-border bg-dls-sidebar lg:grid lg:grid-cols-1 lg:grid-rows-1 ${
            sidebarResizeActive ? "transition-none" : WORKSPACE_LEFT_SIDEBAR_WIDTH_TRANSITION
          }`}
          style={
            sidebarWidthPx != null
              ? { width: `${sidebarWidthPx}px`, minWidth: `${sidebarWidthPx}px` }
              : undefined
          }
        >
          <div
            className={`relative col-start-1 row-start-1 flex h-full min-h-0 flex-col p-2.5 transition-[opacity,transform] duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none motion-reduce:opacity-100 ${
              sidebarCollapsed
                ? "pointer-events-none z-0 -translate-x-2 opacity-0"
                : "z-10 translate-x-0 opacity-100"
            }`}
            aria-hidden={sidebarCollapsed}
          >
            {props.sidebarTopSlot ? <div className="shrink-0">{props.sidebarTopSlot}</div> : null}
            <div className="flex min-h-0 flex-1">
              <WorkspaceSessionList {...props.workspaceSessionListProps} />
            </div>
            {props.onSidebarResizeStart ? (
              <div
                className="absolute right-0 top-3 hidden h-[calc(100%-24px)] w-2 translate-x-1/2 cursor-col-resize rounded-full bg-transparent transition-colors hover:bg-gray-6/40 md:block"
                onPointerDown={props.onSidebarResizeStart}
                title={t("session.resize_workspace_column")}
                aria-label={t("session.resize_workspace_column")}
              />
            ) : null}
          </div>

          <div
            className={`col-start-1 row-start-1 flex min-h-0 flex-col items-center justify-start px-1 pt-3 transition-[opacity,transform] duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none motion-reduce:opacity-100 lg:justify-center lg:pt-0 ${
              sidebarCollapsed ? "z-10 translate-x-0 opacity-100" : "pointer-events-none z-0 translate-x-2 opacity-0"
            }`}
            aria-hidden={!sidebarCollapsed}
          >
            <button
              type="button"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-10 transition-colors duration-200 hover:bg-gray-2/80 hover:text-dls-text active:scale-95 motion-reduce:active:scale-100"
              onClick={() => props.onToggleSidebarCollapsed?.()}
              title={t("workspace_sidebar.expand_sidebar")}
              aria-label={t("workspace_sidebar.expand_sidebar")}
            >
              <ChevronRight size={18} className="transition-transform duration-200 ease-out" />
            </button>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
          <div className="flex-1 overflow-y-auto">
            <header className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-dls-border bg-dls-surface px-4 md:px-6">
              <div className="flex min-w-0 items-center gap-3">
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
              <div className="flex items-center text-gray-10">
                <button
                  type="button"
                  className="flex h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
                  onClick={props.onClose}
                  title={t("dashboard.close_settings")}
                  aria-label={t("dashboard.close_settings")}
                >
                  <X size={18} />
                </button>
              </div>
            </header>

            <div className="w-full space-y-10 p-6 md:p-10">
              <SettingsPage {...props}>{props.children}</SettingsPage>
            </div>

            {props.error ? (
              <div className="mx-auto max-w-5xl px-6 pb-24 md:px-10 md:pb-10">
                <div className="space-y-3 rounded-2xl border border-red-7/20 bg-red-1/40 px-5 py-4 text-sm text-red-12">
                  <div>{props.error}</div>
                  {props.errorSlot}
                </div>
              </div>
            ) : null}

            {props.modalSlot}
          </div>

          {props.footer}
        </main>
      </div>
    </div>
  );
}
