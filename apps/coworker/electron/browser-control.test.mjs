import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { transform } from "esbuild";
import { assertBrowserToolContext, browserPageUrl, checkBrowserPolicy, createBrowserControl } from "./browser-control.mjs";
import { BROWSER_PLUGIN, installBrowserPlugin } from "./browser-plugin.mjs";

function nativeContext() {
  const args = { url: "https://example.com/" };
  return { slug: "scout", name: "coworker_browser_open", args,
    context: { sessionID: "session", messageID: "assistant", callID: "call", directory: "/workspace/scout" },
    entry: { owner: { kind: "private", slug: "scout", threadId: "session", conversationId: "session" }, workspaceId: "workspace", personRequest: true, state: "running", sentAt: 1, messageId: "person" },
    snapshot: { threadId: "session", directory: "/workspace/scout", messages: [
      { id: "person", role: "user", parts: [{ type: "text", text: "Inspect this page" }] },
      { id: "assistant", role: "assistant", parentId: "person", completedAt: null, parts: [{ type: "tool", callId: "call", tool: "coworker_browser_open", toolInput: args, toolStatus: "running" }] },
    ] }, workspaceId: "workspace", active: true };
}

function fixture(options = {}) {
  let events;
  let visible = null;
  let shown = false;
  let panelVisible = false;
  let sequence = 0;
  let active = {};
  let all = [];
  const dispatched = [];
  const controls = [];
  const policies = [];
  const requests = [];
  const captures = [];
  const controller = new AbortController();
  const emit = () => events("openwork:browser:state", { activeTabIdByOwner: { ...active }, tabs: all.map((tab) => ({ id: tab.tabId, ownerSessionId: tab.ownerId, url: tab.url, status: tab.status })) });
  const panel = {
    async createBrowser({ ownerId, url, inBackground, signal, shouldPreserveOnAbort }) {
      const tab = { ownerId, tabId: `tab-${++sequence}`, targetId: `target-${sequence}`, browserUrl: "http://127.0.0.1:9222", url, title: url, status: "ready", canGoBack: true, canGoForward: true };
      all.push(tab);
      if (!inBackground) active[ownerId] = tab.tabId;
      if (ownerId === visible && !inBackground) shown = panelVisible;
      if (ownerId === visible && !inBackground) events("openwork:browser:panel-opened", { ownerSessionId: ownerId });
      emit();
      await options.opening?.({ tab, signal, shouldPreserveOnAbort });
      return tab;
    },
    async captureBrowserThumbnail({ ownerId, tabId, size }) {
      assert.ok(all.some((tab) => tab.ownerId === ownerId && tab.tabId === tabId));
      captures.push({ ownerId, tabId, size });
      await options.capture?.();
      return { mimeType: "image/jpeg", imageBase64: "/9j/", width: size === "watch" ? 1280 : 480, height: size === "watch" ? 900 : 300, capturedAt: 1234, url: "https://private.example/", cookie: "not-for-renderer" };
    },
    listBrowsers: (ownerId) => all.filter((tab) => tab.ownerId === ownerId),
    closeBrowser({ ownerId, tabId, targetId }) {
      const tab = all.find((tab) => tab.ownerId === ownerId && (!tabId || tabId === tab.tabId) && (!targetId || targetId === tab.targetId));
      assert.ok(tab);
      all = all.filter((item) => item !== tab);
      active[ownerId] = all.find((item) => item.ownerId === ownerId)?.tabId ?? null;
      if (ownerId === visible && !active[ownerId]) { shown = false; panelVisible = false; }
      emit(); return tab.tabId;
    },
    selectBrowser({ ownerId, tabId }) { assert.ok(all.some((tab) => tab.ownerId === ownerId && tab.tabId === tabId)); active[ownerId] = tabId; emit(); },
    setVisibleSession(ownerId) { visible = ownerId; },
    setPresentation(value) { controls.push({ presentation: value }); },
    hide() { shown = false; panelVisible = false; controls.push("hide"); },
    show(bounds) { panelVisible = true; shown = Boolean(active[visible]); controls.push({ bounds }); },
    navigate(url) { controls.push({ url }); },
    async stopBrowser(target) { controls.push({ stop: target }); await options.stop?.(target); },
    back() { controls.push("back"); }, forward() { controls.push("forward"); }, reload() { controls.push("reload"); },
    destroy() { all = []; visible = null; shown = false; },
  };
  const broker = createBrowserControl({
    createPanel(input) { events = input.onEvent; options.host = input; assert.equal(input.popupDisposition({}), "embedded"); return panel; },
    panelOptions: {},
    handoffMs: options.handoffMs,
    discussionFor: options.discussionFor ?? (async (slug, threadId) => {
      if (threadId === "worker") throw new Error("Not a saved private discussion.");
      return { workspaceId: `workspace-${slug}`, directory: `/workspace/${slug}` };
    }),
    resolveContext: async (slug, context, expected) => {
      requests.push({ slug, context, expected });
      return { entry: { id: options.executionId ?? `execution-${slug}-${context.sessionID}`, workspaceId: `workspace-${slug}` }, signal: controller.signal, assertActive() { controller.signal.throwIfAborted(); } };
    },
    checkPolicy: async (input) => { policies.push(input); if (options.denied) throw new Error("Policy denied."); await options.policy?.(); },
    runTool: async (name, args, context) => { dispatched.push({ name, args, context }); return options.runTool ? options.runTool(name, args, context) : "Page receipt"; },
  });
  let callNumber = 0;
  const call = (operation, args = {}, slug = "scout", threadId = "one") => ({ slug, payload: { name: `coworker_browser_${operation}`, args, context: { sessionID: threadId, messageID: "assistant", callID: `call-${++callNumber}`, directory: `/workspace/${slug}` } } });
  const execute = ({ slug, payload }) => broker.execute(slug, payload);
  const open = async (slug = "scout", threadId = "one", extra = {}) => JSON.parse(await execute(call("open", { url: "https://example.com/", ...extra }, slug, threadId)));
  const paused = async (viewId = "one") => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const control = broker.read({ viewId }).control;
      if (control.state === "human" && control.phase === "ready") return control;
      await new Promise(setImmediate);
    }
    assert.fail("Browser handoff did not pause");
  };
  return { broker, call, execute, open, paused, captures, dispatched, controls, policies, requests, panel, controller, emit, get visible() { return visible; }, get shown() { return shown; }, get tabs() { return all; } };
}

