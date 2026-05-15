import { create } from "zustand";

export const PERSISTED_UI_STATE_KEY = "openwork:ui-state:v1";
const SIDEBAR_COOKIE_NAME = "sidebar_state";

export type PersistedUiState = {
  sidebarOpen: boolean;
  browserPanelOpen?: boolean;
  applicationMenuVisible?: boolean;
};

export type UiState = {
  sidebarOpen: boolean;
  browserPanelOpen: boolean;
  applicationMenuVisible: boolean;
};

const initialState: UiState = {
  sidebarOpen: true,
  browserPanelOpen: false,
  applicationMenuVisible: false,
};

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
    
    if (!raw) {
      const sidebarOpen = readSidebarCookieOpen();

      if (sidebarOpen === null) {
        return initialState;
      }

      return { ...initialState, sidebarOpen };
    }

    const parsed: PersistedUiState = JSON.parse(raw);
    const browserPanelOpen = parsed.browserPanelOpen ?? initialState.browserPanelOpen;
    const applicationMenuVisible = parsed.applicationMenuVisible ?? initialState.applicationMenuVisible;

    return {
      ...initialState,
      sidebarOpen: parsed.sidebarOpen,
      browserPanelOpen,
      applicationMenuVisible,
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
        sidebarOpen: state.sidebarOpen,
        browserPanelOpen: state.browserPanelOpen,
        applicationMenuVisible: state.applicationMenuVisible,
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

export function setBrowserPanelOpen(state: UiState, open: boolean): UiState {
  if (state.browserPanelOpen === open) {
    return state;
  }

  return {
    ...state,
    browserPanelOpen: open,
  };
}

export function toggleBrowserPanel(state: UiState): UiState {
  return setBrowserPanelOpen(state, !state.browserPanelOpen);
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

function syncApplicationMenuVisible(visible: boolean): void {
  void globalThis.window?.__OPENWORK_ELECTRON__?.invokeDesktop?.("__setApplicationMenuVisible", visible);
}

type UiStateStore = UiState & {
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  openBrowserPanel: () => void;
  closeBrowserPanel: () => void;
  toggleBrowserPanel: () => void;
  setApplicationMenuVisible: (visible: boolean) => void;
};

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedUiState(),
  setSidebarOpen: (open) => set((state) => setSidebarOpen(state, open)),
  toggleSidebar: () => set((state) => toggleSidebar(state)),
  openBrowserPanel: () => set((state) => setBrowserPanelOpen(state, true)),
  closeBrowserPanel: () => set((state) => setBrowserPanelOpen(state, false)),
  toggleBrowserPanel: () => set((state) => toggleBrowserPanel(state)),
  setApplicationMenuVisible: (visible) => {
    set((state) => setApplicationMenuVisible(state, visible));
    syncApplicationMenuVisible(visible);
  },
}));

syncApplicationMenuVisible(useUiStateStore.getState().applicationMenuVisible);

useUiStateStore.subscribe((state) => persistUiState(state));
