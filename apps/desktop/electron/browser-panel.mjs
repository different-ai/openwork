// Embedded browser panel: tab state, BrowserView lifecycle, menu overlay,
// proxy configuration, and browser IPC registrations. Extracted from
// main.mjs as a factory so the main process only owns window creation.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, WebContentsView, clipboard, session, shell } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_SESSION_PARTITION = "persist:openwork-browser";
const BROWSER_DEFAULT_URL = "about:blank";
// URL a user-initiated new tab (the "+" button / opening the browser panel)
// lands on. The agent's programmatic path keeps BROWSER_DEFAULT_URL.
const BROWSER_NEW_TAB_URL = "https://www.google.com";
const BROWSER_TARGET_RESOLVE_TIMEOUT_MS = 2500;
const BROWSER_TARGET_RESOLVE_INTERVAL_MS = 80;
const MENU_OVERLAY_HTML = "overlay.html";
const MENU_OVERLAY_WIDTH = 196;
const MENU_OVERLAY_HEIGHT = 176;
const MENU_OVERLAY_READY_TIMEOUT_MS = 2000;

export function createBrowserPanel({ getWindow, remoteDebugPort }) {
  const browserTabs = new Map();
  let browserTabOrder = [];
  let activeBrowserTabId = null;
  let browserViewVisible = false;
  // Last browser panel bounds reported by the renderer, in renderer CSS pixels.
  // Converted to window device-independent pixels at every setBounds call.
  let lastBrowserBounds = null;
  let browserTabCounter = 0;
  // Active proxy for the built-in browser session: { rules, username, password }.
  let browserProxy = null;
  let menuOverlayView = null;
  let menuOverlayRequest = null;
  let menuOverlayReady = false;
  let menuOverlayReadyResolvers = [];
  let menuOverlayShowSerial = 0;

  function window() {
    return getWindow?.() ?? null;
  }

  function resetMenuOverlayReady({ resolvePending = false } = {}) {
    menuOverlayReady = false;
    if (resolvePending) {
      const resolvers = menuOverlayReadyResolvers.splice(0);
      for (const resolve of resolvers) resolve(false);
    }
  }

  function markMenuOverlayReady(view) {
    if (!view || view.webContents.isDestroyed()) return;
    menuOverlayReady = true;
    const resolvers = menuOverlayReadyResolvers.splice(0);
    for (const resolve of resolvers) resolve(true);
  }

  function waitForMenuOverlayReady(view) {
    if (menuOverlayReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const done = (ready) => {
        if (timer) clearTimeout(timer);
        menuOverlayReadyResolvers = menuOverlayReadyResolvers.filter((candidate) => candidate !== done);
        resolve(ready);
      };
      timer = setTimeout(() => done(false), MENU_OVERLAY_READY_TIMEOUT_MS);
      menuOverlayReadyResolvers.push(done);
      if (!view || view.webContents.isDestroyed()) done(false);
    });
  }

  /** Send an IPC message to the main renderer, guarding against disposed frames. */
  function sendToRenderer(channel, payload) {
    const mainWindow = window();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    try { mainWindow.webContents.send(channel, payload); } catch { /* window closing */ }
  }

  function createBrowserTabId() {
    browserTabCounter += 1;
    return `tab_${Date.now().toString(36)}_${browserTabCounter.toString(36)}`;
  }

  function normalizeBrowserUrl(url, fallback = BROWSER_DEFAULT_URL) {
    const target = typeof url === "string" && url.trim() ? url.trim() : fallback;
    if (!target || target === "about:blank") return "about:blank";
    return /^https?:\/\//i.test(target) ? target : `https://${target}`;
  }

  function isMainWindowAllowedNavigation(url) {
    if (!url) return true;
    if (url.startsWith("file://") || url.startsWith("data:")) return true;
    try {
      const target = new URL(url);
      if (target.hostname === "127.0.0.1" || target.hostname === "localhost") return true;
      const currentUrl = window()?.webContents.getURL();
      if (!currentUrl || currentUrl === "about:blank") return true;
      const current = new URL(currentUrl);
      return target.origin === current.origin;
    } catch {
      return true;
    }
  }

  function routeBlockedMainWindowNavigation(url) {
    if (!/^https?:\/\//i.test(String(url ?? ""))) return;
    void openBrowserUrlForAutomation(url).catch((error) => {
      console.warn("[browser] failed to route blocked main-window navigation", error);
    });
  }

  function cdpBrowserUrl() {
    return `http://127.0.0.1:${remoteDebugPort}`;
  }

  function browserTargetMarkerUrl(tabId) {
    const marker = `openwork-browser-tab:${tabId}`;
    const html = `<!doctype html><title>${marker}</title><meta name="openwork-browser-tab" content="${tabId}"><body>${marker}</body>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }

  async function listCdpTargets() {
    if (!remoteDebugPort || remoteDebugPort <= 0) return [];
    const response = await fetch(`${cdpBrowserUrl()}/json/list`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
    const targets = await response.json();
    return Array.isArray(targets) ? targets : [];
  }

  async function resolveBrowserCdpTargetId(tabId) {
    const marker = encodeURIComponent(`openwork-browser-tab:${tabId}`);
    const deadline = Date.now() + BROWSER_TARGET_RESOLVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const targets = await listCdpTargets().catch(() => []);
      const target = targets.find((candidate) => (
        candidate?.type === "page" &&
        typeof candidate.id === "string" &&
        typeof candidate.url === "string" &&
        candidate.url.includes(marker)
      ));
      if (target?.id) return target.id;
      await new Promise((resolve) => setTimeout(resolve, BROWSER_TARGET_RESOLVE_INTERVAL_MS));
    }
    throw new Error("Could not resolve built-in browser CDP target.");
  }

  async function openBrowserUrlForAutomation(rawUrl, provider = "auto") {
    const requestedProvider = String(provider || "auto").trim().toLowerCase();
    if (requestedProvider && requestedProvider !== "auto" && requestedProvider !== "builtin") {
      throw new Error(`Browser provider is not available yet: ${requestedProvider}`);
    }
    const url = normalizeBrowserUrl(rawUrl);
    const tab = createBrowserTab("about:blank", { select: true });
    await tab.view.webContents.loadURL(browserTargetMarkerUrl(tab.tabId));
    const targetId = await resolveBrowserCdpTargetId(tab.tabId);
    await tab.view.webContents.loadURL(url);
    return {
      provider: "builtin",
      browser_url: cdpBrowserUrl(),
      target_id: targetId,
      tab_id: tab.tabId,
      url,
    };
  }

  function getBrowserTab(tabId = activeBrowserTabId) {
    return tabId ? browserTabs.get(tabId) ?? null : null;
  }

  function getActiveBrowserView() {
    return getBrowserTab()?.view ?? null;
  }

  function getActiveWebContents() {
    return getActiveBrowserView()?.webContents ?? null;
  }

  function getBrowserTabLabel(title, url) {
    if (title) {
      return title;
    }

    if (url && url !== "about:blank") {
      return url;
    }

    return "New tab";
  }

  function browserTabToPanelTab(tabId, tab) {
    const webContents = tab.view.webContents;
    const url = webContents.getURL();
    const title = webContents.getTitle();
    const isLoading = webContents.isLoading();

    return {
      id: tabId,
      type: "browser",
      label: getBrowserTabLabel(title, url),
      url,
      favicon: tab.favicon ?? null,
      status: isLoading ? "loading" : "ready",
      canGoBack: webContents.canGoBack(),
      canGoForward: webContents.canGoForward(),
    };
  }

  function listBrowserTabs() {
    return browserTabOrder
      .map((tabId) => {
        const tab = browserTabs.get(tabId);
        if (!tab || tab.view.webContents.isDestroyed()) return null;
        return browserTabToPanelTab(tabId, tab);
      })
      .filter(Boolean);
  }

  function browserStatePayload() {
    return {
      activeTabId: activeBrowserTabId,
      tabs: listBrowserTabs(),
    };
  }

  function browserTabUrl(tab) {
    const url = tab?.view?.webContents?.getURL?.();
    return typeof url === "string" && url && url !== "about:blank" ? url : null;
  }

  function isHttpUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function normalizeMenuOverlayPoint(point) {
    if (!point || typeof point !== "object") {
      return { x: 0, y: 0 };
    }
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { x: 0, y: 0 };
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function menuOverlayBounds(point) {
    const [contentWidth, contentHeight] = window()?.getContentSize?.() ?? [MENU_OVERLAY_WIDTH, MENU_OVERLAY_HEIGHT];
    return {
      x: Math.min(Math.max(point.x, 0), Math.max(contentWidth - MENU_OVERLAY_WIDTH - 4, 0)),
      y: Math.min(Math.max(point.y, 0), Math.max(contentHeight - MENU_OVERLAY_HEIGHT - 4, 0)),
      width: MENU_OVERLAY_WIDTH,
      height: MENU_OVERLAY_HEIGHT,
    };
  }

  function menuOverlayUrl() {
    const currentUrl = window()?.webContents?.getURL?.();
    if (currentUrl && /^https?:\/\//i.test(currentUrl)) {
      return new URL(MENU_OVERLAY_HTML, currentUrl).toString();
    }
    return null;
  }

  async function loadMenuOverlayRenderer(view) {
    const devUrl = menuOverlayUrl();
    if (devUrl) {
      await view.webContents.loadURL(devUrl);
      return;
    }

    const packagedOverlayPath = path.join(process.resourcesPath, "app-dist", MENU_OVERLAY_HTML);
    const devOverlayPath = path.resolve(__dirname, "../../app/dist", MENU_OVERLAY_HTML);
    await view.webContents.loadFile(app.isPackaged ? packagedOverlayPath : devOverlayPath);
  }

  async function ensureMenuOverlayView() {
    if (menuOverlayView && !menuOverlayView.webContents.isDestroyed()) {
      return menuOverlayView;
    }

    const view = new WebContentsView({
      webPreferences: {
        // Electron only runs ESM preload scripts reliably with sandbox disabled.
        // Keep the bridge isolated and node-free for the React overlay document.
        backgroundThrottling: false,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "menu-overlay-preload.mjs"),
      },
    });
    view.setBackgroundColor?.("#00000000");
    view.setVisible?.(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) resetMenuOverlayReady();
    });
    view.webContents.once("destroyed", () => {
      if (menuOverlayView === view) {
        menuOverlayView = null;
        menuOverlayRequest = null;
        resetMenuOverlayReady({ resolvePending: true });
      }
    });

    menuOverlayView = view;
    resetMenuOverlayReady({ resolvePending: true });
    await loadMenuOverlayRenderer(view);
    return view;
  }

  function hideMenuOverlay() {
    const view = menuOverlayView;
    const mainWindow = window();
    menuOverlayShowSerial += 1;
    menuOverlayRequest = null;
    if (!view || !mainWindow) return;
    view.setVisible?.(false);
    try {
      if (mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.removeChildView(view);
      }
    } catch {
      // already removed
    }
  }

  function bringMenuOverlayToTop(view) {
    const mainWindow = window();
    if (!mainWindow) return;
    try {
      if (mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.removeChildView(view);
      }
    } catch {
      // already removed
    }
    mainWindow.contentView.addChildView(view);
  }

  function tabMenuRequest(tab, point) {
    const url = browserTabUrl(tab);
    return {
      id: `tab-menu:${tab.tabId}:${Date.now()}`,
      source: "tab",
      tabId: tab.tabId,
      url,
      bounds: menuOverlayBounds(normalizeMenuOverlayPoint(point)),
      items: [
        { id: "copy-url", label: "Copy URL", iconName: "copy", disabled: !url },
        { id: "open-external", label: "Open in Browser", iconName: "external", disabled: !(url && isHttpUrl(url)) },
        { id: "close-tab", label: "Close Tab", iconName: "close", separatorBefore: true },
        { id: "close-all-tabs", label: "Close All Tabs", iconName: "close" },
      ],
    };
  }

  async function showBrowserTabContextMenu(tabId, point) {
    const tab = getBrowserTab(String(tabId ?? ""));
    if (!window() || !tab || tab.view.webContents.isDestroyed()) return;

    const showSerial = menuOverlayShowSerial + 1;
    menuOverlayShowSerial = showSerial;
    const request = tabMenuRequest(tab, point ? scaleRendererPoint(point) : point);
    const view = await ensureMenuOverlayView();
    if (showSerial !== menuOverlayShowSerial || menuOverlayView !== view) return;
    menuOverlayRequest = request;
    view.setBounds(request.bounds);
    view.setVisible?.(true);
    bringMenuOverlayToTop(view);
    const ready = await waitForMenuOverlayReady(view);
    if (showSerial !== menuOverlayShowSerial || menuOverlayRequest !== request || menuOverlayView !== view) return;
    if (!ready) {
      console.warn("[menu-overlay] renderer did not signal readiness before show");
    }
    view.webContents.send("openwork:menu-overlay:show", {
      id: request.id,
      source: request.source,
      items: request.items,
    });
    view.webContents.focus();
  }

  function handleMenuOverlayChoice(payload) {
    if (!payload || payload.requestId !== menuOverlayRequest?.id) return;
    const request = menuOverlayRequest;
    const tab = getBrowserTab(request.tabId);
    hideMenuOverlay();

    switch (payload.itemId) {
      case "copy-url":
        if (request.url) clipboard.writeText(request.url);
        break;
      case "open-external":
        if (request.url && isHttpUrl(request.url)) void shell.openExternal(request.url);
        break;
      case "close-tab":
        if (tab) closeBrowserTab(tab.tabId);
        break;
      case "close-all-tabs":
        closeAllBrowserTabs();
        break;
    }
  }

  function resolveBrowserProxyInput(input) {
    const raw = String(input ?? "").trim();
    const envMatch = raw.match(/^env:([A-Za-z0-9_]+)$/i);
    if (!envMatch) return raw;
    const key = `OPENWORK_BROWSER_PROXY_${envMatch[1].toUpperCase()}`;
    const value = String(process.env[key] ?? "").trim();
    if (!value) throw new Error(`No proxy configured: set the ${key} environment variable to a proxy URL.`);
    return value;
  }

  function parseBrowserProxyInput(input) {
    const raw = resolveBrowserProxyInput(input);
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch {
      throw new Error(`Invalid proxy URL: ${raw}`);
    }
    if (!url.hostname || !url.port) {
      throw new Error("Proxy must include host and port, e.g. http://user:pass@host:8080 or socks5://host:1080.");
    }
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    return {
      rules: `${scheme}://${url.hostname}:${url.port}`,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }

  function browserProxyState() {
    return {
      proxy: browserProxy
        ? { rules: browserProxy.rules, authenticated: Boolean(browserProxy.username) }
        : null,
    };
  }

  async function setBrowserProxy(proxyInput) {
    const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
    const parsed = parseBrowserProxyInput(proxyInput);
    if (parsed) {
      await browserSession.setProxy({ proxyRules: parsed.rules, proxyBypassRules: "<local>" });
    } else {
      await browserSession.setProxy({ mode: "system" });
    }
    browserProxy = parsed;
    // Drop keep-alive connections so existing tabs cannot bypass the new proxy.
    await browserSession.closeAllConnections();
    return browserProxyState();
  }

  app.on("login", (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo?.isProxy || !browserProxy?.username) return;
    event.preventDefault();
    callback(browserProxy.username, browserProxy.password);
  });

  function createBrowserTab(url = "about:blank", { select = true } = {}) {
    const tabId = createBrowserTabId();
    const view = new WebContentsView({
      webPreferences: {
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "browser-content-preload.cjs"),
        partition: BROWSER_SESSION_PARTITION,
      },
    });
    const tab = { tabId, view, favicon: null };
    browserTabs.set(tabId, tab);
    browserTabOrder.push(tabId);
    // Load about:blank immediately to preempt persistent-session restore.
    // Cookies live on the session object, not the document — they survive this.
    view.webContents.loadURL("about:blank");
    view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      void shell.openExternal(targetUrl);
      return { action: "deny" };
    });
    view.webContents.on("did-start-navigation", (_event, targetUrl, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      const target = String(targetUrl ?? "");
      // data: loads are internal plumbing (CDP target-marker pages), not
      // user-visible navigations — don't surface the panel for them.
      if (target === "about:blank" || target.startsWith("data:")) return;
      // Agent-driven CDP navigation can target a background tab whose view is
      // detached. Bring that tab on screen, otherwise navigation "succeeds"
      // while the visible tab stays on about:blank (#2015).
      if (activeBrowserTabId !== tabId) {
        try {
          selectBrowserTab(tabId);
        } catch {
          // The tab may be mid-close; the panel-opened event below still fires.
        }
      }
      sendToRenderer("openwork:browser:panel-opened");
    });
    view.webContents.on("did-navigate", () => sendBrowserState());
    view.webContents.on("did-navigate-in-page", () => sendBrowserState());
    view.webContents.on("page-title-updated", () => sendBrowserState());
    view.webContents.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = Array.isArray(favicons) ? favicons[0] ?? null : null;
      sendBrowserState();
    });
    view.webContents.on("did-start-loading", () => sendBrowserState());
    view.webContents.on("did-stop-loading", () => sendBrowserState());
    view.webContents.once("destroyed", () => {
      browserTabs.delete(tabId);
      browserTabOrder = browserTabOrder.filter((id) => id !== tabId);
      if (activeBrowserTabId === tabId) activeBrowserTabId = browserTabOrder[0] ?? null;
      sendBrowserState();
    });
    if (select || !activeBrowserTabId) {
      selectBrowserTab(tabId);
    } else {
      sendBrowserState();
    }
    const finalUrl = normalizeBrowserUrl(url, "about:blank");
    if (finalUrl !== "about:blank") {
      view.webContents.loadURL(finalUrl);
    }
    return tab;
  }

  function detachBrowserView(view) {
    const mainWindow = window();
    if (!mainWindow || !view) return;
    try {
      if (mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.removeChildView(view);
      }
    } catch {
      // already removed
    }
  }

  // The renderer reports bounds in CSS pixels, which Electron scales by the main
  // window's zoom factor. Read the factor from the webContents at apply time so
  // the conversion is always correct, no matter how the zoom was changed
  // (shortcuts, native menu, or Chromium's persisted per-origin zoom).
  function mainWindowZoomFactor() {
    try {
      const factor = window()?.webContents.getZoomFactor();
      return typeof factor === "number" && factor > 0 ? factor : 1;
    } catch {
      return 1;
    }
  }

  function scaleRendererBounds(bounds) {
    const zoom = mainWindowZoomFactor();
    // Round edges (not width/height) so the far edge has no sub-pixel seam.
    const x = Math.round(bounds.x * zoom);
    const y = Math.round(bounds.y * zoom);
    return {
      x,
      y,
      width: Math.round((bounds.x + bounds.width) * zoom) - x,
      height: Math.round((bounds.y + bounds.height) * zoom) - y,
    };
  }

  function scaleRendererPoint(point) {
    const zoom = mainWindowZoomFactor();
    return { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) };
  }

  function attachActiveBrowserView() {
    const mainWindow = window();
    if (!mainWindow || !browserViewVisible) return;
    const view = getActiveBrowserView();
    if (!view) return;
    for (const tab of browserTabs.values()) {
      if (tab.view !== view) detachBrowserView(tab.view);
    }
    if (!mainWindow.contentView.children.includes(view)) {
      mainWindow.contentView.addChildView(view);
    }
    if (lastBrowserBounds && lastBrowserBounds.width > 0 && lastBrowserBounds.height > 0) {
      view.setBounds(scaleRendererBounds(lastBrowserBounds));
    }
  }

  function selectBrowserTab(tabId) {
    if (!browserTabs.has(tabId)) throw new Error(`Unknown browser tab: ${tabId}`);
    hideMenuOverlay();
    const previousView = getActiveBrowserView();
    activeBrowserTabId = tabId;
    if (previousView && previousView !== getActiveBrowserView()) {
      detachBrowserView(previousView);
    }
    attachActiveBrowserView();
    sendBrowserState();
    return getBrowserTab(tabId);
  }

  function closeBrowserTab(tabId = activeBrowserTabId) {
    const tab = getBrowserTab(tabId);
    if (!tab) return null;
    if (menuOverlayRequest?.tabId === tabId) hideMenuOverlay();
    const closingIndex = browserTabOrder.indexOf(tabId);
    const wasActive = activeBrowserTabId === tabId;
    detachBrowserView(tab.view);
    browserTabs.delete(tabId);
    browserTabOrder = browserTabOrder.filter((id) => id !== tabId);
    if (wasActive) {
      const nextTabId =
        browserTabOrder[Math.min(closingIndex, browserTabOrder.length - 1)] ??
        browserTabOrder[closingIndex - 1] ??
        null;
      activeBrowserTabId = nextTabId;
      if (nextTabId) {
        attachActiveBrowserView();
      } else {
        hideBrowserView();
        sendToRenderer("openwork:browser:panel-closed");
      }
    }
    try { tab.view.webContents.close(); } catch { /* already destroyed */ }
    sendBrowserState();
    return tabId;
  }

  function closeAllBrowserTabs() {
    const closedTabIds = [...browserTabOrder];
    if (closedTabIds.length === 0) return [];
    hideMenuOverlay();
    const tabsToClose = closedTabIds
      .map((tabId) => browserTabs.get(tabId))
      .filter(Boolean);
    hideBrowserView();
    browserTabs.clear();
    browserTabOrder = [];
    activeBrowserTabId = null;
    for (const tab of tabsToClose) {
      try { tab.view.webContents.close(); } catch { /* already destroyed */ }
    }
    sendToRenderer("openwork:browser:panel-closed");
    sendBrowserState();
    return closedTabIds;
  }

  function reorderBrowserTabs(tabIds) {
    const nextOrder = Array.isArray(tabIds) ? tabIds.map(String) : [];
    if (nextOrder.length !== browserTabOrder.length) {
      throw new Error("Tab order must include every open tab.");
    }
    if (new Set(nextOrder).size !== nextOrder.length) {
      throw new Error("Tab order must not contain duplicate tabs.");
    }
    const current = new Set(browserTabOrder);
    if (nextOrder.some((tabId) => !current.has(tabId))) {
      throw new Error("Tab order contains an unknown tab.");
    }
    browserTabOrder = nextOrder;
    sendBrowserState();
    return listBrowserTabs();
  }

  function sendBrowserState() {
    sendToRenderer("openwork:browser:state", browserStatePayload());
  }

  /**
   * Attach the browser view to the main window.
   * @param {object} bounds — { x, y, width, height }
   * @param {object} [opts]
   * @param {boolean} [opts.preloadDefault=false] - load default URL if the view has no URL
   * @param {boolean} [opts.ensureTab=false] - create a blank tab if needed
   */
  function attachBrowserView(bounds, { preloadDefault = false, ensureTab = false } = {}) {
    if (!window()) return;
    lastBrowserBounds = bounds;
    browserViewVisible = true;
    if (ensureTab && !activeBrowserTabId) createBrowserTab("about:blank");
    const view = getActiveBrowserView();
    attachActiveBrowserView();
    if (bounds.width > 0 && bounds.height > 0) {
      view?.setBounds(scaleRendererBounds(bounds));
    }
    const url = view?.webContents.getURL();
    if (preloadDefault && (!url || url === "about:blank")) {
      view?.webContents.loadURL(BROWSER_DEFAULT_URL);
    }
    sendBrowserState();
  }

  function hideBrowserView() {
    hideMenuOverlay();
    browserViewVisible = false;
    if (!window()) return;
    for (const tab of browserTabs.values()) {
      detachBrowserView(tab.view);
    }
  }

  function destroyBrowserView() {
    hideBrowserView();
    const overlayView = menuOverlayView;
    menuOverlayView = null;
    menuOverlayRequest = null;
    try { overlayView?.webContents.close(); } catch { /* already destroyed */ }
    for (const tab of browserTabs.values()) {
      try { tab.view.webContents.close(); } catch { /* already destroyed */ }
    }
    browserTabs.clear();
    browserTabOrder = [];
    activeBrowserTabId = null;
    lastBrowserBounds = null;
    sendBrowserState();
  }

  function registerIpc(ipcMain) {
    ipcMain.handle("openwork:browser:show", (_event, bounds) => attachBrowserView(bounds));
    ipcMain.handle("openwork:browser:hide", () => hideBrowserView());
    ipcMain.handle("openwork:browser:openUrl", (_event, url, provider) => openBrowserUrlForAutomation(url, provider));
    ipcMain.handle("openwork:browser:navigate", (_event, url) => {
      const view = getActiveBrowserView() ?? createBrowserTab("about:blank", { select: true }).view;
      view.webContents.loadURL(normalizeBrowserUrl(url));
    });
    ipcMain.handle("openwork:browser:back", () => {
      const webContents = getActiveWebContents();
      if (webContents?.canGoBack()) webContents.goBack();
    });
    ipcMain.handle("openwork:browser:forward", () => {
      const webContents = getActiveWebContents();
      if (webContents?.canGoForward()) webContents.goForward();
    });
    ipcMain.handle("openwork:browser:reload", () => getActiveWebContents()?.reload());
    ipcMain.handle("openwork:browser:bounds", (_event, bounds) => {
      lastBrowserBounds = bounds;
      const view = getActiveBrowserView();
      if (view && browserViewVisible && bounds.width > 0 && bounds.height > 0) {
        view.setBounds(scaleRendererBounds(bounds));
      }
    });
    ipcMain.handle("openwork:browser:state", () => browserStatePayload());
    ipcMain.handle("openwork:browser:createTab", (_event, url) => {
      const target = typeof url === "string" && url.trim() ? url : BROWSER_NEW_TAB_URL;
      const tab = createBrowserTab(target, { select: true });
      return { tabId: tab.tabId };
    });
    ipcMain.handle("openwork:browser:closeTab", (_event, tabId) => closeBrowserTab(tabId == null ? undefined : String(tabId)));
    ipcMain.handle("openwork:browser:closeAllTabs", () => closeAllBrowserTabs());
    ipcMain.handle("openwork:browser:selectTab", (_event, tabId) => selectBrowserTab(String(tabId ?? "")).tabId);
    ipcMain.handle("openwork:browser:reorderTabs", (_event, tabIds) => reorderBrowserTabs(tabIds));
    ipcMain.handle("openwork:browser:listTabs", () => listBrowserTabs());
    ipcMain.handle("openwork:browser:setProxy", (_event, proxy) => setBrowserProxy(proxy));
    ipcMain.handle("openwork:browser:getProxy", () => browserProxyState());
    ipcMain.handle("openwork:browser:tabContextMenu", (_event, tabId, point) => showBrowserTabContextMenu(tabId, point));
    ipcMain.handle("openwork:browser:destroy", () => destroyBrowserView());
    ipcMain.on("openwork:menu-overlay:ready", (event) => {
      if (event.sender !== menuOverlayView?.webContents) return;
      markMenuOverlayReady(menuOverlayView);
    });
    ipcMain.on("openwork:menu-overlay:choose", (event, payload) => {
      if (event.sender !== menuOverlayView?.webContents) return;
      handleMenuOverlayChoice(payload);
    });
    ipcMain.on("openwork:menu-overlay:close", (event, payload) => {
      if (event.sender !== menuOverlayView?.webContents) return;
      if (payload?.requestId && payload.requestId !== menuOverlayRequest?.id) return;
      hideMenuOverlay();
    });
    ipcMain.on("openwork:menu-overlay:dismiss", (event) => {
      if (event.sender === menuOverlayView?.webContents) return;
      hideMenuOverlay();
    });
  }

  return {
    destroy: destroyBrowserView,
    isMainWindowAllowedNavigation,
    registerIpc,
    routeBlockedMainWindowNavigation,
  };
}
