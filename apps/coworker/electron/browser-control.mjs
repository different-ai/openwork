import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const BROWSER_TOOLS = Object.freeze({
  coworker_browser_open: null,
  coworker_browser_tabs: null,
  coworker_browser_close: null,
  coworker_browser_handoff: null,
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
    : ["browser_url", "target_id", ...(name === "coworker_browser_handoff" ? ["reason"] : name === "coworker_browser_navigate" ? ["url"] : name === "coworker_browser_eval" ? ["expression"] : name === "coworker_browser_fill" ? ["uid", "value", "snapshot_id"] : name === "coworker_browser_click" ? ["uid", "snapshot_id"] : [])];
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !fields.includes(key))) throw new Error("Only this browser tool's page arguments are accepted; ownership comes from the native session.");
  if (name === "coworker_browser_open" || name === "coworker_browser_navigate") browserPageUrl(args.url);
  if (name === "coworker_browser_open" && args.in_background !== undefined && typeof args.in_background !== "boolean") throw new Error("in_background must be boolean.");
  if (name === "coworker_browser_handoff" && !["sign-in", "takeover"].includes(args.reason)) throw new Error("Choose sign-in or takeover for the browser handoff.");
  if (!["coworker_browser_open", "coworker_browser_tabs"].includes(name)
    && (typeof args.browser_url !== "string" || args.browser_url.length > 256 || typeof args.target_id !== "string" || !args.target_id || args.target_id.length > 256)) throw new Error("Use the exact browser_url and target_id returned by this discussion's browser tools.");
  if (fields.includes("uid") && (!Number.isSafeInteger(args.uid) || args.uid < 1)) throw new Error("Use a positive integer UID from a fresh snapshot.");
  if (fields.includes("snapshot_id") && (typeof args.snapshot_id !== "string" || !args.snapshot_id || args.snapshot_id.length > 128)) throw new Error("Use the snapshot_id from a fresh snapshot of this exact target.");
  for (const field of ["value", "expression"].filter((key) => fields.includes(key))) {
    if (typeof args[field] !== "string" || args[field].length > 32_000) throw new Error(`${field} must be text of at most 32000 characters.`);
  }
}

const modelTab = (tab) => ({ browser_url: tab.browserUrl, target_id: tab.targetId, tab_id: tab.tabId, url: tab.identityOnly ? "about:blank" : tab.url, title: tab.identityOnly ? "New tab" : tab.title });
const uiTab = (tab) => ({ id: tab.tabId, url: tab.url, title: tab.title, status: tab.status, canGoBack: tab.canGoBack, canGoForward: tab.canGoForward });
const activityLabels = Object.freeze({ open: "Opening a page", tabs: "Checking browser tabs", close: "Closing a page", snapshot: "Reading the page", screenshot: "Capturing the page", click: "Interacting with the page", fill: "Entering text", eval: "Working with the page", navigate: "Navigating the page", handoff: "Waiting for you" });

