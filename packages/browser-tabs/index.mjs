// @openwork/browser-tabs
//
// The built-in browser is one native surface shared by every conversation in
// the desktop app, but each tab belongs to the conversation that opened it.
// This module is the framework-free heart of that rule: which tab is on
// screen, which tabs a conversation may see, and how a tab that belongs to a
// background conversation keeps behaving like a real page while nobody is
// looking at it. The Electron main process and the React renderer both consume
// it; neither owns the policy.

/** Owner key used for tabs that no conversation claimed (legacy/shared tabs). */
export const SHARED_OWNER_KEY = "*";

/** Viewport a background tab lays out and paints at while it is off screen. */
export const BACKGROUND_TAB_VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/**
 * Bounds of the on-window presence that keeps a background tab's compositor
 * producing frames. Keep this presence behind the app's native renderer;
 * one-pixel bounds alone are not a visibility or input-isolation boundary.
 */
export const BACKGROUND_TAB_PRESENCE_BOUNDS = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

/**
 * DevTools commands that make a background tab behave like a page the user is
 * looking at: a real viewport for layout, clicks, and screenshots, and focus
 * emulation so typing and `:focus` behave as on a focused page. This is the
 * same recipe headless browsers rely on.
 */
export function backgroundTabEmulationCommands(viewport = BACKGROUND_TAB_VIEWPORT) {
  return [
    {
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: viewport.width, height: viewport.height, deviceScaleFactor: 0, mobile: false },
    },
    { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
  ];
}

/** Undo `backgroundTabEmulationCommands` before a tab returns to the screen. */
export function foregroundTabEmulationCommands() {
  return [
    { method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } },
    { method: "Emulation.clearDeviceMetricsOverride", params: undefined },
  ];
}

function ownerKey(ownerSessionId) {
  return ownerSessionId ?? SHARED_OWNER_KEY;
}

function normalizeOwner(ownerSessionId) {
  return typeof ownerSessionId === "string" && ownerSessionId.trim() ? ownerSessionId : null;
}

/**
 * Bookkeeping for every open tab: order, owner, the active tab per owner, and
 * the conversation currently on screen. Pure state; no Electron, no React.
 */
