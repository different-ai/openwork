import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createBrowserTaskHost } from "./browser-task.mjs";

/** A page with one upload button; the fake DevTools session opens a file chooser when it is clicked. */
function page({ chooser = { backendNodeId: 7, mode: "selectMultiple", frameId: "main" }, approve = async () => true, checkFiles = async () => {}, frameUrl = "https://studio.example.com/upload" } = {}) {
  class Button {
    tagName = "BUTTON"; parentElement = null; isConnected = true; innerText = "Select files";
    getAttribute(name) { return name === "aria-label" ? "Select files" : null; }
    hasAttribute() { return false; }
    matches() { return false; }
    closest() { return null; }
    contains(element) { return element === this; }
    getBoundingClientRect() { return { x: 100, y: 200, left: 100, top: 200, right: 180, bottom: 240, width: 80, height: 40 }; }
    focus() {}
  }
  const button = new Button();
  const document = { title: "Upload", readyState: "complete", body: { innerText: "Select files" }, activeElement: null,
    getElementById: () => null, elementFromPoint: () => button, querySelector: () => null,
    querySelectorAll: query => query.startsWith('input[type="password"]') ? [] : [button] };
  const context = vm.createContext({ document, HTMLElement: Button, HTMLInputElement: class {}, HTMLSelectElement: class {},
    HTMLTextAreaElement: class {}, HTMLLabelElement: class {}, MutationObserver: class { observe() {} }, Node: { ELEMENT_NODE: 1 },
    getComputedStyle: () => ({ visibility: "visible", display: "block", overflowX: "visible", overflowY: "visible" }),
    innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0, performance, setTimeout });
  const sent = [];
  const listeners = new Set();
  let attached = false, intercepting = false;
  const cdp = { isAttached: () => attached, attach() { attached = true; }, detach() { attached = false; },
    on(_event, listener) { listeners.add(listener); }, removeListener(_event, listener) { listeners.delete(listener); },
    sendCommand: async (method, params) => {
      sent.push({ method, params });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: frameUrl } } };
      if (method === "Page.setInterceptFileChooserDialog") intercepting = params.enabled;
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && intercepting && chooser) {
        for (const listener of listeners) listener({}, "Page.fileChooserOpened", chooser);
      }
      return {};
    } };
  let currentUrl = "https://studio.example.com/upload";
  const tab = { tabId: "tab", webMcpRevision: 0, view: { webContents: { isDestroyed: () => false, debugger: cdp,
    getURL: () => currentUrl, executeJavaScriptInIsolatedWorld: async (_world, scripts) => vm.runInContext(scripts[0].code, context) } } };
  const asked = [];
  const host = createBrowserTaskHost({ getTab: () => tab, tabsFor: () => [tab], ownerOf: () => "chat", activeFor: () => "tab",
    enabled: () => true, allowed: async () => true, changed: () => {}, isVisible: () => true, fileChooserMs: 50,
    checkFiles, approveFiles: async (sessionId, request) => { asked.push({ sessionId, ...request }); return approve(); } });
  async function attach(files) {
    const seen = await host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } });
    assert.equal(seen.ok, true, JSON.stringify(seen));
    return host.request({ sessionId: "chat", operation: "act", args: { tabId: "tab", observationId: seen.observationId,
      action: { type: "attach", ref: seen.elements[0].ref, files } } });
  }
  async function attachBatch(groups) {
    const seen = await host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } });
    return host.request({ sessionId: "chat", operation: "act", args: { tabId: "tab", observationId: seen.observationId,
      actions: groups.map((files) => ({ type: "attach", ref: seen.elements[0].ref, files })) } });
  }
  return { attach, attachBatch, sent, asked, intercepting: () => intercepting, setUrl: (url) => { currentUrl = url; },
    navigateFrame: (url) => { frameUrl = url; for (const listener of listeners) listener({}, "Page.navigatedWithinDocument", { frameId: "main", url }); },
  };
}