async function waitForBrowserWork(work, signal) {
  let abort;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

/** One native host; UI selection is never model authority. Raw loopback CDP is
 * same-user process access, not a sandbox against other local processes. */
export function createBrowserControl({ createPanel, panelOptions, discussionFor, resolveContext, runTool, checkPolicy, handoffMs = 120_000 }) {
  const scopes = new Map();
  const controls = new Map();
  const calls = new Map();
  const targets = new Map();
  const lifetime = new AbortController();
  let activeByOwner = {};
  let binding = null;
  let revision = 0;
  // A launch clock detects owner transitions even while scope admission awaits.
  let controlEpoch = 0;
  let visibleOwner = null;
  let destroyed = false;
  const panel = createPanel({ ...panelOptions, backgroundViewport: { width: 1280, height: 900 }, checkPolicy, popupDisposition: () => "embedded", onPresentationExit: exitPresentation, onEvent(channel, payload) {
    revision++;
    if (channel === "openwork:browser:state") {
      activeByOwner = payload.activeTabIdByOwner;
      for (const target of targets.values()) observeTarget(target, payload.tabs.find((tab) => tab.id === target.tabId && tab.ownerSessionId === target.ownerId));
      for (const [ownerId, control] of controls) {
        if (control.handoff?.tabId === "" && activeByOwner[ownerId]) control.handoff.tabId = activeByOwner[ownerId];
        if (control.handoff?.tabId && !payload.tabs.some((tab) => tab.id === control.handoff.tabId && tab.ownerSessionId === ownerId)) control.handoff.finish(false);
      }
    }
    if (channel === "openwork:browser:unavailable" && binding?.ownerId === payload.ownerId) detachBinding();
  } });
  function controlFor(ownerId) {
    if (!controls.has(ownerId)) controls.set(ownerId, { epoch: 0, controller: new AbortController(), handoff: null, pending: new Set(), uncertain: false, activity: null, presentation: { mode: "floating", snap: "middle" }, returnMode: "floating" });
    return controls.get(ownerId);
  }
  function takeover(ownerId, tabId, reason) {
    if (tabId) selected(ownerId, tabId);
    const control = controlFor(ownerId);
    if (control.handoff) return control.handoff;
    const { promise, resolve } = Promise.withResolvers();
    control.handoff = { id: randomUUID(), tabId, reason, phase: "pausing", wait: promise, finish: resolve, resumedEpoch: null };
    control.epoch = ++controlEpoch;
    if (binding?.ownerId === ownerId) parkNative();
    const interrupted = new Error("The person has browser control. Wait for their Resume; do not replay input.");
    control.controller.abort(interrupted);
    for (const call of control.pending) {
      call.controller?.abort(interrupted);
      if (call.activity) call.activity.state = "interrupted";
    }
    if (control.activity) control.activity.state = "interrupted";
    for (const target of targets.values()) if (target.ownerId === ownerId) { target.needsSnapshot = true; invalidate(target); }
    if (tabId) panel.selectBrowser({ ownerId, tabId });
    settleHandoff(ownerId);
    revision++;
    return control.handoff;
  }
  function settleHandoff(ownerId) {
    const control = controlFor(ownerId);
    if (control.handoff?.phase === "pausing" && !control.pending.size && !control.uncertain) {
      control.handoff.phase = "ready";
      revision++;
      // Bounds are retained only for this binding, never across discussions.
      syncNative();
    }
  }
  function parkNative() { panel.hide(); setVisibleOwner(null); }
  function syncNative() {
    const ownerId = binding?.ownerId;
    const control = ownerId && controlFor(ownerId);
    const bounds = binding?.bounds;
    if (!control || control.handoff?.phase !== "ready" || !["side", "fullscreen"].includes(control.presentation.mode)
      || !bounds || bounds.width <= 0 || bounds.height <= 0) { parkNative(); return; }
    try {
      setVisibleOwner(ownerId);
      panel.setPresentation({ ownerId, tabId: activeByOwner[ownerId], mode: control.presentation.mode });
      panel.show(bounds);
    } catch (error) { detachBinding(); throw error; }
  }
  function detachBinding() {
    if (binding?.ownerId) {
      const control = controlFor(binding.ownerId);
      if (control.presentation.mode === "fullscreen") control.presentation.mode = control.returnMode;
    }
    binding = null;
    parkNative();
    revision++;
  }
  function present(ownerId, mode) {
    if (!["floating", "side", "fullscreen", "hidden"].includes(mode)) throw new Error("Choose a browser presentation mode.");
    const control = controlFor(ownerId);
    if (control.presentation.mode === mode) return;
    if (["floating", "side"].includes(mode)) control.returnMode = mode;
    control.presentation.mode = mode;
    binding.bounds = null;
    binding.captureEpoch++;
    parkNative();
  }
  function exitPresentation({ ownerId, tabId }) {
    const control = controlFor(ownerId);
    if (binding?.ownerId !== ownerId || activeByOwner[ownerId] !== tabId || control.handoff?.phase !== "ready" || control.presentation.mode !== "fullscreen") return;
    panelOptions.getWindow?.()?.webContents.focus();
    present(ownerId, control.returnMode);
    revision++;
  }
  function manualControl(ownerId) {
    if (controlFor(ownerId).handoff?.phase !== "ready") throw new Error("Take over and wait for browser control to be ready before changing tabs or pages.");
  }
  function shouldPreserveOnAbort({ ownerId, tabId }) { return controlFor(ownerId).handoff?.tabId === tabId; }
  function setVisibleOwner(ownerId) {
    if (visibleOwner === ownerId) return;
    for (const target of targets.values()) if (target.ownerId === visibleOwner || target.ownerId === ownerId) invalidate(target);
    visibleOwner = ownerId;
    panel.setVisibleSession(ownerId);
  }
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
      target = { ownerId: tab.ownerId, tabId: tab.tabId, url: tab.url, status: tab.status, generation: 0, receipt: null, needsSnapshot: controlFor(tab.ownerId).epoch > 0, controller: null, closed: false, tail: Promise.resolve() };
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
    if (destroyed) throw new Error("The browser host closed.");
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
    const control = controlFor(ownerId);
    const { handoff, presentation } = control;
    const activity = [...control.pending].findLast((call) => call.activity?.state === "running")?.activity ?? control.activity;
    try {
      return { revision, requested: ["side", "fullscreen"].includes(presentation.mode), presentation: { ...presentation }, activity: activity && { ...activity }, activeTabId: activeByOwner?.[ownerId] ?? null, tabs: panel.listBrowsers(ownerId).map(uiTab),
        control: handoff ? { state: "human", phase: handoff.phase, handoffId: handoff.id, tabId: handoff.tabId, reason: handoff.reason } : { state: "automation" } };
    } catch (error) { detachBinding(); throw error; }
  }
  function owned(ownerId, args) {
    const tab = panel.listBrowsers(ownerId).find((tab) => tab.targetId && tab.targetId === args.target_id && tab.browserUrl === args.browser_url);
    if (!tab) throw new Error("This endpoint and target are not owned by the native discussion. App, shell, and other discussions' targets are denied.");
    if (!tab.identityOnly) browserPageUrl(tab.url);
    return tab;
  }
  return {
    async bind({ slug, threadId, viewId }) {
      if (typeof viewId !== "string" || !viewId || viewId.length > 128) throw new Error("A browser view identity is required.");
      detachBinding();
      const next = { viewId, ownerId: null, bounds: null, captureEpoch: 0, capturing: false };
      binding = next;
      const scope = await scopeFor(slug, threadId);
      if (binding !== next || destroyed) throw new Error("The selected discussion changed.");
      next.ownerId = scope.ownerId;
      return snapshot(scope.ownerId);
    },
    detach({ viewId }) {
      if (binding?.viewId !== viewId) return;
      detachBinding();
    },
    hideWindow: detachBinding,
    read({ viewId }) { return snapshot(view(viewId)); },
    async thumbnail({ viewId, tabId, size = "thumbnail" }) {
      const ownerId = view(viewId);
      if (!["thumbnail", "watch"].includes(size)) throw new Error("Choose thumbnail or watch capture size.");
      if (typeof tabId !== "string" || !tabId || tabId.length > 256) throw new Error("An owned tab is required.");
      const tab = selected(ownerId, tabId);
      const bound = binding;
      const captureEpoch = bound.captureEpoch;
      const control = controlFor(ownerId);
      const epoch = control.epoch;
      const target = targetFor(tab);
      const generation = target.generation;
      const current = () => {
        if (destroyed || binding !== bound || bound.captureEpoch !== captureEpoch || control.handoff || control.epoch !== epoch || control.presentation.mode === "hidden" || activeByOwner[ownerId] !== tabId) return false;
        const fresh = panel.listBrowsers(ownerId).find((item) => item.tabId === tabId && item.targetId === tab.targetId && item.browserUrl === tab.browserUrl);
        observeTarget(target, fresh);
        return !target.closed && target.status === "ready" && target.generation === generation;
      };
      if (bound.capturing || !current()) return null;
      bound.capturing = true;
      const pending = {};
      control.pending.add(pending);
      const work = (async () => {
        try {
          browserPageUrl(tab.url);
          await checkPolicy({ url: tab.url });
          if (!current()) return null;
          const image = await panel.captureBrowserThumbnail({ ownerId, tabId, size });
          if (!current() || !image) return null;
          return { tabId, generation, mimeType: "image/jpeg", imageBase64: image.imageBase64, width: image.width, height: image.height, capturedAt: image.capturedAt };
        } catch {
          if (!current()) return null;
          throw new Error("The browser thumbnail could not be captured.");
        } finally {
          bound.capturing = false;
          control.pending.delete(pending);
          settleHandoff(ownerId);
        }
      })();
      return waitForBrowserWork(work, AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]));
    },
    async command({ viewId, action, url, tabId, bounds, open, handoffId, mode, position }) {
      const ownerId = view(viewId);
      const bound = binding;
      if (action === "takeover") {
        if (typeof tabId !== "string" || !tabId) throw new Error("An owned tab is required.");
        takeover(ownerId, tabId, "takeover");
      } else if (action === "resume") {
        const control = controlFor(ownerId);
        const handoff = control.handoff;
        if (!handoff || handoff.id !== handoffId) throw new Error("Resume requires this discussion's current handoffId.");
        if (handoff.phase !== "ready" || control.pending.size || control.uncertain) throw new Error("Browser control is still pausing. Resume is unavailable until cancellation settles.");
        parkNative();
        control.handoff = null;
        control.epoch = ++controlEpoch;
        control.controller = new AbortController();
        for (const target of targets.values()) if (target.ownerId === ownerId) { target.needsSnapshot = true; invalidate(target); }
        handoff.resumedEpoch = control.epoch;
        handoff.finish(true);
      } else if (action === "request") {
        if (typeof open !== "boolean") throw new Error("Choose whether to open the browser panel.");
        present(ownerId, open ? "side" : "floating");
      } else if (action === "present") present(ownerId, mode);
      else if (action === "snap") {
        if (!["top", "middle", "bottom"].includes(position)) throw new Error("Choose a browser snap position.");
        controlFor(ownerId).presentation.snap = position;
      } else if (action === "exit-fullscreen") {
        const control = controlFor(ownerId);
        if (control.presentation.mode === "fullscreen") {
          panelOptions.getWindow?.()?.webContents.focus();
          present(ownerId, control.returnMode);
        }
      }
      else if (action === "hide") { binding.bounds = null; binding.captureEpoch++; parkNative(); }
      else if (action === "bounds") {
        if (!bounds || ["x", "y", "width", "height"].some((key) => !Number.isFinite(bounds[key]) || bounds[key] < 0 || bounds[key] > 100_000)) throw new Error("Valid browser bounds are required.");
        binding.bounds = { ...bounds };
        syncNative();
      } else if (["select", "close"].includes(action)) {
        if (typeof tabId !== "string" || !tabId) throw new Error("An owned tab is required.");
        if (action === "select") { invalidate(targetFor(selected(ownerId, tabId))); panel.selectBrowser({ ownerId, tabId }); }
        else { manualControl(ownerId); invalidate(targetFor(selected(ownerId, tabId))); panel.closeBrowser({ ownerId, tabId }); }
        syncNative();
      } else if (["open", "navigate"].includes(action)) {
        const control = controlFor(ownerId);
        const epoch = control.epoch;
        const initial = action === "open" && !panel.listBrowsers(ownerId).length && !control.handoff;
        if (!initial) manualControl(ownerId);
        const tab = action === "navigate" ? selected(ownerId) : null;
        url = browserPageUrl(url);
        await checkPolicy({ url });
        view(viewId);
        if (binding !== bound) throw new Error("The selected discussion changed.");
        if (control.epoch !== epoch) throw new Error("Browser control changed before navigation.");
        if (initial && (panel.listBrowsers(ownerId).length || control.pending.size || control.uncertain)) throw new Error("Browser work has not settled. Wait for its tab, then Take over before changing it.");
        if (!initial) manualControl(ownerId);
        if (action === "open") {
          const pending = {};
          control.pending.add(pending);
          if (initial) takeover(ownerId, "", "takeover");
          control.handoff.phase = "pausing";
          parkNative();
          const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60_000)]);
          const work = panel.createBrowser({ ownerId, url, signal, shouldPreserveOnAbort }).then((opened) => {
            control.handoff.tabId = opened.tabId;
            if (binding !== bound || destroyed) throw new Error("The selected discussion changed.");
          }).catch((error) => {
            if (error?.code === "BROWSER_ABORT_CLEANUP_UNCERTAIN") control.uncertain = true;
            throw error;
          }).finally(() => { control.pending.delete(pending); settleHandoff(ownerId); });
          await waitForBrowserWork(work, signal);
        }
        else {
          if (selected(ownerId).tabId !== tab.tabId) throw new Error("The selected browser tab changed.");
          invalidate(targetFor(tab)); panel.navigate(url, { ownerId, tabId: tab.tabId });
        }
      } else if (["back", "forward", "reload"].includes(action)) { manualControl(ownerId); const tab = selected(ownerId); invalidate(targetFor(tab)); panel[action]({ ownerId, tabId: tab.tabId }); }
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
      const admittedEpoch = controlEpoch;
      const handingOff = name === "coworker_browser_handoff";
      const deadline = AbortSignal.timeout(handingOff ? handoffMs : 60_000);
      const call = { name, args: structuredClone(args), controller: new AbortController() };
      const responseSignal = AbortSignal.any([call.controller.signal, lifetime.signal, deadline]);
      calls.set(key, call);
      call.result = Promise.resolve().then(async () => {
        const scope = await scopeFor(slug, context.sessionID);
        if (path.resolve(context.directory) !== scope.directory) throw new Error("The native browser call belongs to another workspace.");
        const control = controlFor(scope.ownerId);
        const epoch = control.epoch;
        const controlSignal = control.controller.signal;
        responseSignal.throwIfAborted();
        if (epoch > admittedEpoch) throw new Error("Browser control changed before admission. Do not replay this call.");
        if (control.handoff) throw new Error("The person has browser control. Only they can Resume in the app.");
        if (!handingOff) {
          call.ownerId = scope.ownerId;
          control.pending.add(call);
        }
        const trusted = await resolveContext(slug, context, { name, args });
        if (epoch > admittedEpoch) throw new Error("Browser control changed before admission. Do not replay this call.");
        if (!handingOff && control.handoff) throw new Error("The person has browser control. Only they can Resume in the app.");
        const signal = AbortSignal.any([trusted.signal, responseSignal, ...(handingOff ? [] : [controlSignal])]);
        const check = () => { trusted.assertActive(); signal.throwIfAborted(); if (destroyed || trusted.entry.workspaceId !== scope.workspaceId) throw new Error("The browser execution is no longer available."); };
        check();
        call.activity = { label: activityLabels[name.slice("coworker_browser_".length)], state: "running" };
        control.activity = call.activity;
        revision++;
        if (name === "coworker_browser_open") {
          await checkPolicy({ url: args.url }); check();
          const tab = await panel.createBrowser({ ownerId: scope.ownerId, url: args.url, inBackground: args.in_background === true, signal, shouldPreserveOnAbort });
          try { check(); } catch (error) { if (!shouldPreserveOnAbort({ ownerId: scope.ownerId, tabId: tab.tabId }) && panel.listBrowsers(scope.ownerId).some((item) => item.tabId === tab.tabId)) panel.closeBrowser({ ownerId: scope.ownerId, tabId: tab.tabId }); throw error; }
          return JSON.stringify(modelTab(tab));
        }
        if (name === "coworker_browser_tabs") {
          const tabs = panel.listBrowsers(scope.ownerId).filter((tab) => tab.targetId);
          await Promise.all(tabs.filter((tab) => !tab.identityOnly).map((tab) => checkPolicy({ url: tab.url })));
          check();
          return JSON.stringify(tabs.map(modelTab));
        }
        const target = targetFor(owned(scope.ownerId, args));
        if (handingOff) {
          await checkPolicy({ url: target.url });
          const fresh = await resolveContext(slug, context, { name, args });
          fresh.assertActive(); check();
          if (fresh.entry.id !== trusted.entry.id || control.epoch !== epoch) throw new Error("The original browser handoff execution changed.");
          const tab = owned(scope.ownerId, args);
          const handoff = takeover(scope.ownerId, tab.tabId, args.reason);
          // Only the person resolves this wait; cancellation leaves control paused.
          const continued = await waitForBrowserWork(handoff.wait, signal);
          check();
          if (!continued) throw new Error("The browser handoff tab closed. No action was replayed.");
          const resumed = await resolveContext(slug, context, { name, args });
          resumed.assertActive(); check();
          if (resumed.entry.id !== trusted.entry.id || control.handoff || control.epoch !== handoff.resumedEpoch) throw new Error("The original browser handoff execution changed.");
          owned(scope.ownerId, args);
          return JSON.stringify({ state: "continued", next: "snapshot", fresh_observation_required: true, actions_replayed: false });
        }
        return await serial(target, async () => {
          check();
          const tab = owned(scope.ownerId, args);
          observeTarget(target, tab);
          if (name === "coworker_browser_close") { invalidate(target); panel.closeBrowser({ ownerId: scope.ownerId, targetId: tab.targetId }); return "Closed this discussion's browser tab."; }
          if (!tab.identityOnly || name === "coworker_browser_navigate") await checkPolicy({ url: name === "coworker_browser_navigate" ? args.url : tab.url });
          const fresh = await resolveContext(slug, context, { name, args });
          fresh.assertActive(); check(); observeTarget(target, owned(scope.ownerId, args));
          const observing = ["coworker_browser_snapshot", "coworker_browser_screenshot", "coworker_browser_click", "coworker_browser_fill"].includes(name);
          if (observing && target.status !== "ready") throw new Error("The browser page is loading. Wait for a fresh snapshot.");
          if (target.needsSnapshot && ["coworker_browser_eval", "coworker_browser_navigate"].includes(name)) throw new Error("Browser control resumed. Take a fresh snapshot before acting; no input was dispatched.");
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
              target.needsSnapshot = false;
              return JSON.stringify({ snapshot_id: target.receipt.id, snapshot: result });
            }
            return result;
          } finally {
            if (target.controller === controller) target.controller = null;
            if (name === "coworker_browser_navigate" && abort.aborted) {
              try { await panel.stopBrowser({ ownerId: scope.ownerId, tabId: tab.tabId, targetId: tab.targetId }); }
              catch (error) { control.uncertain = true; throw error; }
            }
          }
        });
      }).then((result) => {
        if (call.activity?.state === "running") call.activity.state = "idle";
        return result;
      }, (error) => {
        if (call.activity) call.activity.state = "interrupted";
        if (call.ownerId && error?.code === "BROWSER_ABORT_CLEANUP_UNCERTAIN") controlFor(call.ownerId).uncertain = true;
        throw error;
      }).finally(() => {
        if (call.ownerId) { controlFor(call.ownerId).pending.delete(call); settleHandoff(call.ownerId); }
        revision++;
      });
      // Keep actual work tracked through cleanup even when callers (including
      // duplicates) receive a bounded cancellation response first.
      call.result = waitForBrowserWork(call.result, responseSignal);
      try { return await call.result; }
      finally { call.result = Promise.resolve("This native browser call already completed or was interrupted. Do not replay it; use a new observation to inspect the outcome."); }
    },
    destroy() { destroyed = true; lifetime.abort(new Error("The browser host closed.")); detachBinding(); targets.clear(); panel.destroy(); },
  };
}
