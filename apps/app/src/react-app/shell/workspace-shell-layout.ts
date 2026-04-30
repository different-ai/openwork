/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const LEFT_SIDEBAR_WIDTH_KEY = "openwork.workspace-shell.left-width.v1";
const LEFT_SIDEBAR_COLLAPSED_KEY = "openwork.workspace-shell.left-collapsed.v1";
const RIGHT_SIDEBAR_EXPANDED_KEY = "openwork.workspace-shell.right-expanded.v3";

export const DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH = 260;
export const MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH = 220;
export const MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH = 420;
export const COLLAPSED_WORKSPACE_LEFT_SIDEBAR_WIDTH = 48;
export const DEFAULT_WORKSPACE_RIGHT_SIDEBAR_COLLAPSED_WIDTH = 72;

/** Tailwind classes: width eases on collapse/expand; omitted while drag-resizing. */
export const WORKSPACE_LEFT_SIDEBAR_WIDTH_TRANSITION =
  "transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none";

type WorkspaceShellLayoutOptions = {
  defaultLeftWidth?: number;
  minLeftWidth?: number;
  maxLeftWidth?: number;
  collapsedRightWidth?: number;
  expandedRightWidth: number;
};

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore persistence failures
  }
}

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

  const readLeftSidebarWidth = useCallback(() => {
    const raw = readStorage(LEFT_SIDEBAR_WIDTH_KEY);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return defaultLeftWidth;
    return clampNumber(parsed, minLeftWidth, maxLeftWidth);
  }, [defaultLeftWidth, maxLeftWidth, minLeftWidth]);

  const readRightSidebarExpanded = useCallback(() => {
    const raw = readStorage(RIGHT_SIDEBAR_EXPANDED_KEY);
    if (raw == null) return false;
    return raw === "1";
  }, []);

  const readLeftSidebarCollapsed = useCallback(() => {
    const raw = readStorage(LEFT_SIDEBAR_COLLAPSED_KEY);
    if (raw == null) return false;
    return raw === "1";
  }, []);

  const [leftSidebarWidth, setLeftSidebarWidth] = useState(readLeftSidebarWidth);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(readLeftSidebarCollapsed);
  const [rightSidebarExpanded, setRightSidebarExpanded] = useState(readRightSidebarExpanded);
  const [leftSidebarResizeActive, setLeftSidebarResizeActive] = useState(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    writeStorage(
      LEFT_SIDEBAR_WIDTH_KEY,
      String(clampNumber(leftSidebarWidth, minLeftWidth, maxLeftWidth)),
    );
  }, [leftSidebarWidth, maxLeftWidth, minLeftWidth]);

  useEffect(() => {
    writeStorage(RIGHT_SIDEBAR_EXPANDED_KEY, rightSidebarExpanded ? "1" : "0");
  }, [rightSidebarExpanded]);

  useEffect(() => {
    writeStorage(LEFT_SIDEBAR_COLLAPSED_KEY, leftSidebarCollapsed ? "1" : "0");
  }, [leftSidebarCollapsed]);

  const effectiveLeftSidebarWidth = useMemo(
    () => (leftSidebarCollapsed ? COLLAPSED_WORKSPACE_LEFT_SIDEBAR_WIDTH : leftSidebarWidth),
    [leftSidebarCollapsed, leftSidebarWidth],
  );

  const rightSidebarWidth = useMemo(
    () => (rightSidebarExpanded ? expandedRightWidth : collapsedRightWidth),
    [collapsedRightWidth, expandedRightWidth, rightSidebarExpanded],
  );

  const stopLeftSidebarResize = useCallback(() => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    setLeftSidebarResizeActive(false);
    if (typeof document === "undefined") return;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, []);

  const startLeftSidebarResize = useCallback(
    (event: PointerEvent | React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || typeof window === "undefined") return;

      stopLeftSidebarResize();
      setLeftSidebarResizeActive(true);
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
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }

      event.preventDefault();
    },
    [leftSidebarWidth, maxLeftWidth, minLeftWidth, stopLeftSidebarResize],
  );

  const toggleRightSidebar = useCallback(() => {
    setRightSidebarExpanded((current) => !current);
  }, []);

  const toggleLeftSidebar = useCallback(() => {
    setLeftSidebarCollapsed((current) => !current);
  }, []);

  useEffect(() => {
    return () => {
      stopLeftSidebarResize();
    };
  }, [stopLeftSidebarResize]);

  return {
    leftSidebarWidth,
    effectiveLeftSidebarWidth,
    leftSidebarCollapsed,
    leftSidebarResizeActive,
    rightSidebarExpanded,
    rightSidebarWidth,
    setLeftSidebarCollapsed,
    setRightSidebarExpanded,
    startLeftSidebarResize,
    toggleLeftSidebar,
    toggleRightSidebar,
  };
}