export function createBrowserTabRegistry() {
  /** @type {Map<string, { tabId: string, ownerSessionId: string | null }>} */
  const tabs = new Map();
  /** @type {string[]} */
  let order = [];
  /** @type {Map<string, string>} owner key -> active tab id */
  const activeByOwner = new Map();
  /** @type {string | null} */
  let visibleSessionId = null;
  /** The last tab explicitly selected while it could take the screen. */
  /** @type {string | null} */
  let onScreenSelection = null;

  function get(tabId) {
    return tabs.get(tabId) ?? null;
  }

  function has(tabId) {
    return tabs.has(tabId);
  }

  function list() {
    return order.map((tabId) => tabs.get(tabId)).filter(Boolean);
  }

  function tabsFor(ownerSessionId) {
    const owner = normalizeOwner(ownerSessionId);
    return list().filter((tab) => tab.ownerSessionId === owner);
  }

  function ownerOf(tabId) {
    return tabs.get(tabId)?.ownerSessionId ?? null;
  }

  function isOwnerOnScreen(ownerSessionId) {
    return ownerSessionId === null || ownerSessionId === visibleSessionId;
  }

  /**
   * Whether a tab may take the screen right now. Tabs owned by the visible
   * conversation (and shared tabs) surface; everything else stays background.
   */
  function surfacingFor(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return null;
    return isOwnerOnScreen(tab.ownerSessionId) ? "foreground" : "background";
  }

  function add({ tabId, ownerSessionId = null }) {
    if (tabs.has(tabId)) throw new Error(`Duplicate browser tab: ${tabId}`);
    const tab = { tabId, ownerSessionId: normalizeOwner(ownerSessionId) };
    tabs.set(tabId, tab);
    order.push(tabId);
    const key = ownerKey(tab.ownerSessionId);
    if (!activeByOwner.has(key)) activeByOwner.set(key, tabId);
    return tab;
  }

  /**
   * Make a tab the active one for its owner. A tab that may take the screen
   * also becomes the on-screen tab, so a shared tab picked from a
   * conversation's tab strip really shows up.
   */
  function select(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`Unknown browser tab: ${tabId}`);
    activeByOwner.set(ownerKey(tab.ownerSessionId), tabId);
    if (isOwnerOnScreen(tab.ownerSessionId)) onScreenSelection = tabId;
    return tab;
  }

  /**
   * Forget a tab. Returns which tab should become active for that owner (the
   * neighbour to the right, else the left, else none) and whether the owner
   * has any tabs left.
   */
  function remove(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return null;
    const key = ownerKey(tab.ownerSessionId);
    const siblings = order.filter((id) => tabs.get(id)?.ownerSessionId === tab.ownerSessionId);
    const index = siblings.indexOf(tabId);
    const wasActive = activeByOwner.get(key) === tabId;
    tabs.delete(tabId);
    order = order.filter((id) => id !== tabId);
    if (onScreenSelection === tabId) onScreenSelection = null;
    const remaining = siblings.filter((id) => id !== tabId);
    let nextActiveTabId = activeByOwner.get(key) ?? null;
    if (wasActive) {
      nextActiveTabId = remaining[Math.min(index, remaining.length - 1)] ?? remaining[index - 1] ?? null;
      if (nextActiveTabId) activeByOwner.set(key, nextActiveTabId);
      else activeByOwner.delete(key);
    }
    return { tab, wasActive, nextActiveTabId, ownerHasTabs: remaining.length > 0 };
  }

  function reorder(tabIds) {
    const nextOrder = Array.isArray(tabIds) ? tabIds.map(String) : [];
    if (nextOrder.length !== order.length) {
      throw new Error("Tab order must include every open tab.");
    }
    if (new Set(nextOrder).size !== nextOrder.length) {
      throw new Error("Tab order must not contain duplicate tabs.");
    }
    if (nextOrder.some((tabId) => !tabs.has(tabId))) {
      throw new Error("Tab order contains an unknown tab.");
    }
    order = nextOrder;
    return list();
  }

  function setVisibleSession(sessionId) {
    const next = normalizeOwner(sessionId);
    if (next !== visibleSessionId) onScreenSelection = null;
    visibleSessionId = next;
    return visibleSessionId;
  }

  function getVisibleSessionId() {
    return visibleSessionId;
  }

  function activeTabIdFor(ownerSessionId) {
    return activeByOwner.get(ownerKey(normalizeOwner(ownerSessionId))) ?? null;
  }

  /**
   * The tab that belongs on screen: the last tab picked while it could take
   * the screen, else the visible conversation's active tab, else the shared one.
   */
  function onScreenTabId() {
    if (onScreenSelection && tabs.has(onScreenSelection) && surfacingFor(onScreenSelection) === "foreground") {
      return onScreenSelection;
    }
    if (visibleSessionId !== null) {
      const owned = activeByOwner.get(visibleSessionId);
      if (owned) return owned;
    }
    return activeByOwner.get(SHARED_OWNER_KEY) ?? null;
  }

  function activeTabIdByOwner() {
    return Object.fromEntries(activeByOwner);
  }

  function clear() {
    tabs.clear();
    order = [];
    activeByOwner.clear();
    onScreenSelection = null;
  }

  return {
    add,
    select,
    remove,
    reorder,
    get,
    has,
    list,
    tabsFor,
    ownerOf,
    surfacingFor,
    setVisibleSession,
    visibleSessionId: getVisibleSessionId,
    onScreenTabId,
    activeTabIdFor,
    activeTabIdByOwner,
    clear,
    size: () => tabs.size,
  };
}

/** Tabs a conversation's side panel may show: its own, plus shared (unowned) tabs. */
export function browserTabsForSession(tabs, sessionId) {
  return tabs.filter((tab) => tab.ownerSessionId == null || tab.ownerSessionId === sessionId);
}

/**
 * The active browser tab for a conversation from a state payload: its own
 * active tab, else the shared active tab, else the global on-screen tab, else
 * the first tab it may see.
 */
export function activeBrowserTabIdForSession(payload, sessionId, tabs) {
  const byOwner = payload.activeTabIdByOwner ?? {};
  const candidates = [byOwner[sessionId], byOwner[SHARED_OWNER_KEY], payload.activeTabId];
  for (const candidate of candidates) {
    if (candidate && tabs.some((tab) => tab.id === candidate)) return candidate;
  }
  return tabs[0]?.id ?? null;
}
