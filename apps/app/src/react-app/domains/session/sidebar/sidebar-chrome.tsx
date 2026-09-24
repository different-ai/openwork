/** @jsxImportSource react */
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMacPlatform } from "@/app/utils";
import { t } from "@/i18n";
import { NotificationBell } from "../../../shell/notification-center";
import { useShellConfig } from "../../../shell/shell-config";

export type ConversationHistoryControls = {
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigate: (direction: "back" | "forward") => void;
};

function SidebarToggle({ surface }: { surface: "sidebar" | "main" }) {
  const { open, openMobile, isMobile } = useSidebar();
  return (
    <SidebarTrigger
      data-sidebar-toggle={surface}
      data-testid={`${surface}-sidebar-toggle`}
      className="size-8! rounded-lg text-muted-foreground transition-colors hover:bg-muted titlebar-no-drag"
      aria-expanded={isMobile ? openMobile : open}
      aria-keyshortcuts={isMacPlatform() ? "Meta+B" : "Control+B"}
      title={`Toggle sidebar (${isMacPlatform() ? "⌘B" : "Ctrl+B"})`}
      onClick={() => {
        if (isMobile) return;
        // The clicked control moves with the sidebar. Keep keyboard focus on
        // its visible counterpart rather than inside the now-inert panel.
        requestAnimationFrame(() => {
          document.querySelector<HTMLButtonElement>(`[data-sidebar-toggle="${open ? "main" : "sidebar"}"]`)?.focus({ preventScroll: true });
        });
      }}
    />
  );
}

export function SidebarTitlebar({ history }: { history?: ConversationHistoryControls }) {
  return (
    <div data-sidebar-titlebar className="window-titlebar mac-window-controls-inset flex shrink-0 items-center gap-1 px-2 titlebar-drag">
      <SidebarToggle surface="sidebar" />
      {history ? (
        <div className="ml-auto flex gap-0.5 titlebar-no-drag" role="group" aria-label="Conversation history controls">
          <Button variant="ghost" size="icon-sm" className="rounded-lg text-muted-foreground transition-colors hover:bg-muted"
            aria-label="Back in conversation history" title="Back in conversation history"
            data-conversation-history-control="back" disabled={!history.canGoBack} onClick={() => history.onNavigate("back")}>
            <ArrowLeft strokeWidth={1.5} />
          </Button>
          <Button variant="ghost" size="icon-sm" className="rounded-lg text-muted-foreground transition-colors hover:bg-muted"
            aria-label="Forward in conversation history" title="Forward in conversation history"
            data-conversation-history-control="forward" disabled={!history.canGoForward} onClick={() => history.onNavigate("forward")}>
            <ArrowRight strokeWidth={1.5} />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** One search/bell pair, in the brand row or the main titlebar when hidden. */
export function SidebarActions({ onOpenSessionSearch }: { onOpenSessionSearch?: () => void }) {
  return (
    <div data-sidebar-actions className="flex shrink-0 items-center gap-0.5 titlebar-no-drag">
      {onOpenSessionSearch ? (
        <Tooltip>
          <TooltipTrigger render={
            <Button variant="ghost" size="icon-sm" className="rounded-lg text-muted-foreground transition-colors hover:bg-muted"
              aria-label={t("workspace_list.search_sessions")}
              aria-keyshortcuts={isMacPlatform() ? "Meta+Shift+F" : "Control+Shift+F"}
              onClick={onOpenSessionSearch}>
              <Search strokeWidth={1.5} />
            </Button>
          } />
          <TooltipContent>{t("workspace_list.search_sessions")} ({isMacPlatform() ? "⌘⇧F" : "Ctrl+Shift+F"})</TooltipContent>
        </Tooltip>
      ) : null}
      <NotificationBell align="start" />
    </div>
  );
}

export function MainSidebarControls({ onOpenSessionSearch }: { onOpenSessionSearch?: () => void }) {
  const { open, isMobile, openMobile } = useSidebar();
  const { config } = useShellConfig();
  if (open && !isMobile) return null;
  return (
    <div className="flex shrink-0 items-center gap-1 titlebar-no-drag">
      <SidebarToggle surface="main" />
      {isMobile && openMobile ? (
        <div aria-hidden="true" className="flex gap-0.5">
          {onOpenSessionSearch ? <span className="size-8" /> : null}
          {config.notifications ? <span className="size-8" /> : null}
        </div>
      ) : <SidebarActions onOpenSessionSearch={onOpenSessionSearch} />}
    </div>
  );
}
