// Request interception for secret handles in the built-in browser. While a tab has a live
// placeholder, every request of that tab pauses in `webContents.debugger` and the shared decision
// in `@openwork/computer-use/browser-secrets` answers it: continue as sent, continue with the
// placeholder swapped for the value, or fail. A paused request can hold a value (a redirect hop
// repeats the rewritten body), so nothing of one is ever logged, kept or put in an error.
import { decidePausedRequest } from "@openwork/computer-use/browser-secrets";

/** @typedef {{ tabId: string, view: { webContents: import("electron").WebContents } }} InterceptedTab */
/** @typedef {ReturnType<typeof import("@openwork/computer-use/browser-secrets").createBrowserSecrets>} BrowserSecrets */
/** @typedef {Parameters<typeof decidePausedRequest>[2]} PausedRequest */
/**
 * @typedef {{
 *   tab: InterceptedTab, tabId: string, contents: import("electron").WebContents, cdp: import("electron").Debugger,
 *   attachedByUs: boolean, detachDeferred: boolean, enabled: boolean, autoAttach: boolean, lost: boolean,
 *   ready: Promise<boolean>, arming: Promise<boolean>, releasing: Promise<void> | null,
 *   graceUntil: number, graceTimer: NodeJS.Timeout | null, work: Set<Promise<unknown>>, children: Set<string>,
 *   onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void, onDetach: () => void, onGone: () => void, onDestroyed: () => void,
 * }} Held
 */

