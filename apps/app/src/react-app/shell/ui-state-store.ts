import { create } from "zustand";

export const PERSISTED_UI_STATE_KEY = "openwork:ui-state:v1";
const SIDEBAR_COOKIE_NAME = "sidebar_state";
const LEGACY_WORKSPACE_LEFT_SIDEBAR_WIDTH_KEY = "openwork.workspace-shell.left-width.v1";
const LEGACY_WORKSPACE_RIGHT_SIDEBAR_EXPANDED_KEY = "openwork.workspace-shell.right-expanded.v3";
const LEGACY_WORKSPACE_RIGHT_SIDEBAR_WIDTH_KEY = "openwork.workspace-shell.right-width.v1";

export const DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH = 260;
export const MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH = 220;
export const MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH = 420;
export const DEFAULT_WORKSPACE_RIGHT_SIDEBAR_COLLAPSED_WIDTH = 72;
export const DEFAULT_WORKSPACE_RIGHT_SIDEBAR_EXPANDED_WIDTH = 520;
export const MIN_WORKSPACE_RIGHT_SIDEBAR_WIDTH = 320;
export const MAX_WORKSPACE_RIGHT_SIDEBAR_WIDTH = 960;

export const SIDE_PANEL_ITEMS = ["panel", "extensions", "voice"] as const;
export type SidePanelItem = (typeof SIDE_PANEL_ITEMS)[number];
export type SidePanelState = Record<string, SidePanelItem | null>;

const LEGACY_UNIFIED_PANEL_ITEMS = ["browser", "artifacts"] as const;
type LegacyUnifiedPanelItem = (typeof LEGACY_UNIFIED_PANEL_ITEMS)[number];

function normalizeSidePanelItem(value: unknown): SidePanelItem | null {
  if (value === null) {
    return null;
  }

  if (isSidePanelItem(value)) {
    return value;
  }

  if (LEGACY_UNIFIED_PANEL_ITEMS.includes(value as LegacyUnifiedPanelItem)) {
    return "panel";
  }

  return null;
}

export type PersistedUiState = {
  sidePanelState?: SidePanelState;
  applicationMenuVisible?: boolean;
  workspaceLeftSidebarWidth?: number;
  workspaceRightSidebarExpanded?: boolean;
  workspaceRightSidebarExpandedWidth?: number;
};

export type UiState = {
  sidebarOpen: boolean;
  sidePanelState: SidePanelState;
  applicationMenuVisible: boolean;
  workspaceLeftSidebarWidth: number;
  workspaceLeftSidebarResizing: boolean;
  workspaceRightSidebarExpanded: boolean;
  workspaceRightSidebarExpandedWidth: number;
};

const initialState: UiState = {
  sidebarOpen: true,
  sidePanelState: {},
  applicationMenuVisible: false,
  workspaceLeftSidebarWidth: DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  workspaceLeftSidebarResizing: false,
  workspaceRightSidebarExpanded: false,
  workspaceRightSidebarExpandedWidth: DEFAULT_WORKSPACE_RIGHT_SIDEBAR_EXPANDED_WIDTH,
};

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeNumber(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return clampNumber(value, min, max);
}

function readLegacyNumber(key: string, min: number, max: number) {
  if (globalThis.window === undefined) {
    return null;
  }

  const parsed = Number(window.localStorage.getItem(key));
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return clampNumber(parsed, min, max);
}

function readLegacyWorkspaceLayoutState() {
  if (globalThis.window === undefined) {
    return {};
  }

  const rightSidebarExpanded = window.localStorage.getItem(LEGACY_WORKSPACE_RIGHT_SIDEBAR_EXPANDED_KEY);

  return {
    workspaceLeftSidebarWidth: readLegacyNumber(
      LEGACY_WORKSPACE_LEFT_SIDEBAR_WIDTH_KEY,
      MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH,
      MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH,
    ) ?? undefined,
    workspaceRightSidebarExpanded: rightSidebarExpanded == null ? undefined : rightSidebarExpanded === "1",
    workspaceRightSidebarExpandedWidth: readLegacyNumber(
      LEGACY_WORKSPACE_RIGHT_SIDEBAR_WIDTH_KEY,
      MIN_WORKSPACE_RIGHT_SIDEBAR_WIDTH,
      MAX_WORKSPACE_RIGHT_SIDEBAR_WIDTH,
    ) ?? undefined,
  } satisfies Partial<PersistedUiState>;
}

function isSidePanelItem(value: unknown): value is SidePanelItem {
  return SIDE_PANEL_ITEMS.includes(value as SidePanelItem);
}

