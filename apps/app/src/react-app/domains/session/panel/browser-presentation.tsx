/** @jsxImportSource react */
import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Globe, Minimize2, PanelRight, PictureInPicture2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { BrowserFloatingCardPortal } from "./browser-floating-card";
import { useSessionFloatingSlot } from "./floating-slot";
import { BrowserPanelContent } from "./side-panel";
import type { BrowserPresentationController } from "./use-browser-presentation";

type BrowserFullscreenDialogProps = {
  sessionId: string;
  controller: BrowserPresentationController;
};

/**
 * The browser over the whole window. A Base UI dialog rather than a native
 * `<dialog>`: the top layer would hide the toolbar's portaled tooltips,
 * popovers and menus behind it. Escape, Exit and the close button all leave
 * to the person's last floating or side choice.
 */
function BrowserFullscreenDialog({ sessionId, controller }: BrowserFullscreenDialogProps) {
  const exitRef = React.useRef<HTMLButtonElement>(null);
  const { tab, status, needsYou, present, exitFullscreen, fullscreenReturnFocus } = controller;
  const open = controller.mode === "fullscreen" && tab !== null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) exitFullscreen(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          data-testid="browser-fullscreen-dialog"
          data-browser-fullscreen-dialog=""
          initialFocus={exitRef}
          finalFocus={() => {
            const previous = fullscreenReturnFocus.current;
            fullscreenReturnFocus.current = null;
            return previous?.isConnected && previous.getClientRects().length > 0 ? previous : true;
          }}
          className="fixed inset-0 z-50 flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground outline-none data-closed:hidden"
        >
          <TooltipProvider delay={1000}>
            <header className="window-titlebar flex shrink-0 items-center gap-2 border-b border-border px-3 electron:titlebar-drag mac:mac-window-controls-inset windows:pr-[max(0.75rem,calc(100vw_-_env(titlebar-area-x,0px)_-_env(titlebar-area-width,100vw)))] linux:pr-[max(0.75rem,calc(100vw_-_env(titlebar-area-x,0px)_-_env(titlebar-area-width,100vw)))]">
              <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <DialogPrimitive.Title className="text-sm font-medium">Browser</DialogPrimitive.Title>
              <span role="status" className={cn("min-w-0 flex-1 truncate text-xs", needsYou ? "text-amber-11" : "text-muted-foreground")}>
                {status}
              </span>
              <div className="flex shrink-0 items-center gap-1 titlebar-no-drag">
                <Tooltip>
                  <TooltipTrigger
                    render={(
                      <Button variant="ghost" size="icon-sm" aria-label="Open beside chat" data-testid="browser-mode-side" onClick={() => present("side")}>
                        <PanelRight />
                      </Button>
                    )}
                  />
                  <TooltipContent>Open beside chat</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={(
                      <Button variant="ghost" size="icon-sm" aria-label="Float browser" data-testid="browser-mode-float" onClick={() => present("floating")}>
                        <PictureInPicture2 />
                      </Button>
                    )}
                  />
                  <TooltipContent>Float over chat</TooltipContent>
                </Tooltip>
                <DialogPrimitive.Close
                  ref={exitRef}
                  render={<Button variant="outline" size="sm" data-testid="browser-fullscreen-exit" />}
                >
                  <Minimize2 />
                  Exit full screen
                  <kbd className="ml-1 font-sans text-[11px] text-muted-foreground">esc</kbd>
                </DialogPrimitive.Close>
              </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col">
              {tab ? (
                <BrowserPanelContent
                  sessionId={sessionId}
                  tab={tab}
                  onClose={exitFullscreen}
                  presentation={{ mode: "fullscreen", onPresent: present }}
                />
              ) : null}
            </div>
          </TooltipProvider>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The floating card and the full-screen view, for the conversation on screen. */
export function BrowserPresentationSurfaces({ sessionId, controller }: BrowserFullscreenDialogProps) {
  const slot = useSessionFloatingSlot();
  if (!controller.enabled) return null;
  const { mode, tab, presentation, present, setSnap } = controller;
  return (
    <>
      {mode === "floating" && tab && slot ? (
        <BrowserFloatingCardPortal
          slot={slot}
          tab={tab}
          snap={presentation.snap}
          onSnap={setSnap}
          onOpenSide={() => present("side")}
          onFullscreen={() => present("fullscreen")}
          onHide={() => present("hidden")}
        />
      ) : null}
      <BrowserFullscreenDialog sessionId={sessionId} controller={controller} />
    </>
  );
}

/** The session header's browser toggle: hidden ↔ the last floating or side choice. */
export function BrowserHeaderButton({ controller }: { controller: BrowserPresentationController }) {
  const shown = controller.mode !== "hidden";
  const label = `Browser · ${controller.status}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "relative hidden rounded-xl text-gray-10 transition-colors hover:bg-muted hover:text-foreground lg:inline-flex",
              shown && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
            )}
            aria-label={label}
            aria-pressed={shown}
            data-testid="session-browser-toggle"
            data-browser-mode={controller.mode}
            onClick={controller.toggle}
          >
            <Globe size={16} />
            {controller.needsYou ? (
              <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-amber-9" data-testid="session-browser-needs-you" aria-hidden="true" />
            ) : null}
          </Button>
        )}
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
