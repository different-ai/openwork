import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCloudBrowser, publicDestination } from "./chromium.mjs";

async function fixture({ rejectInterception = false, holdInterception = false, existing = true, missingEgress = false, pages = existing ? ["tab"] : [], owned = pages, onCommand = () => undefined } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openwork-browser-network-"));
  const commands = [], sockets = [], held = [];
  let origin, nextTab = 0;
  const target = (url = "https://8.8.8.8/resource", id = "tab") => ({ type: "page", id, url, title: "Test page",
    webSocketDebuggerUrl: origin.replace("http:", "ws:") + `/devtools/page/${id}` });
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/json/new")) {
      const id = `opened-${++nextTab}`;
      pages.push(id);
      response.end(JSON.stringify(target("about:blank", id)));
    } else {
      response.end(JSON.stringify(pages.map(id => target(undefined, id))));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const OriginalWebSocket = globalThis.WebSocket;
  class Socket extends EventTarget {
    constructor() { super(); sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    message(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
    send(bytes) {
      const command = JSON.parse(bytes);
      commands.push(command);
      const reply = () => {
        const supplied = onCommand(command, this);
        if (supplied === false) return; // A missing CDP receipt, for deadline tests.
        this.message({ id: command.id,
        ...(supplied ?? (rejectInterception && command.method === "Fetch.enable" ? { error: { message: "Interception unavailable" } }
          : { result: command.method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main", loaderId: "loader" } } }
            : command.method === "Page.navigate" ? { frameId: "main", loaderId: "loader" }
            : command.method === "Page.createIsolatedWorld" ? { executionContextId: 11 }
            : command.method === "Runtime.evaluate" ? { result: { value: command.params.expression === "document.readyState" ? "complete"
              : { ok: true, value: { quietMs: 10_000, readyState: "complete", busy: false, textChars: 50 } } } } : {} })) });
      };
      if (holdInterception && command.method === "Fetch.enable") held.push(reply);
      else queueMicrotask(reply);
    }
    close() { this.dispatchEvent(new Event("close")); }
  }
  globalThis.WebSocket = Socket;
  const statePath = join(directory, "owners.json");
  await writeFile(statePath, JSON.stringify(owned.map(id => [id, "chat"])));
  const browser = createCloudBrowser({ statePath, endpoint: origin, assertActive() {}, enabled: () => true, beforeInput: async () => {},
    verifyEgress: async () => { if (missingEgress) throw Object.assign(new Error("Missing kernel filter"), { code: "egress_unavailable" }); } });
  return { browser, commands, sockets, release() { for (const reply of held.splice(0)) reply(); },
    async close() {
      browser.close(); globalThis.WebSocket = OriginalWebSocket;
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true });
    } };
}

async function eventually(read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Expected browser command did not arrive");
}

test("cloud interception validates every resource type and redirect destination", async () => {
  const f = await fixture();
  try {
    const result = await f.browser.request({ sessionId: "chat", operation: "site_tools", args: { tabId: "tab" } });
    assert.equal(result.ok, true, JSON.stringify(result));
    const enable = await eventually(() => f.commands.find(command => command.method === "Fetch.enable"));
    assert.deepEqual(enable.params.patterns, [{ urlPattern: "*", requestStage: "Request" }]);
    for (const resourceType of ["Document", "Image", "Stylesheet", "Script", "Font", "Media", "XHR", "Fetch", "WebSocket", "Ping", "Other"]) {
      for (const [suffix, url, expected] of [
        ["private", "http://127.0.0.1/control", "Fetch.failRequest"],
        ["metadata", "http://169.254.169.254/latest/meta-data", "Fetch.failRequest"],
        ["nat64", "http://[64:ff9b::a9fe:a9fe]/latest/meta-data", "Fetch.failRequest"],
        ["socket", "ws://[::1]:6080/control", "Fetch.failRequest"],
        ["public", "https://8.8.8.8/resource", "Fetch.continueRequest"],
      ]) {
        const requestId = `${resourceType}-${suffix}`;
        f.sockets[0].message({ method: "Fetch.requestPaused", params: { requestId, resourceType, request: { url } } });
        const answer = await eventually(() => f.commands.find(command => command.params?.requestId === requestId));
        assert.equal(answer.method, expected, requestId);
      }
    }
    f.sockets[0].message({ method: "Fetch.requestPaused", params: { requestId: "redirect", redirectedRequestId: "Image-public",
      resourceType: "Image", request: { url: "http://10.0.0.1/private" } } });
    assert.equal((await eventually(() => f.commands.find(command => command.params?.requestId === "redirect"))).method, "Fetch.failRequest");
  } finally { await f.close(); }
});