function normalizeSidePanelState(value: unknown): SidePanelState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return initialState.sidePanelState;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([sessionId, panel]) => {
      if (typeof sessionId !== "string") {
        return [];
      }

      const normalized = normalizeSidePanelItem(panel);
      if (normalized === null && panel !== null) {
        return [];
      }

      return [[sessionId, normalized] as const];
    }),
  );
}

function readSidebarCookieOpen(): boolean | null {
  if (globalThis.window === undefined) {
    return null;
  }

  const prefix = `${SIDEBAR_COOKIE_NAME}=`;
  const cookie = window.document.cookie
    .split("; ")
    .find((row) => row.startsWith(prefix));

  if (!cookie) {
    return null;
  }

  return cookie.slice(prefix.length) === "true";
}

function readPersistedUiState(): UiState {
  if (globalThis.window === undefined) {
    return initialState;
  }

  try {
    const raw = window.localStorage.getItem(PERSISTED_UI_STATE_KEY);
    const sidebarOpen = readSidebarCookieOpen() ?? initialState.sidebarOpen;
    const legacyLayoutState = readLegacyWorkspaceLayoutState();

    if (!raw) {
      return {
        ...initialState,
        sidebarOpen,
        workspaceLeftSidebarWidth:
          legacyLayoutState.workspaceLeftSidebarWidth ?? initialState.workspaceLeftSidebarWidth,
        workspaceRightSidebarExpanded:
          legacyLayoutState.workspaceRightSidebarExpanded ?? initialState.workspaceRightSidebarExpanded,
        workspaceRightSidebarExpandedWidth:
          legacyLayoutState.workspaceRightSidebarExpandedWidth ?? initialState.workspaceRightSidebarExpandedWidth,
      };
    }

    const parsed: PersistedUiState = JSON.parse(raw);
    const sidePanelState = normalizeSidePanelState(parsed.sidePanelState);

    return {
      ...initialState,
      sidebarOpen,
      sidePanelState,
      applicationMenuVisible: parsed.applicationMenuVisible ?? initialState.applicationMenuVisible,
      workspaceLeftSidebarWidth: normalizeNumber(
        parsed.workspaceLeftSidebarWidth,
        MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH,
        MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH,
      ) ?? legacyLayoutState.workspaceLeftSidebarWidth ?? initialState.workspaceLeftSidebarWidth,
      workspaceRightSidebarExpanded:
        parsed.workspaceRightSidebarExpanded ??
        legacyLayoutState.workspaceRightSidebarExpanded ??
        initialState.workspaceRightSidebarExpanded,
      workspaceRightSidebarExpandedWidth: normalizeNumber(
        parsed.workspaceRightSidebarExpandedWidth,
        MIN_WORKSPACE_RIGHT_SIDEBAR_WIDTH,
        MAX_WORKSPACE_RIGHT_SIDEBAR_WIDTH,
      ) ?? legacyLayoutState.workspaceRightSidebarExpandedWidth ?? initialState.workspaceRightSidebarExpandedWidth,
    };
  } catch {
    return initialState;
  }
}

export function persistUiState(state: UiState): void {
  if (globalThis.window === undefined) {
    return;
  }

  try {
    window.localStorage.setItem(
      PERSISTED_UI_STATE_KEY,
      JSON.stringify({
        sidePanelState: state.sidePanelState,
        applicationMenuVisible: state.applicationMenuVisible,
        workspaceLeftSidebarWidth: state.workspaceLeftSidebarWidth,
        workspaceRightSidebarExpanded: state.workspaceRightSidebarExpanded,
        workspaceRightSidebarExpandedWidth: state.workspaceRightSidebarExpandedWidth,
      } satisfies PersistedUiState),
    );
  } catch {
    return;
  }
}

export function setSidebarOpen(state: UiState, open: boolean): UiState {
  if (state.sidebarOpen === open) {
    return state;
  }

  return {
    ...state,
    sidebarOpen: open,
  };
}

export function toggleSidebar(state: UiState): UiState {
  return setSidebarOpen(state, !state.sidebarOpen);
}

export function getSidePanelState(state: UiState, sessionId: string | null | undefined): SidePanelItem | null {
  if (!sessionId) {
    return null;
  }

  return state.sidePanelState[sessionId] ?? null;
}