const REQUEST_STAGE = Object.freeze({ patterns: [{ urlPattern: "*", requestStage: "Request" }] });
// Cross-site frames and service workers are debugger targets of their own. Each one found is
// intercepted like its page; `waitForDebuggerOnStart` stays off so a page never waits on OpenWork,
// which means a request such a target makes before its interception is on keeps its placeholder.
const AUTO_ATTACH = Object.freeze({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const NO_AUTO_ATTACH = Object.freeze({ autoAttach: false, waitForDebuggerOnStart: false, flatten: true });

/** @param {unknown} value @param {string} key @returns {unknown} */
const field = (value, key) => value && typeof value === "object" ? Reflect.get(value, key) : undefined;
/** @param {unknown} params @returns {params is PausedRequest} */
const isPausedRequest = (params) => typeof field(params, "requestId") === "string" && typeof field(field(params, "request"), "url") === "string";

/**
 * @param {{
 *   secrets: BrowserSecrets,
 *   hasDocument?: (tab: InterceptedTab) => boolean,
 *   keepDebugger?: (tab: InterceptedTab) => boolean,
 *   armGraceMs?: number,
 *   commandTimeoutMs?: number,
 * }} options
 * `hasDocument` says whether the tab has a committed document (the debugger is never attached
 * before one). `keepDebugger` says whether something else still needs the tab's debugger when
 * interception ends. After `arm`, interception stays on for `armGraceMs` even with no live
 * placeholder, so the placeholder issued right after arming is covered.
 */
export function createSecretInterception({ secrets, hasDocument = (_tab) => true, keepDebugger = (_tab) => false, armGraceMs = 10_000, commandTimeoutMs = 5_000 }) {
  /** @type {Map<string, Held>} */
  const held = new Map();
  let disposed = false;

  /** @param {InterceptedTab} tab */
  const usable = (tab) => {
    const contents = tab.view.webContents;
    return !disposed && !contents.isDestroyed() && !contents.isCrashed() && hasDocument(tab);
  };
  /** @param {Held} state */
  const attached = (state) => !state.contents.isDestroyed() && state.cdp.isAttached();
  /** A debugger command that settles: a target that never answers rejects after `commandTimeoutMs`. @param {Held} state @param {string} method @param {object} [params] @param {string} [sessionId] */
  function command(state, method, params, sessionId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("debugger_timeout")), commandTimeoutMs);
      state.cdp.sendCommand(method, params, sessionId).then(
        (result) => { clearTimeout(timer); resolve(result); },
        () => { clearTimeout(timer); reject(new Error("debugger_command_failed")); },
      );
    });
  }
  /** @template T @param {Held} state @param {Promise<T>} work @returns {Promise<T>} */
  function track(state, work) {
    state.work.add(work);
    const done = () => { state.work.delete(work); };
    work.then(done, done);
    return work;
  }
  /** Resolves once every answer and child setup in flight has settled, or stopped answering. @param {Held} state */
  async function quiet(state) {
    const deadline = Date.now() + commandTimeoutMs;
    while (state.work.size && Date.now() < deadline) {
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      await Promise.race([Promise.allSettled([...state.work]), new Promise((resolve) => { timer = setTimeout(resolve, Math.max(deadline - Date.now(), 0)); })]);
      clearTimeout(timer);
    }
  }
  /** @param {Held} state */
  function unlisten(state) {
    if (state.graceTimer) clearTimeout(state.graceTimer);
    state.graceTimer = null;
    state.cdp.removeListener("message", state.onMessage);
    state.cdp.removeListener("detach", state.onDetach);
    state.contents.removeListener("render-process-gone", state.onGone);
    state.contents.removeListener("destroyed", state.onDestroyed);
  }
  /** @param {Held} state */
  function forget(state) {
    if (held.get(state.tabId) === state) held.delete(state.tabId);
  }

  /** The bytes the event carries, for a body it does not carry whole: a part read from disk has none. @param {PausedRequest} params */
  function carriedBody(params) {
    const entries = Array.isArray(params.request.postDataEntries) ? params.request.postDataEntries : [];
    return { body: Buffer.concat(entries.flatMap((entry) => typeof entry?.bytes === "string" ? [Buffer.from(entry.bytes, "base64")] : [])), complete: false };
  }

  /**
   * Answers one paused request exactly once. A rewrite Chromium refuses, or any other failure,
   * fails the request; when even that cannot be sent the request went away with its target.
   * @param {Held} state @param {unknown} params @param {string} [sessionId]
   */
  async function answer(state, params, sessionId) {
    const requestId = field(params, "requestId");
    // The page's own session reports itself as an empty id, which no command accepts.
    const session = sessionId || undefined;
    try {
      if (!isPausedRequest(params)) throw new Error("not a paused request");
      // Only requests are decided here; a response paused by another pattern goes on as it is.
      const reply = field(params, "responseStatusCode") !== undefined || field(params, "responseErrorReason") !== undefined
        ? { method: "Fetch.continueRequest", params: { requestId } }
        : await decidePausedRequest(secrets, state.tabId, params, { readBody: async () => carriedBody(params) });
      await state.cdp.sendCommand(reply.method, reply.params, session);
    } catch {
      try { await state.cdp.sendCommand("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, session); } catch { /* the request or its target is gone */ }
    }
  }

  /** Intercepts a frame or worker target the page's session reported. @param {Held} state @param {unknown} params */
  async function adopt(state, params) {
    const child = field(params, "sessionId");
    if (typeof child !== "string" || state.releasing || state.lost) return;
    state.children.add(child);
    try {
      // A dedicated worker has no Fetch domain: its requests pause in its page's session.
      await command(state, "Fetch.enable", REQUEST_STAGE, child);
      await command(state, "Target.setAutoAttach", AUTO_ATTACH, child);
    } catch { /* not a target that loads through its own session */ }
    if (field(params, "waitingForDebugger") === true) await command(state, "Runtime.runIfWaitingForDebugger", undefined, child).catch(() => {});
  }

  /** Turns interception on for a tab already recorded in `held`. Never rejects. @param {Held} state */
  async function enable(state) {
    try {
      await command(state, "Fetch.enable", REQUEST_STAGE);
    } catch { return false; }
    try {
      await command(state, "Target.setAutoAttach", AUTO_ATTACH);
      state.autoAttach = true;
      // Frames and workers that already exist were reported before that answer.
      await quiet(state);
    } catch { /* the page itself is intercepted; its other targets keep their placeholders */ }
    return true;
  }

  /**
   * Removes interception without leaving a request paused: the listener keeps answering until
   * Chromium confirms interception is off. The debugger is detached when this module attached it
   * (or held back someone's detach) and nothing else needs it, and always when interception could
   * not be turned off cleanly, since a detach releases every paused request.
   * @param {Held} state
   */
  async function teardown(state) {
    await state.ready;
    await quiet(state);
    let clean = true;
    if (!state.lost && attached(state)) {
      // A frame or worker that already went away has nothing left to turn off.
      await Promise.all([...state.children].map((child) => command(state, "Fetch.disable", undefined, child).catch(() => {})));
      // Ending auto-attach detaches every frame and worker session, which also ends their interception.
      if (state.autoAttach) clean = await command(state, "Target.setAutoAttach", NO_AUTO_ATTACH).then(() => true, () => false);
      clean = await command(state, "Fetch.disable").then(() => true, () => false) && clean;
      await quiet(state);
    }
    const lost = state.lost;
    unlisten(state);
    if (!lost && attached(state) && (!clean || ((state.attachedByUs || state.detachDeferred) && !keepDebugger(state.tab)))) {
      try { state.cdp.detach(); } catch { /* already detached */ }
    }
    state.enabled = false;
    forget(state);
  }
  /** @param {Held} state */
  const release = (state) => state.releasing ??= teardown(state);

  /** The debugger went away underneath: nothing of this tab is intercepted any more. @param {Held} state */
  function lose(state) {
    if (state.lost) return;
    state.lost = true;
    state.enabled = false;
    unlisten(state);
    forget(state);
    secrets.interceptionLost(state.tabId);
  }

  /** @param {Held} state */
  function extendGrace(state) {
    state.graceUntil = Date.now() + armGraceMs;
    if (state.graceTimer) clearTimeout(state.graceTimer);
    state.graceTimer = setTimeout(() => { state.graceTimer = null; releaseWhenIdle(state.tabId); }, armGraceMs + 1);
    state.graceTimer.unref();
  }
  /** @param {string} tabId */
  function releaseWhenIdle(tabId) {
    const state = held.get(tabId);
    if (!state || state.releasing || !state.enabled || Date.now() < state.graceUntil || secrets.live(tabId)) return;
    void release(state);
  }
  const unsubscribe = secrets.onLiveChange((tabId, live) => { if (!live) releaseWhenIdle(tabId); });

  /** @param {InterceptedTab} tab @returns {Promise<boolean>} */
  function start(tab) {
    const contents = tab.view.webContents;
    const cdp = contents.debugger;
    let attachedByUs = false;
    try {
      if (!cdp.isAttached()) { cdp.attach("1.3"); attachedByUs = true; }
    } catch { return Promise.resolve(false); }
    /** @type {Held} */
    const state = {
      tab, tabId: tab.tabId, contents, cdp, attachedByUs, detachDeferred: false, enabled: false, autoAttach: false, lost: false,
      ready: Promise.resolve(false), arming: Promise.resolve(false), releasing: null,
      graceUntil: 0, graceTimer: null, work: new Set(), children: new Set(),
      onMessage(_event, method, params, sessionId) {
        if (method === "Fetch.requestPaused") void track(state, answer(state, params, sessionId));
        else if (method === "Target.attachedToTarget") void track(state, adopt(state, params));
        else if (method === "Target.detachedFromTarget") state.children.delete(String(field(params, "sessionId")));
      },
      onDetach() { lose(state); },
      // A dead renderer sends nothing more: its placeholders end at once, then interception is removed.
      onGone() { secrets.interceptionLost(state.tabId); void release(state); },
      onDestroyed() { lose(state); },
    };
    held.set(state.tabId, state);
    cdp.on("message", state.onMessage);
    cdp.on("detach", state.onDetach);
    contents.on("render-process-gone", state.onGone);
    contents.once("destroyed", state.onDestroyed);
    state.ready = enable(state);
    state.arming = state.ready.then(async (on) => {
      if (on && !state.lost && !state.releasing && usable(tab)) {
        state.enabled = true;
        extendGrace(state);
        return true;
      }
      if (!state.lost) await release(state);
      return false;
    });
    return state.arming;
  }

  return {
    /**
     * Resolves true once every request of the tab's page pauses here, and those of the cross-site
     * frames and service workers it has at that moment. False when the tab has no document, its
     * renderer is gone, or its debugger belongs to someone else (DevTools open on the page).
     * Safe to call again and concurrently.
     * @param {InterceptedTab} tab @returns {Promise<boolean>}
     */
    async arm(tab) {
      if (typeof tab?.tabId !== "string" || !tab.view?.webContents || !usable(tab)) return false;
      for (;;) {
        const state = held.get(tab.tabId);
        if (!state) return start(tab);
        if (state.contents !== tab.view.webContents) { await release(state); continue; }
        if (state.releasing) { await state.releasing; continue; }
        const on = await state.arming;
        if (on && held.get(tab.tabId) === state && !state.releasing) { extendGrace(state); return true; }
        if (!on) return false;
      }
    },
    /** True from the moment interception starts for the tab until it is fully removed: nobody else may detach its debugger meanwhile. @param {InterceptedTab} tab */
    holds(tab) {
      const state = tab ? held.get(tab.tabId) : undefined;
      return Boolean(state) && state?.contents === tab.view?.webContents;
    },
    /** Someone else is done with the tab's debugger while interception holds it: it is detached when interception ends. @param {InterceptedTab} tab */
    detachOnRelease(tab) {
      const state = tab ? held.get(tab.tabId) : undefined;
      if (state && state.contents === tab.view?.webContents) state.detachDeferred = true;
    },
    /** Removes the tab's interception now. Placeholders it still had are revoked: none stays live without interception. @param {InterceptedTab} tab @returns {Promise<void>} */
    release(tab) {
      const state = tab ? held.get(tab.tabId) : undefined;
      if (!state) return Promise.resolve();
      secrets.interceptionLost(state.tabId);
      return release(state);
    },
    /** Removes every interception, revoking the placeholders they covered, and stops following the store. @returns {Promise<void>} */
    async dispose() {
      disposed = true;
      unsubscribe();
      await Promise.all([...held.values()].map((state) => { secrets.interceptionLost(state.tabId); return release(state); }));
    },
  };
}
