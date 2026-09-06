import { control } from "@openwork/behaviors";
import { captureScreenshot, connect, debuggerUrlFor, evaluate, listTargets, navigate } from "@openwork/cdp";
import type { CdpClient, Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

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
  ownerSessionId: string | null;
}

export interface BrowserState {
  activeTabId: string | null;
  visibleSessionId: string | null;
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
  + '<script>window.__clicks=0;document.getElementById("hit").addEventListener("click",()=>{window.__clicks+=1});</script>',
)}`;

function pngSize(png: Buffer): Viewport {
  if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") throw new Error("Screenshot is not a PNG.");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function parseBrowserState(value: unknown): BrowserState {
  if (!isRecord(value) || !Array.isArray(value.tabs)) throw new Error("The desktop bridge did not report browser state.");
  if (!Array.isArray(value.nativeViews)) throw new Error("The desktop bridge did not report native browser views.");
  return {
    activeTabId: typeof value.activeTabId === "string" ? value.activeTabId : null,
    visibleSessionId: typeof value.visibleSessionId === "string" ? value.visibleSessionId : null,
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
      return {
        id: stringField(tab.id),
        label: stringField(tab.label),
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

/**
 * A page origin the app can always reach from its own host: the embedded
 * OpenWork server. Any HTTP response renders as a page in the built-in
 * browser; the response body is irrelevant to the viewport journey.
 */
async function embeddedServerUrl(seed: Seed, app: Surface): Promise<string> {
  const info = await seed.evalIn(app, `window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo")`, { awaitPromise: true });
  if (!isRecord(info) || info.running !== true) throw new Error("The embedded OpenWork server is not running.");
  return stringField(info.baseUrl).replace(/\/+$/, "");
}

