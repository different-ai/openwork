import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserTaskHost } from "./browser-task.mjs";

const nextImmediate = () => new Promise(resolve => setImmediate(resolve));

function fixture(navigate = async () => {}) {
  let destroyed = false;
  let stops = 0;
  const tab = { tabId: "tab", webMcpRevision: 0, view: { webContents: {
    isDestroyed: () => destroyed,
    stop: () => { stops++; },
    getURL: () => "https://example.com/",
  } } };
  const tabs = new Map([[tab.tabId, tab]]);
  const published = [];
  const host = createBrowserTaskHost({
    getTab: id => tabs.get(id),
    tabsFor: () => [...tabs.values()],
    ownerOf: () => "chat",
    activeFor: () => "tab",
    enabled: () => true,
    allowed: async () => true,
    changed: (tabId, value) => published.push({ tabId, ...value }),
    isVisible: () => true,
    siteTools: async () => ({ ok: true }),
    navigate,
  });
  return { host, tab, tabs, published, destroy: () => { destroyed = true; }, stops: () => stops };
}

function navigateRequest(host, signal) {
  return host.request({ sessionId: "chat", operation: "navigate",
    args: { tabId: "tab", url: "https://example.com/next" } }, { signal });
}

test("pause publishes takeover immediately but stops only after Promise microtasks unwind", async () => {
  const { host, published, stops } = fixture();
  host.pause("tab");
  assert.equal(host.stateFor("tab").status, "paused");
  assert.equal(published.at(-1).status, "paused");
  assert.equal(stops(), 0);
  await Promise.resolve();
  const blocked = await host.request({ sessionId: "chat", operation: "site_tools", args: { tabId: "tab" } });
  assert.equal(blocked.code, "paused");
  assert.equal(stops(), 0, "even awaited host work must not stop in the microtask checkpoint");
  await nextImmediate();
  assert.equal(stops(), 1);
  await nextImmediate();
  assert.equal(stops(), 1, "one pause schedules only one stop per tab");
});

for (const change of ["resume", "destruction", "replacement", "revision", "last-tab invalidation"]) {
  test(`a queued takeover stop skips after ${change}`, async () => {
    const f = fixture();
    f.host.pause("tab");
    if (change === "resume") {
      f.host.resume("tab");
      assert.equal(f.host.stateFor("tab").status, "idle");
    } else if (change === "destruction") f.destroy();
    else if (change === "replacement") f.tabs.set("tab", { ...f.tab });
    else if (change === "revision") f.tab.webMcpRevision++;
    else f.host.invalidate("tab", { closed: true });
    await nextImmediate();
    assert.equal(f.stops(), 0);
  });
}

for (const timing of ["callback", "microtask"]) {
  test(`cancellation inside a navigation ${timing} defers stop until setImmediate`, async () => {
    const controller = new AbortController();
    let navigated = false;
    const f = fixture(async () => {
      navigated = true;
      const cancel = () => {
        controller.abort();
        assert.equal(f.stops(), 0, "abort must not synchronously stop native navigation");
      };
      if (timing === "microtask") await Promise.resolve().then(cancel);
      else cancel();
      await Promise.resolve();
      assert.equal(f.stops(), 0, "a Promise continuation is still too early to stop");
    });
    const result = await navigateRequest(f.host, controller.signal);
    assert.equal(navigated, true, "cancellation must happen after navigation is dispatched");
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, true);
    assert.equal(f.stops(), 0);
    await nextImmediate();
    assert.equal(f.stops(), 1);
    await nextImmediate();
    assert.equal(f.stops(), 1);
  });
}

for (const change of ["destruction", "replacement", "revision", "new navigation scope"]) {
  test(`a queued navigation cancellation stop skips after ${change}`, async () => {
    const controller = new AbortController();
    const f = fixture(async () => { controller.abort(); });
    const result = await navigateRequest(f.host, controller.signal);
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, true);
    assert.equal(f.stops(), 0);
    if (change === "destruction") f.destroy();
    else if (change === "replacement") f.tabs.set("tab", { ...f.tab });
    else if (change === "revision") f.tab.webMcpRevision++;
    else {
      const tools = await f.host.request({ sessionId: "chat", operation: "site_tools", args: { tabId: "tab" } });
      assert.equal(tools.ok, true, JSON.stringify(tools));
    }
    await nextImmediate();
    assert.equal(f.stops(), 0);
  });
}

test("closing the last tab cancels pending navigation without stopping the invalidated tab", async () => {
  let entered;
  let finish;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(() => { entered(); return pending; });
  const request = navigateRequest(f.host);
  await started;
  assert.equal(f.host.stateFor("tab").status, "running");
  f.host.invalidate("tab", { closed: true });
  assert.equal(f.host.navigationGuard("tab"), null);
  assert.equal(f.stops(), 0);
  finish();
  const result = await request;
  assert.equal(result.ok, false);
  assert.equal(result.code, "canceled");
  assert.equal(result.dispatched, true);
  await nextImmediate();
  assert.equal(f.stops(), 0);
});
