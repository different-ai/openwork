/** @jsxImportSource react */
import * as React from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";

import { PanelTab, PanelTabClose } from "@/components/panel-tabs";
import { Button } from "@/components/ui/button";
import { PortalContainerContext } from "@/components/ui/portal-container";
import { toast } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import type { BrowserPresentationMode } from "./browser-presentation-store";
import type { BrowserPanelTab } from "./panel-tab-store";
import { BrowserPanelContent, BrowserTabIcon } from "./side-panel";
import { useSidePanelTabs } from "./use-side-panel-tabs";
import { getElectronBrowser } from "./utils";

type BrowserWindowProps = {
  /** The container inside the popped-out window. */
  slot: HTMLElement;
  sessionId: string;
  /** The page on screen, one of `tabs`. */
  tab: BrowserPanelTab;
  tabs: BrowserPanelTab[];
  onPresent: (mode: BrowserPresentationMode) => void;
};

/**
 * The browser in its own OS window: the conversation's tabs in the title bar,
 * the same toolbar as beside the chat, and the live page below them. Closing
 * the window puts the page back beside the chat.
 */
export function BrowserWindow({ slot, sessionId, tab, tabs, onPresent }: BrowserWindowProps) {
  const { createTab, closeTab } = useSidePanelTabs(sessionId);

  // Straight to the host: a selection in the panel store would also move an
  // artifact open beside the chat aside, and pull the page back there.
  const selectTab = (tabId: string) => {
    void getElectronBrowser()?.selectTab?.(tabId).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  };

  return createPortal(
    <PortalContainerContext.Provider value={slot}>
      <TooltipProvider delay={1000}>
        <div data-testid="browser-window" className="flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground">
          <header className="window-titlebar flex shrink-0 items-center gap-1 border-b border-border/60 pr-2 electron:titlebar-drag mac:mac-window-controls-inset windows:pr-[max(0.5rem,calc(100vw_-_env(titlebar-area-x,0px)_-_env(titlebar-area-width,100vw)))] linux:pr-[max(0.5rem,calc(100vw_-_env(titlebar-area-x,0px)_-_env(titlebar-area-width,100vw)))]">
            <div role="tablist" aria-label="Browser tabs" className="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto">
              {tabs.map((entry) => (
                <div key={entry.id} className="group relative w-44 min-w-20 shrink titlebar-no-drag">
                  <PanelTab
                    role="tab"
                    aria-selected={entry.id === tab.id}
                    active={entry.id === tab.id}
                    title={entry.label}
                    aria-label={`Select tab: ${entry.label}`}
                    data-testid="browser-window-tab"
                    onClick={() => selectTab(entry.id)}
                    onAuxClick={(event) => {
                      if (event.button === 1) closeTab(entry);
                    }}
                  >
                    <BrowserTabIcon tab={entry} />
                    <span className="min-w-0 flex-1 truncate text-left">{entry.label}</span>
                  </PanelTab>
                  <PanelTabClose active={entry.id === tab.id} label={entry.label} onClose={() => closeTab(entry)} />
                </div>
              ))}
            </div>
            <Button variant="ghost" size="icon-sm" className="titlebar-no-drag" title="Open new tab" aria-label="Open new tab" data-testid="browser-window-new-tab" onClick={() => void createTab()}>
              <Plus />
            </Button>
          </header>
          <BrowserPanelContent
            sessionId={sessionId}
            tab={tab}
            onClose={() => onPresent("side")}
            presentation={{ mode: "window", onPresent }}
          />
        </div>
      </TooltipProvider>
    </PortalContainerContext.Provider>,
    slot,
  );
}
