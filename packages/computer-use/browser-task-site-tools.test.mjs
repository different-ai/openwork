import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserTaskHost } from "./browser-task.mjs";

function hostFor(tab) {
  return createBrowserTaskHost({ getTab: () => tab, tabsFor: () => [tab], ownerOf: () => "chat", activeFor: () => "tab",
    enabled: () => true, allowed: async () => true, changed: () => {}, isVisible: () => true });
}

test("an observation reports website tools only when the page offers them", async () => {
  const page = { title: "Project", elements: [], viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 }, hasPasswordField: false };
  const tab = { tabId: "tab", webMcpRevision: 0, webMcpToolCount: 0, view: { webContents: { isDestroyed: () => false,
    getURL: () => "https://example.com/", executeJavaScriptInIsolatedWorld: async () => ({ ok: true, value: page }) } } };
  const host = hostFor(tab);
  const observe = mode => host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab", mode } });

  for (const mode of ["interactive", "full"]) {
    tab.webMcpToolCount = 0;
    const none = await observe(mode);
    assert.equal(none.ok, true, JSON.stringify(none));
    assert.equal("siteTools" in none, false);
    tab.webMcpToolCount = 3;
    assert.equal((await observe(mode)).siteTools, 3);
  }
});
