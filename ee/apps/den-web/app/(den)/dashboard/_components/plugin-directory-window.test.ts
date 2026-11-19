import assert from "node:assert/strict";
import { test } from "node:test";
import { isDirectoryScrollOverflow, pluginDirectoryRange, shouldAutoLoadPluginPage } from "./plugin-directory-window";

test("windowing covers every visible row across many windows without drawing the whole directory", () => {
  const count = 2500;
  const rowHeight = 49;
  const height = 637;
  for (let top = 0; top < count * rowHeight; top += 313) {
    const { start, end } = pluginDirectoryRange(top, height, rowHeight, count);
    assert.ok(start >= 0 && start <= end && end <= count);
    assert.ok(start <= Math.floor(top / rowHeight));
    assert.ok(end >= Math.min(count, Math.ceil((top + height) / rowHeight)));
    assert.ok(end - start <= Math.ceil(height / rowHeight) + 9);
  }
});

test("window ranges handle empty results, overscroll and a filter shrinking a deep list", () => {
  assert.deepEqual(pluginDirectoryRange(0, 637, 49, 0), { start: 0, end: 0 });
  assert.deepEqual(pluginDirectoryRange(-100, 637, 49, 100), { start: 0, end: 17 });
  assert.deepEqual(pluginDirectoryRange(40000, 637, 49, 8), { start: 8, end: 8 });
  assert.deepEqual(pluginDirectoryRange(0, 637, 49, 8), { start: 0, end: 8 });
});

test("only auto and scroll ancestors are directory viewports, not ItemPanel's hidden overflow", () => {
  for (const overflow of ["hidden", "clip", "visible", ""]) assert.equal(isDirectoryScrollOverflow(overflow), false);
  for (const overflow of ["auto", "scroll"]) assert.equal(isDirectoryScrollOverflow(overflow), true);
});

const ready = { listBottom: 1000, viewportTop: 100, viewportHeight: 700, hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false };

test("auto-loading uses the scroller's viewport and a strict 300px threshold", () => {
  assert.equal(shouldAutoLoadPluginPage(ready), true);
  assert.equal(shouldAutoLoadPluginPage({ ...ready, listBottom: 1100 }), false);
  assert.equal(shouldAutoLoadPluginPage({ ...ready, listBottom: 1099 }), true);
  assert.equal(shouldAutoLoadPluginPage({ ...ready, listBottom: 600 }), true, "short pages fill the viewport");
  assert.equal(shouldAutoLoadPluginPage({ ...ready, listBottom: 99 }), false, "an offscreen list must not drain every page");
  assert.equal(shouldAutoLoadPluginPage({ ...ready, viewportHeight: 0 }), false);
});

test("a failed next page never automatically loops; explicit retry can resume after success", () => {
  assert.equal(shouldAutoLoadPluginPage({ ...ready, hasNextPage: false }), false);
  assert.equal(shouldAutoLoadPluginPage({ ...ready, isFetchingNextPage: true }), false);
  for (let event = 0; event < 20; event++) {
    assert.equal(shouldAutoLoadPluginPage({ ...ready, isFetchNextPageError: true }), false);
  }
  assert.equal(shouldAutoLoadPluginPage({ ...ready, isFetchingNextPage: true, isFetchNextPageError: true }), false);
  assert.equal(shouldAutoLoadPluginPage(ready), true);
});