test("attach gives the page's file chooser the approved files without the system picker", async () => {
  const p = page();
  const result = await p.attach(["/Users/me/Movies/launch.mp4"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.outcome, "attached");
  assert.deepEqual(p.asked, [{ sessionId: "chat", app: "studio.example.com", url: "https://studio.example.com/upload", files: ["/Users/me/Movies/launch.mp4"] }]);
  const set = p.sent.find((command) => command.method === "DOM.setFileInputFiles");
  assert.deepEqual(set.params, { files: ["/Users/me/Movies/launch.mp4"], backendNodeId: 7 });
  assert.equal(p.intercepting(), false, "the chooser is no longer intercepted afterwards");
});

test("nothing is clicked when the person declines the files", async () => {
  const p = page({ approve: async () => false });
  const result = await p.attach(["/Users/me/Movies/launch.mp4"]);
  assert.equal(result.code, "files_declined");
  assert.ok(!p.sent.some((command) => command.method === "Input.dispatchMouseEvent" || command.method === "DOM.setFileInputFiles"));
});

test("files are checked only after the person answers, and a link or missing file is never attached", async () => {
  const checked = [];
  const declined = page({ approve: async () => false, checkFiles: async (paths) => { checked.push(paths); } });
  assert.equal((await declined.attach(["/Users/me/secret.mp4"])).code, "files_declined");
  assert.deepEqual(checked, [], "a declined request reveals nothing about the paths");
  const link = page({ checkFiles: async () => { throw new Error("not_the_real_path"); } });
  const result = await link.attach(["/Users/me/innocent.mp4"]);
  assert.equal(result.code, "file_unavailable");
  assert.ok(!link.sent.some((command) => command.method === "Input.dispatchMouseEvent" || command.method === "DOM.setFileInputFiles"));
});

test("relative paths and controls that open no chooser are reported", async () => {
  const relative = page();
  assert.equal((await relative.attach(["launch.mp4"])).code, "invalid_action");
  const none = page({ chooser: null });
  assert.equal((await none.attach(["/Users/me/a.mp4"])).code, "no_file_chooser");
  const single = page({ chooser: { backendNodeId: 7, mode: "selectSingle" } });
  assert.equal((await single.attach(["/Users/me/a.mp4", "/Users/me/b.mp4"])).code, "single_file");
});

test("a batch never attaches more files than the approval card lists", async () => {
  const p = page();
  const files = (from, count) => Array.from({ length: count }, (_, index) => `/Users/me/clip-${from + index}.mp4`);
  const result = await p.attachBatch([files(0, 10), files(10, 10), files(20, 1)]);
  assert.equal(result.code, "invalid_action");
  assert.deepEqual(p.asked, []);
});


test("managed consent is revalidated at the chooser before any file is shared", async () => {
  let revalidated = 0;
  const p = page({ approve: async () => ({ allowed: true, revalidate: async () => { revalidated++; return false; } }) });
  const result = await p.attach(["/Users/me/Movies/launch.mp4"]);
  assert.equal(result.code, "files_permission_changed");
  assert.equal(revalidated, 1);
  assert.ok(!p.sent.some((command) => command.method === "DOM.setFileInputFiles"));
});

test("a remembered top-level website grant never shares files with a cross-origin chooser frame", async () => {
  const p = page({ frameUrl: "https://other.example.com/upload", approve: async () => ({ allowed: true, revalidate: async () => true }) });
  const result = await p.attach(["/Users/me/Movies/launch.mp4"]);
  assert.equal(result.code, "files_permission_changed");
  assert.ok(!p.sent.some((command) => command.method === "DOM.setFileInputFiles"));
});

test("navigation during a new approval stops the handoff", async () => {
  const p = page({ approve: async () => { p.setUrl("https://other.example.com"); return { allowed: true, revalidate: async () => true }; } });
  const result = await p.attach(["/Users/me/Movies/launch.mp4"]);
  assert.equal(result.code, "page_changed");
  assert.ok(!p.sent.some((command) => command.method === "DOM.setFileInputFiles"));
});

test("a managed approval still checks exact real file paths again immediately before attachment", async () => {
  let checked = 0;
  const p = page({ approve: async () => ({ allowed: true, revalidate: async () => true }), checkFiles: async () => { checked++; } });
  const result = await p.attach(["/Users/me/Movies/launch.mp4"]);
  assert.equal(result.outcome, "attached");
  assert.equal(checked, 2);
  assert.equal(p.sent.filter((command) => command.method === "DOM.setFileInputFiles").length, 1);
});


test("receiving-frame same-document navigation during async policy checking never receives the files", async () => {
  const p = page({ approve: async () => ({ allowed: true, revalidate: async () => {
    p.navigateFrame("https://studio.example.com/blocked/frame");
    return true; // The old policy answer cannot authorize the new frame URL.
  } }) });
  const result = await p.attach(["/Users/me/Movies/launch.mp4"]);
  assert.equal(result.code, "files_permission_changed");
  assert.ok(!p.sent.some((command) => command.method === "DOM.setFileInputFiles"));
});