test("browser authority is the exact running native tool and person-request discussion", () => {
  assert.doesNotThrow(() => assertBrowserToolContext(nativeContext()));
  for (const change of [
    (v) => { v.name = "browser_snapshot"; }, (v) => { v.args = { url: "https://other.example/" }; },
    (v) => { v.active = false; }, (v) => { v.context.sessionID = "another"; },
    (v) => { v.context.callID = "another"; }, (v) => { v.context.directory = "/other"; },
    (v) => { v.workspaceId = "other"; }, (v) => { v.entry.owner.slug = "other"; },
    (v) => { v.entry.owner.kind = "group"; }, (v) => { v.entry.personRequest = false; },
    (v) => { v.entry.continuation = true; }, (v) => { v.entry.state = "cancelled"; },
    (v) => { v.snapshot.messages[0].parts[0].synthetic = true; },
    (v) => { v.snapshot.messages[1].completedAt = 10; },
    (v) => { v.snapshot.messages[1].parts[0].toolStatus = "completed"; },
  ]) { const input = nativeContext(); change(input); assert.throws(() => assertBrowserToolContext(input), /exact running tool/); }
});

test("page URLs reject app/control origins, non-web protocols and URL credentials", () => {
  assert.equal(browserPageUrl("https://example.com"), "https://example.com/");
  for (const url of ["file:///app/index.html", "data:text/html,app", "javascript:alert(1)", "opencoworker://app", "http://localhost:5183/", "http://localhost.:5183/", "http://127.0.0.1:9222", "http://127.1/", "http://[::1]/", "http://0.0.0.0/", "https://user:password@example.com/", "http://[::ffff:127.0.0.1]/"]) assert.throws(() => browserPageUrl(url));
});

test("managed policy uses only the dedicated scope and fails closed", async () => {
  const calls = [];
  const handle = { url: "http://127.0.0.1:8790", policyToken: "test-evaluation-token", ownerToken: "not-used" };
  const request = async (url, input) => { calls.push({ url, ...input }); return { ok: true, json: async () => ({ allowed: true }) }; };
  await checkBrowserPolicy(handle, { url: "https://example.com/", method: "POST", hasUpload: true }, request);
  assert.equal(calls[0].url, `${handle.url}/managed-policy/evaluate`);
  assert.equal(calls[0].headers.Authorization, "Bearer test-evaluation-token");
  assert.deepEqual(JSON.parse(calls[0].body), { action: "browser", input: { url: "https://example.com/", method: "POST", hasUpload: true } });
  for (const result of [{ ok: false }, { ok: true, json: async () => ({ allowed: false }) }, { ok: true, json: async () => ({}) }]) await assert.rejects(checkBrowserPolicy(handle, { url: "https://example.com/" }, async () => result));
  await assert.rejects(checkBrowserPolicy({ url: handle.url, ownerToken: "no-fallback" }, { url: "https://example.com/" }, request), /unavailable/);
  await assert.rejects(checkBrowserPolicy(handle, { url: "https://example.com/" }, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(calls.length, 1);
});

test("WS(S) resources preserve managed policy input while page opens and loopback remain blocked", async () => {
  const calls = [];
  const handle = { url: "http://127.0.0.1:8790", policyToken: "test-policy-token" };
  const request = async (_url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ allowed: true }) }; };
  for (const url of ["wss://example.com/socket", "ws://example.com/socket", "https://example.com/upload"]) {
    const input = { url, method: "POST", hasUpload: true };
    await checkBrowserPolicy(handle, input, request);
    assert.deepEqual(calls.at(-1), { action: "browser", input });
  }
  for (const input of [{ url: "wss://example.com/socket" }, { url: "wss://example.com/socket", method: "GET", external: true }, { url: "wss://localhost:5183/", method: "GET" }, { url: "ws://127.0.0.1:9222/", method: "GET" }, { url: "wss://[::1]/", method: "GET" }]) await assert.rejects(checkBrowserPolicy(handle, input, request));
  assert.equal(calls.length, 3);
  await assert.rejects(checkBrowserPolicy(handle, { url: "wss://example.com/socket", method: "GET", hasUpload: false }, async () => ({ ok: true, json: async () => ({ allowed: false }) })), /not allowed/);
  assert.throws(() => browserPageUrl("wss://example.com/socket"));
});

test("one host keeps background opens and UI state with their workspace/native-session owner", async () => {
  const f = fixture();
  await f.broker.bind({ slug: "scout", threadId: "one", viewId: "visible-one" });
  const owner = f.visible;
  const first = await f.open();
  assert.equal(f.broker.read({ viewId: "visible-one" }).requested, false);
  assert.equal(f.visible, null, "collapsed pages are parked, not selected as native foreground views");
  await f.broker.command({ viewId: "visible-one", action: "request", open: false });
  await f.open("scout", "two");
  await f.open("other", "one");
  await f.open("scout", "one", { in_background: true });
  assert.equal(f.visible, owner);
  const state = f.broker.read({ viewId: "visible-one" });
  assert.equal(state.requested, false);
  assert.equal(state.activeTabId, first.tab_id);
  assert.equal(state.tabs.length, 2);
  assert.equal(new Set(f.tabs.map((tab) => tab.ownerId)).size, 3);
  assert.doesNotMatch(JSON.stringify(state), /9222|target-|browser_url|browserUrl/);
  const list = JSON.parse(await f.execute(f.call("tabs")));
  assert.equal(list.length, 2);
  assert.ok(list.every((tab) => tab.browser_url === first.browser_url));
});

