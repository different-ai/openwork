import { browserScript, browserSource } from "@openwork/cdp";
import { control, readBrowserTabMetrics } from "@openwork/behaviors";
import { captureScreenshot, connect, debuggerUrlFor, evaluate, listTargets, navigate } from "@openwork/cdp";
import type { AttachedSurface, CdpClient, Surface } from "@openwork/cdp";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { browserScriptValue, runBrowserHost } from "../packages/env/src/browser-task.ts";

export const CAPTURE_VIEWPORT = { width: 1440, height: 900 };

export function browserTabHandle(value: unknown) {
  if (!value || typeof value !== "object" || !("tab_id" in value) || typeof value.tab_id !== "string"
    || !("target_id" in value) || typeof value.target_id !== "string") throw new Error("The built-in browser returned no exact tab handle.");
  return { tabId: value.tab_id, targetId: value.target_id };
}

export interface BuiltinBrowserTab {
  tabId: string;
  targetId: string;
  /** Distinguishes this tab's URL, and so its label in the side panel tab strip. */
  name: string;
}

export interface Viewport {
  width: number;
  height: number;
}

/** What the page inside a tab experiences: its viewport and whether it believes it is focused. */
export interface PageProbe extends Viewport {
  hasFocus: boolean;
}

export interface BrowserTabState {
  id: string;
  label: string;
  url: string;
  ownerSessionId: string | null;
}

export interface BrowserState {
  activeTabId: string | null;
  visibleSessionId: string | null;
  visibleWindowCount: number;
  tabLimit: number;
  backgroundWindowCount: number;
  backgroundWindowVisible: boolean;
  tabs: BrowserTabState[];
  nativeViews: Array<{
    tabId: string;
    attached: boolean;
    aboveApp: boolean;
    bounds: Viewport & { x: number; y: number };
  }>;
}

export interface OpenedTab extends BuiltinBrowserTab {
  ownerSessionId: string | null;
  visible: boolean;
}

/**
 * A page with a full-window button and a text field, so a spec can prove a
 * tab accepts real clicks and typing. Loaded over CDP the way an agent
 * navigates; the marker-style `data:` URL never surfaces a panel.
 */
