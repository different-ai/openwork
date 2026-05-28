/** @jsxImportSource react */
import { useCallback, useEffect, useRef } from "react";

import {
  DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  DEFAULT_WORKSPACE_RIGHT_SIDEBAR_COLLAPSED_WIDTH,
  DEFAULT_WORKSPACE_RIGHT_SIDEBAR_EXPANDED_WIDTH,
  MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  MAX_WORKSPACE_RIGHT_SIDEBAR_WIDTH,
  MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  MIN_WORKSPACE_RIGHT_SIDEBAR_WIDTH,
  useUiStateStore,
} from "./ui-state-store";

type WorkspaceShellLayoutOptions = {
  defaultLeftWidth?: number;
  minLeftWidth?: number;
  maxLeftWidth?: number;
  collapsedRightWidth?: number;
  expandedRightWidth: number;
  minRightWidth?: number;
  maxRightWidth?: number;
};

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function useWorkspaceShellLayout(options: WorkspaceShellLayoutOptions) {
  const minLeftWidth = Math.max(180, options.minLeftWidth ?? MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH);
  const maxLeftWidth = Math.max(minLeftWidth, options.maxLeftWidth ?? MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH);
  const defaultLeftWidth = clampNumber(
    options.defaultLeftWidth ?? DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
    minLeftWidth,
    maxLeftWidth,
  );
  const collapsedRightWidth = Math.max(
    56,
    options.collapsedRightWidth ?? DEFAULT_WORKSPACE_RIGHT_SIDEBAR_COLLAPSED_WIDTH,
  );
  const expandedRightWidth = Math.max(collapsedRightWidth, options.expandedRightWidth);
  const minRightWidth = Math.max(collapsedRightWidth, options.minRightWidth ?? MIN_WORKSPACE_RIGHT_SIDEBAR_WIDTH);
  const maxRightWidth = Math.max(minRightWidth, options.maxRightWidth ?? MAX_WORKSPACE_RIGHT_SIDEBAR_WIDTH);
  const defaultRightWidth = clampNumber(
    expandedRightWidth || DEFAULT_WORKSPACE_RIGHT_SIDEBAR_EXPANDED_WIDTH,
    minRightWidth,
    maxRightWidth,
  );

  const leftSidebarWidth = useUiStateStore((state) =>
    clampNumber(state.workspaceLeftSidebarWidth || defaultLeftWidth, minLeftWidth, maxLeftWidth),
  );
  const leftSidebarResizing = useUiStateStore((state) => state.workspaceLeftSidebarResizing);
  const rightSidebarExpanded = useUiStateStore((state) => state.workspaceRightSidebarExpanded);
  const rightSidebarExpandedWidth = useUiStateStore((state) =>
    clampNumber(state.workspaceRightSidebarExpandedWidth || defaultRightWidth, minRightWidth, maxRightWidth),
  );
  const setLeftSidebarWidth = useUiStateStore((state) => state.setWorkspaceLeftSidebarWidth);
  const setLeftSidebarResizing = useUiStateStore((state) => state.setWorkspaceLeftSidebarResizing);
  const setRightSidebarExpanded = useUiStateStore((state) => state.setWorkspaceRightSidebarExpanded);
  const setRightSidebarExpandedWidth = useUiStateStore((state) => state.setWorkspaceRightSidebarExpandedWidth);
  const toggleRightSidebar = useUiStateStore((state) => state.toggleWorkspaceRightSidebar);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const stopLeftSidebarResize = useCallback(() => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    setLeftSidebarResizing(false);
    if (typeof document === "undefined") return;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, [setLeftSidebarResizing]);

  const startLeftSidebarResize = useCallback(
    (event: PointerEvent | React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || typeof window === "undefined") return;

      stopLeftSidebarResize();
      setLeftSidebarResizing(true);
      const initialX = event.clientX;
      const initialWidth = leftSidebarWidth;

      const handleMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - initialX;
        setLeftSidebarWidth(clampNumber(initialWidth + delta, minLeftWidth, maxLeftWidth));
      };

      const handleStop = () => {
        stopLeftSidebarResize();
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleStop);
      window.addEventListener("pointercancel", handleStop);
      dragCleanupRef.current = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleStop);
        window.removeEventListener("pointercancel", handleStop);
      };

      if (typeof document !== "undefined") {
        Object.assign(document.body.style, {
          cursor: "col-resize",
          userSelect: "none",
        });
      }

      event.preventDefault();
    },
    [leftSidebarWidth, maxLeftWidth, minLeftWidth, setLeftSidebarResizing, setLeftSidebarWidth, stopLeftSidebarResize],
  );

  useEffect(() => {
    return () => {
      stopLeftSidebarResize();
    };
  }, [stopLeftSidebarResize]);

  return {
    leftSidebarWidth,
    leftSidebarResizing,
    rightSidebarExpanded,
    rightSidebarExpandedWidth,
    rightSidebarWidth: rightSidebarExpanded ? rightSidebarExpandedWidth : collapsedRightWidth,
    setRightSidebarExpanded,
    setRightSidebarExpandedWidth,
    startLeftSidebarResize,
    toggleRightSidebar,
  };
}