test("thumbnails are view/owner scoped, image-only, receipt-neutral and suppressed during takeover", async () => {
  const options = {};
  const f = fixture(options);
  await f.broker.bind({ slug: "scout", threadId: "one", viewId: "one" });
  const tab = await f.open();
  const other = await f.open("scout", "two");
  const handle = { browser_url: tab.browser_url, target_id: tab.target_id };
  const { snapshot_id } = JSON.parse(await f.execute(f.call("snapshot", handle)));
  const thumbnail = await f.broker.thumbnail({ viewId: "one", tabId: tab.tab_id });
  assert.deepEqual(thumbnail, { tabId: tab.tab_id, generation: 1, mimeType: "image/jpeg", imageBase64: "/9j/", width: 480, height: 300, capturedAt: 1234 });
  assert.doesNotMatch(JSON.stringify(thumbnail), /url|cookie|target|owner|private|9222/i);
  assert.equal(f.visible, null);
  await assert.rejects(f.broker.thumbnail({ viewId: "one", tabId: other.tab_id }), /owned browser tab/);
  await assert.rejects(f.broker.thumbnail({ viewId: "stale", tabId: tab.tab_id }), /no longer selected/);
  assert.equal(f.captures.length, 1);
  await f.execute(f.call("click", { ...handle, uid: 2, snapshot_id }));
  options.denied = true;
  await assert.rejects(f.broker.thumbnail({ viewId: "one", tabId: tab.tab_id }), /could not be captured/);
  assert.equal(f.captures.length, 1);
  options.denied = false;
  await f.broker.command({ viewId: "one", action: "takeover", tabId: tab.tab_id });
  assert.equal(await f.broker.thumbnail({ viewId: "one", tabId: tab.tab_id }), null);
  assert.equal(f.captures.length, 1);
});

test("late thumbnail policy/capture cannot leak across binding, navigation, selection or handoff changes", async () => {
  for (const boundary of ["policy", "capture"]) for (const change of ["binding", "navigation", "loading", "selection", "close", "takeover", "presentation", "hide"]) {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const options = {};
    const f = fixture(options);
    await f.broker.bind({ slug: "scout", threadId: "one", viewId: "one" });
    const first = await f.open();
    const second = await f.open();
    await f.broker.command({ viewId: "one", action: "select", tabId: first.tab_id });
    options[boundary] = async () => { entered.resolve(); await release.promise; };
    const reading = f.broker.thumbnail({ viewId: "one", tabId: first.tab_id });
    await entered.promise;
    assert.equal(await f.broker.thumbnail({ viewId: "one", tabId: first.tab_id, size: "watch" }), null, "only one capture may be in flight");
    if (change === "binding") await f.broker.bind({ slug: "scout", threadId: "two", viewId: "one" });
    if (change === "navigation") { f.tabs[0].url = "https://example.com/changed"; f.emit(); }
    if (change === "loading") { f.tabs[0].status = "loading"; f.emit(); f.tabs[0].status = "ready"; f.emit(); }
    if (change === "selection") await f.broker.command({ viewId: "one", action: "select", tabId: second.tab_id });
    if (change === "close") f.panel.closeBrowser({ ownerId: f.tabs[0].ownerId, tabId: first.tab_id });
    if (change === "hide") await f.broker.command({ viewId: "one", action: "hide" });
    if (change === "presentation") {
      await f.broker.command({ viewId: "one", action: "present", mode: "hidden" });
      await f.broker.command({ viewId: "one", action: "present", mode: "floating" });
    }
    if (change === "takeover") {
      const { control } = await f.broker.command({ viewId: "one", action: "takeover", tabId: first.tab_id });
      assert.equal(control.phase, "pausing");
      await f.broker.command({ viewId: "one", action: "present", mode: "fullscreen" });
      await f.broker.command({ viewId: "one", action: "bounds", bounds: { x: 0, y: 0, width: 900, height: 700 } });
      assert.equal(f.shown, false);
      await assert.rejects(f.broker.command({ viewId: "one", action: "resume", handoffId: control.handoffId }), /still pausing/);
      const exited = await f.broker.command({ viewId: "one", action: "exit-fullscreen" });
      assert.equal(exited.presentation.mode, "floating");
      assert.equal(exited.control.phase, "pausing");
      release.resolve();
      assert.equal(await reading, null);
      await f.paused();
      await f.broker.command({ viewId: "one", action: "resume", handoffId: control.handoffId });
    }
    release.resolve();
    assert.equal(await reading, null, `${boundary}: ${change}`);
    assert.equal(f.captures.length, boundary === "policy" ? 0 : 1);
  }
});

