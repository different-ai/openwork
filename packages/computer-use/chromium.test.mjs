import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCloudBrowser, publicDestination } from "./chromium.mjs";

async function fixture({ rejectInterception = false, holdInterception = false, existing = true, missingEgress = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openwork-browser-network-"));
  const commands = [], sockets = [], held = [];
  let origin;
  const target = (url = "https://8.8.8.8/resource") => ({ type: "page", id: "tab", url, title: "Test page",
    webSocketDebuggerUrl: origin.replace("http:", "ws:") + "/devtools/page/tab" });
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url.startsWith("/json/new") ? target("about:blank") : existing ? [target()] : []));
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
      const reply = () => this.message({ id: command.id,
        ...(rejectInterception && command.method === "Fetch.enable" ? { error: { message: "Interception unavailable" } }
          : { result: command.method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main", loaderId: "loader" } } }
            : command.method === "Page.navigate" ? { frameId: "main", loaderId: "loader" }
            : command.method === "Runtime.evaluate" ? { result: { value: "complete" } } : {} }) });
      if (holdInterception && command.method === "Fetch.enable") held.push(reply);
      else queueMicrotask(reply);
    }
    close() { this.dispatchEvent(new Event("close")); }
  }
  globalThis.WebSocket = Socket;
  const statePath = join(directory, "owners.json");
  await writeFile(statePath, JSON.stringify(existing ? [["tab", "chat"]] : []));
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