test("cloud navigation waits for interception and fails closed when it cannot be enabled", async () => {
  for (const rejectInterception of [false, true]) {
    const f = await fixture({ rejectInterception, holdInterception: true, existing: false });
    try {
      const pending = f.browser.request({ sessionId: "chat", operation: "open", args: { url: "https://8.8.8.8/" } });
      await eventually(() => f.commands.some(command => command.method === "Fetch.enable"));
      assert.equal(f.commands.some(command => command.method === "Page.navigate"), false);
      f.release();
      const result = await pending;
      assert.equal(result.ok, !rejectInterception, JSON.stringify(result));
      assert.equal(f.commands.some(command => command.method === "Page.navigate"), !rejectInterception);
    } finally { await f.close(); }
  }
});

test("a conversation works in a tab the person opened once it names that tab", async () => {
  const f = await fixture({ owned: [] });
  try {
    assert.deepEqual((await f.browser.request({ sessionId: "chat", operation: "tabs" })).tabs, []);
    assert.equal((await f.browser.request({ sessionId: "chat", operation: "pause", args: { tabId: "closed" } })).code, "tab_closed");
    const named = await f.browser.request({ sessionId: "chat", operation: "pause", args: { tabId: "tab" } });
    assert.equal(named.tabId, "tab", JSON.stringify(named));
    assert.deepEqual((await f.browser.request({ sessionId: "chat", operation: "tabs" })).tabs.map(tab => tab.tabId), ["tab"]);
    // Once a conversation has it, another can't take it by naming it.
    assert.equal((await f.browser.request({ sessionId: "side", operation: "pause", args: { tabId: "tab" } })).code, "wrong_conversation");
  } finally { await f.close(); }
});

test("a conversation's active tab is the one of its tabs most recently in front", async () => {
  const f = await fixture({ pages: ["second", "first"], owned: ["first", "second"] });
  try {
    assert.equal((await f.browser.request({ sessionId: "chat", operation: "pause" })).tabId, "second");
  } finally { await f.close(); }
});

test("cloud browser opens beyond twelve tabs without evicting another conversation's pages", async () => {
  const original = Array.from({ length: 12 }, (_, index) => `existing-${index}`);
  const f = await fixture({ pages: [...original] });
  try {
    const opened = [];
    for (let index = 0; index < 4; index++) {
      const result = await f.browser.request({ sessionId: "side", operation: "open", args: { url: `https://8.8.8.8/page-${index}` } });
      assert.equal(result.ok, true, JSON.stringify(result));
      opened.push(result.tabId);
    }
    assert.equal(new Set(opened).size, 4);
    assert.deepEqual((await f.browser.request({ sessionId: "chat", operation: "tabs" })).tabs.map(tab => tab.tabId), original);
    assert.deepEqual((await f.browser.request({ sessionId: "side", operation: "tabs" })).tabs.map(tab => tab.tabId), opened);
    assert.equal(f.sockets.length, 16);
    assert.equal((await f.browser.request({ sessionId: "side", operation: "pause", args: { tabId: original[0] } })).code, "wrong_conversation");
  } finally { await f.close(); }
});