test("takeover aborts inflight and queued work across an owner, including eval, without stopping another owner", async () => {
  for (const operation of ["fill", "eval", "navigate", "navigate-uncertain"]) {
    const navigating = operation.startsWith("navigate");
    const providerOperation = navigating ? "navigate" : operation;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const stopping = Promise.withResolvers();
    const stopped = Promise.withResolvers();
    let supplied;
    const f = fixture({ stop: async (target) => {
      assert.deepEqual(target, { ownerId: f.tabs[0].ownerId, tabId: f.tabs[0].tabId, targetId: f.tabs[0].targetId });
      stopping.resolve(); await stopped.promise;
      if (operation === "navigate-uncertain") throw new Error("Native stop uncertain");
    }, runTool: async (name, _args, context) => {
      if (name === `browser_${providerOperation}`) { supplied = context.abort; entered.resolve(); await release.promise; context.abort.throwIfAborted(); }
      return "Page receipt";
    } });
    await f.broker.bind({ slug: "scout", threadId: "one", viewId: "one" });
    const tab = await f.open();
    const sibling = await f.open();
    const other = await f.open("scout", "two");
    const handle = { browser_url: tab.browser_url, target_id: tab.target_id };
    const { snapshot_id } = JSON.parse(await f.execute(f.call("snapshot", handle)));
    const request = f.call(providerOperation, { ...handle, ...(navigating ? { url: "https://example.com/next" } : operation === "fill" ? { snapshot_id, uid: 2, value: "text" } : { expression: "document.title" }) });
    const running = assert.rejects(f.execute(request), /person has browser control/);
    await entered.promise;
    const duplicate = assert.rejects(f.execute(request), /person has browser control/);
    const select = f.panel.selectBrowser;
    f.panel.selectBrowser = (input) => {
      assert.equal(supplied.aborted, true, "pause input before selecting the handoff target");
      assert.equal(f.broker.read({ viewId: "one" }).control.state, "human");
      assert.equal(input.tabId, tab.tab_id);
      return select(input);
    };
    const queued = assert.rejects(f.execute(f.call("snapshot", handle)), /person has browser control|control changed/);
    await new Promise(setImmediate);
    const { control } = await f.broker.command({ viewId: "one", action: "takeover", tabId: tab.tab_id });
    assert.equal(control.phase, "pausing");
    await f.broker.command({ viewId: "one", action: "present", mode: "fullscreen" });
    await f.broker.command({ viewId: "one", action: "bounds", bounds: { x: 0, y: 0, width: 1200, height: 800 } });
    assert.equal(f.visible, null);
    assert.equal(f.shown, false);
    assert.equal(supplied.aborted, true);
    await assert.rejects(f.execute(f.call("snapshot", { browser_url: sibling.browser_url, target_id: sibling.target_id })), /person has browser control/);
    assert.equal(await f.execute(f.call("screenshot", { browser_url: other.browser_url, target_id: other.target_id }, "scout", "two")), "Page receipt");
    await f.broker.execute(request.slug, { ...request.payload, cancel: true });
    await assert.rejects(f.broker.command({ viewId: "one", action: "resume", handoffId: control.handoffId }), /still pausing/);
    await Promise.all([running, duplicate, queued]);
    assert.equal(f.broker.read({ viewId: "one" }).control.phase, "pausing", "bounded cancellation replies are not evidence of cleanup");
    release.resolve();
    await Promise.all([running, queued]);
    if (navigating) {
      await stopping.promise;
      assert.equal(f.broker.read({ viewId: "one" }).control.phase, "pausing");
      assert.equal(f.shown, false);
      stopped.resolve();
      if (operation === "navigate-uncertain") {
        await new Promise(setImmediate);
        assert.equal(f.broker.read({ viewId: "one" }).control.phase, "pausing");
        await assert.rejects(f.broker.command({ viewId: "one", action: "resume", handoffId: control.handoffId }), /still pausing/);
        continue;
      }
    }
    await f.paused();
    assert.equal(f.shown, true);
    await f.broker.command({ viewId: "one", action: "resume", handoffId: control.handoffId });
    assert.equal(f.visible, null);
    assert.match(await f.execute(request), /Do not replay/);
    assert.deepEqual(f.dispatched.map(({ name }) => name), ["browser_snapshot", `browser_${providerOperation}`, "browser_screenshot"]);
  }
});

test("cancelled, expired, closed or replaced-execution handoffs never resume or replay themselves", async () => {
  for (const stop of ["tool", "turn", "timeout", "close", "execution"]) {
    const options = { handoffMs: stop === "timeout" ? 20 : 120_000 };
    const f = fixture(options);
    await f.broker.bind({ slug: "scout", threadId: "one", viewId: "one" });
    const tab = await f.open();
    const request = f.call("handoff", { browser_url: tab.browser_url, target_id: tab.target_id, reason: "sign-in" });
    const waiting = assert.rejects(f.execute(request), /cancelled|timeout|closed|execution changed/i);
    const control = await f.paused();
    if (stop === "tool") await f.broker.execute(request.slug, { ...request.payload, cancel: true });
    if (stop === "turn") f.controller.abort(new Error("Turn cancelled"));
    if (stop === "timeout") await new Promise((resolve) => setTimeout(resolve, 30));
    if (stop === "close") await f.broker.command({ viewId: "one", action: "close", tabId: tab.tab_id });
    if (stop === "execution") {
      options.executionId = "replacement-execution";
      await f.broker.command({ viewId: "one", action: "resume", handoffId: control.handoffId });
    }
    await waiting;
    assert.equal(f.broker.read({ viewId: "one" }).control.state, stop === "execution" ? "automation" : "human");
    assert.equal(f.dispatched.length, 0);
    assert.match(await f.execute(request), /Do not replay/);
  }
});

test("all reused page tools require exact owned endpoint AND target", async () => {
  const f = fixture();
  const first = await f.open();
  const other = await f.open("scout", "two");
  const handle = { browser_url: first.browser_url, target_id: first.target_id };
  for (const [name, extra] of [["snapshot", {}], ["click", { uid: 1 }], ["fill", { uid: 1, value: "text" }], ["eval", { expression: "document.title" }], ["navigate", { url: "https://example.com/next" }], ["screenshot", {}]]) {
    if (["click", "fill"].includes(name)) extra.snapshot_id = JSON.parse(await f.execute(f.call("snapshot", handle))).snapshot_id;
    const result = await f.execute(f.call(name, { ...handle, ...extra }));
    assert.equal(name === "snapshot" ? JSON.parse(result).snapshot : result, "Page receipt");
    for (const wrong of [{ target_id: other.target_id }, { target_id: "app-shell" }, { browser_url: "http://127.0.0.1:9333" }]) await assert.rejects(f.execute(f.call(name, { ...handle, ...extra, ...wrong })), /not owned/);
    await assert.rejects(f.execute(f.call(name, { ...extra, browser_url: first.browser_url })), /exact browser_url/);
  }
  assert.deepEqual(f.dispatched.map((call) => call.name), ["browser_snapshot", "browser_snapshot", "browser_click", "browser_snapshot", "browser_fill", "browser_eval", "browser_navigate", "browser_screenshot"]);
  assert.ok(f.dispatched.every(({ args, context }) => !Object.hasOwn(args, "snapshot_id") && context.abort instanceof AbortSignal && context.directory === "/workspace/scout" && context.sessionID === "one" && context.callID));
  assert.equal(f.requests.at(-1).context.directory, "/workspace/scout");
  assert.equal(f.policies.length, 10);
  await f.execute(f.call("close", handle));
  await assert.rejects(f.execute(f.call("snapshot", handle)), /not owned/);
});

