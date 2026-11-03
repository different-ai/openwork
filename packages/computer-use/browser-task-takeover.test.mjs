import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createBrowserTaskHost } from "./browser-task.mjs";

test("a takeover blocks the agent until control is handed back, then the agent works again", async () => {
  const document = { title: "Home", readyState: "complete", body: { innerText: "Hello" }, activeElement: null,
    getElementById: () => null, elementFromPoint: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const context = vm.createContext({ document, HTMLElement: class {}, HTMLInputElement: class {}, HTMLSelectElement: class {},
    HTMLTextAreaElement: class {}, HTMLLabelElement: class {}, MutationObserver: class { observe() {} }, Node: { ELEMENT_NODE: 1 },
    getComputedStyle: () => ({ visibility: "visible", display: "block", overflowX: "visible", overflowY: "visible" }),
    innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0, performance, setTimeout });
  const tab = { tabId: "tab", webMcpRevision: 0, view: { webContents: { isDestroyed: () => false, stop() {},
    getURL: () => "https://example.com/", executeJavaScriptInIsolatedWorld: async (_world, scripts) => vm.runInContext(scripts[0].code, context) } } };
  const published = [];
  const host = createBrowserTaskHost({ getTab: () => tab, tabsFor: () => [tab], ownerOf: () => "chat", activeFor: () => "tab",
    enabled: () => true, allowed: async () => true, changed: (_id, value) => published.push(value.status), isVisible: () => true });

  host.pause("tab");
  const blocked = await host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "paused");
  assert.match(blocked.message ?? blocked.error ?? "", /next message/);

  assert.equal(published.at(-1), "paused");
  host.resume("tab");
  assert.equal(host.stateFor("tab").status, "idle");
  const seen = await host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } });
  assert.equal(seen.ok, true, JSON.stringify(seen));
  assert.equal(published.at(-1), "idle");
});