test("cloud destination checks reject private IPv4, IPv6 and translated addresses", async () => {
  for (const url of ["http://localhost/", "http://127.0.0.1/", "http://10.0.0.1/", "http://100.100.100.200/",
    "http://169.254.169.254/", "http://[::1]/", "http://[fd00::1]/", "http://[::ffff:7f00:1]/", "http://[::7f00:1]/",
    "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::a00:1]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[64:ff9b::808:808]/",
    "http://[64:ff9b:1:7f00:1::]/", "http://[64:ff9b:1::a9fe:a9fe]/", "file:///etc/passwd"]) {
    assert.equal(await publicDestination(url), false, url);
  }
  assert.equal(await publicDestination("https://8.8.8.8/"), true);
});


test("cloud browser refuses to connect without kernel egress enforcement", async () => {
  const f = await fixture({ missingEgress: true, existing: false });
  try {
    await assert.rejects(f.browser.request({ sessionId: "chat", operation: "open", args: { url: "https://8.8.8.8/" } }), { code: "egress_unavailable" });
    assert.equal(f.sockets.length, 0);
    assert.equal(f.commands.length, 0);
  } finally { await f.close(); }
});

test("native kernel readiness requires complete UID-bound IPv4 and IPv6 rejection", async () => {
  const { nativeBrowserEgress } = await import("./chromium.mjs");
  const ranges = {
    ip: [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16]],
    ip6: [["::", 96], ["::ffff:0.0.0.0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["fc00::", 7], ["fe80::", 10]],
  };
  const rules = { nftables: [
    { chain: { family: "inet", table: "openwork_desktop", name: "output", type: "filter", hook: "output" } },
    ...Object.entries(ranges).map(([protocol, prefixes]) => ({ rule: {
      family: "inet", table: "openwork_desktop", chain: "output", expr: [
        { match: { op: "==", left: { meta: { key: "skuid" } }, right: 1001 } },
        { match: { op: "==", left: { payload: { protocol, field: "daddr" } }, right: { set: prefixes.map(([addr, len]) => ({ prefix: { addr, len } })) } } },
        { reject: { type: "icmpx", expr: "port-unreachable" } },
      ],
    } })),
  ] };
  assert.equal(nativeBrowserEgress(rules, 1001), true);
  assert.equal(nativeBrowserEgress(rules, 1002), false);
  assert.equal(nativeBrowserEgress(rules, 0), false);
  for (const change of [
    value => { value.nftables.shift(); },
    value => { value.nftables.pop(); },
    value => { value.nftables[1].rule.expr[1].match.right.set.pop(); },
    value => { value.nftables[1].rule.expr[0].match.op = "!="; },
    value => { value.nftables[1].rule.expr.push({ accept: null }); },
    value => { value.nftables[1].rule.chain = "unattached"; },
  ]) {
    const incomplete = structuredClone(rules);
    change(incomplete);
    assert.equal(nativeBrowserEgress(incomplete, 1001), false);
  }
});

const pageValue = (value) => ({ result: { result: { value: { ok: true, value } } } });
const isObservation = (command) => command.method === "Runtime.evaluate" && command.params.expression.includes("function observePage");
const isBlockers = (command) => command.method === "Runtime.evaluate" && command.params.expression.includes("function readBlockers");
const observedPage = () => ({ elements: [], title: "Test page", viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 }, hasPaymentField: false, hasCredentialField: false });