test("stale UIDs cannot use a newer provider mapping; snapshot receipts are exact-target and single-use", async () => {
  let backend = 10;
  const input = [];
  const f = fixture({ runTool: async (name, args) => {
    if (name === "browser_snapshot") return `[2] textbox "Node ${++backend}"`;
    input.push({ target: args.target_id, backend, uid: args.uid });
    return "Input receipt";
  } });
  const tab = await f.open();
  const handle = { browser_url: tab.browser_url, target_id: tab.target_id };
  const first = JSON.parse(await f.execute(f.call("snapshot", handle)));
  const second = JSON.parse(await f.execute(f.call("snapshot", handle)));
  assert.notEqual(first.snapshot_id, second.snapshot_id);
  assert.match(first.snapshot, /Node 11/);
  assert.match(second.snapshot, /Node 12/);
  await assert.rejects(f.execute(f.call("click", { ...handle, uid: 2, snapshot_id: first.snapshot_id })), /snapshot_id is stale/);
  const other = await f.open();
  await assert.rejects(f.execute(f.call("fill", { browser_url: other.browser_url, target_id: other.target_id, uid: 2, snapshot_id: second.snapshot_id, value: "text" })), /snapshot_id is stale/);
  await assert.rejects(f.execute(f.call("click", { ...handle, uid: 2 })), /snapshot_id/);
  assert.deepEqual(input, []);
  await f.execute(f.call("click", { ...handle, uid: 2, snapshot_id: second.snapshot_id }));
  assert.deepEqual(input, [{ target: tab.target_id, backend: 12, uid: 2 }]);
  await assert.rejects(f.execute(f.call("fill", { ...handle, uid: 2, snapshot_id: second.snapshot_id, value: "text" })), /snapshot_id is stale/);
  assert.equal(input.length, 1);
});

test("failed input consumes its observation and a fresh snapshot permits a new action", async () => {
  let attempts = 0;
  const f = fixture({ runTool: async (name) => {
    if (name === "browser_fill" && ++attempts === 1) throw new Error("Input outcome uncertain");
    return "Receipt";
  } });
  const tab = await f.open();
  const handle = { browser_url: tab.browser_url, target_id: tab.target_id };
  let { snapshot_id } = JSON.parse(await f.execute(f.call("snapshot", handle)));
  await f.execute(f.call("screenshot", handle));
  await assert.rejects(f.execute(f.call("fill", { ...handle, uid: 2, snapshot_id, value: "text" })), /uncertain/);
  await assert.rejects(f.execute(f.call("fill", { ...handle, uid: 2, snapshot_id, value: "text" })), /snapshot_id is stale/);
  assert.equal(attempts, 1);
  ({ snapshot_id } = JSON.parse(await f.execute(f.call("snapshot", handle))));
  assert.equal(await f.execute(f.call("fill", { ...handle, uid: 2, snapshot_id, value: "text" })), "Receipt");
  assert.equal(attempts, 2);
});

test("host URL/loading changes and native navigation controls invalidate snapshot generations", async () => {
  const f = fixture();
  await f.broker.bind({ slug: "scout", threadId: "one", viewId: "one" });
  const tab = await f.open();
  const handle = { browser_url: tab.browser_url, target_id: tab.target_id };
  const manual = async (command) => {
    const { control } = await f.broker.command({ viewId: "one", action: "takeover", tabId: tab.tab_id });
    await f.broker.command({ viewId: "one", ...command });
    await f.broker.command({ viewId: "one", action: "resume", handoffId: control.handoffId });
  };
  for (const change of [
    async () => { f.tabs[0].status = "loading"; f.emit(); f.tabs[0].status = "ready"; f.emit(); },
    async () => { f.tabs[0].url = "https://example.com/other"; f.emit(); f.tabs[0].url = tab.url; f.emit(); },
    ...["reload", "back", "forward"].map((action) => () => manual({ action })),
    () => manual({ action: "navigate", url: "https://example.com/next" }),
    () => f.execute(f.call("navigate", { ...handle, url: "https://example.com/next" })),
    () => f.execute(f.call("eval", { ...handle, expression: "document.body.textContent = 'changed'" })),
  ]) {
    const { snapshot_id } = JSON.parse(await f.execute(f.call("snapshot", handle)));
    await change();
    await assert.rejects(f.execute(f.call("click", { ...handle, uid: 2, snapshot_id })), /snapshot_id is stale/);
  }
  const { snapshot_id } = JSON.parse(await f.execute(f.call("snapshot", handle)));
  await manual({ action: "close", tabId: tab.tab_id });
  await assert.rejects(f.execute(f.call("click", { ...handle, uid: 2, snapshot_id })), /not owned/);
  assert.equal(f.dispatched.filter(({ name }) => name === "browser_click").length, 0);
});

test("same-target snapshots and input serialize, without blocking another target", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let snapshots = 0;
  let simultaneous = 0;
  let peak = 0;
  const f = fixture({ runTool: async (name) => {
    if (name !== "browser_snapshot") return "Other target receipt";
    simultaneous++; peak = Math.max(peak, simultaneous); snapshots++;
    if (snapshots === 1) { entered.resolve(); await release.promise; }
    simultaneous--;
    return `[2] textbox "Mapping ${snapshots}"`;
  } });
  const tab = await f.open();
  const handle = { browser_url: tab.browser_url, target_id: tab.target_id };
  const first = f.execute(f.call("snapshot", handle));
  await entered.promise;
  const second = f.execute(f.call("snapshot", handle));
  const other = await f.open();
  assert.equal(await f.execute(f.call("screenshot", { browser_url: other.browser_url, target_id: other.target_id })), "Other target receipt");
  assert.equal(snapshots, 1);
  release.resolve();
  const a = JSON.parse(await first);
  const b = JSON.parse(await second);
  assert.equal(peak, 1);
  assert.notEqual(a.snapshot_id, b.snapshot_id);
  await assert.rejects(f.execute(f.call("click", { ...handle, uid: 2, snapshot_id: a.snapshot_id })), /snapshot_id is stale/);
});

