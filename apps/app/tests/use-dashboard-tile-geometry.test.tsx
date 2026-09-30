import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushDashboardTileCacheStorage, resetDashboardTileCacheMemory } from "../src/app/lib/dashboard-cache-storage";
import { dashboardTileCacheScopeKey } from "../src/react-app/domains/dashboard/dashboard-tile-cache";
import { readDashboardTileGeometry, writeDashboardTileGeometry, type DashboardTileGeometry } from "../src/react-app/domains/dashboard/dashboard-tile-geometry";
import { useDashboardTileGeometry } from "../src/react-app/domains/dashboard/use-dashboard-tile-geometry";

GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const previousObserver = globalThis.ResizeObserver;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const scope = dashboardTileCacheScopeKey("member", "org");
const now = 1_800_000_000_000;
const saved: DashboardTileGeometry = { workspaceId: "workspace", contentWidth: 640, frameHeight: 220, outerHeight: 248, measuredAt: now - 100 };
const frames = new Map<number, FrameRequestCallback>();
const observers: MockResizeObserver[] = [];
let nextFrame = 0;
let size = { width: 640, height: 248 };
let container: HTMLDivElement;
let root: Root;
let current: ReturnType<typeof useDashboardTileGeometry> | null;
let initialHeights: Array<number | undefined>;

class MockResizeObserver {
  target: Element | null = null;
  notify: (width?: number, height?: number, outerHeight?: number) => void;
  constructor(callback: ResizeObserverCallback) {
    this.notify = (width = size.width, height = size.height, outerHeight = height) => {
      if (!this.target) return;
      callback([{
        target: this.target,
        contentRect: new DOMRect(0, 0, width, height),
        borderBoxSize: [{ inlineSize: width, blockSize: outerHeight }],
        contentBoxSize: [{ inlineSize: width, blockSize: height }],
        devicePixelContentBoxSize: [],
      }], this);
    };
    observers.push(this);
  }
  observe = mock((node: Element) => { this.target = node; });
  unobserve() {}
  disconnect = mock(() => {});
}

function Probe({ scopeKey = scope, entryId = "tile", workspaceId = "workspace", style }: {
  scopeKey?: string; entryId?: string; workspaceId?: string; style?: CSSProperties;
}) {
  current = useDashboardTileGeometry(scopeKey, entryId, workspaceId);
  initialHeights.push(current.initialHeight);
  return <div ref={current.ref} style={style} data-geometry-host />;
}

function geometry() {
  if (!current) throw new Error("Missing geometry hook");
  return current;
}

function observer() {
  const value = observers.at(-1);
  if (!value) throw new Error("Missing geometry observer");
  return value;
}

async function flush() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

beforeEach(() => {
  setSystemTime(now);
  resetDashboardTileCacheMemory();
  window.localStorage.clear();
  frames.clear();
  observers.length = 0;
  nextFrame = 0;
  current = null;
  initialHeights = [];
  size = { width: 640, height: 248 };
  Reflect.set(globalThis, "ResizeObserver", MockResizeObserver);
  spyOn(document, "hidden", "get").mockReturnValue(false);
  spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, size.width, size.height));
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  expect(frames.size).toBe(0);
  for (const value of observers) expect(value.disconnect).toHaveBeenCalledTimes(1);
  container.remove();
  resetDashboardTileCacheMemory();
  mock.restore();
  setSystemTime();
  Reflect.set(globalThis, "ResizeObserver", previousObserver);
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  await GlobalRegistrator.unregister();
});