test("a self-reload replaces the original navigation loader (YouTube first visit)", async () => {
  const f = await fixture({ existing: false, onCommand(command, socket) {
    if (command.method === "Page.navigate") {
      socket.message({ method: "Page.frameNavigated", params: { frame: { id: "main", url: "https://8.8.8.8/" } } });
      socket.message({ method: "Page.frameNavigated", params: { frame: { id: "main", url: "https://8.8.8.8/?themeRefresh=1" } } });
      return { result: { frameId: "main", loaderId: "original-loader" } };
    }
    if (command.method === "Page.getFrameTree") return { result: { frameTree: { frame: { id: "main", loaderId: "new-loader" } } } };
  } });
  try {
    const result = await f.browser.request({ sessionId: "chat", operation: "open", args: { url: "https://8.8.8.8/" } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.page, "settled");
    assert.equal(f.commands.filter(c => c.method === "Page.navigate").length, 1, "never repeats navigation");
    assert.equal(f.commands.filter(c => c.params?.expression === "document.readyState").length, 1, "does not wait for the old loader");
  } finally { await f.close(); }
});

test("embed navigations and unrelated world destruction do not invalidate a top-document observation", async () => {
  const f = await fixture({ onCommand(command, socket) {
    if (isObservation(command)) {
      socket.message({ method: "Page.frameNavigated", params: { frame: { id: "ad-frame", parentId: "main", url: "about:blank" } } });
      socket.message({ method: "Runtime.executionContextDestroyed", params: { executionContextId: 42 } });
      return pageValue(observedPage());
    }
  } });
  try {
    const result = await f.browser.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab", mode: "interactive" } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.observationId);
  } finally { await f.close(); }
});

test("read recovery is default-off, retries a changed document once when on, never loops", async () => {
  for (const recovery of [undefined, false, true]) for (const alwaysChanges of [false, true]) {
    let reads = 0;
    const f = await fixture({ onCommand(command, socket) {
      if (isObservation(command)) {
        if (++reads === 1 || alwaysChanges) socket.message({ method: "Page.frameNavigated", params: { frame: { id: "main", url: "https://8.8.8.8/resource" } } });
        return pageValue(observedPage());
      }
    } });
    try {
      const result = await f.browser.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } }, { recovery });
      assert.equal(result.ok, recovery === true && !alwaysChanges, JSON.stringify(result));
      assert.equal(reads, recovery ? 2 : 1);
      if (!result.ok) assert.equal(result.code, "page_changed");
      const state = (await f.browser.request({ sessionId: "chat", operation: "tabs" })).tabs[0];
      assert.equal(state.status, "idle", "a transient page change is not a stuck needs_attention");
      assert.equal(f.commands.some(c => c.method.startsWith("Input.")), false);
    } finally { await f.close(); }
  }
});

test("a destroyed observation world is retried once as page_changed, not an opaque failure", async () => {
  let reads = 0;
  const f = await fixture({ onCommand(command) {
    if (isObservation(command)) return ++reads === 1 ? { error: { message: "Cannot find context with specified id" } } : pageValue(observedPage());
  } });
  try {
    const result = await f.browser.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } }, { recovery: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(reads, 2);
    assert.equal(f.commands.filter(c => c.method === "Page.createIsolatedWorld").length, 2);
  } finally { await f.close(); }
});

