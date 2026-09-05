export type BrowserTabSurfacing = "foreground" | "background";

export type CdpCommand = {
  method: string;
  params?: Record<string, unknown>;
};

export type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Viewport = {
  width: number;
  height: number;
};

/** Browser tab state mirrored across the desktop IPC bridge. */
export type BrowserPanelTab = {
  id: string;
  type: "browser";
  label: string;
  url: string;
  favicon: string | null;
  status: "loading" | "ready";
  canGoBack: boolean;
  canGoForward: boolean;
  /** Conversation (session) that opened the tab; null for shared/legacy tabs. */
  ownerSessionId: string | null;
};

export type BrowserStatePayload = {
  /** The tab currently on screen, if any. */
  activeTabId?: string | null;
  /** Active tab per owner session id (or `SHARED_OWNER_KEY`). */
  activeTabIdByOwner?: Record<string, string>;
  /** The conversation whose tabs may take the screen. */
  visibleSessionId?: string | null;
  tabs?: BrowserPanelTab[];
};

export type BrowserPanelOwnerPayload = {
  ownerSessionId: string | null;
};

export type OpenBrowserUrlResult = {
  provider: "builtin";
  browser_url: string;
  target_id: string;
  tab_id: string;
  url: string;
  owner_session_id: string | null;
  /** False when the tab loads silently for a conversation that is not on screen. */
  visible: boolean;
};

export type RegistryTab = {
  tabId: string;
  ownerSessionId: string | null;
};

export type RemovedRegistryTab = {
  tab: RegistryTab;
  wasActive: boolean;
  nextActiveTabId: string | null;
  ownerHasTabs: boolean;
};

export type BrowserTabRegistry = {
  add(tab: { tabId: string; ownerSessionId?: string | null }): RegistryTab;
  select(tabId: string): RegistryTab;
  remove(tabId: string): RemovedRegistryTab | null;
  reorder(tabIds: string[]): RegistryTab[];
  get(tabId: string): RegistryTab | null;
  has(tabId: string): boolean;
  list(): RegistryTab[];
  tabsFor(ownerSessionId: string | null | undefined): RegistryTab[];
  ownerOf(tabId: string): string | null;
  surfacingFor(tabId: string): BrowserTabSurfacing | null;
  setVisibleSession(sessionId: string | null | undefined): string | null;
  visibleSessionId(): string | null;
  onScreenTabId(): string | null;
  activeTabIdFor(ownerSessionId: string | null | undefined): string | null;
  activeTabIdByOwner(): Record<string, string>;
  clear(): void;
  size(): number;
};

export const SHARED_OWNER_KEY: "*";
export const BACKGROUND_TAB_VIEWPORT: Readonly<Viewport>;
export const BACKGROUND_TAB_PRESENCE_BOUNDS: Readonly<Bounds>;

export function backgroundTabEmulationCommands(viewport?: Viewport): CdpCommand[];
export function foregroundTabEmulationCommands(): CdpCommand[];
export function createBrowserTabRegistry(): BrowserTabRegistry;
export function browserTabsForSession<Tab extends { ownerSessionId: string | null }>(tabs: Tab[], sessionId: string): Tab[];
export function activeBrowserTabIdForSession(
  payload: BrowserStatePayload,
  sessionId: string,
  tabs: Array<{ id: string }>,
): string | null;
