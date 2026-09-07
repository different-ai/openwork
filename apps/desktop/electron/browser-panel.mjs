// Embedded browser panel: tab state, BrowserView lifecycle, menu overlay,
// proxy configuration, and browser IPC registrations. Extracted from
// main.mjs as a factory so the main process only owns window creation.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, WebContentsView, clipboard, dialog, session, shell } from "electron";
import {
  BACKGROUND_TAB_VIEWPORT,
  backgroundTabEmulationCommands,
  createBrowserTabRegistry,
  foregroundTabEmulationCommands,
} from "@openwork/browser-tabs";
import { runDetachedTask } from "./process-resilience.mjs";
import { listInstalledBrowsers } from "./installed-browsers.mjs";

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

export function createBrowserPanel({ getWindow, remoteDebugPort, onDeepLink, checkPolicy }) {
  let policyRequestHookInstalled = false;
  function installPolicyRequestHook() {
    if (policyRequestHookInstalled || !checkPolicy) return;
    policyRequestHookInstalled = true;
    // The session request boundary covers normal navigation, redirects, frames,
    // scripted fetches and CDP navigation; window navigation events do not.
    session.fromPartition(BROWSER_SESSION_PARTITION).webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      if (["about:", "data:", "blob:"].some((scheme) => details.url.startsWith(scheme))) { callback({ cancel: false }); return; }
      Promise.resolve(checkPolicy({ url: details.url, method: details.method, hasUpload: Boolean(details.uploadData?.length) }))
        .then(() => callback({ cancel: false }), () => callback({ cancel: true }));
    });
  }
  // tabId -> { tabId, view, favicon, background }. Order, ownership, the active
  // tab per conversation, and which conversation is on screen live in the
  // registry; this map only holds the native views.
  const browserTabs = new Map();
  const registry = createBrowserTabRegistry();
  let browserViewVisible = false;
  let backgroundWindow = null;
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
      if (target.hostname === "127.0.0.1" || target.hostname === "localhost" || target.hostname === "[::1]") return true;
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
    void openBrowserUrlForAutomation(url, "auto", { ownerSessionId: registry.visibleSessionId() }).catch((error) => {
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
    // loopback-fetch: CDP discovery targets Electron's local remote debugging port on 127.0.0.1.
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

  /**
   * Open a URL for an agent. The tab belongs to the conversation that asked
   * (`ownerSessionId`). When that conversation is on screen the tab surfaces as
   * before; otherwise it loads silently in the background — sized, focused,
   * and painting — without disturbing whatever the user is reading.
   */
  async function openBrowserUrlForAutomation(rawUrl, provider = "auto", { ownerSessionId = null } = {}) {
    const requestedProvider = String(provider || "auto").trim().toLowerCase();
    if (requestedProvider && requestedProvider !== "auto" && requestedProvider !== "builtin") {
      throw new Error(`Browser provider is not available yet: ${requestedProvider}`);
    }
    const url = normalizeBrowserUrl(rawUrl);
    // The marker page is loaded right away, so skip the blank initialize load:
    // a queued about:blank navigation would abort this awaited load with
    // ERR_ABORTED and fail the agent's request before the page ever opens.
    const tab = createBrowserTab("about:blank", { select: true, initializeBlank: false, ownerSessionId });
    await tab.view.webContents.loadURL(browserTargetMarkerUrl(tab.tabId));
    const targetId = await resolveBrowserCdpTargetId(tab.tabId);
    await tab.view.webContents.loadURL(url);
    return {
      provider: "builtin",
      browser_url: cdpBrowserUrl(),
      target_id: targetId,
      tab_id: tab.tabId,
      url,
      owner_session_id: registry.ownerOf(tab.tabId),
      visible: registry.surfacingFor(tab.tabId) === "foreground",
    };
  }

  function getBrowserTab(tabId = registry.onScreenTabId()) {
    return tabId ? browserTabs.get(tabId) ?? null : null;
  }

  function tabForView(view) {
    for (const tab of browserTabs.values()) {
      if (tab.view === view) return tab;
    }
    return null;
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
      ownerSessionId: registry.ownerOf(tabId),
    };
  }

  function listBrowserTabs() {
    return registry
      .list()
      .map(({ tabId }) => {
        const tab = browserTabs.get(tabId);
        if (!tab || tab.view.webContents.isDestroyed()) return null;
        return browserTabToPanelTab(tabId, tab);
      })
      .filter(Boolean);
  }

  function browserStatePayload() {
    return {
      activeTabId: registry.onScreenTabId(),
      activeTabIdByOwner: registry.activeTabIdByOwner(),
      visibleSessionId: registry.visibleSessionId(),
      tabs: listBrowserTabs(),
    };
  }

  // Read the actual native hierarchy, not the registry's intended surfacing.
  // A tab can be logically background while its native view covers the app.
  function browserNativeViews() {
    const mainWindow = window();
    const children = mainWindow?.contentView.children ?? [];
    return [...browserTabs.values()].map(({ tabId, view }) => {
      const index = children.indexOf(view);
      return {
        tabId,
        attached: index !== -1,
        // BrowserWindow's primary renderer is below the entire contentView.
        aboveApp: index !== -1,
        bounds: view.getBounds(),
      };
    });
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

  function menuOverlayBounds(point, size = { width: MENU_OVERLAY_WIDTH, height: MENU_OVERLAY_HEIGHT }) {
    const [contentWidth, contentHeight] = window()?.getContentSize?.() ?? [MENU_OVERLAY_WIDTH, MENU_OVERLAY_HEIGHT];
    const width = Math.min(size.width, contentWidth);
    const height = Math.min(size.height, contentHeight);
    return {
      x: Math.min(Math.max(point.x, 0), Math.max(contentWidth - width - 4, 0)),
      y: Math.min(Math.max(point.y, 0), Math.max(contentHeight - height - 4, 0)),
      width,
      height,
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
    const restoreFocus = !view.webContents.isDestroyed() && view.webContents.isFocused?.();
    view.setVisible?.(false);
    if (!view.webContents.isDestroyed()) view.webContents.send("openwork:menu-overlay:hide");
    try {
      if (mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.removeChildView(view);
      }
    } catch {
      // already removed
    }
    if (restoreFocus && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.focus();
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

    const request = tabMenuRequest(tab, point ? scaleRendererPoint(point) : point);
    await showMenuOverlay(request, ++menuOverlayShowSerial);
  }

  async function showLinkContextMenu({ url, point, sessionId }) {
    if (typeof url !== "string" || !isHttpUrl(url) || url.length > 32_768) return;
    const parsed = new URL(url);
    if (parsed.username || parsed.password || /[\u0000-\u001f\u007f]/.test(url)) return;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    // Capture ownership before discovery; a later focus change must not retarget
    // the link. Dismissals invalidate pending discovery through the serial.
    const ownerSessionId = normalizeSessionId(sessionId) ?? registry.visibleSessionId();
    hideMenuOverlay();
    const showSerial = ++menuOverlayShowSerial;
    const browsers = await listInstalledBrowsers();
    if (showSerial !== menuOverlayShowSerial) return;
    const items = [
      { id: "open-builtin", label: "Open in OpenWork" },
      { id: "open-external", label: "Open in Default Browser" },
      ...browsers.map(({ id, name }) => ({ id: `browser:${id}`, label: `Open in ${name}` })),
      { id: "copy-url", label: "Copy Link Address", separatorBefore: true },
    ];
    await showMenuOverlay({
      id: `link-menu:${showSerial}`,
      source: "link",
      url,
      ownerSessionId,
      browsers,
      items,
      bounds: menuOverlayBounds(scaleRendererPoint(point), { width: 264, height: items.length * 36 + 28 }),
    }, showSerial);
  }

  async function showMenuOverlay(request, showSerial) {
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
    if (!request.items.some((item) => item.id === payload.itemId && !item.disabled)) return;
    const tab = getBrowserTab(request.tabId);
    hideMenuOverlay();

    if (request.source === "link" && payload.itemId !== "copy-url") {
      runDetachedTask("open link", async () => {
        try {
          const external = payload.itemId !== "open-builtin";
          await checkPolicy?.({ url: request.url, external });
          if (!external) {
            createBrowserTab(request.url, { ownerSessionId: request.ownerSessionId, initializeBlank: false });
          } else if (payload.itemId === "open-external") {
            await shell.openExternal(request.url);
          } else {
            const browser = request.browsers.find(({ id }) => `browser:${id}` === payload.itemId);
            await browser.open(request.url);
          }
        } catch {
          const mainWindow = window();
          if (mainWindow && !mainWindow.isDestroyed()) {
            await dialog.showMessageBox(mainWindow, {
              type: "error", message: "Could not open this link",
              detail: "Your browser may be unavailable, or your organization may restrict this destination. You can copy the link address instead.",
            });
          }
        }
      });
      return;
    }

    switch (payload.itemId) {
      case "copy-url":
        if (request.url) clipboard.writeText(request.url);
        break;
      case "open-external":
        if (request.url && isHttpUrl(request.url)) {
          runDetachedTask("open browser tab externally", async () => {
            await checkPolicy?.({ url: request.url, external: true });
            await shell.openExternal(request.url);
          });
        }
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

  function createBrowserTab(url = "about:blank", { select = true, initializeBlank = true, ownerSessionId = null } = {}) {
    installPolicyRequestHook();
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
    const tab = { tabId, view, favicon: null, background: false };
    browserTabs.set(tabId, tab);
    registry.add({ tabId, ownerSessionId });
    // Load about:blank immediately to preempt persistent-session restore.
    // Cookies live on the session object, not the document — they survive this.
    // Callers that load their own page synchronously opt out, because this
    // queued navigation would otherwise abort theirs.
    if (initializeBlank) {
      runDetachedTask("initialize browser tab", () => view.webContents.loadURL("about:blank"));
    }
    view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      runDetachedTask("open browser popup", async () => {
        try { await checkPolicy?.({ url: targetUrl, external: true }); }
        catch { createBrowserTab(targetUrl, { ownerSessionId, initializeBlank: false }); return; }
        await shell.openExternal(targetUrl);
      });
      return { action: "deny" };
    });
    view.webContents.on("did-start-navigation", (_event, targetUrl, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      const target = String(targetUrl ?? "");
      // data: loads are internal plumbing (CDP target-marker pages), not
      // user-visible navigations — don't surface the panel for them.
      if (target === "about:blank" || target.startsWith("data:")) return;
      // Intercept openwork:// deep links (e.g. den-auth handoff grants) so
      // in-app browser auth works without the system protocol handler.
      if (target.startsWith("openwork://") || target.startsWith("openwork-dev://")) {
        if (typeof onDeepLink === "function") {
          onDeepLink([target]);
        }
        // Navigate the tab to about:blank to prevent the custom-scheme load
        // from erroring, then hide the panel. Avoid closing the tab
        // synchronously during a navigation event to prevent renderer crashes.
        setTimeout(() => {
          try {
            if (!view.webContents.isDestroyed()) {
              runDetachedTask("clear completed browser handoff", () => view.webContents.loadURL("about:blank"));
            }
            hideBrowserView();
          } catch { /* tab already gone */ }
        }, 200);
        return;
      }
      // Agent-driven CDP navigation can target a tab whose view is detached.
      // If the tab's conversation is on screen, bring the tab on screen,
      // otherwise navigation "succeeds" while the visible tab stays on
      // about:blank (#2015). A tab that belongs to another conversation only
      // becomes that conversation's active tab: it must never steal the
      // screen from what the user is reading.
      const surfacing = registry.surfacingFor(tabId);
      if (surfacing === "foreground" && registry.onScreenTabId() !== tabId) {
        try {
          selectBrowserTab(tabId);
        } catch {
          // The tab may be mid-close; the panel-opened event below still fires.
        }
      } else if (surfacing === "background") {
        registry.select(tabId);
        sendBrowserState();
      }
      sendToRenderer("openwork:browser:panel-opened", { ownerSessionId: registry.ownerOf(tabId) });
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
    view.webContents.on("focus", () => resetViewportEmulation(view));
    view.webContents.once("destroyed", () => {
      browserTabs.delete(tabId);
      registry.remove(tabId);
      sendBrowserState();
    });
    if (registry.surfacingFor(tabId) === "background") {
      // Silent: the owner is not on screen. Keep the page real while unseen.
      if (select) registry.select(tabId);
      enterBackgroundMode(tab);
      sendBrowserState();
    } else if (select || !registry.onScreenTabId()) {
      selectBrowserTab(tabId);
    } else {
      sendBrowserState();
    }
    if (select) {
      // Explicit opens select their page in the owner's unified panel. Later
      // navigations may keep that panel open, but must not displace an artifact
      // the user selected while a page was loading or refreshing itself.
      sendToRenderer("openwork:browser:panel-opened", {
        ownerSessionId: registry.ownerOf(tabId),
        tab: browserTabToPanelTab(tabId, tab),
      });
    }
    const finalUrl = normalizeBrowserUrl(url, "about:blank");
    if (finalUrl !== "about:blank") {
      runDetachedTask("navigate new browser tab", () => view.webContents.loadURL(finalUrl));
    }
    return tab;
  }

  function detachBrowserView(view) {
    if (!view) return;
    for (const host of [window(), backgroundWindow]) {
      try {
        if (host && !host.isDestroyed() && host.contentView.children.includes(view)) {
          host.contentView.removeChildView(view);
        }
      } catch {
        // already removed
      }
    }
  }

  function backgroundBrowserWindow() {
    if (!backgroundWindow || backgroundWindow.isDestroyed()) {
      backgroundWindow = new BrowserWindow({
        ...BACKGROUND_TAB_VIEWPORT,
        show: false,
        paintWhenInitiallyHidden: true,
        focusable: false,
        skipTaskbar: true,
        webPreferences: { backgroundThrottling: false, sandbox: true },
      });
    }
    return backgroundWindow;
  }

  // A tab whose conversation is not on screen must still behave like a real
  // page for the agent driving it: lay out at a real viewport, accept typing as
  // a focused page, and paint so CDP screenshots work. Park it in a never-shown
  // window: detached views stop painting, and every child of the main window's
  // contentView paints above OpenWork, regardless of its child index or bounds.
  // Moving the same view preserves the document and CDP target.
  function enterBackgroundMode(tab) {
    if (!tab || tab.background) return;
    const webContents = tab.view.webContents;
    if (webContents.isDestroyed()) return;
    tab.background = true;
    detachBrowserView(tab.view);
    tab.view.setBounds({ x: 0, y: 0, ...BACKGROUND_TAB_VIEWPORT });
    backgroundBrowserWindow().contentView.addChildView(tab.view);
    const cdp = webContents.debugger;
    runDetachedTask("emulate background browser tab", async () => {
      if (webContents.isDestroyed() || !tab.background) return;
      if (!cdp.isAttached()) cdp.attach("1.3");
      for (const { method, params } of backgroundTabEmulationCommands()) {
        if (!tab.background) return;
        await cdp.sendCommand(method, params);
      }
    });
  }

  function exitBackgroundMode(tab) {
    if (!tab || !tab.background) return;
    tab.background = false;
    const webContents = tab.view.webContents;
    detachBrowserView(tab.view);
    if (webContents.isDestroyed()) return;
    const cdp = webContents.debugger;
    if (!cdp.isAttached()) return;
    runDetachedTask("restore foreground browser tab", async () => {
      try {
        for (const { method, params } of foregroundTabEmulationCommands()) {
          if (webContents.isDestroyed()) return;
          await cdp.sendCommand(method, params);
        }
      } finally {
        if (!webContents.isDestroyed() && cdp.isAttached()) cdp.detach();
      }
    });
  }

  /** Re-evaluate every tab after the on-screen conversation changed. */
  function applySurfacing() {
    for (const tab of browserTabs.values()) {
      if (registry.surfacingFor(tab.tabId) === "background") enterBackgroundMode(tab);
      else exitBackgroundMode(tab);
    }
  }

  function setVisibleSession(sessionId) {
    const previous = registry.visibleSessionId();
    const next = registry.setVisibleSession(sessionId);
    if (next === previous) return next;
    hideMenuOverlay();
    applySurfacing();
    attachActiveBrowserView();
    sendBrowserState();
    return next;
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

  // Automation clients (docs shots, screenshot skills, Playwright) attach to a
  // tab over CDP and emulate a viewport with Emulation.setDeviceMetricsOverride.
  // Chromium keeps that emulated size after the client disconnects, so the page
  // keeps laying out for e.g. 1440x900 inside a 400px panel and shows up
  // clipped. Only a DevTools session that owns an override can drop it: take a
  // brief session of our own, set a disabled (zero) override, then clear it.
  // Call this on user-driven moments only — panel show, tab select, focus —
  // so a capture in progress is not disturbed by background navigation.
  function resetViewportEmulation(view) {
    const webContents = view?.webContents;
    if (!webContents || webContents.isDestroyed()) return;
    // A background tab's viewport is ours on purpose; it is restored when the
    // tab comes back on screen.
    if (tabForView(view)?.background) return;
    const cdp = webContents.debugger;
    if (cdp.isAttached()) return;
    runDetachedTask("reset browser viewport emulation", async () => {
      cdp.attach("1.3");
      try {
        await cdp.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 0,
          height: 0,
          deviceScaleFactor: 0,
          mobile: false,
        });
        await cdp.sendCommand("Emulation.clearDeviceMetricsOverride");
      } finally {
        if (cdp.isAttached()) cdp.detach();
      }
    });
  }

  /** Detach every view that is neither on screen nor a background presence. */
  function detachIdleBrowserViews(keepView = null) {
    for (const tab of browserTabs.values()) {
      if (tab.view !== keepView && !tab.background) detachBrowserView(tab.view);
    }
  }

  function attachActiveBrowserView() {
    const mainWindow = window();
    if (!mainWindow || !browserViewVisible) return;
    if (!lastBrowserBounds || lastBrowserBounds.width <= 0 || lastBrowserBounds.height <= 0) return;
    const tab = getBrowserTab();
    if (!tab) return;
    exitBackgroundMode(tab);
    detachIdleBrowserViews(tab.view);
    // Size before attaching so a restored view never flashes at stale bounds.
    tab.view.setBounds(scaleRendererBounds(lastBrowserBounds));
    if (!mainWindow.contentView.children.includes(tab.view)) {
      mainWindow.contentView.addChildView(tab.view);
    }
  }

  function selectBrowserTab(tabId) {
    const tab = browserTabs.get(tabId);
    if (!tab) throw new Error(`Unknown browser tab: ${tabId}`);
    hideMenuOverlay();
    const previousView = getActiveBrowserView();
    registry.select(tabId);
    if (registry.surfacingFor(tabId) === "foreground") {
      if (previousView && previousView !== tab.view && !tabForView(previousView)?.background) {
        detachBrowserView(previousView);
      }
      attachActiveBrowserView();
    }
    sendBrowserState();
    return tab;
  }

  function closeBrowserTab(tabId = registry.onScreenTabId()) {
    const tab = getBrowserTab(tabId);
    if (!tab) return null;
    if (menuOverlayRequest?.tabId === tabId) hideMenuOverlay();
    const wasOnScreen = registry.onScreenTabId() === tabId;
    tab.background = false;
    detachBrowserView(tab.view);
    browserTabs.delete(tabId);
    const removed = registry.remove(tabId);
    if (wasOnScreen) {
      if (registry.onScreenTabId()) {
        attachActiveBrowserView();
      } else {
        hideBrowserView();
      }
    }
    if (removed && !removed.ownerHasTabs) {
      sendToRenderer("openwork:browser:panel-closed", { ownerSessionId: removed.tab.ownerSessionId });
    }
    try { tab.view.webContents.close(); } catch { /* already destroyed */ }
    sendBrowserState();
    return tabId;
  }

  function closeAllBrowserTabs() {
    const closedTabIds = registry.list().map((tab) => tab.tabId);
    if (closedTabIds.length === 0) return [];
    hideMenuOverlay();
    const tabsToClose = closedTabIds
      .map((tabId) => browserTabs.get(tabId))
      .filter(Boolean);
    const owners = new Set(closedTabIds.map((tabId) => registry.ownerOf(tabId)));
    for (const tab of tabsToClose) tab.background = false;
    hideBrowserView();
    browserTabs.clear();
    registry.clear();
    for (const tab of tabsToClose) {
      try { tab.view.webContents.close(); } catch { /* already destroyed */ }
    }
    for (const ownerSessionId of owners) {
      sendToRenderer("openwork:browser:panel-closed", { ownerSessionId });
    }
    sendBrowserState();
    return closedTabIds;
  }

  function reorderBrowserTabs(tabIds) {
    registry.reorder(tabIds);
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
   * @param {string | null} [opts.sessionId] - the conversation whose panel is showing
   */
  function attachBrowserView(bounds, { preloadDefault = false, ensureTab = false, sessionId } = {}) {
    if (!window()) return;
    lastBrowserBounds = bounds;
    browserViewVisible = true;
    if (sessionId !== undefined) {
      const previous = registry.visibleSessionId();
      if (registry.setVisibleSession(sessionId) !== previous) applySurfacing();
    }
    if (ensureTab && !registry.onScreenTabId()) {
      createBrowserTab("about:blank", { ownerSessionId: registry.visibleSessionId() });
    }
    const view = getActiveBrowserView();
    attachActiveBrowserView();
    if (bounds.width > 0 && bounds.height > 0) {
      view?.setBounds(scaleRendererBounds(bounds));
    }
    resetViewportEmulation(view);
    const url = view?.webContents.getURL();
    if (preloadDefault && (!url || url === "about:blank")) {
      runDetachedTask("load browser default page", () => view?.webContents.loadURL(BROWSER_DEFAULT_URL));
    }
    sendBrowserState();
  }

  function hideBrowserView() {
    hideMenuOverlay();
    browserViewVisible = false;
    if (!window()) return;
    detachIdleBrowserViews();
  }

  function destroyBrowserView() {
    hideBrowserView();
    const overlayView = menuOverlayView;
    menuOverlayView = null;
    menuOverlayRequest = null;
    try { overlayView?.webContents.close(); } catch { /* already destroyed */ }
    for (const tab of browserTabs.values()) {
      tab.background = false;
      detachBrowserView(tab.view);
      try { tab.view.webContents.close(); } catch { /* already destroyed */ }
    }
    browserTabs.clear();
    registry.clear();
    if (backgroundWindow && !backgroundWindow.isDestroyed()) backgroundWindow.destroy();
    backgroundWindow = null;
    lastBrowserBounds = null;
    sendBrowserState();
  }

  function normalizeSessionId(value) {
    return typeof value === "string" && value.trim() ? value : null;
  }

  function registerIpc(ipcMain) {
    ipcMain.handle("openwork:browser:show", (_event, bounds, sessionId) => (
      attachBrowserView(bounds, sessionId === undefined ? {} : { sessionId: normalizeSessionId(sessionId) })
    ));
    ipcMain.handle("openwork:browser:hide", () => hideBrowserView());
    ipcMain.handle("openwork:browser:setVisibleSession", (_event, sessionId) => setVisibleSession(normalizeSessionId(sessionId)));
    ipcMain.handle("openwork:browser:openUrl", (_event, url, provider, options) => (
      openBrowserUrlForAutomation(url, provider, {
        ownerSessionId: normalizeSessionId(options && typeof options === "object" ? options.sessionId : null),
      })
    ));
    ipcMain.handle("openwork:browser:navigate", (_event, url) => {
      const view = getActiveBrowserView()
        ?? createBrowserTab("about:blank", { select: true, ownerSessionId: registry.visibleSessionId() }).view;
      runDetachedTask("navigate browser tab", () => view.webContents.loadURL(normalizeBrowserUrl(url)));
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
    ipcMain.handle("openwork:browser:state", () => ({
      ...browserStatePayload(),
      nativeViews: browserNativeViews(),
      backgroundWindowVisible: Boolean(backgroundWindow && !backgroundWindow.isDestroyed() && backgroundWindow.isVisible()),
      visibleWindowCount: BrowserWindow.getAllWindows().filter((host) => host.isVisible()).length,
    }));
    ipcMain.handle("openwork:browser:createTab", (_event, url, sessionId) => {
      const target = typeof url === "string" && url.trim() ? url : BROWSER_NEW_TAB_URL;
      const ownerSessionId = sessionId === undefined ? registry.visibleSessionId() : normalizeSessionId(sessionId);
      const tab = createBrowserTab(target, { select: true, ownerSessionId });
      return { tabId: tab.tabId };
    });
    ipcMain.handle("openwork:browser:closeTab", (_event, tabId) => closeBrowserTab(tabId == null ? undefined : String(tabId)));
    ipcMain.handle("openwork:browser:closeAllTabs", () => closeAllBrowserTabs());
    ipcMain.handle("openwork:browser:selectTab", (_event, tabId) => {
      const tab = selectBrowserTab(String(tabId ?? ""));
      resetViewportEmulation(tab.view);
      return tab.tabId;
    });
    ipcMain.handle("openwork:browser:reorderTabs", (_event, tabIds) => reorderBrowserTabs(tabIds));
    ipcMain.handle("openwork:browser:listTabs", () => listBrowserTabs());
    ipcMain.handle("openwork:browser:setProxy", (_event, proxy) => setBrowserProxy(proxy));
    ipcMain.handle("openwork:browser:getProxy", () => browserProxyState());
    ipcMain.handle("openwork:browser:tabContextMenu", (_event, tabId, point) => showBrowserTabContextMenu(tabId, point));
    ipcMain.on("openwork:browser:linkContextMenu", (event, payload) => {
      const mainContents = window()?.webContents;
      if (event.sender !== mainContents || event.senderFrame !== mainContents?.mainFrame) return;
      if (!payload || typeof payload !== "object") return;
      runDetachedTask("show link context menu", () => showLinkContextMenu(payload));
    });
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