async function withTabClient<T>(app: Surface, targetId: string, run: (client: CdpClient) => Promise<T>): Promise<T> {
  const target = (await listTargets(app.handle.cdpUrl)).find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`Built-in browser tab target ${targetId} is not listed by the app's CDP endpoint.`);
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
async function createBuiltinBrowserWorld(seed: Seed, env?: Record<string, string>) {
  const app = await seed.desktop({ name: "builtin-browser", env });
  const workspace = await seed.workspace(app, seed.tmpPath("builtin-browser"));
  const session = await seed.session(app);
  const origin = await embeddedServerUrl(seed, app);
  const loginWitnessOrigin = stringField(await seed.evalIn(
    app,
    "window.__OPENWORK_ELECTRON__.browserLogins.testWitnessUrl()",
    { awaitPromise: true },
  ));

  return {
    app,
    workspace,
    session,

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
        const actions = await seed.evalIn(app, "window.__openworkControl.listActions().map((action) => action.id)");
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

    /** Open a page in the built-in browser the way the agent's browser tool does. */
    async openTab(name: string): Promise<BuiltinBrowserTab> {
      const url = `${origin}/?viewport-probe=${encodeURIComponent(name)}`;
      const result = await seed.evalIn(
        app,
        `window.__OPENWORK_ELECTRON__.browser.openUrl(${JSON.stringify(url)})`,
        { awaitPromise: true, timeoutMs: 30_000 },
      );
      if (!isRecord(result)) throw new Error("browser.openUrl returned no handle.");
      return {
        tabId: stringField(result.tab_id),
        targetId: stringField(result.target_id),
        name,
      };
    },

    /** Open a page that reports only whether an HttpOnly session cookie arrived. */
    async openLoginWitnessTab(name: string): Promise<BuiltinBrowserTab> {
      const url = `${loginWitnessOrigin}/?login-probe=${encodeURIComponent(name)}`;
      const result = await seed.evalIn(
        app,
        `window.__OPENWORK_ELECTRON__.browser.openUrl(${JSON.stringify(url)})`,
        { awaitPromise: true, timeoutMs: 30_000 },
      );
      if (!isRecord(result)) throw new Error("browser.openUrl returned no login witness handle.");
      return { tabId: stringField(result.tab_id), targetId: stringField(result.target_id), name };
    },

    /** Open the value-free login witness from a conversation that is not on screen. */
    async openLoginWitnessTabAs(name: string, ownerSessionId: string): Promise<OpenedTab> {
      const url = `${loginWitnessOrigin}/?login-probe=${encodeURIComponent(name)}`;
      const result = await seed.evalIn(
        app,
        `window.__openworkControl.command(${JSON.stringify({
          id: "browser.open_url",
          args: { url, provider: "builtin" },
          origin: { sessionId: ownerSessionId },
        })})`,
        { awaitPromise: true, timeoutMs: 30_000 },
      );
      if (!isRecord(result) || result.ok !== true || !isRecord(result.result)) {
        throw new Error(`background login witness failed: ${isRecord(result) ? String(result.error ?? "unknown") : "no response"}`);
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

    /**
     * Open a page the way an agent in a given conversation does: the request
     * reaches the UI command bus stamped with that conversation as its origin,
     * exactly as the OpenWork bridge stamps `openwork_execute` calls.
     */
    async openTabAs(name: string, ownerSessionId: string): Promise<OpenedTab> {
      const url = `${origin}/?viewport-probe=${encodeURIComponent(name)}`;
      const result = await seed.evalIn(
        app,
        `window.__openworkControl.command(${JSON.stringify({
          id: "browser.open_url",
          args: { url, provider: "builtin" },
          origin: { sessionId: ownerSessionId },
        })})`,
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

    /** Host used by the value-free HttpOnly login witness. */
    loginWitnessHost: new URL(loginWitnessOrigin).hostname,

    /**
     * Seed a Firefox-shaped cookie store the import dialog can find, so the
     * journey drives the real import against a known set of logins.
     */
    async seedLoginStore(name: string, cookies: Array<Record<string, unknown>>): Promise<{ id: string; label: string; path: string }> {
      const directory = seed.tmpPath(`logins-${name}`);
      const storePath = `${directory}/cookies.sqlite`;
      const result = await seed.evalIn(
        app,
        `window.__OPENWORK_ELECTRON__.browserLogins.writeTestStore(${JSON.stringify({ path: storePath, cookies })})`,
        { awaitPromise: true, timeoutMs: 30_000 },
      );
      if (!isRecord(result)) throw new Error("The eval seam did not register a login store.");
      return { id: stringField(result.id), label: stringField(result.label), path: storePath };
    },

    /** Replace the synthetic source store; the desktop watcher observes this write. */
    async updateLoginStore(storePath: string, cookies: Array<Record<string, unknown>>): Promise<void> {
      const result = await seed.evalIn(
        app,
        `window.__OPENWORK_ELECTRON__.browserLogins.writeTestStore(${JSON.stringify({ path: storePath, cookies })})`,
        { awaitPromise: true, timeoutMs: 30_000 },
      );
      if (!isRecord(result)) throw new Error("The eval seam did not update the login store.");
    },

    /** Open a Settings panel the way the app's own navigation does. */
    async openSettingsPanel(panel: string): Promise<void> {
      await control(app, "settings.panel.open", { panel });
    },

    /** Which sites the import dialog currently has checked. */
    async readCheckedSyncSites(): Promise<string[]> {
      const result = await seed.evalIn(
        app,
        `[...document.querySelectorAll('[data-testid^="login-sync-site-"]')]
          .filter((element) => element.getAttribute("aria-checked") === "true" || element.hasAttribute("data-checked"))
          .map((element) => element.getAttribute("data-testid").slice("login-sync-site-".length))`,
      );
      if (!Array.isArray(result)) throw new Error("The sync dialog did not report its checked sites.");
      return result.map(String);
    },

    /** Ask the desktop to preview a discovered source; used to prove the policy gate refuses. */
    async previewLoginStore(sourceId: string): Promise<{ ok: boolean; error: string | null; sites: string[] }> {
      const result = await seed.evalIn(
        app,
        `window.__OPENWORK_ELECTRON__.browserLogins.preview(${JSON.stringify({ sourceId })})
          .then((preview) => ({ ok: true, error: null, sites: preview.sites.map((site) => site.site) }))
          .catch((error) => ({ ok: false, error: String(error && error.message || error), sites: [] }))`,
        { awaitPromise: true, timeoutMs: 30_000 },
      );
      if (!isRecord(result) || typeof result.ok !== "boolean" || !Array.isArray(result.sites)) {
        throw new Error("The desktop bridge did not answer the login preview.");
      }
      return { ok: result.ok, error: typeof result.error === "string" ? result.error : null, sites: result.sites.map(String) };
    },

    /** Sites the built-in browser is signed in to, as Settings shows them. */
    async signedInSites(): Promise<string[]> {
      const result = await seed.evalIn(app, "window.__OPENWORK_ELECTRON__.browserLogins.signedInSites()", { awaitPromise: true });
      if (!Array.isArray(result)) throw new Error("The desktop bridge did not list signed-in sites.");
      return result.map((site) => (isRecord(site) ? stringField(site.site) : "")).filter(Boolean);
    },

    /** Renderer-safe sync metadata, never cookie values. */
    async loginSyncState(): Promise<Record<string, unknown>> {
      const result = await seed.evalIn(app, "window.__OPENWORK_ELECTRON__.browserLogins.state()", { awaitPromise: true });
      if (!isRecord(result)) throw new Error("The desktop bridge did not report browser login sync state.");
      return result;
    },

    async pauseLoginSync(): Promise<void> {
      await seed.evalIn(app, "window.__OPENWORK_ELECTRON__.browserLogins.pause()", { awaitPromise: true });
    },

    /** What the witness page observes without exposing an HttpOnly cookie value. */
    async readLoginWitness(tab: BuiltinBrowserTab): Promise<string> {
      return withTabClient(app, tab.targetId, async (client) => String(await evaluate(client, "document.body.dataset.loginState")));
    },

    /** What the page inside a tab can read from `document.cookie`. */
    async readDocumentCookie(tab: BuiltinBrowserTab): Promise<string> {
      return withTabClient(app, tab.targetId, async (client) => String(await evaluate(client, "document.cookie")));
    },

    /** Reload a tab over CDP and wait for it to settle. */
    async reloadTab(tab: BuiltinBrowserTab): Promise<void> {
      await withTabClient(app, tab.targetId, async (client) => {
        await client.send("Page.reload");
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          if ((await evaluate(client, "document.readyState")) === "complete") return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
    },

    /** Every tab the native browser holds, who owns it, and which conversation is on screen. */
    async readBrowserState(): Promise<BrowserState> {
      return parseBrowserState(await seed.evalIn(
        app,
        "window.__OPENWORK_ELECTRON__.browser.getState()",
        { awaitPromise: true },
      ));
    },

    /** The viewport a tab lays out for and whether its page believes it has focus. */
    async readPageProbe(tab: BuiltinBrowserTab): Promise<PageProbe> {
      return withTabClient(app, tab.targetId, async (client) => parsePageProbe(
        await evaluate(client, "({ width: window.innerWidth, height: window.innerHeight, hasFocus: document.hasFocus() })"),
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
          if ((await evaluate(client, "document.title")) === "input-probe") return;
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
        await evaluate(client, "document.getElementById('field').focus()");
        for (const char of text) {
          await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
          await client.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
        }
        const result = await evaluate(client, "({ clicks: window.__clicks, value: document.getElementById('field').value })");
        if (!isRecord(result) || typeof result.clicks !== "number" || typeof result.value !== "string") {
          throw new Error("The input probe page did not report clicks and typed text.");
        }
        return { clicks: result.clicks, value: result.value };
      });
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
        await evaluate(client, "({ width: window.innerWidth, height: window.innerHeight })"),
      ));
    },
  };
}

export function builtinBrowserWorld(seed: Seed) {
  return createBuiltinBrowserWorld(seed);
}

export function browserLoginSyncWorld(seed: Seed) {
  return createBuiltinBrowserWorld(seed, { OPENWORK_EVAL_BROWSER_LOGIN_SYNC: "1" });
}
