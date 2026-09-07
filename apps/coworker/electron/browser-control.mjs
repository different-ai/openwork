import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const BROWSER_TOOLS = Object.freeze({
  coworker_browser_open: null,
  coworker_browser_tabs: null,
  coworker_browser_close: null,
  coworker_browser_snapshot: "browser_snapshot",
  coworker_browser_click: "browser_click",
  coworker_browser_fill: "browser_fill",
  coworker_browser_eval: "browser_eval",
  coworker_browser_navigate: "browser_navigate",
  coworker_browser_screenshot: "browser_screenshot",
});

export function assertBrowserToolContext({ slug, context, name, args, entry, snapshot, workspaceId, active }) {
  const message = snapshot.messages.find((item) => item.id === context.messageID && item.role === "assistant");
  const part = message?.parts.find((item) => item.type === "tool" && item.callId === context.callID);
  const parent = snapshot.messages.find((item) => item.id === entry?.messageId && item.role === "user");
  if (!Object.hasOwn(BROWSER_TOOLS, name) || !active || !entry?.personRequest || entry.continuation
    || entry.state !== "running" || !entry.sentAt || entry.owner.kind !== "private"
    || entry.owner.slug !== slug || entry.owner.threadId !== context.sessionID || entry.owner.conversationId !== context.sessionID
    || !workspaceId || workspaceId !== entry.workspaceId || snapshot.threadId !== context.sessionID
    || !context.directory || !snapshot.directory || path.resolve(context.directory) !== path.resolve(snapshot.directory)
    || !parent?.parts.some((item) => item.type === "text" && item.text && !item.synthetic && !item.ignored)
    || message?.parentId !== entry.messageId || message.completedAt != null || message.error
    || part?.tool !== name || part.toolStatus !== "running" || !isDeepStrictEqual(part.toolInput, args)) {
    throw new Error("Browser control requires this exact running tool call in a saved private user-request execution.");
  }
}

export function browserPageUrl(value, resource = false) {
  if (typeof value !== "string" || !value || value.length > 8192) throw new Error("An HTTP(S) page URL is required.");
  const url = new URL(value);
  if (!(resource ? ["https:", "http:", "wss:", "ws:"] : ["https:", "http:"]).includes(url.protocol) || url.username || url.password
    || /^(localhost|.*\.localhost|127\..*|0\.0\.0\.0|\[::(?:1)?\]|\[::ffff:.*\])$/i.test(url.hostname.replace(/\.$/, ""))) {
    throw new Error("Browser pages cannot target the app, local control services, credentials, or non-web URLs.");
  }
  return url.href;
}