test("loading during an observation aborts it and cannot mint a snapshot receipt", async () => {
  const entered = Promise.withResolvers();
  let aborted;
  const f = fixture({ runTool: async (_name, _args, context) => {
    entered.resolve();
    await new Promise((_, reject) => context.abort.addEventListener("abort", () => { aborted = context.abort.aborted; reject(context.abort.reason); }, { once: true }));
  } });
  const tab = await f.open();
  const reading = assert.rejects(f.execute(f.call("snapshot", { browser_url: tab.browser_url, target_id: tab.target_id })), /page changed/);
  await entered.promise;
  f.tabs[0].status = "loading"; f.emit();
  await reading;
  assert.equal(aborted, true);
  await assert.rejects(f.execute(f.call("snapshot", { browser_url: tab.browser_url, target_id: tab.target_id })), /page is loading/);
});

test("native turn and exact-tool cancellation reach the provider signal and do not replay", async () => {
  for (const kind of ["turn", "tool"]) {
    const entered = Promise.withResolvers();
    let supplied;
    const f = fixture({ runTool: async (name, _args, context) => {
      if (name === "browser_snapshot") return "[2] textbox";
      supplied = context; entered.resolve();
      await new Promise((_, reject) => context.abort.addEventListener("abort", () => reject(context.abort.reason), { once: true }));
    } });
    const tab = await f.open();
    const handle = { browser_url: tab.browser_url, target_id: tab.target_id };
    const { snapshot_id } = JSON.parse(await f.execute(f.call("snapshot", handle)));
    const request = f.call("fill", { ...handle, uid: 2, snapshot_id, value: "text" });
    const filling = assert.rejects(f.execute(request), /cancelled/);
    await entered.promise;
    assert.equal(supplied.sessionID, request.payload.context.sessionID);
    assert.equal(supplied.callID, request.payload.context.callID);
    if (kind === "turn") f.controller.abort(new Error("Turn cancelled"));
    else {
      await assert.rejects(f.broker.execute(request.slug, { ...request.payload, args: { ...request.payload.args, value: "different" }, cancel: true }), /exact native browser call/);
      assert.equal(supplied.abort.aborted, false);
      await f.broker.execute(request.slug, { ...request.payload, cancel: true });
      assert.equal(f.controller.signal.aborted, false);
    }
    await filling;
    assert.equal(supplied.abort.aborted, true);
    assert.match(await f.execute(request), /Do not replay/);
    assert.equal(f.dispatched.filter(({ name }) => name === "browser_fill").length, 1);
    if (kind === "tool") await assert.rejects(f.execute(f.call("fill", request.payload.args)), /snapshot_id is stale/);
  }
});

test("an authenticated early cancellation prevents a delayed duplicate from starting", async () => {
  const f = fixture();
  const request = f.call("open", { url: "https://example.com/" });
  await f.broker.execute(request.slug, { ...request.payload, cancel: true });
  assert.match(await f.execute(request), /cancelled before admission/);
  assert.equal(f.tabs.length, 0);
});

test("malformed arguments, unsaved work and forged native directories never dispatch", async () => {
  const f = fixture();
  for (const args of [null, [], { url: "https://example.com", ownerId: "other" }, { url: "https://example.com", in_background: "true" }]) await assert.rejects(f.execute(f.call("open", args)));
  await assert.rejects(f.execute(f.call("open", { url: "https://example.com" }, "scout", "worker")), /saved private/);
  const request = f.call("open", { url: "https://example.com" });
  request.payload.context.directory = "/workspace/other";
  await assert.rejects(f.execute(request), /another workspace/);
  await assert.rejects(f.broker.execute("scout", { name: "coworker_browser_open", args: { url: "https://example.com" } }), /canonical native/);
  assert.equal(f.tabs.length, 0);
  assert.equal(f.dispatched.length, 0);
});

test("policy denial and stopped native executions do not open or capture a tab", async () => {
  const denied = fixture({ denied: true });
  await assert.rejects(denied.open(), /Policy denied/);
  assert.equal(denied.tabs.length, 0);
  const f = fixture();
  const tab = await f.open();
  f.controller.abort();
  await assert.rejects(f.execute(f.call("screenshot", { browser_url: tab.browser_url, target_id: tab.target_id })));
  assert.equal(f.dispatched.length, 0);
});

test("slow native opens deduplicate by call ID without a semantic mailbox retry", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const f = fixture({ opening: () => waiting });
  const request = f.call("open", { url: "https://example.com/" });
  const first = f.execute(request);
  const duplicate = f.execute(request);
  release();
  assert.equal(await first, await duplicate);
  assert.equal(f.tabs.length, 1);
  assert.match(await f.execute(request), /Do not replay/);
  await assert.rejects(f.execute({ slug: request.slug, payload: { ...request.payload, args: { url: "https://other.example/" } } }), /different arguments/);
});

test("changed policy and non-web target navigations cannot yield model observations", async () => {
  const options = {};
  const f = fixture(options);
  const tab = await f.open();
  const handle = { browser_url: tab.browser_url, target_id: tab.target_id };
  options.denied = true;
  await assert.rejects(f.execute(f.call("tabs")), /Policy denied/);
  await assert.rejects(f.execute(f.call("snapshot", handle)), /Policy denied/);
  options.denied = false;
  f.tabs[0].url = "file:///app/index.html";
  await assert.rejects(f.execute(f.call("eval", { ...handle, expression: "document.title" })), /non-web/);
  assert.equal(f.dispatched.length, 0);
});

