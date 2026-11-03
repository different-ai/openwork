import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createBrowserTaskHost } from "./browser-task.mjs";

test("a page drawn scaled gets its viewport first, view-pixel input and full-resolution captures", async () => {
  class Button {
    tagName = "BUTTON"; parentElement = null; isConnected = true; innerText = "Continue";
    getAttribute(name) { return name === "aria-label" ? "Continue" : null; }
    hasAttribute() { return false; }
    matches() { return false; }
    closest() { return null; }
    contains(element) { return element === this; }
    getBoundingClientRect() { return { x: 100, y: 200, left: 100, top: 200, right: 180, bottom: 240, width: 80, height: 40 }; }
    focus() {}
  }
  const button = new Button();
  const document = { title: "Checkout", readyState: "complete", body: { innerText: "Continue" }, activeElement: null,
    getElementById: () => null, elementFromPoint: () => button, querySelector: () => null,
    querySelectorAll: query => query.startsWith('input[type="password"]') ? [] : [button] };
  // The panel is narrow until the host applies the agent's fixed viewport.
  const context = vm.createContext({ document, HTMLElement: Button, HTMLInputElement: class {}, HTMLSelectElement: class {},
    HTMLTextAreaElement: class {}, HTMLLabelElement: class {}, MutationObserver: class { observe() {} }, Node: { ELEMENT_NODE: 1 },
    getComputedStyle: () => ({ visibility: "visible", display: "block", overflowX: "visible", overflowY: "visible" }),
    innerWidth: 420, innerHeight: 600, scrollX: 0, scrollY: 0, performance, setTimeout });
  const sent = [];
  let attached = false;
  const cdp = { isAttached: () => attached, attach() { attached = true; }, detach() { attached = false; },
    sendCommand: async (method, params) => { sent.push({ method, params }); return {}; } };
  const tab = { tabId: "tab", webMcpRevision: 0, view: { webContents: { isDestroyed: () => false, debugger: cdp,
    getURL: () => "https://example.com/", executeJavaScriptInIsolatedWorld: async (_world, scripts) => vm.runInContext(scripts[0].code, context) } } };
  const captured = [];
  const host = createBrowserTaskHost({ getTab: () => tab, tabsFor: () => [tab], ownerOf: () => "chat", activeFor: () => "tab",
    enabled: () => true, allowed: async () => true, changed: () => {}, isVisible: () => true,
    prepare: async () => { await new Promise(resolve => setTimeout(resolve, 10)); context.innerWidth = 1280; context.innerHeight = 800; },
    inputScale: () => 0.5,
    capture: async (_tab, viewport) => { captured.push(viewport); return Buffer.from("full-resolution"); } });

  const seen = await host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab", includeImage: true } });
  assert.equal(seen.ok, true, JSON.stringify(seen));
  // Page objects come from the vm realm; compare their plain values.
  assert.deepEqual({ ...seen.viewport }, { width: 1280, height: 800 }, "The observation must wait for the fixed viewport");
  assert.deepEqual(captured.map(viewport => ({ ...viewport })), [{ width: 1280, height: 800 }]);
  assert.equal(seen.image.data, Buffer.from("full-resolution").toString("base64"));

  const clicked = await host.request({ sessionId: "chat", operation: "act", args: { tabId: "tab", observationId: seen.observationId,
    action: { type: "click", ref: seen.elements[0].ref } } });
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  const press = sent.find(command => command.params?.type === "mousePressed");
  assert.deepEqual([press.params.x, press.params.y], [70, 110], "CSS (140, 220) is (70, 110) in a view drawn at 50%");

  const fresh = await host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } });
  const scrolled = await host.request({ sessionId: "chat", operation: "act", args: { tabId: "tab", observationId: fresh.observationId,
    action: { type: "scroll", x: 600, y: 400, deltaY: 400 } } });
  assert.equal(scrolled.ok, true, JSON.stringify(scrolled));
  const wheel = sent.find(command => command.params?.type === "mouseWheel");
  assert.deepEqual([wheel.params.x, wheel.params.y, wheel.params.deltaY], [300, 200, 200]);
});
