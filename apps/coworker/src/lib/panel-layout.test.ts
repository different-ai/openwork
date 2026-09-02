import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampPanelWidth,
  readPanelLayout,
  renderedPanelWidth,
  resolvePanelDrag,
  resolvePanelKey,
  writePanelLayout,
  type PanelBounds,
} from "./panel-layout.ts";

const bounds: PanelBounds = { min: 200, max: 360, collapsedWidth: 72, collapseBelow: 150 };

test("a left panel grows when dragged right and snaps closed below the threshold", () => {
  const open = { width: 272, collapsed: false };
  assert.deepEqual(resolvePanelDrag(open, { side: "left", startX: 272, currentX: 300, startWidth: 272 }, bounds), { width: 300, collapsed: false });
  assert.deepEqual(resolvePanelDrag(open, { side: "left", startX: 272, currentX: 100, startWidth: 272 }, bounds), { width: 272, collapsed: true });
  // Dragged back past the threshold it reopens at the pointer, not at the old width.
  const closed = { width: 272, collapsed: true };
  assert.deepEqual(resolvePanelDrag(closed, { side: "left", startX: 72, currentX: 250, startWidth: 72 }, bounds), { width: 250, collapsed: false });
  assert.deepEqual(resolvePanelDrag(closed, { side: "left", startX: 72, currentX: 120, startWidth: 72 }, bounds), closed);
});

test("a right panel grows when dragged left and respects the window's room", () => {
  const open = { width: 360, collapsed: false };
  assert.deepEqual(resolvePanelDrag(open, { side: "right", startX: 900, currentX: 860, startWidth: 360 }, { ...bounds, max: 620 }), { width: 400, collapsed: false });
  assert.deepEqual(resolvePanelDrag(open, { side: "right", startX: 900, currentX: 500, startWidth: 360 }, { ...bounds, max: 620 }, 480), { width: 480, collapsed: false });
  assert.deepEqual(resolvePanelDrag(open, { side: "right", startX: 900, currentX: 1200, startWidth: 360 }, { ...bounds, max: 620 }), { width: 360, collapsed: true });
});

test("keyboard nudges shrink into collapse and grow out of it", () => {
  const open = { width: 200, collapsed: false };
  assert.deepEqual(resolvePanelKey(open, { side: "left", key: "ArrowLeft", shift: false }, bounds), { width: 200, collapsed: true });
  assert.deepEqual(resolvePanelKey(open, { side: "left", key: "ArrowRight", shift: true }, bounds), { width: 240, collapsed: false });
  const closed = { width: 260, collapsed: true };
  assert.deepEqual(resolvePanelKey(closed, { side: "right", key: "ArrowLeft", shift: false }, bounds), { width: 260, collapsed: false });
  assert.deepEqual(resolvePanelKey(closed, { side: "right", key: "ArrowRight", shift: false }, bounds), closed);
  assert.deepEqual(resolvePanelKey(open, { side: "left", key: "End", shift: false }, bounds), { width: 360, collapsed: false });
  assert.deepEqual(resolvePanelKey(open, { side: "left", key: "Home", shift: false }, bounds), { width: 200, collapsed: true });
  assert.equal(resolvePanelKey(open, { side: "left", key: "a", shift: false }, bounds), null);
});

test("rendered width is the collapsed rail when closed and the clamped width when open", () => {
  assert.equal(renderedPanelWidth({ width: 900, collapsed: false }, bounds), 360);
  assert.equal(renderedPanelWidth({ width: 900, collapsed: true }, bounds), 72);
  assert.equal(clampPanelWidth(10, bounds), 200);
  assert.equal(clampPanelWidth(300, bounds, 250), 250);
  // A window too narrow for the minimum still gets the minimum.
  assert.equal(clampPanelWidth(300, bounds, 100), 200);
});

test("layout persists the expanded width and the collapsed flag, and reads the legacy width key", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  writePanelLayout(storage, "panel", { width: 300, collapsed: true });
  assert.deepEqual(readPanelLayout(storage, "panel", 272, bounds), { width: 300, collapsed: true });
  writePanelLayout(storage, "panel", { width: 300, collapsed: false });
  assert.deepEqual(readPanelLayout(storage, "panel", 272, bounds), { width: 300, collapsed: false });
  writePanelLayout(storage, "panel", null);
  assert.deepEqual(readPanelLayout(storage, "panel", 272, bounds), { width: 272, collapsed: false });
  store.set("legacy", "333");
  assert.deepEqual(readPanelLayout(storage, "legacy", 272, bounds), { width: 333, collapsed: false });
  assert.deepEqual(readPanelLayout(null, "none", 272, bounds), { width: 272, collapsed: false });
});