test("late opens after native stop discard their handles and close only their own tab", async () => {
  const f = fixture({ opening: async () => { f.controller.abort(); } });
  await assert.rejects(f.open());
  assert.equal(f.tabs.length, 0);
});

test("UI controls are view-scoped and old cleanup cannot hide the next discussion", async () => {
  const f = fixture();
  await f.broker.bind({ slug: "scout", threadId: "one", viewId: "one" });
  const first = await f.open();
  for (const command of [{ action: "navigate", url: "https://example.com/" }, { action: "open", url: "https://example.com/" }, { action: "close", tabId: first.tab_id }, ...["back", "forward", "reload"].map((action) => ({ action }))]) {
    await assert.rejects(f.broker.command({ viewId: "one", ...command }), /Take over/);
  }
  await f.broker.command({ viewId: "one", action: "takeover", tabId: first.tab_id });
  await f.broker.command({ viewId: "one", action: "request", open: true });
  await f.broker.command({ viewId: "one", action: "bounds", bounds: { x: 20, y: 150, width: 600, height: 300 } });
  assert.equal(f.shown, true);
  await f.broker.command({ viewId: "one", action: "hide" });
  assert.equal(f.shown, false);
  for (const action of ["back", "forward", "reload"]) await f.broker.command({ viewId: "one", action });
  await f.broker.command({ viewId: "one", action: "select", tabId: first.tab_id });
  await f.broker.command({ viewId: "one", action: "navigate", url: "https://example.com/next" });
  await f.broker.bind({ slug: "scout", threadId: "two", viewId: "two" });
  const owner = f.visible;
  f.broker.detach({ viewId: "one" });
  assert.equal(f.visible, owner);
  await assert.rejects(f.broker.command({ viewId: "one", action: "reload" }), /no longer selected/);
  await assert.rejects(f.broker.command({ viewId: "two", action: "bounds", bounds: { x: 0, y: 0, width: NaN, height: 300 } }), /bounds/);
  f.broker.hideWindow();
  assert.equal(f.visible, null);
  f.broker.destroy();
  await assert.rejects(f.open());
});

test("the actual panel bounds effect re-shows a tab opened after closing the last tab at unchanged bounds", async () => {
  const f = fixture();
  await f.open();
  await f.broker.bind({ slug: "scout", threadId: "one", viewId: "one" });
  await f.broker.command({ viewId: "one", action: "takeover", tabId: f.tabs[0].tabId });
  await f.broker.command({ viewId: "one", action: "present", mode: "side" });
  const hooks = [];
  const effects = [];
  const frames = new Map();
  const mutations = new Set();
  let cursor = 0;
  let serial = 0;
  const viewport = { closest: () => null, getBoundingClientRect: () => ({ x: 20, y: 100, width: 600, height: 300, right: 620, bottom: 400 }) };
  // Execute the hook's real effect/dependency lifecycle without a native
  // page or DOM service. The parent journey owns real React/Electron proof.
  const react = {
    useLayoutEffect(run, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (previous && dependencies.every((value, position) => Object.is(value, previous.dependencies[position]))) return;
      const next = { dependencies, cleanup: null };
      hooks[index] = next;
      effects.push(() => { previous?.cleanup?.(); next.cleanup = run(); });
    },
  };
  const bridge = { browser: {
    command: (viewId, command) => f.broker.command({ ...command, viewId }),
  } };
  const modules = { react, "@/lib/bridge": { coworkerBridge: bridge } };
  const source = await readFile(new URL("../src/ui/use-discussion-browser.ts", import.meta.url), "utf8");
  const { code } = await transform(source, { loader: "tsx", format: "cjs", jsx: "automatic", target: "node22" });
  const module = { exports: {} };
  const window = { innerWidth: 1200, innerHeight: 800, requestAnimationFrame: (fn) => { frames.set(++serial, fn); return serial; }, cancelAnimationFrame: (id) => frames.delete(id), addEventListener() {}, removeEventListener() {} };
  const document = { body: {}, hidden: false, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  class ResizeObserver { constructor(fn) { this.fn = fn; } observe() { this.fn(); } disconnect() {} }
  class MutationObserver { constructor(fn) { this.fn = fn; } observe() { mutations.add(this.fn); } disconnect() { mutations.delete(this.fn); } }
  new Function("require", "module", "exports", "window", "document", "ResizeObserver", "MutationObserver", code)((name) => { assert.ok(modules[name], name); return modules[name]; }, module, module.exports, window, document, ResizeObserver, MutationObserver);
  async function flush(viewId = "one", active = true) {
    cursor = 0;
    const state = f.broker.read({ viewId });
    module.exports.useBrowserViewport(viewId, viewport, state.requested, active, state.activeTabId, state.control.phase, state.presentation.mode);
    for (let turn = 0; turn < 30; turn++) {
      for (const effect of effects.splice(0)) effect();
      const next = [...frames.values()]; frames.clear();
      for (const frame of next) frame();
      await new Promise(setImmediate);
      if (!effects.length && !frames.size) return;
    }
    assert.fail("Panel effects did not settle");
  }
  try {
    await flush();
    assert.equal(f.shown, true);
    await f.broker.command({ viewId: "one", action: "close", tabId: f.tabs[0].tabId });
    await flush();
    assert.equal(f.tabs.length, 0);
    assert.equal(f.shown, false);
    const currentView = "one";
    await f.broker.command({ viewId: currentView, action: "open", url: "https://example.com/" });
    await flush();
    assert.equal(f.shown, true);
    // Closing and replacing between polls keeps the count at one; the new
    // active ID must also reset the bounds effect.
    const current = f.tabs[0];
    await f.broker.command({ viewId: currentView, action: "close", tabId: current.tabId });
    await f.broker.command({ viewId: currentView, action: "open", url: "https://example.com/" });
    await flush();
    assert.equal(f.shown, true);
    const bounds = f.controls.filter((control) => control.bounds).map((control) => control.bounds);
    assert.ok(bounds.length >= 2);
    assert.ok(bounds.every((value) => JSON.stringify(value) === JSON.stringify(bounds[0])));
    const oldCleanup = hooks[0].cleanup;
    await f.broker.bind({ slug: "scout", threadId: "two", viewId: "two" });
    await f.broker.command({ viewId: "two", action: "open", url: "https://example.com/other" });
    await f.broker.command({ viewId: "two", action: "present", mode: "side" });
    await flush("two");
    assert.equal(f.shown, true);
    oldCleanup();
    await new Promise(setImmediate);
    assert.equal(f.shown, true, "old effect cleanup cannot hide the next binding");
    await flush("two", false);
    assert.equal(f.shown, false, "inactive workspaces detach native content");
  } finally { for (const hook of hooks) hook?.cleanup?.(); }
});

test("a late bind cannot select a discussion after its unmount", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ discussionFor: async (slug, threadId) => { if (threadId === "one") await gate; return { directory: `/workspace/${slug}`, workspaceId: `workspace-${slug}` }; } });
  const first = f.broker.bind({ slug: "scout", threadId: "one", viewId: "one" });
  f.broker.detach({ viewId: "one" });
  await f.broker.bind({ slug: "scout", threadId: "two", viewId: "two" });
  const owner = f.visible;
  release();
  await assert.rejects(first, /selected discussion changed/);
  assert.equal(f.visible, owner);
});

