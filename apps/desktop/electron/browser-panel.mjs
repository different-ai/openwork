// Embedded browser panel: tab state, BrowserView lifecycle, native context menus,
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
import { BrowserTaskError, createBrowserTaskHost } from "./browser-task.mjs";
import { createWebMcpBroker } from "./webmcp-host.mjs";
import { createWebMcpFramePolicy } from "./webmcp-policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_SESSION_PARTITION = "persist:openwork-browser";
const BROWSER_DEFAULT_URL = "about:blank";
// URL a user-initiated new tab (the "+" button / opening the browser panel)
// lands on. The agent's programmatic path keeps BROWSER_DEFAULT_URL.
const BROWSER_NEW_TAB_URL = "https://www.google.com";
// Bound native page allocation across conversations. Refuse new work rather
// than evicting a live document (unsaved input and CDP handles cannot be restored
// from a URL). This is a tab bound, not a Chromium process or memory limit.
const MAX_BROWSER_TABS = 12;
const BROWSER_TARGET_RESOLVE_TIMEOUT_MS = 2500;
const BROWSER_SECURITY_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  // Run the isolated preload in each iframe. Sandboxing still disables Node
  // in website JavaScript, including opener-linked popup contents.
  nodeIntegrationInSubFrames: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
});

export function createBrowserPanel({ getWindow, remoteDebugPort, onDeepLink, checkPolicy, showNativeContextMenu, closeNativeContextMenu }) {
  let browserSessionHooksInstalled = false;
  function installBrowserSessionHooks() {
    if (browserSessionHooksInstalled) return;
    // The manager is constructed before app.whenReady(). Only acquire the
    // Electron session when creating a tab, after native window setup.
    const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
    browserSession.on("will-download", (_event, item, contents) => {
      const tab = [...browserTabs.values()].find((candidate) => candidate.view.webContents === contents);
      if (!tab) return;
      tab.downloads.add(item);
      item.once("done", () => tab.downloads.delete(item));
    });
    browserSessionHooksInstalled = true;
    if (!checkPolicy) return;
    // The session request boundary covers normal navigation, redirects, frames,
    // scripted fetches and CDP navigation; window navigation events do not.
    browserSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      if (["about:", "data:", "blob:"].some((scheme) => details.url.startsWith(scheme))) { callback({ cancel: false }); return; }
      const tab = [...browserTabs.values()].find((item) => item.view.webContents.id === details.webContentsId);
      const owner = registry.ownerOf(tab?.tabId);
      const documentGeneration = tab?.documentGeneration;
      const guard = details.resourceType === "mainFrame" ? taskHost.navigationGuard(tab?.tabId) : null;
      const request = { url: details.url, method: details.method, hasUpload: Boolean(details.uploadData?.length) };
      Promise.resolve().then(async () => {
        await checkPolicy(request);
        if (guard) {
          const validate = await guard(details.url);
          await checkPolicy(request);
          return validate;
        }
      })
        .then((validate) => {
          try {
            validate?.();
            if (tab && details.resourceType === "mainFrame" && (getBrowserTab(tab.tabId) !== tab || tab.view.webContents.isDestroyed() || registry.ownerOf(tab.tabId) !== owner)) throw new Error("Browser navigation owner changed");
          } catch { callback({ cancel: true }); return; }
          callback({ cancel: false });
        }, (error) => {
          if (tab && getBrowserTab(tab.tabId) === tab && !tab.view.webContents.isDestroyed()
            && registry.ownerOf(tab.tabId) === owner && tab.documentGeneration === documentGeneration
            && (error?.code === "policy_unavailable" || error?.code === "organization_policy_denied")) {
            tab.loadError = {
              code: error.code,
              message: error.code === "organization_policy_denied"
                ? "This page may be incomplete. Your organization's policy blocked a browser request."
                : "This page may be incomplete. Your organization's policy could not be verified.",
            };
            sendBrowserState();
          }
          callback({ cancel: true });
        });
    });
  }
  // tabId -> { tabId, view, favicon, background }. Order, ownership, the active
  // tab per conversation, and which conversation is on screen live in the
  // registry; this map only holds the native views.
  let browserSession = null;
  let webMcpFramePolicy = null;
  function ensureBrowserSession() {
    if (!browserSession) {
      browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
      // Capture the first response, before a view can load any document.
      webMcpFramePolicy = createWebMcpFramePolicy(browserSession);
      webMcpFramePolicy.install();
    }
    return browserSession;
  }
  function ensureWebMcpFramePolicy() {
    ensureBrowserSession();
    return webMcpFramePolicy;
  }
  const browserTabs = new Map();
  const suspendedTabs = new Map();
  const registry = createBrowserTabRegistry();
  let browserViewVisible = false;
  let backgroundWindow = null;
  // Last accepted geometry in window DIPs. Reattaching must not scale an old
  // CSS rectangle with a newer zoom while the renderer is still catching up.
  let lastBrowserBounds = null;
  let browserTabCounter = 0;
  // Active proxy for the built-in browser session: { rules, username, password }.
  let browserProxy = null;
  let browserControlEnabled = true;
  let menuRequest = null;
  let menuShowSerial = 0;
  const webMcpRefreshTimers = new Map();

  function window() {
    return getWindow?.() ?? null;
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

  async function browserTaskAllowed(url) {
    if (!browserControlEnabled || typeof checkPolicy !== "function") return false;
    try {
      await checkPolicy({ url });
      return browserControlEnabled;
    } catch {
      return false;
    }
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
    const ownerSessionId = registry.visibleSessionId();
    runDetachedTask("open linked browser page", () => openBrowserUrlForAutomation(url, "builtin", { ownerSessionId }));
  }

  function cdpBrowserUrl() {
    return `http://127.0.0.1:${remoteDebugPort}`;
  }

  /**
   * Open a URL for an agent. The tab belongs to the conversation that asked
   * (`ownerSessionId`). When that conversation is on screen the tab surfaces as
   * before; a new origin waits for review without contacting the destination
   * or switching the visible conversation.
   */
  async function openBrowserUrlForAutomation(rawUrl, provider = "auto", { ownerSessionId = null } = {}) {
    const requestedProvider = String(provider || "auto").trim().toLowerCase();
    const url = normalizeBrowserUrl(rawUrl);
    const result = await taskHost.request({ sessionId: ownerSessionId, operation: "open", args: { url, provider: requestedProvider } });
    if (!result.ok) throw new BrowserTaskError(result.code, result.error);
    // Electron supplies the exact target without a marker navigation or focus.
    const targetId = getBrowserTab(result.tabId).view.webContents.getOrCreateDevToolsTargetId();
    return {
      provider: "builtin",
      browser_url: cdpBrowserUrl(),
      target_id: targetId,
      tab_id: result.tabId,
      url: getBrowserTab(result.tabId).view.webContents.getURL(),
      owner_session_id: registry.ownerOf(result.tabId),
      visible: registry.surfacingFor(result.tabId) === "foreground",
    };
  }

  async function openBrowserTab(url, ownerSessionId, signal = undefined, beforeLoad = undefined) {
    signal?.throwIfAborted();
    const tab = createBrowserTab("about:blank", { select: true, initializeBlank: false, deferBackground: true, ownerSessionId, automationProtected: true });
    tab.operation = true;
    const stop = () => {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.stop();
      closeBrowserTab(tab.tabId);
    };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      await beforeLoad?.(tab);
      signal?.throwIfAborted();
      if (getBrowserTab(tab.tabId) !== tab || tab.view.webContents.isDestroyed() || registry.ownerOf(tab.tabId) !== ownerSessionId) throw new BrowserTaskError("tab_closed", "The browser tab closed or changed owner before navigation.");
      await tab.view.webContents.loadURL(url); signal?.throwIfAborted();
      tab.deferBackground = false;
      applySurfacing();
      await tab.emulation;
      signal?.throwIfAborted();
      return tab;
    }
    catch (error) {
      // No usable handle was returned; retries must not retain abandoned pages.
      closeBrowserTab(tab.tabId);
      throw error;
    }
    finally { signal?.removeEventListener("abort", stop); tab.operation = false; sendBrowserState(); }
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
    if (getBrowserTab()?.suspending) throw new Error("Browser tab is suspending.");
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
      status: tab.suspending ? "suspending" : tab.operation ? "restoring" : isLoading ? "loading" : "ready",
      automationProtected: tab.automationProtected,
      canGoBack: webContents.canGoBack(),
      canGoForward: webContents.canGoForward(),
      ownerSessionId: registry.ownerOf(tabId),
      browserApproval: tab.browserApproval ?? null,
      loadError: tab.loadError,
      browserTask: tab.browserTask ?? { status: "idle", operation: null },
      siteToolCount: Number.isInteger(tab.webMcpToolCount) ? tab.webMcpToolCount : 0,
      siteTools: Array.isArray(tab.webMcpTools) ? tab.webMcpTools : [],
      siteToolActivity: Array.isArray(tab.webMcpActivity) ? tab.webMcpActivity : [],
    };
  }

  function listBrowserTabs() {
    return registry
      .list()
      .map(({ tabId }) => {
        const tab = browserTabs.get(tabId);
        if (!tab || tab.view.webContents.isDestroyed()) return suspendedTabs.get(tabId) ?? null;
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
        visible: view.getVisible(),
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

  function normalizeMenuPoint(point) {
    if (!point || typeof point !== "object") {
      return { x: 0, y: 0 };
    }
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { x: 0, y: 0 };
    }
    return { x, y };
  }

  function hideContextMenu() {
    if (!menuRequest) return;
    menuShowSerial += 1;
    menuRequest = null;
    closeNativeContextMenu();
  }

  function tabMenuRequest(tab, point) {
    const url = browserTabUrl(tab);
    return {
      source: "tab",
      tabId: tab.tabId,
      ownerSessionId: registry.ownerOf(tab.tabId),
      url,
      point: normalizeMenuPoint(point),
      items: [
        { type: "item", id: "copy-url", label: "Copy URL", enabled: !!url },
        { type: "item", id: "open-external", label: "Open in Browser", enabled: !!url && isHttpUrl(url) },
        { type: "separator" },
        { type: "item", id: "close-tab", label: "Close Tab" },
        { type: "item", id: "close-all-tabs", label: "Close All Tabs" },
      ],
    };
  }

  async function showBrowserTabContextMenu(tabId, point) {
    const tab = getBrowserTab(String(tabId ?? ""));
    if (!window() || !tab || tab.view.webContents.isDestroyed()) return;

    await showContextMenu(tabMenuRequest(tab, point));
  }

  async function showLinkContextMenu({ url, point, sessionId }) {
    if (typeof url !== "string" || !isHttpUrl(url) || url.length > 32_768) return;
    const parsed = new URL(url);
    if (parsed.username || parsed.password || /[\u0000-\u001f\u007f]/.test(url)) return;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    // Capture ownership before discovery; a later focus change must not retarget
    // the link. Dismissals invalidate pending discovery through the serial.
    const ownerSessionId = normalizeSessionId(sessionId) ?? registry.visibleSessionId();
    await showContextMenu({
      source: "link",
      url,
      ownerSessionId,
      point: normalizeMenuPoint(point),
    });
  }

  async function showPageContextMenu(tab, params) {
    if (!browserTabVisible(tab.tabId)) return;
    const contents = tab.view.webContents;
    const items = [];
    const actions = new Map();
    const add = (id, label, action, enabled = true) => {
      items.push({ type: "item", id, label, enabled });
      actions.set(id, action);
    };
    const separator = () => { if (items.length) items.push({ type: "separator" }); };
    if (params.linkURL) {
      add("open-new-tab", "Open Link in New Tab", null, isHttpUrl(params.linkURL));
      add("copy-link", "Copy Link Address", () => clipboard.writeText(params.linkURL));
    }
    if (params.mediaType === "image") {
      separator();
      add("copy-image", "Copy Image", () => contents.copyImageAt(params.x, params.y), params.hasImageContents === true);
      if (params.srcURL) add("copy-image-address", "Copy Image Address", () => clipboard.writeText(params.srcURL));
    }
    if (params.isEditable || params.selectionText) {
      separator();
      const edit = (id, label, flag) => add(id, label, () => contents[id](), params.editFlags?.[flag] === true);
      if (params.isEditable) {
        edit("undo", "Undo", "canUndo");
        edit("redo", "Redo", "canRedo");
        separator();
        edit("cut", "Cut", "canCut");
      }
      edit("copy", "Copy", "canCopy");
      if (params.isEditable) {
        edit("paste", "Paste", "canPaste");
        edit("selectAll", "Select All", "canSelectAll");
      }
    }
    if (!params.isEditable && !params.selectionText && !params.linkURL && params.mediaType !== "image") {
      add("back", "Back", () => contents.goBack(), contents.canGoBack());
      add("forward", "Forward", () => contents.goForward(), contents.canGoForward());
      add("reload", "Reload", () => contents.reload());
    }
    // Chromium supplies view-relative coordinates, already in window DIPs.
    // Convert to app CSS pixels for the shared helper, not through page zoom.
    const bounds = tab.view.getBounds();
    const appZoom = window().webContents.getZoomFactor();
    await showContextMenu({
      source: "page", tabId: tab.tabId, ownerSessionId: registry.ownerOf(tab.tabId),
      url: params.linkURL, items, actions,
      point: { x: (bounds.x + params.x) / appZoom, y: (bounds.y + params.y) / appZoom },
    });
  }

  async function showContextMenu(request) {
    hideContextMenu();
    const showSerial = ++menuShowSerial;
    const mainWindow = window();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    const tab = request.tabId ? getBrowserTab(request.tabId) : null;
    const isCurrent = () => showSerial === menuShowSerial && window() === mainWindow
      && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()
      && (!tab || (getBrowserTab(tab.tabId) === tab && !tab.view.webContents.isDestroyed() && registry.ownerOf(tab.tabId) === request.ownerSessionId))
      && (request.source !== "page" || browserTabVisible(request.tabId));
    const dismiss = () => { if (menuRequest === request) hideContextMenu(); };
    const invalidate = () => {
      if (showSerial !== menuShowSerial) return;
      dismiss();
      menuShowSerial += 1;
    };
    const navigated = (_event, _url, _isInPlace, isMainFrame) => { if (isMainFrame || request.source === "page") invalidate(); };
    menuRequest = request;
    mainWindow.on("blur", dismiss);
    mainWindow.webContents.on("did-start-navigation", navigated);
    mainWindow.webContents.on("destroyed", invalidate);
    tab?.view.webContents.on("did-start-navigation", navigated);
    try {
      if (request.source === "link") {
        request.browsers = await listInstalledBrowsers();
        if (!isCurrent()) return;
        request.items = [
          { type: "item", id: "open-builtin", label: "Open in OpenWork" },
          { type: "item", id: "open-external", label: "Open in Default Browser" },
          ...request.browsers.map(({ id, name }) => ({ type: "item", id: `browser:${id}`, label: `Open in ${name}` })),
          { type: "separator" },
          { type: "item", id: "copy-url", label: "Copy Link Address" },
        ];
      }
      // The native helper owns zoom conversion and resolves only an ID or null.
      const itemId = await showNativeContextMenu({ items: request.items, point: request.point });
      if (!isCurrent()) return;
      menuRequest = null;
      if (!request.items.some((item) => item.type === "item" && item.id === itemId && item.enabled !== false)) return;
      // Once selected, changing conversations must not retarget or cancel the
      // captured link. A newer menu or destroyed document still invalidates it.
      await handleMenuChoice(request, itemId, isCurrent);
    } finally {
      dismiss();
      mainWindow.removeListener("blur", dismiss);
      mainWindow.webContents.removeListener("did-start-navigation", navigated);
      mainWindow.webContents.removeListener("destroyed", invalidate);
      tab?.view.webContents.removeListener("did-start-navigation", navigated);
    }
  }

  async function handleMenuChoice(request, itemId, isCurrent) {
    const tab = getBrowserTab(request.tabId);

    if ((request.source === "link" && itemId !== "copy-url") || (request.source === "page" && itemId === "open-new-tab")) {
      try {
        const external = request.source === "link" && itemId !== "open-builtin";
        await checkPolicy?.({ url: request.url, external });
        if (!isCurrent()) return;
        if (!external) {
          createBrowserTab(request.url, { ownerSessionId: request.ownerSessionId, initializeBlank: false });
        } else if (itemId === "open-external") {
          await shell.openExternal(request.url);
        } else {
          const browser = request.browsers.find(({ id }) => `browser:${id}` === itemId);
          await browser.open(request.url);
        }
      } catch (error) {
        if (isCurrent()) {
          await dialog.showMessageBox(window(), {
            type: "error", message: "Could not open this link",
            detail: error instanceof Error ? error.message : "Your browser may be unavailable, or your organization may restrict this destination. You can copy the link address instead.",
          });
        }
      }
      return;
    }

    if (request.source === "page") {
      request.actions.get(itemId)?.();
      return;
    }

    switch (itemId) {
      case "copy-url":
        if (request.url) clipboard.writeText(request.url);
        break;
      case "open-external":
        if (request.url && isHttpUrl(request.url)) {
          await checkPolicy?.({ url: request.url, external: true });
          if (isCurrent()) await shell.openExternal(request.url);
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

  const approvals = new Map();
  function browserTabVisible(tabId) {
    const tab = getBrowserTab(tabId);
    return !!tab && browserViewVisible && registry.onScreenTabId() === tabId
      && window()?.contentView.children.includes(tab.view) === true && tab.view.getVisible();
  }
  function confirmBrowserAction({ tabId, title, message, detail, signal, approveLabel = "Allow once", waitForVisible = false }) {
    const tab = getBrowserTab(tabId);
    const owner = registry.ownerOf(tabId);
    if (!tab || (!waitForVisible && !browserTabVisible(tabId)) || signal?.aborted) return Promise.resolve(false);
    if (approvals.has(tabId)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = createBrowserTabId();
      const finish = (allowed) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", canceled);
        if (approvals.get(tabId)?.id !== id) return;
        approvals.delete(tabId); tab.browserApproval = null;
        if (!tab.view.webContents.isDestroyed()) tab.view.setVisible(true);
        sendBrowserState(); resolve(allowed && !signal?.aborted && getBrowserTab(tabId) === tab && registry.ownerOf(tabId) === owner && browserTabVisible(tabId));
      };
      const canceled = () => finish(false);
      const timer = setTimeout(canceled, 60_000);
      approvals.set(tabId, { id, finish });
      tab.browserApproval = { id, title, message, detail, approveLabel };
      tab.view.setVisible(false);
      signal?.addEventListener("abort", canceled, { once: true });
      sendBrowserState();
    });
  }
  async function confirmWebMcpExecution({ tool, inputSummary, tabId, signal }) {
    return confirmBrowserAction({ tabId, signal, title: "Allow website action?",
      message: `Allow ${tool.origin} to run “${tool.name}”?`,
      detail: `This website tool may change data. Arguments: ${inputSummary}` });
  }

  const webMcpBroker = createWebMcpBroker({
    getTab: (tabId) => getBrowserTab(tabId),
    getActiveTabId: (sessionId) => registry.activeTabIdFor(sessionId),
    assertTabAccess: async (tabId, sessionId) => {
      if (!sessionId || registry.ownerOf(tabId) !== sessionId) throw new Error("wrong_conversation");
      const tab = getBrowserTab(tabId);
      if (!tab || !await browserTaskAllowed(tab.view.webContents.getURL())) throw new Error("website_blocked");
    },
    confirmExecution: confirmWebMcpExecution,
    confirmResultDisclosure: ({ tabId, signal, tool, resultText }) => confirmBrowserAction({
      tabId, signal, title: "Share website result?", approveLabel: "Share result",
      message: `Share the result from ${tool.origin} with this conversation and its model provider?`,
      detail: `The website action has already run. Review this complete result for passwords, session cookies, tokens or other private data before sharing. Denying keeps the result out of the conversation and does not undo the action.\n\n${resultText}`,
    }),
    isFrameAllowed: async (frame) => await browserTaskAllowed(frame.url) && ensureWebMcpFramePolicy().checkFrame(frame),
    onActivity: (activity) => {
      const tab = getBrowserTab(activity.tabId);
      if (!tab) return;
      tab.webMcpActivity = [activity, ...(tab.webMcpActivity ?? [])].slice(0, 20);
      sendBrowserState();
    },
    onToolCountChanged: (tabId, count) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return;
      tab.webMcpToolCount = count;
      sendBrowserState();
    },
    onToolsChanged: (tabId, tools) => {
      const tab = getBrowserTab(tabId);
      if (!tab) return;
      tab.webMcpTools = tools;
      tab.webMcpToolCount = tools.length;
      sendBrowserState();
    },
  });


  const taskHost = createBrowserTaskHost({
    getTab: getBrowserTab,
    tabsFor: (sessionId) => registry.tabsFor(sessionId).map((item) => getBrowserTab(item.tabId)).filter(Boolean),
    ownerOf: (tabId) => registry.ownerOf(tabId),
    activeFor: (sessionId) => registry.activeTabIdFor(sessionId),
    isVisible: browserTabVisible,
    enabled: () => browserControlEnabled,
    allowed: browserTaskAllowed,
    openTab: openBrowserTab,
    navigate: (tab, url) => tab.view.webContents.loadURL(url),
    confirm: confirmBrowserAction,
    changed: (tabId, activity) => { const tab = getBrowserTab(tabId); if (tab) { tab.browserTask = activity; sendBrowserState(); } },
    siteTools: (args) => webMcpBroker.listTools(args),
    runSiteTool: (args, options) => webMcpBroker.executeTool(args, options),
  });

  function scheduleWebMcpToolCountRefresh(tabId) {
    if (!tabId || webMcpRefreshTimers.has(tabId)) return;
    const timer = setTimeout(() => {
      webMcpRefreshTimers.delete(tabId);
      void webMcpBroker.refreshTabToolCount(tabId);
    }, 250);
    webMcpRefreshTimers.set(tabId, timer);
  }

  function invalidateWebMcpTab(tab) {
    if (!tab) return;
    taskHost.invalidate(tab.tabId);
    tab.webMcpRevision = (Number.isInteger(tab.webMcpRevision) ? tab.webMcpRevision : 0) + 1;
    tab.webMcpToolCount = 0;
    tab.webMcpTools = [];
    webMcpBroker.invalidateTab(tab.tabId);
  }

  async function setBrowserProxy(proxyInput) {
    const browserSession = ensureBrowserSession();
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

  function createBrowserTab(url = "about:blank", { select = true, initializeBlank = true, deferBackground = false, ownerSessionId = null, restoreTabId = null, automationProtected = false, contentsOptions = /** @type {import("electron").WebContentsViewConstructorOptions} */ ({}) } = {}) {
    // Check synchronously before creating a WebContentsView, including pending
    // opens, popups, transcript links and the tab-strip button.
    if (browserTabs.size >= MAX_BROWSER_TABS) {
      throw new BrowserTaskError("tab_limit", `OpenWork has ${MAX_BROWSER_TABS} browser tabs open. Close an unused browser tab in any conversation, then try again.`);
    }
    if (!restoreTabId && registry.size() >= 100) throw new Error("OpenWork has 100 saved browser tabs. Close an unused tab, then try again.");
    installBrowserSessionHooks();
    ensureWebMcpFramePolicy();
    const tabId = restoreTabId ?? createBrowserTabId();
    const view = new WebContentsView({
      ...contentsOptions,
      webPreferences: {
        ...contentsOptions.webPreferences,
        backgroundThrottling: false,
        ...BROWSER_SECURITY_PREFERENCES,
        preload: path.join(__dirname, "browser-content-preload.cjs"),
        partition: BROWSER_SESSION_PARTITION,
      },
    });
    const tab = {
      tabId, view, favicon: null, background: false, automationProtected,
      deferBackground,
      operation: false, suspending: false, mediaPlaying: false, downloads: new Set(),
      domReady: false, emulation: Promise.resolve(),
      /** @type {((error: Error | null) => void) | null} */
      finishSuspension: null,
      webMcpRevision: 0,
      documentGeneration: 0,
      /** @type {import("@openwork/browser-tabs").BrowserPanelTab["loadError"]} */
      loadError: null,
      webMcpToolCount: 0,
      webMcpTools: [],
      webMcpActivity: [],
    };
    browserTabs.set(tabId, tab);
    if (!restoreTabId) registry.add({ tabId, ownerSessionId });
    view.webContents.on("context-menu", (_event, params) => {
      runDetachedTask("show browser page menu", () => showPageContextMenu(tab, params));
    });
    view.webContents.once("dom-ready", () => {
      tab.domReady = true;
      if (tab.background) emulateBackgroundTab(tab);
    });
    view.webContents.on("media-started-playing", () => { tab.mediaPlaying = true; });
    view.webContents.on("media-paused", () => { tab.mediaPlaying = false; });
    view.webContents.on("will-prevent-unload", () => {
      // Do not preventDefault: the page's beforeunload veto must win.
      if (!tab.suspending || browserTabs.get(tabId) !== tab) return;
      tab.suspending = false;
      suspendedTabs.delete(tabId);
      tab.finishSuspension?.(new Error("The page prevented suspension."));
      sendBrowserState();
    });
    // Load about:blank immediately to preempt persistent-session restore.
    // Cookies live on the session object, not the document — they survive this.
    // Callers that load their own page synchronously opt out, because this
    // queued navigation would otherwise abort theirs.
    if (initializeBlank) {
      runDetachedTask("initialize browser tab", () => view.webContents.loadURL("about:blank"));
    }
    view.webContents.setWindowOpenHandler(({ url: targetUrl, disposition }) => {
      if (!/^https?:\/\//i.test(targetUrl)) return { action: "deny" };
      // The shared all-request policy hook checks popup requests too. Never
      // fall back to an external browser when that policy denies a request.
      return { action: "allow", overrideBrowserWindowOptions: { webPreferences: BROWSER_SECURITY_PREFERENCES }, createWindow: (options) => {
        // Electron supplies the opener-linked webContents. Retain it: creating
        // a different one leaves the synchronous window.open handshake waiting.
        const popup = createBrowserTab("about:blank", { select: disposition !== "background-tab", initializeBlank: false, ownerSessionId: registry.ownerOf(tabId), contentsOptions: options });
        taskHost.inheritNavigation(tabId, popup);
        if (disposition === "background-tab") runDetachedTask("load background browser popup", () => popup.view.webContents.loadURL(targetUrl));
        return popup.view.webContents;
      } };
    });
    view.webContents.on("did-start-navigation", (_event, targetUrl, isInPlace, isMainFrame) => {
      if (isMainFrame || !isInPlace) {
        invalidateWebMcpTab(tab);
        sendBrowserState();
      }
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
    view.webContents.on("did-navigate", () => {
      // Only a main-frame commit replaces the document. Aborts and downloads
      // retain its warning; old resource failures cannot affect the new document.
      tab.documentGeneration += 1;
      tab.loadError = null;
      sendBrowserState();
    });
    view.webContents.on("did-navigate-in-page", () => sendBrowserState());
    view.webContents.on("page-title-updated", () => sendBrowserState());
    view.webContents.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = Array.isArray(favicons) ? favicons[0] ?? null : null;
      sendBrowserState();
    });
    view.webContents.on("did-start-loading", () => sendBrowserState());
    view.webContents.on("did-stop-loading", () => {
      sendBrowserState();
      scheduleWebMcpToolCountRefresh(tabId);
    });
    view.webContents.on("focus", () => resetViewportEmulation(view));
    view.webContents.once("destroyed", () => {
      // CDP Target.closeTarget and page-initiated close bypass our tab-strip
      // handler; they must release the native parent and owner state too.
      if (browserTabs.get(tabId) === tab) closeBrowserTab(tabId, tab.suspending);
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

  function releaseEmptyBackgroundWindow() {
    if (!backgroundWindow) return;
    if (!backgroundWindow.isDestroyed() && backgroundWindow.contentView.children.length > 0) return;
    if (!backgroundWindow.isDestroyed()) backgroundWindow.destroy();
    backgroundWindow = null;
  }

  // A tab whose conversation is not on screen must still behave like a real
  // page for the agent driving it: lay out at a real viewport, accept typing as
  // a focused page, and paint so CDP screenshots work. Park it in a never-shown
  // window: detached views stop painting, and every child of the main window's
  // contentView paints above OpenWork, regardless of its child index or bounds.
  // Moving the same view preserves the document and CDP target.
  function enterBackgroundMode(tab) {
    // A task's blank consent tab has no document to paint or observe. Attaching
    // its uninitialized widget to a hidden host can crash Electron on Linux.
    // Keep it detached until its approved first navigation has completed.
    if (!tab || tab.background || tab.deferBackground) return;
    const webContents = tab.view.webContents;
    if (webContents.isDestroyed()) return;
    tab.background = true;
    detachBrowserView(tab.view);
    tab.view.setBounds({ x: 0, y: 0, ...BACKGROUND_TAB_VIEWPORT });
    backgroundBrowserWindow().contentView.addChildView(tab.view);
    if (tab.domReady) emulateBackgroundTab(tab);
  }

  function emulateBackgroundTab(tab) {
    const webContents = tab.view.webContents;
    const cdp = webContents.debugger;
    tab.emulation = tab.emulation.then(async () => {
      if (webContents.isDestroyed() || !tab.background) return;
      if (!cdp.isAttached()) cdp.attach("1.3");
      for (const { method, params } of backgroundTabEmulationCommands()) {
        if (webContents.isDestroyed() || !tab.background) return;
        await cdp.sendCommand(method, params);
      }
    });
    runDetachedTask("emulate background browser tab", () => tab.emulation);
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
    releaseEmptyBackgroundWindow();
  }

  function setVisibleSession(sessionId) {
    const previous = registry.visibleSessionId();
    const next = registry.setVisibleSession(sessionId);
    if (next === previous) return next;
    hideContextMenu();
    applySurfacing();
    attachActiveBrowserView();
    sendBrowserState();
    return next;
  }

  function mainWindowZoomFactor() {
    try {
      const factor = window()?.webContents.getZoomFactor();
      return Number.isFinite(factor) && factor > 0 ? factor : 1;
    } catch {
      return 1;
    }
  }

  function acceptBrowserBounds(bounds) {
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0) return false;
    const currentZoom = mainWindowZoomFactor();
    // Unstamped callers retain the existing CSS-pixel IPC contract.
    const zoom = bounds.zoomFactor === undefined ? currentZoom : bounds.zoomFactor;
    if (!Number.isFinite(zoom) || zoom <= 0 || Math.abs(zoom - currentZoom) > 1e-6) return false;
    // Round edges (not width/height) so the far edge has no sub-pixel seam.
    const x = Math.round(bounds.x * zoom);
    const y = Math.round(bounds.y * zoom);
    lastBrowserBounds = {
      x,
      y,
      width: Math.round((bounds.x + bounds.width) * zoom) - x,
      height: Math.round((bounds.y + bounds.height) * zoom) - y,
    };
    return true;
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
    const tab = tabForView(view);
    if (!tab?.domReady || tab.background || tab.suspending) return;
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
    if (!tab) { detachIdleBrowserViews(); return; }
    exitBackgroundMode(tab);
    tab.view.setVisible(!approvals.has(tab.tabId));
    detachIdleBrowserViews(tab.view);
    // Size before attaching so a restored view never flashes at stale bounds.
    tab.view.setBounds(lastBrowserBounds);
    if (!mainWindow.contentView.children.includes(tab.view)) {
      mainWindow.contentView.addChildView(tab.view);
    }
  }

  function selectBrowserTab(tabId) {
    const tab = browserTabs.get(tabId);
    if (!tab) throw new Error(`Unknown browser tab: ${tabId}`);
    if (tab.suspending) throw new Error("Browser tab is suspending.");
    hideContextMenu();
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

  function closeBrowserTab(tabId = registry.onScreenTabId(), preserve = false) {
    const tab = getBrowserTab(tabId);
    if (!registry.has(tabId)) return null;
    approvals.get(tabId)?.finish(false);
    taskHost.invalidate(tabId, { closed: true });
    if (!preserve) suspendedTabs.delete(tabId);
    if (menuRequest?.tabId === tabId) hideContextMenu();
    const wasOnScreen = registry.onScreenTabId() === tabId;
    if (tab) {
      tab.background = false;
      tab.finishSuspension?.(preserve ? null : new Error("Browser tab was closed."));
      detachBrowserView(tab.view);
    }
    webMcpBroker.invalidateTab(tabId);
    const refreshTimer = webMcpRefreshTimers.get(tabId);
    if (refreshTimer) clearTimeout(refreshTimer);
    webMcpRefreshTimers.delete(tabId);
    browserTabs.delete(tabId);
    const removed = preserve ? null : registry.remove(tabId);
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
    try {
      if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    } catch { /* already destroyed */ }
    releaseEmptyBackgroundWindow();
    sendBrowserState();
    return tabId;
  }

  function requireTabOwner(tabId, sessionId) {
    if (!registry.has(tabId) || (sessionId !== null && !normalizeSessionId(sessionId)) || registry.ownerOf(tabId) !== sessionId) {
      throw new Error("Browser tab owner mismatch or unknown tab.");
    }
  }

  async function suspendBrowserTab(tabId) {
    const tab = browserTabs.get(tabId);
    const mainWindow = window();
    const check = () => {
      if (!tab || browserTabs.get(tabId) !== tab || tab.view.webContents.isDestroyed()) throw new Error("Unknown browser tab.");
      if (tab.automationProtected || tab.operation || tab.suspending) throw new Error("Browser tab is protected or busy. Release task protection before suspending.");
      if (tab.view.webContents.isLoading() || tab.downloads.size || tab.mediaPlaying || tab.view.webContents.isCurrentlyAudible()) {
        throw new Error("Browser tab is loading, downloading, or playing media.");
      }
    };
    check();
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Browser window is unavailable.");
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning", title: "Suspend browser tab?", message: "Suspend browser tab?",
      detail: "Form input, scroll position, and page history will be lost. Reload opens the saved URL, not the current document. Only suspend if you are willing to lose this page state.",
      buttons: ["Cancel", "Suspend"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return null;
    check();
    suspendedTabs.set(tabId, { ...browserTabToPanelTab(tabId, tab), status: "suspended", canGoBack: false, canGoForward: false });
    tab.suspending = true;
    sendBrowserState();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser tab is still waiting to close.")), BROWSER_TARGET_RESOLVE_TIMEOUT_MS);
      tab.finishSuspension = (error) => {
        clearTimeout(timer);
        tab.finishSuspension = null;
        if (error) reject(error); else resolve(tabId);
      };
      try { tab.view.webContents.close({ waitForBeforeUnload: true }); }
      catch (error) {
        tab.suspending = false;
        suspendedTabs.delete(tabId);
        tab.finishSuspension(error);
        sendBrowserState();
      }
    });
  }

  // Known live contents can identify their target without replacing the document
  // with a marker. Task protection is held by the page until explicit release.
  async function restoreBrowserTab(tabId, protect = false) {
    const saved = suspendedTabs.get(tabId);
    const live = browserTabs.get(tabId);
    if (live?.suspending || live?.operation) throw new Error("Browser tab is busy.");
    if (!live && !saved) throw new Error("Unknown browser tab.");
    const tab = live ?? createBrowserTab("about:blank", {
      initializeBlank: false, ownerSessionId: registry.ownerOf(tabId), restoreTabId: tabId, automationProtected: protect,
    });
    const wasProtected = tab.automationProtected;
    tab.operation = true;
    if (protect) tab.automationProtected = true;
    sendBrowserState();
    try {
      if (!live) await tab.view.webContents.loadURL(saved.url);
      if (!tab.domReady) await new Promise((resolve, reject) => {
        const contents = tab.view.webContents;
        const finish = () => {
          clearTimeout(timer);
          contents.removeListener("dom-ready", finish);
          contents.removeListener("destroyed", finish);
          if (tab.domReady && !contents.isDestroyed()) resolve(undefined);
          else reject(new Error("Browser tab did not become ready."));
        };
        const timer = setTimeout(finish, BROWSER_TARGET_RESOLVE_TIMEOUT_MS);
        contents.once("dom-ready", finish);
        contents.once("destroyed", finish);
      });
      await tab.emulation;
      if (browserTabs.get(tabId) !== tab) throw new Error("Browser tab was closed.");
      let handle = null;
      if (protect) {
        const cdp = tab.view.webContents.debugger;
        const attached = cdp.isAttached();
        try {
          if (!attached) cdp.attach("1.3");
          const { targetInfo } = await cdp.sendCommand("Target.getTargetInfo");
          if (!targetInfo?.targetId) throw new Error("Could not resolve built-in browser CDP target.");
          handle = {
            provider: "builtin", browser_url: cdpBrowserUrl(), target_id: targetInfo.targetId,
            tab_id: tabId, url: tab.view.webContents.getURL(), owner_session_id: registry.ownerOf(tabId),
            visible: registry.surfacingFor(tabId) === "foreground",
          };
        } finally {
          if (!attached && !tab.view.webContents.isDestroyed() && cdp.isAttached()) cdp.detach();
        }
      }
      if (browserTabs.get(tabId) !== tab) throw new Error("Browser tab was closed.");
      suspendedTabs.delete(tabId);
      return { tab, handle };
    } catch (error) {
      if (browserTabs.get(tabId) === tab) {
        if (!live) closeBrowserTab(tabId, true);
        else tab.automationProtected = wasProtected;
      }
      throw error;
    } finally {
      tab.operation = false;
      sendBrowserState();
    }
  }

  function closeAllBrowserTabs() {
    const closedTabIds = registry.list().map((tab) => tab.tabId);
    for (const tabId of closedTabIds) closeBrowserTab(tabId);
    return closedTabIds;
  }

  function closeSessionBrowserTabs(sessionId) {
    // Missing/malformed ownership must never become a request to close shared
    // tabs or the currently visible conversation.
    const ownerSessionId = normalizeSessionId(sessionId);
    if (!ownerSessionId) return [];
    const closedTabIds = registry.list()
      .filter((tab) => tab.ownerSessionId === ownerSessionId)
      .map((tab) => tab.tabId);
    for (const tabId of closedTabIds) closeBrowserTab(tabId);
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
    if (!window() || !acceptBrowserBounds(bounds)) return false;
    browserViewVisible = true;
    if (sessionId !== undefined) {
      const previous = registry.visibleSessionId();
      if (registry.setVisibleSession(sessionId) !== previous) {
        hideContextMenu();
        applySurfacing();
      }
    }
    if (ensureTab && !registry.onScreenTabId()) {
      createBrowserTab("about:blank", { ownerSessionId: registry.visibleSessionId() });
    }
    const view = getActiveBrowserView();
    attachActiveBrowserView();
    resetViewportEmulation(view);
    const url = view?.webContents.getURL();
    if (preloadDefault && (!url || url === "about:blank")) {
      runDetachedTask("load browser default page", () => view?.webContents.loadURL(BROWSER_DEFAULT_URL));
    }
    sendBrowserState();
    return true;
  }

  function hideBrowserView() {
    hideContextMenu();
    browserViewVisible = false;
    if (!window()) return;
    detachIdleBrowserViews();
  }

  function destroyBrowserView() {
    hideBrowserView();
    menuShowSerial += 1;
    closeAllBrowserTabs();
    browserTabs.clear();
    suspendedTabs.clear();
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
    function authorizeManualNavigation(event) {
      const contents = window()?.webContents;
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error("Use the browser toolbar to navigate.");
      const tabId = registry.onScreenTabId();
      if (tabId && registry.ownerOf(tabId) !== registry.visibleSessionId()) throw new Error("Select this conversation first.");
      taskHost.manualNavigation(tabId);
    }
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
    ipcMain.handle("openwork:browser:navigate", (event, url) => {
      authorizeManualNavigation(event);
      getActiveWebContents(); // Reject navigation while suspension is pending.
      const view = getActiveBrowserView()
        ?? createBrowserTab("about:blank", { select: true, ownerSessionId: registry.visibleSessionId() }).view;
      runDetachedTask("navigate browser tab", () => view.webContents.loadURL(normalizeBrowserUrl(url)));
    });
    ipcMain.handle("openwork:browser:back", (event) => {
      authorizeManualNavigation(event);
      const webContents = getActiveWebContents();
      if (webContents?.canGoBack()) webContents.goBack();
    });
    ipcMain.handle("openwork:browser:forward", (event) => {
      authorizeManualNavigation(event);
      const webContents = getActiveWebContents();
      if (webContents?.canGoForward()) webContents.goForward();
    });
    ipcMain.handle("openwork:browser:reload", (event) => {
      authorizeManualNavigation(event);
      getActiveWebContents()?.reload();
    });
    ipcMain.handle("openwork:browser:bounds", (_event, bounds) => {
      if (!acceptBrowserBounds(bounds)) return false;
      const view = getActiveBrowserView();
      if (view && browserViewVisible) {
        view.setBounds(lastBrowserBounds);
      }
      return true;
    });
    ipcMain.handle("openwork:browser:state", () => ({
      ...browserStatePayload(),
      nativeViews: browserNativeViews(),
      tabLimit: MAX_BROWSER_TABS,
      backgroundWindowCount: Number(Boolean(backgroundWindow && !backgroundWindow.isDestroyed())),
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
    ipcMain.handle("openwork:browser:suspendTab", (_event, tabId) => suspendBrowserTab(tabId));
    ipcMain.handle("openwork:browser:restoreTab", async (_event, tabId, sessionId) => {
      requireTabOwner(tabId, sessionId);
      return (await restoreBrowserTab(tabId, true)).handle;
    });
    ipcMain.handle("openwork:browser:releaseTab", (_event, tabId, sessionId) => {
      requireTabOwner(tabId, sessionId);
      const tab = browserTabs.get(tabId);
      if (tab?.operation || tab?.suspending) throw new Error("Browser tab is busy.");
      if (tab) tab.automationProtected = false;
      sendBrowserState();
      return { tabId, released: true };
    });
    ipcMain.handle("openwork:browser:closeAllTabs", () => closeAllBrowserTabs());
    ipcMain.handle("openwork:browser:closeSessionTabs", (_event, sessionId) => closeSessionBrowserTabs(sessionId));
    ipcMain.handle("openwork:browser:selectTab", async (_event, tabId) => {
      const id = String(tabId ?? "");
      if (!browserTabs.has(id) && suspendedTabs.has(id)) await restoreBrowserTab(id);
      const tab = selectBrowserTab(id);
      resetViewportEmulation(tab.view);
      return tab.tabId;
    });
    ipcMain.handle("openwork:browser:reorderTabs", (_event, tabIds) => reorderBrowserTabs(tabIds));
    ipcMain.handle("openwork:browser:listTabs", () => listBrowserTabs());
    ipcMain.handle("openwork:browser:webmcpListTools", (_event, args) => taskHost.request({ sessionId: registry.visibleSessionId(), operation: "site_tools", args }));
    ipcMain.handle("openwork:browser:webmcpExecuteTool", (_event, args) => taskHost.request({ sessionId: registry.visibleSessionId(), operation: "site_tool", args }));
    ipcMain.handle("openwork:browser:approve", (event, tabId, approvalId, allowed) => {
      if (event.sender !== window()?.webContents || event.senderFrame !== window()?.webContents.mainFrame || registry.ownerOf(tabId) !== registry.visibleSessionId()) return false;
      const pending = approvals.get(tabId);
      if (!pending || pending.id !== approvalId) return false;
      pending.finish(allowed === true); return true;
    });
    ipcMain.handle("openwork:browser:taskControl", (event, tabId, action) => {
      if (event.sender !== window()?.webContents || event.senderFrame !== window()?.webContents.mainFrame || !getBrowserTab(tabId) || registry.ownerOf(tabId) !== registry.visibleSessionId()) throw new Error("Select this conversation first.");
      if (action === "resume") taskHost.resume(tabId);
      else if (action === "pause") taskHost.pause(tabId);
      else throw new Error("Unsupported browser control.");
    });
    ipcMain.handle("openwork:webmcp:frame-policy", (event) => {
      const tab = [...browserTabs.values()].find((candidate) => candidate.view.webContents === event.sender);
      if (!tab || !event.senderFrame) {
        return { allowed: false, originKeyed: false, reason: "unknown_browser_frame" };
      }
      return ensureWebMcpFramePolicy().checkFrame(event.senderFrame);
    });
    ipcMain.handle("openwork:browser:setProxy", (_event, proxy) => setBrowserProxy(proxy));
    ipcMain.handle("openwork:browser:getProxy", () => browserProxyState());
    ipcMain.handle("openwork:browser:setControlEnabled", (event, enabled) => {
      if (event.sender !== window()?.webContents || event.senderFrame !== window()?.webContents.mainFrame) return false;
      browserControlEnabled = enabled === true;
      if (!browserControlEnabled) for (const tab of browserTabs.values()) taskHost.pause(tab.tabId, "Browser control disabled");
      return browserControlEnabled;
    });
    ipcMain.handle("openwork:browser:tabContextMenu", (_event, tabId, point) => showBrowserTabContextMenu(tabId, point));
    ipcMain.on("openwork:browser:linkContextMenu", (event, payload) => {
      const mainContents = window()?.webContents;
      if (event.sender !== mainContents || event.senderFrame !== mainContents?.mainFrame) return;
      if (!payload || typeof payload !== "object") return;
      const showing = showLinkContextMenu(payload);
      runDetachedTask("show link context menu", () => showing);
    });
    ipcMain.handle("openwork:browser:destroy", () => destroyBrowserView());
    ipcMain.on("openwork:menu-overlay:dismiss", () => hideContextMenu());
    ipcMain.on("openwork:webmcp:tools-changed", (event) => {
      const tab = [...browserTabs.values()].find((candidate) => candidate.view.webContents === event.sender);
      if (!tab) return;
      // The page relays this after a debounce, so it routinely arrives after a
      // listing that already saw the same registrations. It is not a new
      // document: only navigation bumps the revision. Listed handles stay
      // valid, and execution revalidates each tool's live descriptor digest
      // before asking for consent, so a changed or removed tool still fails
      // as stale_tool while an unchanged one reaches the approval prompt.
      scheduleWebMcpToolCountRefresh(tab.tabId);
    });
  }

  return {
    destroy: destroyBrowserView,
    isMainWindowAllowedNavigation,
    browserTask: (args, options) => taskHost.request(args, options),
    listWebMcpTools: (args, options) => taskHost.request({ sessionId: args?.sessionId, operation: "site_tools", args }, options),
    executeWebMcpTool: (args, options) => taskHost.request({ sessionId: args?.sessionId, operation: "site_tool", args }, options),
    registerIpc,
    routeBlockedMainWindowNavigation,
  };
}