test("empty extraction gets a bounded second read, not a false no-match answer", async () => {
  let reads = 0;
  const f = await fixture({ onCommand(command) {
    if (isObservation(command)) return pageValue({ title: "Test page", text: ++reads === 1 ? "" : "Recommended videos\nRelaxing music" });
  } });
  try {
    const result = await f.browser.request({ sessionId: "chat", operation: "extract", args: { tabId: "tab", question: "recommended videos" } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(reads, 2);
    assert.ok(result.pageChars > 0);
    assert.ok(result.passages[0].includes("Recommended videos"));
  } finally { await f.close(); }
});

test("consent and human-check guidance is flag-gated and does not click anything", async () => {
  for (const recovery of [false, true]) for (const blocker of ["consent", "bot_check"]) {
    const f = await fixture({ onCommand(command) {
      if (isBlockers(command)) return pageValue({ blocker, textChars: 25 });
      if (isObservation(command)) return pageValue({ title: "Test page", text: "" });
    } });
    try {
      const result = await f.browser.request({ sessionId: "chat", operation: "extract", args: { tabId: "tab", question: "recommended videos" } }, { recovery });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.blocker, recovery ? blocker : undefined);
      if (recovery) assert.match(result.next, blocker === "consent" ? /cookie or consent/ : /must not solve/);
      else assert.match(result.next, /no readable text/);
      assert.equal(f.commands.some(c => c.method.startsWith("Input.")), false);
    } finally { await f.close(); }
  }
});

test("lost tab connections reconnect only with recovery on and never replay uncertain navigation", async () => {
  for (const recovery of [false, true]) {
    const f = await fixture();
    try {
      await f.browser.request({ sessionId: "chat", operation: "tabs" });
      f.sockets[0].close();
      const result = await f.browser.request({ sessionId: "chat", operation: "navigate", args: { tabId: "tab", url: "https://8.8.8.8/" } }, { recovery });
      assert.equal(result.ok, recovery, JSON.stringify(result));
      assert.equal(f.sockets.length, recovery ? 2 : 1);
      assert.equal(f.commands.filter(c => c.method === "Page.navigate").length, recovery ? 1 : 0);
    } finally { await f.close(); }
  }
  const f = await fixture({ onCommand(command) {
    if (command.method === "Page.navigate") return { error: { message: "Browser disconnected" } };
  } });
  try {
    const result = await f.browser.request({ sessionId: "chat", operation: "navigate", args: { tabId: "tab", url: "https://8.8.8.8/" } }, { recovery: true });
    assert.equal(result.dispatched, true);
    assert.equal(result.retrySafe, false);
    assert.equal(f.commands.filter(c => c.method === "Page.navigate").length, 1);
    assert.match(result.next, /never repeat input/);
    assert.equal(result.detail, "connection_lost");
  } finally { await f.close(); }
});

test("navigation net errors are actionable, not anonymous browser_operation_failed", async () => {
  const f = await fixture({ onCommand(command) {
    if (command.method === "Page.navigate") return { result: { errorText: "net::ERR_NAME_NOT_RESOLVED" } };
  } });
  try {
    const result = await f.browser.request({ sessionId: "chat", operation: "navigate", args: { tabId: "tab", url: "https://8.8.8.8/" } });
    assert.equal(result.code, "navigation_failed");
    assert.match(result.error, /address could not be found/);
    assert.equal(f.commands.filter(c => c.method === "Page.navigate").length, 1);
  } finally { await f.close(); }
});

test("a page replaced during isolated-world creation gets the same one-read recovery", async () => {
  let worlds = 0;
  const f = await fixture({ onCommand(command) {
    if (command.method === "Page.createIsolatedWorld" && ++worlds === 1) return { error: { message: "No frame for given id found" } };
    if (isObservation(command)) return pageValue(observedPage());
  } });
  try {
    const result = await f.browser.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } }, { recovery: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(worlds, 2);
  } finally { await f.close(); }
});

test("missing document-ready receipts respect the shared ten-second budget, without replaying navigation", async () => {
  let trees = 0;
  const f = await fixture({ onCommand(command) {
    if (command.method === "Page.getFrameTree" && ++trees === 1) return false;
  } });
  try {
    const at = Date.now();
    const result = await f.browser.request({ sessionId: "chat", operation: "navigate", args: { tabId: "tab", url: "https://8.8.8.8/" } });
    const ms = Date.now() - at;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(ms >= 9900 && ms < 13_000, `readiness budget was ${ms}ms, not the default 15s per command`);
    assert.equal(f.commands.filter(c => c.method === "Page.navigate").length, 1);
  } finally { await f.close(); }
});

test("failed opens retain the created tab identity so recovery inspects it instead of opening another", async () => {
  const f = await fixture({ existing: false, rejectInterception: true });
  try {
    const result = await f.browser.request({ sessionId: "chat", operation: "open", args: { url: "https://8.8.8.8/" } });
    assert.equal(result.ok, false);
    assert.equal(result.tabId, "opened-1");
    const tabs = await f.browser.request({ sessionId: "chat", operation: "tabs" });
    assert.equal(tabs.tabs[0].status, "needs_attention");
    assert.notEqual(tabs.tabs[0].operation, "Check browser");
    assert.equal(f.commands.some(c => c.method === "Page.navigate"), false);
  } finally { await f.close(); }
});