export function setSidePanelState(
  state: UiState,
  sessionId: string | null | undefined,
  panel: SidePanelItem | null,
): UiState {
  if (!sessionId || getSidePanelState(state, sessionId) === panel) {
    return state;
  }

  return {
    ...state,
    sidePanelState: {
      ...state.sidePanelState,
      [sessionId]: panel,
    },
  };
}

export function toggleSidePanelState(
  state: UiState,
  sessionId: string | null | undefined,
  panel: SidePanelItem,
): UiState {
  return setSidePanelState(state, sessionId, getSidePanelState(state, sessionId) === panel ? null : panel);
}

export function setApplicationMenuVisible(state: UiState, visible: boolean): UiState {
  if (state.applicationMenuVisible === visible) {
    return state;
  }

  return {
    ...state,
    applicationMenuVisible: visible,
  };
}

export function setWorkspaceLeftSidebarWidth(state: UiState, width: number): UiState {
  const nextWidth = clampNumber(width, MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH, MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH);
  if (state.workspaceLeftSidebarWidth === nextWidth) {
    return state;
  }

  return {
    ...state,
    workspaceLeftSidebarWidth: nextWidth,
  };
}

export function setWorkspaceLeftSidebarResizing(state: UiState, resizing: boolean): UiState {
  if (state.workspaceLeftSidebarResizing === resizing) {
    return state;
  }

  return {
    ...state,
    workspaceLeftSidebarResizing: resizing,
  };
}

export function setWorkspaceRightSidebarExpanded(state: UiState, expanded: boolean): UiState {
  if (state.workspaceRightSidebarExpanded === expanded) {
    return state;
  }

  return {
    ...state,
    workspaceRightSidebarExpanded: expanded,
  };
}

export function setWorkspaceRightSidebarExpandedWidth(state: UiState, width: number): UiState {
  const nextWidth = clampNumber(width, MIN_WORKSPACE_RIGHT_SIDEBAR_WIDTH, MAX_WORKSPACE_RIGHT_SIDEBAR_WIDTH);
  if (state.workspaceRightSidebarExpandedWidth === nextWidth) {
    return state;
  }

  return {
    ...state,
    workspaceRightSidebarExpandedWidth: nextWidth,
  };
}

export function toggleWorkspaceRightSidebar(state: UiState): UiState {
  return setWorkspaceRightSidebarExpanded(state, !state.workspaceRightSidebarExpanded);
}

function syncApplicationMenuVisible(visible: boolean): void {
  void globalThis.window?.__OPENWORK_ELECTRON__?.invokeDesktop?.("__setApplicationMenuVisible", visible);
}

type UiStateStore = UiState & {
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidePanelState: (sessionId: string | null | undefined, panel: SidePanelItem | null) => void;
  toggleSidePanelState: (sessionId: string | null | undefined, panel: SidePanelItem) => void;
  setApplicationMenuVisible: (visible: boolean) => void;
  setWorkspaceLeftSidebarWidth: (width: number) => void;
  setWorkspaceLeftSidebarResizing: (resizing: boolean) => void;
  setWorkspaceRightSidebarExpanded: (expanded: boolean) => void;
  setWorkspaceRightSidebarExpandedWidth: (width: number) => void;
  toggleWorkspaceRightSidebar: () => void;
};

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedUiState(),
  setSidebarOpen: (open) => set((state) => setSidebarOpen(state, open)),
  toggleSidebar: () => set((state) => toggleSidebar(state)),
  setSidePanelState: (sessionId, panel) => set((state) => setSidePanelState(state, sessionId, panel)),
  toggleSidePanelState: (sessionId, panel) => set((state) => toggleSidePanelState(state, sessionId, panel)),
  setApplicationMenuVisible: (visible) => {
    set((state) => setApplicationMenuVisible(state, visible));
    syncApplicationMenuVisible(visible);
  },
  setWorkspaceLeftSidebarWidth: (width) => set((state) => setWorkspaceLeftSidebarWidth(state, width)),
  setWorkspaceLeftSidebarResizing: (resizing) => set((state) => setWorkspaceLeftSidebarResizing(state, resizing)),
  setWorkspaceRightSidebarExpanded: (expanded) => set((state) => setWorkspaceRightSidebarExpanded(state, expanded)),
  setWorkspaceRightSidebarExpandedWidth: (width) => set((state) => setWorkspaceRightSidebarExpandedWidth(state, width)),
  toggleWorkspaceRightSidebar: () => set((state) => toggleWorkspaceRightSidebar(state)),
}));

syncApplicationMenuVisible(useUiStateStore.getState().applicationMenuVisible);

useUiStateStore.subscribe((state) => persistUiState(state));