/** The dedicated evaluation token never reaches renderer state or model handles. */
export async function checkBrowserPolicy(handle, input, request = fetch) {
  // Host request hooks include a method; only those may be WS(S) resources.
  // Explicit page opens/navigation remain HTTP(S), including external opens.
  browserPageUrl(input.url, typeof input.method === "string" && !input.external);
  if (!handle?.url || !handle.policyToken) throw new Error("The browser policy service is unavailable.");
  const response = await request(`${handle.url}/managed-policy/evaluate`, {
    method: "POST", headers: { Authorization: `Bearer ${handle.policyToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: input.external ? "browser_external" : "browser", input }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || (await response.json()).allowed !== true) throw new Error("The browser request was not allowed by managed policy.");
}

function toolArguments(name, args) {
  const fields = name === "coworker_browser_open" ? ["url", "in_background"] : name === "coworker_browser_tabs" ? []
    : ["browser_url", "target_id", ...(name === "coworker_browser_navigate" ? ["url"] : name === "coworker_browser_eval" ? ["expression"] : name === "coworker_browser_fill" ? ["uid", "value", "snapshot_id"] : name === "coworker_browser_click" ? ["uid", "snapshot_id"] : [])];
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !fields.includes(key))) throw new Error("Only this browser tool's page arguments are accepted; ownership comes from the native session.");
  if (name === "coworker_browser_open" || name === "coworker_browser_navigate") browserPageUrl(args.url);
  if (name === "coworker_browser_open" && args.in_background !== undefined && typeof args.in_background !== "boolean") throw new Error("in_background must be boolean.");
  if (!["coworker_browser_open", "coworker_browser_tabs"].includes(name)
    && (typeof args.browser_url !== "string" || args.browser_url.length > 256 || typeof args.target_id !== "string" || !args.target_id || args.target_id.length > 256)) throw new Error("Use the exact browser_url and target_id returned by this discussion's browser tools.");
  if (fields.includes("uid") && (!Number.isSafeInteger(args.uid) || args.uid < 1)) throw new Error("Use a positive integer UID from a fresh snapshot.");
  if (fields.includes("snapshot_id") && (typeof args.snapshot_id !== "string" || !args.snapshot_id || args.snapshot_id.length > 128)) throw new Error("Use the snapshot_id from a fresh snapshot of this exact target.");
  for (const field of ["value", "expression"].filter((key) => fields.includes(key))) {
    if (typeof args[field] !== "string" || args[field].length > 32_000) throw new Error(`${field} must be text of at most 32000 characters.`);
  }
}

const modelTab = (tab) => ({ browser_url: tab.browserUrl, target_id: tab.targetId, tab_id: tab.tabId, url: tab.url, title: tab.title });
const uiTab = (tab) => ({ id: tab.tabId, url: tab.url, title: tab.title, status: tab.status, canGoBack: tab.canGoBack, canGoForward: tab.canGoForward });

/** One native host; UI selection is never model authority. Raw loopback CDP is
 * same-user process access, not a sandbox against other local processes. */
export function createBrowserControl({ createPanel, panelOptions, discussionFor, resolveContext, runTool, checkPolicy }) {
  const scopes = new Map();
  const calls = new Map();
  const requested = new Set();
  const targets = new Map();
  const lifetime = new AbortController();
  let activeByOwner = {};
  let binding = null;
  let revision = 0;
  let destroyed = false;
  const panel = createPanel({ ...panelOptions, checkPolicy, popupDisposition: () => "embedded", onEvent(channel, payload) {
    revision++;
    if (channel === "openwork:browser:state") {
      activeByOwner = payload.activeTabIdByOwner;
      for (const target of targets.values()) observeTarget(target, payload.tabs.find((tab) => tab.id === target.tabId && tab.ownerSessionId === target.ownerId));
    }
    if (channel === "openwork:browser:panel-opened" && payload.ownerSessionId === binding?.ownerId) requested.add(payload.ownerSessionId);
  } });
  function invalidate(target) {
    target.generation++;
    target.receipt = null;
    target.controller?.abort(new Error("The browser page changed. Observe again before acting."));
  }
  function observeTarget(target, tab) {
    if ((!tab && !target.closed) || (tab && (target.url !== tab.url || (tab.status === "loading" && target.status !== "loading")))) invalidate(target);
    target.closed = !tab;
    target.url = tab?.url;
    target.status = tab?.status;
  }
  function targetFor(tab) {
    const key = JSON.stringify([tab.ownerId, tab.browserUrl, tab.targetId]);
    let target = targets.get(key);
    if (!target) {
      target = { ownerId: tab.ownerId, tabId: tab.tabId, url: tab.url, status: tab.status, generation: 0, receipt: null, controller: null, closed: false, tail: Promise.resolve() };
      targets.set(key, target);
    } else observeTarget(target, tab);
    return target;
  }
  function serial(target, work) {
    const result = target.tail.then(work);
    target.tail = result.catch(() => undefined);
    return result;
  }
  function selected(ownerId, tabId = activeByOwner[ownerId]) {
    const tab = panel.listBrowsers(ownerId).find((tab) => tab.tabId === tabId);
    if (!tab) throw new Error("Select an owned browser tab first.");
    return tab;
  }
  async function scopeFor(slug, threadId) {
    if (destroyed || typeof slug !== "string" || !slug || typeof threadId !== "string" || !threadId) throw new Error("Choose a saved private discussion.");
    const scope = await discussionFor(slug, threadId);
    const ownerId = createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.directory, threadId])).digest("hex");
    const key = JSON.stringify([slug, threadId]);
    if (scopes.has(key) && scopes.get(key).ownerId !== ownerId) throw new Error("The original browser workspace changed. Restart Coworker before using its browser.");
    const owner = { ...scope, ownerId };
    scopes.set(key, owner);
    return owner;
  }
  function view(viewId) {
    if (destroyed || !binding?.ownerId || binding.viewId !== viewId) throw new Error("This browser panel is no longer selected.");
    return binding.ownerId;
  }
  function snapshot(ownerId) {
    return { revision, requested: requested.has(ownerId), activeTabId: activeByOwner?.[ownerId] ?? null, tabs: panel.listBrowsers(ownerId).map(uiTab) };
  }
  function owned(ownerId, args) {
    const tab = panel.listBrowsers(ownerId).find((tab) => tab.targetId && tab.targetId === args.target_id && tab.browserUrl === args.browser_url);
    if (!tab) throw new Error("This endpoint and target are not owned by the native discussion. App, shell, and other discussions' targets are denied.");
    browserPageUrl(tab.url);
    return tab;
  }
  return {
    async bind({ slug, threadId, viewId }) {
      if (typeof viewId !== "string" || !viewId || viewId.length > 128) throw new Error("A browser view identity is required.");
      panel.hide(); panel.setVisibleSession(null);
      const next = { viewId, ownerId: null };
      binding = next;
      const scope = await scopeFor(slug, threadId);
      if (binding !== next || destroyed) throw new Error("The selected discussion changed.");
      next.ownerId = scope.ownerId;
      panel.setVisibleSession(scope.ownerId);
      return snapshot(scope.ownerId);
    },
    detach({ viewId }) {
      if (binding?.viewId !== viewId) return;
      binding = null; panel.hide(); panel.setVisibleSession(null);
    },
    hideWindow() { binding = null; panel.hide(); panel.setVisibleSession(null); },
    read({ viewId }) { return snapshot(view(viewId)); },
    async command({ viewId, action, url, tabId, bounds, open }) {
      const ownerId = view(viewId);
      if (action === "request") { if (typeof open !== "boolean") throw new Error("Choose whether to open the browser panel."); if (open) requested.add(ownerId); else { requested.delete(ownerId); panel.hide(); } }
      else if (action === "hide") panel.hide();
      else if (action === "bounds") {
        if (!bounds || ["x", "y", "width", "height"].some((key) => !Number.isFinite(bounds[key]) || bounds[key] < 0 || bounds[key] > 100_000)) throw new Error("Valid browser bounds are required.");
        if (requested.has(ownerId) && bounds.width > 0 && bounds.height > 0) panel.show(bounds);
        else panel.hide();
      } else if (["select", "close"].includes(action)) {
        if (typeof tabId !== "string" || !tabId) throw new Error("An owned tab is required.");
        if (action === "select") panel.selectBrowser({ ownerId, tabId });
        else { invalidate(targetFor(selected(ownerId, tabId))); panel.closeBrowser({ ownerId, tabId }); }
      } else if (["open", "navigate"].includes(action)) {
        const tab = action === "navigate" ? selected(ownerId) : null;
        url = browserPageUrl(url);
        await checkPolicy({ url });
        view(viewId);
        if (action === "open") await panel.createBrowser({ ownerId, url });
        else {
          if (selected(ownerId).tabId !== tab.tabId) throw new Error("The selected browser tab changed.");
          invalidate(targetFor(tab)); panel.navigate(url);
        }
      } else if (["back", "forward", "reload"].includes(action)) { invalidate(targetFor(selected(ownerId))); panel[action](); }
      else throw new Error("Unknown browser panel command.");
      revision++;
      return snapshot(ownerId);
    },
    async execute(slug, { name, args, context, cancel = false }) {
      if (!Object.hasOwn(BROWSER_TOOLS, name) || !context?.sessionID || !context.messageID || !context.callID || !context.directory) throw new Error("A canonical native browser tool origin is required.");
      toolArguments(name, args);
      const key = JSON.stringify([slug, context.directory, context.sessionID, context.messageID, context.callID]);
      let prior = calls.get(key);
      if (typeof cancel !== "boolean") throw new Error("Invalid browser cancellation.");
      if (cancel) {
        if (!prior) {
          await resolveContext(slug, context, { name, args });
          prior = calls.get(key);
        }
        if (prior && (prior.name !== name || !isDeepStrictEqual(prior.args, args))) throw new Error("Cancellation requires the exact native browser call.");
        if (!prior) {
          if (calls.size >= 4096) throw new Error("This launch reached its browser receipt limit. Restart Coworker.");
          prior = { name, args: structuredClone(args), controller: new AbortController(), result: Promise.resolve("This native browser call was cancelled before admission. Do not replay it.") };
          calls.set(key, prior);
        }
        prior.controller.abort(new Error("This native browser tool was cancelled. Do not replay an uncertain action."));
        return "Browser tool cancelled. Already dispatched input cannot be undone; observe before continuing.";
      }
      if (prior) {
        if (prior.name !== name || !isDeepStrictEqual(prior.args, args)) throw new Error("This native tool call already used different arguments.");
        return prior.result;
      }
      if (calls.size >= 4096) throw new Error("This launch reached its browser receipt limit. Restart Coworker.");
      const call = { name, args: structuredClone(args), controller: new AbortController() };
      calls.set(key, call);
      call.result = Promise.resolve().then(async () => {
        const scope = await scopeFor(slug, context.sessionID);
        if (path.resolve(context.directory) !== scope.directory) throw new Error("The native browser call belongs to another workspace.");
        const trusted = await resolveContext(slug, context, { name, args });
        const signal = AbortSignal.any([trusted.signal, call.controller.signal, lifetime.signal]);
        const check = () => { trusted.assertActive(); signal.throwIfAborted(); if (destroyed || trusted.entry.workspaceId !== scope.workspaceId) throw new Error("The browser execution is no longer available."); };
        check();
        if (name === "coworker_browser_open") {
          await checkPolicy({ url: args.url }); check();
          const tab = await panel.createBrowser({ ownerId: scope.ownerId, url: args.url, inBackground: args.in_background === true });
          try { check(); } catch (error) { panel.closeBrowser({ ownerId: scope.ownerId, tabId: tab.tabId }); throw error; }
          return JSON.stringify(modelTab(tab));
        }
        if (name === "coworker_browser_tabs") {
          const tabs = panel.listBrowsers(scope.ownerId).filter((tab) => tab.targetId);
          await Promise.all(tabs.map((tab) => checkPolicy({ url: tab.url })));
          check();
          return JSON.stringify(tabs.map(modelTab));
        }
        const target = targetFor(owned(scope.ownerId, args));
        return serial(target, async () => {
          check();
          const tab = owned(scope.ownerId, args);
          observeTarget(target, tab);
          if (name === "coworker_browser_close") { invalidate(target); panel.closeBrowser({ ownerId: scope.ownerId, targetId: tab.targetId }); return "Closed this discussion's browser tab."; }
          await checkPolicy({ url: name === "coworker_browser_navigate" ? args.url : tab.url });
          const fresh = await resolveContext(slug, context, { name, args });
          fresh.assertActive(); check(); observeTarget(target, owned(scope.ownerId, args));
          const observing = ["coworker_browser_snapshot", "coworker_browser_screenshot", "coworker_browser_click", "coworker_browser_fill"].includes(name);
          if (observing && target.status !== "ready") throw new Error("The browser page is loading. Wait for a fresh snapshot.");
          if (["coworker_browser_click", "coworker_browser_fill"].includes(name)
            && (!target.receipt || target.receipt.id !== args.snapshot_id || target.receipt.generation !== target.generation)) throw new Error("This snapshot_id is stale or belongs to another target. Observe again; no input was dispatched.");
          // Consume before any dispatch, including failures. Arbitrary eval can
          // mutate the page too; only screenshot leaves an observation intact.
          if (name !== "coworker_browser_screenshot") invalidate(target);
          const generation = target.generation;
          const controller = new AbortController();
          if (observing) target.controller = controller;
          const abort = AbortSignal.any([signal, controller.signal]);
          const { snapshot_id: _receipt, ...providerArgs } = args;
          try {
            const result = await runTool(BROWSER_TOOLS[name], providerArgs, { ...context, directory: scope.directory, abort });
            check(); abort.throwIfAborted(); observeTarget(target, owned(scope.ownerId, args));
            if (observing && (target.generation !== generation || target.status !== "ready")) throw new Error("The browser page changed during observation or input. Observe again; do not replay input.");
            if (name === "coworker_browser_snapshot") {
              target.receipt = { id: randomUUID(), generation };
              return JSON.stringify({ snapshot_id: target.receipt.id, snapshot: result });
            }
            return result;
          } finally { if (target.controller === controller) target.controller = null; }
        });
      });
      try { return await call.result; }
      finally { call.result = Promise.resolve("This native browser call already completed or was interrupted. Do not replay it; use a new observation to inspect the outcome."); }
    },
    destroy() { destroyed = true; lifetime.abort(new Error("The browser host closed.")); binding = null; requested.clear(); targets.clear(); panel.destroy(); },
  };
}