test("hydrates one small geometry cache and selects the exact rounded width in the layout phase without persisting estimates", async () => {
  writeDashboardTileGeometry(scope, "tile", saved);
  writeDashboardTileGeometry(scope, "tile", { ...saved, contentWidth: 320, frameHeight: 600, outerHeight: 628, measuredAt: now });
  flushDashboardTileCacheStorage();
  resetDashboardTileCacheMemory();
  const reads = spyOn(window.localStorage, "getItem");
  const writes = spyOn(window.localStorage, "setItem");
  size.width = 640.4;
  await act(async () => root.render(<Probe />));
  expect(initialHeights[0]).toBe(600);
  expect(geometry().initialHeight).toBe(220);
  expect(geometry().reservedHeight).toBe(248);
  await act(async () => root.render(<Probe />));
  observer().notify();
  await flush();
  flushDashboardTileCacheStorage();
  expect(reads).toHaveBeenCalledTimes(1);
  expect(writes).not.toHaveBeenCalled();
  expect(readDashboardTileGeometry(scope, "tile", "workspace", 640)?.measuredAt).toBe(saved.measuredAt);
});

test("coalesces real normalized frame heights with content width and outer chrome, then permits shrink without repeated writes", async () => {
  size = { width: 664.4, height: 900 };
  await act(async () => root.render(<Probe style={{ padding: "8px 10px", border: "2px solid" }} />));
  expect(geometry().initialHeight).toBeUndefined();
  await act(async () => {
    geometry().recordHeight(900);
    geometry().recordHeight(5000);
  });
  expect(frames.size).toBe(1);
  await flush();
  expect(readDashboardTileGeometry(scope, "tile", "workspace", 640)).toEqual({ ...saved, frameHeight: 800, outerHeight: 900, measuredAt: now });
  size.height = 302.5;
  await act(async () => geometry().recordHeight(274.1));
  await flush();
  expect(geometry().initialHeight).toBe(275);
  expect(geometry().reservedHeight).toBe(302.5);
  flushDashboardTileCacheStorage();
  const writes = spyOn(window.localStorage, "setItem");
  const reads = spyOn(HTMLElement.prototype, "getBoundingClientRect");
  reads.mockClear();
  setSystemTime(now + 1_000);
  observer().notify(640.4, 282.5, 302.5);
  observer().notify(640.4, 282.5, 302.5);
  expect(frames.size).toBe(1);
  await flush();
  flushDashboardTileCacheStorage();
  expect(reads).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
  expect(readDashboardTileGeometry(scope, "tile", "workspace", 640)?.measuredAt).toBe(now);
});

test("waits for a loading reservation to release before saving the smaller natural host height", async () => {
  writeDashboardTileGeometry(scope, "tile", { ...saved, frameHeight: 600, outerHeight: 628 });
  size.height = 628;
  await act(async () => root.render(<Probe style={{ minHeight: 628 }} />));
  await act(async () => geometry().recordHeight(220));
  await flush();
  expect(readDashboardTileGeometry(scope, "tile", "workspace", 640)?.frameHeight).toBe(600);
  size.height = 248;
  await act(async () => root.render(<Probe />));
  observer().notify();
  await flush();
  expect(readDashboardTileGeometry(scope, "tile", "workspace", 640)).toEqual({ ...saved, measuredAt: now });
  expect(geometry().reservedHeight).toBe(248);
});

test("observer-only loading and recovery heights cannot overwrite a guest measurement", async () => {
  await act(async () => root.render(<Probe />));
  await act(async () => geometry().recordHeight(220));
  await flush();
  const measured = readDashboardTileGeometry(scope, "tile", "workspace", 640);
  size.height = 64;
  observer().notify();
  await flush();
  expect(readDashboardTileGeometry(scope, "tile", "workspace", 640)).toEqual(measured);
  expect(geometry().reservedHeight).toBe(248);
});