test("installed wrapper disables unrestricted tools and preserves config without duplicate registration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "coworker-browser-"));
  try {
    await writeFile(path.join(directory, "opencode.json"), JSON.stringify({ plugin: ["existing"], tools: { read: false }, permission: { edit: "ask" } }));
    await installBrowserPlugin({ path: directory });
    await installBrowserPlugin({ path: directory });
    const config = JSON.parse(await readFile(path.join(directory, "opencode.json"), "utf8"));
    assert.equal(config.plugin.length, 2);
    assert.equal(config.tools.read, false);
    assert.equal(config.tools.browser_list, false);
    assert.equal(config.tools.browser_eval, false);
    assert.deepEqual(config.permission, { edit: "ask" });
    assert.equal(await readFile(path.join(directory, ".opencode", "coworker-browser.js"), "utf8"), BROWSER_PLUGIN);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native plugin hook rejects originals and stamps the actual engine identity on wrapper calls", async () => {
  const sent = [];
  const tool = Object.assign((definition) => definition, { schema: z });
  const factory = new Function("tool", "readFile", "path", "fetch", BROWSER_PLUGIN.replace(/^import .*;\n/gm, "").replace("export default", "return"))(
    tool, async () => JSON.stringify({ url: "http://127.0.0.1:1234/context", token: "scoped-test-token" }), path,
    async (url, input) => { sent.push({ url, ...input }); return { ok: true, json: async () => "Page receipt" }; },
  );
  const plugin = await factory({ directory: "/workspace/scout" });
  for (const name of ["browser_list", "browser_snapshot", "browser_eval", "browser_screenshot", "browser_navigate"]) await assert.rejects(plugin["tool.execute.before"]({ tool: name }, { args: {} }), /Unrestricted browser/);
  const args = { browser_url: "http://127.0.0.1:9222", target_id: "owned" };
  assert.equal(z.object(plugin.tool.coworker_browser_snapshot.args).safeParse({ browser_url: args.browser_url }).success, false);
  assert.equal(z.object(plugin.tool.coworker_browser_click.args).safeParse({ ...args, uid: 2 }).success, false);
  assert.equal(z.object(plugin.tool.coworker_browser_fill.args).safeParse({ ...args, uid: 2, value: "text", snapshot_id: "receipt" }).success, true);
  assert.equal(z.object(plugin.tool.coworker_browser_handoff.args).safeParse({ ...args, reason: "sign-in" }).success, true);
  assert.equal(z.object(plugin.tool.coworker_browser_handoff.args).safeParse({ ...args, reason: "resume" }).success, false);
  assert.equal(plugin.tool.coworker_browser_resume, undefined);
  await plugin["tool.execute.before"]({ tool: "coworker_browser_snapshot", sessionID: "native-session", callID: "hook-call" }, { args });
  assert.equal(await plugin.tool.coworker_browser_snapshot.execute(args, { sessionID: "native-session", messageID: "native-message", directory: "/workspace/scout", abort: new AbortController().signal }), "Page receipt");
  assert.deepEqual(JSON.parse(sent[0].body), { name: "coworker_browser_snapshot", args, context: { sessionID: "native-session", messageID: "native-message", callID: "hook-call", directory: "/workspace/scout" } });
  assert.equal(sent[0].headers.Authorization, "Bearer scoped-test-token");
  await assert.rejects(plugin.tool.coworker_browser_snapshot.execute(args, { sessionID: "native-session", messageID: "native-message", abort: new AbortController().signal }), /native call identity/);
});

test("the native wrapper propagates tool cancellation to the same scoped broker call", async () => {
  const requests = [];
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const tool = Object.assign((definition) => definition, { schema: z });
  const factory = new Function("tool", "readFile", "path", "fetch", BROWSER_PLUGIN.replace(/^import .*;\n/gm, "").replace("export default", "return"))(
    tool, async () => JSON.stringify({ url: "http://127.0.0.1:1234/context", token: "scoped-test-token" }), path,
    async (_url, init) => {
      const request = JSON.parse(init.body); requests.push(request);
      if (request.cancel) return { ok: true, json: async () => "Cancelled" };
      started.resolve();
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    },
  );
  const plugin = await factory({ directory: "/workspace/scout" });
  const args = { browser_url: "http://127.0.0.1:9222", target_id: "owned", snapshot_id: "receipt", uid: 2, value: "text" };
  const context = { sessionID: "native-session", messageID: "native-message", callID: "native-call", directory: "/workspace/scout", abort: controller.signal };
  const operation = assert.rejects(plugin.tool.coworker_browser_fill.execute(args, context), /cancelled/);
  await started.promise;
  controller.abort(new Error("Tool cancelled"));
  await operation;
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], { ...requests[0], cancel: true });
});
