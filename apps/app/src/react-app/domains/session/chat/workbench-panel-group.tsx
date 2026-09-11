import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useGroupRef, type Layout } from "react-resizable-panels";
import { ResizablePanelGroup } from "@/components/ui/resizable";
import { useWorkbenchUiState } from "./workbench-ui-state";

export const PRIMARY_PANEL_ID = "workbench-primary";
export const SECONDARY_PANEL_ID = "workbench-secondary";

export function WorkbenchPanelGroup({ owner, primaryVisible, secondaryVisible, children }: {
  owner: string | null;
  primaryVisible: boolean;
  secondaryVisible: boolean;
  children: ReactNode;
}) {
  const groupRef = useGroupRef();
  const elementRef = useRef<HTMLDivElement>(null);
  const coordinate = JSON.stringify([owner, primaryVisible, secondaryVisible]);
  const restoration = useRef<{ coordinate: string; layout: Layout; applied: boolean } | null>(null);
  if (restoration.current?.coordinate !== coordinate) {
    const ratio = owner ? useWorkbenchUiState.getState().splitRatios.get(owner) ?? 50 : 50;
    restoration.current = {
      coordinate,
      applied: false,
      layout: {
        ...(primaryVisible ? { [PRIMARY_PANEL_ID]: secondaryVisible ? ratio : 100 } : {}),
        ...(secondaryVisible ? { [SECONDARY_PANEL_ID]: primaryVisible ? 100 - ratio : 100 } : {}),
      },
    };
  }
  const restore = (layout: Layout) => {
    const pending = restoration.current;
    if (!pending || pending.applied || !groupRef.current) return false;
    // Panel registration is a separate layout pass. Never apply a two-panel
    // layout to the one-panel registry (or persist that transitional layout).
    const ids = Object.keys(pending.layout);
    if (ids.length !== Object.keys(layout).length || ids.some((id) => !(id in layout))) return true;
    pending.applied = true;
    groupRef.current.setLayout(pending.layout);
    return true;
  };
  useLayoutEffect(() => {
    if (groupRef.current) restore(groupRef.current.getLayout());
  }, [coordinate]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    const view = element?.ownerDocument.defaultView;
    if (!element || !view) return;
    let focused: HTMLElement | null = null;
    const down = () => {
      const active = element.ownerDocument.activeElement;
      focused = active instanceof HTMLElement && element.contains(active) && !active.hasAttribute("data-separator")
        ? active : null;
    };
    const up = () => {
      // The library focuses separators on pointer resize. Return only that
      // incidental focus; keyboard divider navigation and deliberate focus stay.
      const active = element.ownerDocument.activeElement;
      if (focused?.isConnected && element.contains(focused) && active && element.contains(active)
        && active.hasAttribute("data-separator")) {
        focused.focus({ preventScroll: true });
      }
      focused = null;
    };
    view.addEventListener("pointerdown", down, true);
    view.addEventListener("pointerup", up);
    view.addEventListener("pointercancel", up);
    return () => {
      view.removeEventListener("pointerdown", down, true);
      view.removeEventListener("pointerup", up);
      view.removeEventListener("pointercancel", up);
    };
  }, []);

  return <ResizablePanelGroup
    groupRef={groupRef}
    elementRef={elementRef}
    defaultLayout={restoration.current.layout}
    orientation="horizontal"
    className="min-h-0 flex-1"
    onLayoutChange={(layout) => {
      if (restore(layout)) return;
      if (owner && primaryVisible && secondaryVisible
        && Object.keys(layout).length === 2 && SECONDARY_PANEL_ID in layout) {
        useWorkbenchUiState.getState().setSplitRatio(owner, layout[PRIMARY_PANEL_ID]);
      }
    }}
  >{children}</ResizablePanelGroup>;
}