export const INPUT_PROBE_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><title>input-probe</title>'
  + '<body style="margin:0"><button id="hit" style="position:fixed;inset:0 0 50% 0;font-size:24px">hit</button>'
  + '<input id="field" style="position:fixed;top:60%;left:10px;width:300px;font-size:24px">'
  + `<script>${browserSource(() => {
    window.__clicks = 0;
    const button = document.getElementById("hit");
    if (!button) throw new Error("Input probe button missing");
    button.addEventListener("click", () => { window.__clicks += 1; });
  })}</script>`,
)}`;

function pngSize(png: Buffer): Viewport {
  if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") throw new Error("Screenshot is not a PNG.");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function parseBrowserState(value: unknown): BrowserState {
  if (!isRecord(value) || !Array.isArray(value.tabs)) throw new Error("The desktop bridge did not report browser state.");
  if (!Array.isArray(value.nativeViews)) throw new Error("The desktop bridge did not report native browser views.");
  if (typeof value.visibleWindowCount !== "number" || typeof value.backgroundWindowVisible !== "boolean") {
    throw new Error("The desktop bridge did not report native window visibility.");
  }
  if (typeof value.tabLimit !== "number" || typeof value.backgroundWindowCount !== "number") {
    throw new Error("The desktop bridge did not report browser capacity and background host count.");
  }
  return {
    activeTabId: typeof value.activeTabId === "string" ? value.activeTabId : null,
    visibleSessionId: typeof value.visibleSessionId === "string" ? value.visibleSessionId : null,
    visibleWindowCount: value.visibleWindowCount,
    tabLimit: value.tabLimit,
    backgroundWindowCount: value.backgroundWindowCount,
    backgroundWindowVisible: value.backgroundWindowVisible,
    nativeViews: value.nativeViews.map((view) => {
      if (!isRecord(view) || typeof view.attached !== "boolean" || typeof view.aboveApp !== "boolean"
        || !isRecord(view.bounds) || typeof view.bounds.x !== "number" || typeof view.bounds.y !== "number") {
        throw new Error("The desktop bridge reported malformed native browser view state.");
      }
      return {
        tabId: stringField(view.tabId),
        attached: view.attached,
        aboveApp: view.aboveApp,
        bounds: { ...parseViewport(view.bounds), x: view.bounds.x, y: view.bounds.y },
      };
    }),
    tabs: value.tabs.map((tab) => {
      if (!isRecord(tab)) throw new Error("Browser state listed a malformed tab.");
      // A native tab can exist before its first navigation commits. Keep it in
      // the snapshot; readiness belongs to the assertion about that page.
      if (typeof tab.url !== "string") throw new Error("Browser state listed a malformed tab URL.");
      return {
        id: stringField(tab.id),
        label: stringField(tab.label),
        // A native tab can exist before its first navigation commits. Keep it in
        // the snapshot; readiness belongs to the assertion about that page.
        // Electron can report an empty URL while a newly created page starts loading.
        url: stringValue(tab.url),
        ownerSessionId: typeof tab.ownerSessionId === "string" ? tab.ownerSessionId : null,
      };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a non-empty string from the desktop bridge.");
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string from the desktop bridge.");
  return value;
}

/** Explicit human-created initial state, not an automation navigation or consent grant. */
async function seedBrowserTab(seed: Seed, app: Surface, url: string, ownerSessionId: string | null) {
  const { tabId } = await seed.evalIn(app, browserScript((url, ownerSessionId) => window.__OPENWORK_ELECTRON__.browser.createTab(url, ownerSessionId), [url, ownerSessionId]));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const targets = (await listTargets(app.handle.cdpUrl)).filter((target) => target.type === "page" && target.url === url);
    if (targets.length === 1) {
      const state = await seed.evalIn(app, () => window.__OPENWORK_ELECTRON__.browser.getState(), { awaitPromise: true });
      const nativeTab = parseBrowserState(state).tabs.find((tab) => tab.id === tabId);
      // Target discovery can announce the destination before the native view
      // commits it. Baselines must describe the loaded page, not that transition.
      if (nativeTab?.url === url && nativeTab.label !== "New tab") return { tabId, targetId: targets[0].id };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The seeded browser page did not finish opening.");
}

/**
 * A page origin the app can always reach from its own host: the embedded
 * OpenWork server. Any HTTP response renders as a page in the built-in
 * browser; the response body is irrelevant to the viewport journey.
 */
async function embeddedServerUrl(seed: Seed, app: Surface): Promise<string> {
  const info = await seed.evalIn(app, () => (window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo")), { awaitPromise: true });
  if (!isRecord(info) || info.running !== true) throw new Error("The embedded OpenWork server is not running.");
  return stringField(info.baseUrl).replace(/\/+$/, "");
}

async function withTabClient<T>(app: Surface, targetId: string, run: (client: CdpClient) => Promise<T>): Promise<T> {
  const target = (await listTargets(app.handle.cdpUrl)).find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("The exact built-in tab target is missing.");
  const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

function parseViewport(value: unknown): Viewport {
  if (!isRecord(value) || typeof value.width !== "number" || typeof value.height !== "number") {
    throw new Error("The built-in browser tab did not report a viewport.");
  }
  return { width: value.width, height: value.height };
}

function parsePageProbe(value: unknown): PageProbe {
  const viewport = parseViewport(value);
  if (!isRecord(value) || typeof value.hasFocus !== "boolean") {
    throw new Error("The built-in browser tab did not report its focus state.");
  }
  return { ...viewport, hasFocus: value.hasFocus };
}

/**
 * A desktop with one session open, so the built-in browser side panel has a
 * home, plus helpers that play an automation client against its tabs.
 */
export async function createBuiltinBrowserWorld(seed: Seed, env?: Record<string, string>) {
  const app = await seed.desktop({ name: "builtin-browser", env });
  const workspacePath = seed.tmpPath("builtin-browser");
  const workspace = await seed.workspace(app, workspacePath, { create: true });
  const session = await seed.session(app);
  const origin = await embeddedServerUrl(seed, app);

  return {
    app,
    workspace,
    session,
    sessionApiBase: `/workspace/${encodeURIComponent(workspace.workspaceId)}/${resolveEvalEngine() === "v2" ? "opencode2/api" : "opencode"}/session`,

    /** Persist a real transcript link and an attached file without invoking a model. */
    async seedTranscriptLink(sessionId: string) {
      const url = `${origin}/?viewport-probe=transcript-link&source=chat%20link#working-page`;
      const artifactName = "browser-handoff.md";
      const artifactText = "Keep these notes open while following the research link.";
      await seed.evalIn(app, browserScript(async (workspaceId, sessionId, url, artifactName, artifactText, fileUrl) => {
        const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
        if (!info.baseUrl) throw new Error("Missing local server URL");
        const base = info.baseUrl.replace(/\/+$/, "") + "/workspace/" + encodeURIComponent(workspaceId);
        const headers = { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken), "Content-Type": "application/json" };
        const file = await fetch(base + "/files/content", {
          method: "POST", headers, signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ path: artifactName, content: artifactText, baseUpdatedAt: null }),
        });
        if (!file.ok) throw new Error("Could not seed the handoff file: " + file.status);
        const message = await fetch(base + "/opencode/session/" + encodeURIComponent(sessionId) + "/message", {
          method: "POST", headers, signal: AbortSignal.timeout(30000),
          body: JSON.stringify({ noReply: true, parts: [
            { type: "text", text: "Continue research at " + url },
            { type: "text", synthetic: true, text: "Attached workspace file: " + artifactName,
              metadata: { openworkAttachments: [{ filename: artifactName, mime: "text/markdown", url: fileUrl }] } },
          ] }),
        });
        if (!message.ok) throw new Error("Could not seed the transcript link: " + message.status);
        const saved = await message.json();
        if (!Array.isArray(saved.parts) || !saved.parts.some((part: { type?: string; text?: string }) => part.type === "text" && part.text?.includes(url))) {
          throw new Error("Transcript seed did not persist the requested link.");
        }
      }, [workspace.workspaceId, sessionId, url, artifactName, artifactText, new URL(`file://${workspacePath}/${artifactName}`).href]), { awaitPromise: true, timeoutMs: 50_000 });
      return { url, artifactName, artifactText };
    },

    /** Create another conversation in the same workspace; the app shows it. */
    async openSession(title: string): Promise<{ sessionId: string; title: string }> {
      return seed.session(app, { title });
    },

    /** Give a conversation a stable title so a spec can find it in the sidebar. */
    async renameSession(sessionId: string, title: string): Promise<void> {
      await control(app, "session.rename", { sessionId, title });
    },

    /**
     * Bring a conversation on screen programmatically. Arrangement only: a
     * claim about the user switching conversations must click the sidebar.
     * From Settings this first returns to the session route and waits for the
     * session actions to register again.
     */
    async showSession(sessionId: string): Promise<void> {
      const deadline = Date.now() + 30_000;
      let routed = false;
      while (Date.now() < deadline) {
        const actions = await seed.evalIn(app, () => (window.__openworkControl.listActions().map((action) => action.id)));
        if (Array.isArray(actions) && actions.includes("session.open")) {
          await control(app, "session.open", { sessionId });
          return;
        }
        if (!routed && Array.isArray(actions) && actions.includes("route.session")) {
          await control(app, "route.session");
          routed = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("The session view did not come back on screen.");
    },

    /** Arrange a human-created page, shared by default; grants are never seeded. */
    async openTab(name: string, ownerSessionId: string | null = null): Promise<BuiltinBrowserTab> {
      const url = `${origin}/?viewport-probe=${encodeURIComponent(name)}`;
      return { ...await seedBrowserTab(seed, app, url, ownerSessionId), name };
    },

    /**
     * Open a page the way an agent in a given conversation does: the request
     * reaches the UI command bus stamped with that conversation as its origin,
     * exactly as the OpenWork bridge stamps `openwork_execute` calls.
     */
    async openTabAs(name: string, ownerSessionId: string, url = `${origin}/?viewport-probe=${encodeURIComponent(name)}`): Promise<OpenedTab> {
      const result = await seed.evalIn(
        app,
        browserScript((value) => (window.__openworkControl.command(value)), [{
          id: "browser.open_url",
          args: { url, provider: "builtin" },
          origin: { sessionId: ownerSessionId },
        }]),
        { awaitPromise: true, timeoutMs: 30_000 },
      );
      if (!isRecord(result) || result.ok !== true || !isRecord(result.result)) {
        throw new Error(`browser.open_url failed: ${isRecord(result) ? String(result.error ?? "unknown") : "no response"}`);
      }
      const handle = result.result;
      return {
        tabId: stringField(handle.tab_id),
        targetId: stringField(handle.target_id),
        name,
        ownerSessionId: typeof handle.owner_session_id === "string" ? handle.owner_session_id : null,
        visible: handle.visible === true,
      };
    },

    /** The page origin the built-in browser can always reach: the embedded OpenWork server. */
    origin,

    /** Open a Settings panel the way the app's own navigation does. */
    async openSettingsPanel(panel: string): Promise<void> {
      await control(app, "settings.panel.open", { panel });
    },

    /** Navigate the existing CDP page without opening a replacement tab. */
    async navigateTab(tab: BuiltinBrowserTab, url: string): Promise<void> {
      await withTabClient(app, tab.targetId, (client) => navigate(client, url));
    },

    /** Reload a tab over CDP and wait for it to settle. */
    async reloadTab(tab: BuiltinBrowserTab): Promise<void> {
      await withTabClient(app, tab.targetId, async (client) => {
        await client.send("Page.reload");
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          if ((await evaluate(client, () => (document.readyState))) === "complete") return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
    },

    /** Every tab the native browser holds, who owns it, and which conversation is on screen. */
    async readBrowserState(): Promise<BrowserState> {
      return parseBrowserState(await seed.evalIn(
        app,
        () => (window.__OPENWORK_ELECTRON__.browser.getState()),
        { awaitPromise: true },
      ));
    },

    /** Exclude the menu document, but include popups, hidden hosts, and all built-in pages. */
    async pageTargets() {
      return (await listTargets(app.handle.cdpUrl))
        .filter(target => target.type === "page" && !/\/overlay\.html(?:[?#]|$)/.test(target.url))
        .map(({ id, url }) => ({ id, url }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    /** Resolve a user-opened tab without opening or selecting another page. */
    async tabHandle(tab: BrowserTabState): Promise<BuiltinBrowserTab> {
      const targets = (await listTargets(app.handle.cdpUrl)).filter((target) => target.type === "page" && target.url === tab.url);
      if (targets.length !== 1) throw new Error(`Expected one CDP page for ${tab.url}, found ${targets.length}.`);
      return { tabId: tab.id, targetId: targets[0].id, name: tab.label };
    },

    /** The viewport a tab lays out for and whether its page believes it has focus. */
    async readPageProbe(tab: BuiltinBrowserTab): Promise<PageProbe> {
      return withTabClient(app, tab.targetId, async (client) => parsePageProbe(
        await evaluate(client, () => (({ width: window.innerWidth, height: window.innerHeight, hasFocus: document.hasFocus() }))),
      ));
    },

    /** A CDP screenshot of the tab, as the agent's browser_screenshot tool takes it. */
    async screenshotSize(tab: BuiltinBrowserTab): Promise<Viewport> {
      return withTabClient(app, tab.targetId, async (client) => pngSize(await captureScreenshot(client)));
    },

    /** Navigate a tab over CDP to the input probe page and wait for it. */
    async loadInputProbe(tab: BuiltinBrowserTab): Promise<void> {
      await withTabClient(app, tab.targetId, async (client) => {
        await navigate(client, INPUT_PROBE_PAGE);
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          if (await evaluate(client, () => (document.readyState === "complete"
            && document.title === "input-probe"
            && Boolean(document.getElementById("hit") && document.getElementById("field"))
            && typeof window.__clicks === "number"))) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("The input probe page did not load in the built-in browser tab.");
      });
    },

    /** Click the probe page's button and type into its field the way the agent's tools do. */
    async clickAndType(tab: BuiltinBrowserTab, text: string): Promise<{ clicks: number; value: string }> {
      return withTabClient(app, tab.targetId, async (client) => {
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100, button: "left", clickCount: 1 });
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 100, button: "left", clickCount: 1 });
        await evaluate(client, () => (document.getElementById('field')?.focus()));
        for (const char of text) {
          await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
          await client.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
        }
        const result = await evaluate(client, () => (({ clicks: window.__clicks, value: document.querySelector<HTMLInputElement>('#field')?.value })));
        if (!isRecord(result) || typeof result.clicks !== "number" || typeof result.value !== "string") {
          throw new Error("The input probe page did not report clicks and typed text.");
        }
        return { clicks: result.clicks, value: result.value };
      });
    },

    /** Observe the existing document without focusing its hidden native view. */
    async readInputProbe(tab: BuiltinBrowserTab): Promise<unknown> {
      return withTabClient(app, tab.targetId, (client) => evaluate(client,
        () => (({ clicks: window.__clicks, value: document.querySelector<HTMLInputElement>('#field')?.value }))));
    },

    /**
     * What a screenshot or docs-shots client does: attach over CDP, emulate a
     * capture viewport, and disconnect without restoring it.
     */
    async leaveViewportEmulation(tab: BuiltinBrowserTab, viewport: Viewport): Promise<void> {
      await withTabClient(app, tab.targetId, async (client) => {
        await client.send("Emulation.setDeviceMetricsOverride", {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 0,
          mobile: false,
        });
      });
    },

    /** The viewport the page inside a tab is laying out for right now. */
    async readViewport(tab: BuiltinBrowserTab): Promise<Viewport> {
      return withTabClient(app, tab.targetId, async (client) => parseViewport(
        await evaluate(client, () => (({ width: window.innerWidth, height: window.innerHeight }))),
      ));
    },
  };
}

/** Arrange a persisted transcript link and its neighboring conversation. */
export async function transcriptLinkWorld(seed: Seed) {
  const world = await createBuiltinBrowserWorld(seed, { OPENWORK_DEV_MODE: "1", OPENWORK_EVAL_CAPTURE_EXTERNAL_OPENS: "1" });
  const { app, workspace } = world;
  const profileDir = app.handle.profileDir;
  if (!profileDir) throw new Error("The link fixture desktop did not expose its isolated profile.");
  const reading = { ...world.session, title: "Reading a shared link" };
  await world.renameSession(reading.sessionId, reading.title);
  const neighbor = await world.openSession("Unrelated browser research");
  const neighborTab = await world.openTab("link-neighbor", neighbor.sessionId);
  const origin = await embeddedServerUrl(seed, app);
  const linkUrl = `${origin}/?link-context=alpha%20beta&encoded=%2Fkeep%3Fyes%3D1#thread-link`;
  const note = "Keep this note in its own conversation.";
  await seed.evalIn(app, browserScript(async (workspaceId, sessionId, note, url) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    const response = await fetch(String(info.baseUrl).replace(/\/+$/, "")
      + "/workspace/" + encodeURIComponent(workspaceId)
      + "/opencode/session/" + encodeURIComponent(sessionId) + "/message", {
      method: "POST",
      headers: { Authorization: "Bearer " + info.ownerToken, "Content-Type": "application/json" },
      body: JSON.stringify({ noReply: true, parts: [
        { type: "text", text: note },
        { type: "text", text: "Reference: " + url },
      ] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Transcript message seed failed: " + response.status);
    return true;
  }, [workspace.workspaceId, reading.sessionId, note, linkUrl]), { awaitPromise: true, timeoutMs: 35_000 });
  await world.showSession(reading.sessionId);

  return {
    ...world,
    reading,
    neighbor,
    neighborTab,
    linkUrl,
    note,

    // Observe the shipping external-open boundary using its existing dev-only
    // capture, so the test never opens a browser in the person's real profile.
    async externalOpens(): Promise<string[]> {
      const text = await runBrowserHost(app, `
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        try { return await readFile(join(${browserScriptValue(profileDir)}, "electron-userdata", "openwork-eval-external-opens.jsonl"), "utf8"); }
        catch (error) { if (error.code === "ENOENT") return ""; throw error; }
      `);
      if (typeof text !== "string") throw new Error("External-open capture did not return text.");
      return text.trim() ? text.trim().split("\n").map((line) => {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "string") throw new Error("Invalid external-open capture.");
        return value;
      }) : [];
    },

    async readLink() {
      return evaluate(app.client, browserScript((linkUrl) => {
        const link = [...document.querySelectorAll<HTMLAnchorElement>('[data-message-role="user"] a[href]')]
          .find(node => node.getAttribute("href") === linkUrl);
        return link ? { href: link.href, sessionId: link.closest<HTMLElement>("[data-session-surface-id]")?.dataset.sessionSurfaceId } : null;
      }, [linkUrl]));
    },

    async readMainUrl() {
      return evaluate(app.client, () => (location.href));
    },

    async readClipboard() {
      return evaluate(app.client, () => (navigator.clipboard.readText()), { awaitPromise: true });
    },

    /**
     * The native popup as the development seam describes it. Native menus are
     * OS widgets with no CDP target, so this is the only observation of them.
     */
    async nativeMenu(): Promise<NativeMenuState> {
      return parseNativeMenuState(await evaluate(app.client, () => (window.__OPENWORK_ELECTRON__.contextMenu.inspect()), { awaitPromise: true }));
    },

    /** What the OS does when the user clicks one entry of the open popup. */
    async chooseMenuItem(id: string): Promise<boolean> {
      return await evaluate(app.client, browserScript((id) => window.__OPENWORK_ELECTRON__.contextMenu.choose(id), [id]), { awaitPromise: true }) === true;
    },

    /** What the OS does when the user clicks away from or escapes the open popup. */
    async dismissMenu(): Promise<boolean> {
      return await evaluate(app.client, () => (window.__OPENWORK_ELECTRON__.contextMenu.dismiss()), { awaitPromise: true }) === true;
    },
  };
}

export interface NativeMenuItem {
  type: "item" | "separator";
  id: string | null;
  label: string | null;
  enabled: boolean;
}

export interface NativeMenuPopup {
  requestId: string | null;
  items: NativeMenuItem[];
}

export interface NativeMenuState {
  open: boolean;
  current: NativeMenuPopup | null;
  last: (NativeMenuPopup & { selectedId: string | null }) | null;
}

function parseNativeMenuPopup(value: unknown): NativeMenuPopup {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("The desktop bridge reported a malformed native menu.");
  return {
    requestId: typeof value.requestId === "string" ? value.requestId : null,
    items: value.items.map((entry) => {
      if (!isRecord(entry) || (entry.type !== "item" && entry.type !== "separator")) throw new Error("The desktop bridge reported a malformed native menu item.");
      return {
        type: entry.type,
        id: typeof entry.id === "string" ? entry.id : null,
        label: typeof entry.label === "string" ? entry.label : null,
        enabled: entry.enabled !== false,
      };
    }),
  };
}

function parseNativeMenuState(value: unknown): NativeMenuState {
  if (!isRecord(value) || typeof value.open !== "boolean") throw new Error("The desktop bridge did not report native menu state.");
  return {
    open: value.open,
    current: value.current === null ? null : parseNativeMenuPopup(value.current),
    last: value.last === null || !isRecord(value.last) ? null
      : { ...parseNativeMenuPopup(value.last), selectedId: typeof value.last.selectedId === "string" ? value.last.selectedId : null },
  };
}

/** Arrangement attaches only the exact native tab; disposal releases CDP, not the tab. */
export async function attachBuiltinTab(app: Surface, targetId: string): Promise<AttachedSurface> {
  const target = (await listTargets(app.handle.cdpUrl)).find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("The exact built-in tab target is missing.");
  const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
  return {
    handle: { ...app.handle, kind: "chrome", name: "project-tab" }, client,
    async stop() { client.close(); },
    async [Symbol.asyncDispose]() { client.close(); },
  };
}

export async function builtinBrowserWorld(seed: Seed, options: { workspacePath?: string } = {}) {
  // Pixel witnesses use CSS sRGB colors, not the host display's ICC profile.
  const app = await seed.desktop({ name: "builtin-browser", env: { ELECTRON_EXTRA_LAUNCH_ARGS: "--force-color-profile=srgb" } });
  const workspace = await seed.workspace(app, options.workspacePath ?? seed.tmpPath("builtin-browser"), { create: true });
  const session = await seed.session(app, { title: "Browser project" });
  const info = await seed.evalIn(app, () => window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo"), { awaitPromise: true });
  if (!info || typeof info !== "object" || !("baseUrl" in info) || typeof info.baseUrl !== "string") throw new Error("The embedded server is unavailable.");
  return { app, workspace, session, origin: info.baseUrl.replace(/\/+$/, "") };
}

/** A working native tab and a refused loopback destination on the same host. */
export async function browserConnectionFailureWorld(seed: Seed) {
  const world = await builtinBrowserWorld(seed);
  const tab = await seedBrowserTab(seed, world.app, `${world.origin}/?connection-probe=working`, world.session.sessionId);
  // Allocate and release a port on the desktop host so the navigation reaches
  // a refused loopback connection, not DNS, an unsafe port, or a public site.
  const port = await runBrowserHost(world.app, `
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
  `);
  if (typeof port !== "number") throw new Error("The connection failure fixture returned no port.");
  const failedUrl = `http://127.0.0.1:${port}/connection-probe`;
  const page = await attachBuiltinTab(world.app, tab.targetId);
  let recoveryPid: number | null = null;
  return {
    ...world, tab, page, failedUrl,
    // Restoring this fixture's network fault changes only the local site;
    // the person must still use the browser's Reload control to recover.
    async restoreConnection() {
      const source = `
        const { createServer } = await import('node:http');
        const server = createServer((request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Connection restored</title><h1>Connection restored</h1><p>The same address is available again.</p>');
        });
        server.listen(${port}, '127.0.0.1');
        process.on('SIGTERM', () => server.close(() => process.exit(0)));
      `;
      const pid = await runBrowserHost(world.app, `
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, ['--input-type=module', '-e', ${browserScriptValue(source)}], { detached: true, stdio: 'ignore' });
        child.unref();
        return child.pid;
      `);
      if (typeof pid !== "number") throw new Error("The recovery site returned no process.");
      recoveryPid = pid;
      const ready = await runBrowserHost(world.app, `
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            const response = await fetch(${browserScriptValue(failedUrl)}, { signal: AbortSignal.timeout(1000) });
            if (response.ok && (await response.text()).includes('<title>Connection restored</title>')) return true;
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
      `);
      if (ready !== true) throw new Error("The recovery site did not become available.");
    },
    async [Symbol.asyncDispose]() {
      await page.stop();
      if (recoveryPid !== null) await runBrowserHost(world.app, `try { process.kill(${recoveryPid}, 'SIGTERM'); } catch {} return true;`);
    },
  };
}

/** Real native tab and deterministic document, with no viewport emulation. */
export async function browserGeometryWorld(seed: Seed) {
  const world = await createBuiltinBrowserWorld(seed);
  const session = { ...world.session, title: "Browser geometry" };
  await world.renameSession(session.sessionId, session.title);
  const neighbor = await world.openSession("Browser neighbor");
  await world.showSession(session.sessionId);
  const tab = await world.openTab("geometry", session.sessionId);
  await world.loadInputProbe(tab);
  const page = await attachBuiltinTab(world.app, tab.targetId);
  return { app: world.app, session, neighbor, tab, page,
    async [Symbol.asyncDispose]() { await page.stop(); } };
}

/**
 * Leave the emulation fault behind before the body; recovery is a real user act.
 * The capture client stays connected until disposal: since Electron 43.5
 * (electron/electron#52946), a client that disconnects without clearing its
 * override restores the view size itself, which would undo the fault early.
 */
export async function browserViewportWorld(seed: Seed) {
  const base = await builtinBrowserWorld(seed);
  const tab = await seedBrowserTab(seed, base.app, `${base.origin}/?viewport-probe=first`, base.session.sessionId);
  const surface = await attachBuiltinTab(base.app, tab.targetId);
  try {
    const deadline = Date.now() + 15_000;
    let metrics = await readBrowserTabMetrics(base.app, tab.targetId);
    while ((metrics.width <= 0 || metrics.width >= 1280) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      metrics = await readBrowserTabMetrics(base.app, tab.targetId);
    }
    if (metrics.width <= 0 || metrics.width >= 1280) throw new Error("The tab never acquired its panel viewport.");
    const panelViewport = { width: metrics.width, height: metrics.height };
    await surface.client.send("Emulation.setDeviceMetricsOverride", { ...CAPTURE_VIEWPORT, deviceScaleFactor: 0, mobile: false });
    return { ...base, tab, panelViewport, async [Symbol.asyncDispose]() { await surface.stop(); } };
  } catch (error) {
    await surface.stop();
    throw error;
  }
}