test("uses width variants without saving the previous width's guest height as a new measurement", async () => {
  writeDashboardTileGeometry(scope, "tile", saved);
  writeDashboardTileGeometry(scope, "tile", { ...saved, contentWidth: 320, frameHeight: 480, outerHeight: 508 });
  await act(async () => root.render(<Probe />));
  await act(async () => geometry().recordHeight(220));
  await flush();
  size = { width: 320, height: 248 };
  observer().notify();
  await flush();
  expect(geometry().initialHeight).toBe(480);
  expect(geometry().reservedHeight).toBe(508);
  expect(readDashboardTileGeometry(scope, "tile", "workspace", 320)?.frameHeight).toBe(480);
  size = { width: 800, height: 248 };
  observer().notify();
  await flush();
  expect(readDashboardTileGeometry(scope, "tile", "workspace", 800)).toBeNull();
  size.height = 188;
  await act(async () => geometry().recordHeight(160));
  await flush();
  expect(readDashboardTileGeometry(scope, "tile", "workspace", 800)?.frameHeight).toBe(160);
  expect(readDashboardTileGeometry(scope, "tile", "workspace", 640)?.frameHeight).toBe(220);
});

test("ignores hidden, empty and invalid measurements without inventing a saved height", async () => {
  await act(async () => root.render(<Probe />));
  for (const height of [0, -1, NaN, Infinity]) geometry().recordHeight(height);
  expect(frames.size).toBe(0);
  size.width = 0;
  geometry().recordHeight(300);
  observer().notify();
  size = { width: 640, height: 0 };
  geometry().recordHeight(300);
  observer().notify();
  size.height = 328;
  const node = geometry().ref.current;
  if (!node) throw new Error("Missing geometry host");
  node.style.visibility = "hidden";
  geometry().recordHeight(300);
  observer().notify();
  node.style.visibility = "visible";
  spyOn(document, "hidden", "get").mockReturnValue(true);
  geometry().recordHeight(300);
  observer().notify();
  await flush();
  expect(readDashboardTileGeometry(scope, "tile", "workspace")).toBeNull();
});

const identities = [
  { scopeKey: `${scope}.deployment.other`, entryId: "tile", workspaceId: "workspace" },
  { scopeKey: scope, entryId: "other-tile", workspaceId: "workspace" },
  { scopeKey: scope, entryId: "tile", workspaceId: "other-workspace" },
];

test.each(identities)("resets synchronously for identity %j and rejects queued or stale callbacks", async (identity) => {
  writeDashboardTileGeometry(scope, "tile", saved);
  const next = { ...saved, workspaceId: identity.workspaceId, frameHeight: 440, outerHeight: 468 };
  writeDashboardTileGeometry(identity.scopeKey, identity.entryId, next);
  await act(async () => root.render(<Probe />));
  const old = geometry();
  const oldNode = old.ref.current;
  const oldObserver = observer();
  await act(async () => old.recordHeight(700));
  expect(frames.size).toBe(1);
  initialHeights = [];
  await act(async () => root.render(<Probe {...identity} />));
  expect(initialHeights[0]).toBe(440);
  expect(geometry().initialHeight).toBe(440);
  expect(geometry().ref.current).toBe(oldNode);
  expect(frames.size).toBe(0);
  old.recordHeight(800);
  oldObserver.notify();
  await flush();
  expect(readDashboardTileGeometry(scope, "tile", "workspace", 640)).toEqual(saved);
  expect(readDashboardTileGeometry(identity.scopeKey, identity.entryId, identity.workspaceId, 640)).toEqual(next);
  await act(async () => geometry().recordHeight(500));
  await act(async () => root.render(null));
  expect(frames.size).toBe(0);
  expect(readDashboardTileGeometry(identity.scopeKey, identity.entryId, identity.workspaceId, 640)).toEqual(next);
});

test("does not hydrate or persist without a scope and workspace", async () => {
  const reads = spyOn(window.localStorage, "getItem");
  await act(async () => root.render(<Probe scopeKey="" workspaceId="" />));
  geometry().recordHeight(300);
  await flush();
  expect(geometry().initialHeight).toBeUndefined();
  expect(geometry().reservedHeight).toBeUndefined();
  expect(reads).not.toHaveBeenCalled();
  expect(observers).toHaveLength(0);
});
