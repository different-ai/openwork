/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { SessionScrollOverlay } from "../src/react-app/domains/session/surface/scroll-overlay";
import { flushSessionScrollState, sessionScrollKey, useSessionScrollStore } from "../src/react-app/domains/session/surface/scroll-store";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const originalResizeObserver = globalThis.ResizeObserver;
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const resizeCallbacks = new Set<() => void>();
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  useSessionScrollStore.setState({ sessions: {} });
  Reflect.set(globalThis, "ResizeObserver", class {
    callback: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.callback = () => callback([], this);
      resizeCallbacks.add(this.callback);
    }
    observe() {}
    unobserve() {}
    disconnect() { resizeCallbacks.delete(this.callback); }
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  flushSessionScrollState();
  localStorage.clear();
  Reflect.set(globalThis, "ResizeObserver", originalResizeObserver);
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function fixture() {
  const host = document.createElement("div");
  const container = document.createElement("div");
  const content = document.createElement("div");
  container.append(content);
  document.body.append(container, host);
  const root = createRoot(host);
  const containerRef = createRef<HTMLDivElement>();
  const contentRef = createRef<HTMLDivElement>();
  containerRef.current = container;
  contentRef.current = content;
  const layout = { height: 1000, viewport: 200, width: 500 };
  Object.defineProperties(container, {
    scrollHeight: { get: () => layout.height },
    clientHeight: { get: () => layout.viewport },
    clientWidth: { get: () => layout.width },
  });
  const props = {
    sessionId: "thread", owner: "workspace", isStreaming: false,
    historyReady: true, hasNewer: false, containerRef, contentRef,
    onJumpToLatest: () => {}, onJumpToStartOfMessage: () => {},
  };
  const key = sessionScrollKey(props.sessionId, props.owner);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
    host.remove();
  });
  return {
    layout, props, key, container,
    latest: () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Jump to latest"),
    start: () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Jump to start"),
    render: async () => { await act(async () => root.render(<SessionScrollOverlay {...props} />)); },
    scroll: async (top: number) => { await act(async () => {
      container.scrollTop = top;
      container.dispatchEvent(new Event("scroll"));
    }); },
    resize: async () => { await act(async () => { for (const callback of resizeCallbacks) callback(); }); },
  };
}

describe("Jump to latest visibility", () => {
  test("hides at the measured bottom even in manual mode, and reappears when scrolling away", async () => {
    const view = fixture();
    useSessionScrollStore.getState().setManualScroll(view.key, 900, "latest");
    view.container.scrollTop = 800;
    await view.render();
    expect(view.latest()).toBeUndefined();
    expect(view.start()).toBeDefined();
    await view.scroll(798);
    expect(view.latest()).toBeDefined();
    await view.scroll(799.5);
    expect(view.latest()).toBeUndefined();
    expect(useSessionScrollStore.getState().sessions[view.key].mode).toBe("manual");
  });

  test("tracks streaming growth and resize without depending on follow mode or scroll events", async () => {
    const view = fixture();
    view.props.isStreaming = true;
    view.container.scrollTop = 800;
    await view.render();
    expect(view.latest()).toBeUndefined();
    view.layout.height += 100;
    await view.resize();
    expect(view.latest()).toBeDefined();
    await view.scroll(900);
    expect(view.latest()).toBeUndefined();
    await view.scroll(850);
    expect(view.latest()).toBeDefined();
    view.layout.viewport += 50;
    await view.resize();
    expect(view.latest()).toBeUndefined();
  });

  test("keeps latest available at a loaded page boundary when newer history exists", async () => {
    const view = fixture();
    view.container.scrollTop = 800;
    view.props.hasNewer = true;
    await view.render();
    expect(view.latest()).toBeDefined();
    view.props.hasNewer = false;
    await view.render();
    expect(view.latest()).toBeUndefined();
  });

  test("hides while loading, in a hidden pane, and when the whole thread fits", async () => {
    const view = fixture();
    useSessionScrollStore.getState().setManualScroll(view.key, 325, null);
    view.props.historyReady = false;
    await view.render();
    expect(view.latest()).toBeUndefined();
    view.props.historyReady = true;
    await view.render();
    expect(view.latest()).toBeDefined();
    view.layout.viewport = 0;
    await view.resize();
    expect(view.latest()).toBeUndefined();
    view.layout.viewport = 1200;
    await view.resize();
    expect(view.latest()).toBeUndefined();
    view.layout.viewport = 200;
    await view.resize();
    expect(view.latest()).toBeDefined();
  });
});
