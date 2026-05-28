/** @jsxImportSource react */
import * as React from "react";
import ReactDOM from "react-dom/client";

import { bootstrapTheme } from "../app/theme";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut } from "./context-menu";
import "../app/index.css";

type ContextMenuItem = {
  id: string;
  label: string;
  iconName?: "copy" | "external" | "close";
  disabled?: boolean;
  shortcut?: string;
  separatorBefore?: boolean;
};

type ContextMenuRequest = {
  id: string;
  source: "tab" | "page" | "sidebar";
  items: ContextMenuItem[];
};

type MenuOverlayApi = {
  ready: () => void;
  onShow: (callback: (request: ContextMenuRequest) => void) => () => void;
  choose: (requestId: string, itemId: string) => void;
  close: (requestId?: string) => void;
};

const MENU_ITEM_SELECTOR = "button[data-slot='context-menu-item']:not(:disabled)";

declare global {
  interface Window {
    __OPENWORK_MENU_OVERLAY__?: MenuOverlayApi;
  }
}

function ContextMenuSurface({
  request,
  onChoose,
  onClose,
}: {
  request: ContextMenuRequest;
  onChoose: (itemId: string) => void;
  onClose: () => void;
}) {
  React.useEffect(() => {
    // document.querySelector<HTMLButtonElement>(MENU_ITEM_SELECTOR)?.focus();
  }, [request.id]);

  return (
    <div
      className="dark h-dvh overflow-hidden bg-transparent text-popover-foreground p-px"
      onKeyDown={(event) => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR));
        const currentIndex = Math.max(buttons.indexOf(document.activeElement as HTMLButtonElement), 0);
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          buttons[(currentIndex + 1) % buttons.length]?.focus();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          buttons[(currentIndex - 1 + buttons.length) % buttons.length]?.focus();
        }
      }}
    >
      <ContextMenuContent
        role="menu"
        aria-label={`${request.source} context menu`}
        className="w-full"
      >
        {request.items.map((item) => {
          return (
            <React.Fragment key={item.id}>
              {item.separatorBefore ? <ContextMenuSeparator /> : null}
              <ContextMenuItem
                role="menuitem"
                disabled={item.disabled}
                onClick={() => onChoose(item.id)}
              >
                <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                {item.shortcut ? <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut> : null}
              </ContextMenuItem>
            </React.Fragment>
          );
        })}
      </ContextMenuContent>
    </div>
  );
}

function OverlayApp() {
  const [request, setRequest] = React.useState<ContextMenuRequest | null>(null);
  const api = window.__OPENWORK_MENU_OVERLAY__;

  React.useEffect(() => {
    if (!api) return;
    const unsubscribe = api.onShow((nextRequest) => {
      setRequest(nextRequest);
    });
    api.ready();
    return unsubscribe;
  }, [api]);

  if (!api || !request) return null;

  return (
    <ContextMenuSurface
      request={request}
      onChoose={(itemId) => api.choose(request.id, itemId)}
      onClose={() => api.close(request.id)}
    />
  );
}

bootstrapTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Overlay root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>,
);
