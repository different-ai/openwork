/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, Fragment, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { SESSION_SCROLL_NAVIGATION_EVENT, useSessionScrollController } from "../src/react-app/domains/session/surface/scroll-controller";
import { flushSessionScrollState, getSessionScrollState, readPersistedSessionScrollState, sessionScrollKey, useSessionScrollStore } from "../src/react-app/domains/session/surface/scroll-store";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const originalResizeObserver = globalThis.ResizeObserver;
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const storageKey = "openwork:session-scroll:v1";
const frames = new Map<number, FrameRequestCallback>();
const observers: (() => void)[] = [];
const cleanups: (() => Promise<void>)[] = [];
let frameId = 0;
let now = 1_000;

beforeEach(() => {
  jest.useFakeTimers();
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  Reflect.set(globalThis, "ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { observers.push(() => callback([], this)); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  useSessionScrollStore.setState({ sessions: {} });
  flushSessionScrollState();
  localStorage.clear();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  flushSessionScrollState();
  frames.clear();
  observers.length = 0;
  now = 1_000;
  Reflect.set(globalThis, "ResizeObserver", originalResizeObserver);
  mock.restore();
  jest.useRealTimers();
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function state(id = "a", owner?: string) {
  return getSessionScrollState(useSessionScrollStore.getState().sessions, id, owner);
}

function runFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(now);
}

function observeStorageWrites() {
  const storage = window.localStorage;
  const setItem = storage.setItem;
  const writes = mock(setItem);
  // Happy DOM caches bound methods; defineProperty bypasses that binding while
  // the forwarding mock still exercises real storage and serialized values.
  Object.defineProperty(storage, "setItem", { configurable: true, writable: true, value: writes });
  cleanups.push(async () => {
    Object.defineProperty(storage, "setItem", { configurable: true, writable: true, value: setItem });
  });
  return writes;
}

function fixture(geometryOwner?: string, pagination: Pick<Parameters<typeof useSessionScrollController>[0], "historyPages" | "windowReady" | "pageForAnchor" | "historyComplete" | "ensureFullHistory"> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const layout = {
    height: 1_000,
    viewportHeight: 200,
    complete: true,
    virtualized: false,
    transcriptHidden: false,
    transcriptCommitted: true,
    fallback: false,
    placeholders: [] as { id: string; before: string; top: number; height: number }[],
    messages: [
      { id: "first", top: 0, height: 300 },
      { id: "reading", top: 300, height: 300 },
      { id: "latest", top: 600, height: 400 },
    ],
  };
  let scrollTop = 0;
  const scrollWrites: number[] = [];
  let controls: ReturnType<typeof useSessionScrollController> | undefined;
  let unmounted = false;
  function Harness({ sessionId, ready }: { sessionId: string; ready: boolean }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const setContainer = useCallback((node: HTMLDivElement | null) => {
      containerRef.current = node;
      if (!node) return;
      Object.defineProperties(node, {
        scrollHeight: { configurable: true, get: () => layout.height },
        clientHeight: { configurable: true, get: () => layout.viewportHeight },
        clientWidth: { configurable: true, get: () => 500 },
        scrollTop: { configurable: true, get: () => scrollTop, set: (top: number) => {
          scrollWrites.push(top);
          scrollTop = Math.max(0, Math.min(top, layout.height - layout.viewportHeight));
        } },
        scrollTo: { configurable: true, value: (options: ScrollToOptions) => { node.scrollTop = options.top ?? scrollTop; } },
        getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 40, 500, layout.viewportHeight) },
      });
    }, []);
    const scroll = useSessionScrollController({
      selectedSessionId: sessionId, geometryOwner, submittedMessageId: null, historyReady: ready, renderedMessages: [...layout.messages], containerRef, contentRef, ...pagination,
    });
    controls = scroll;
    return <div ref={setContainer} onScroll={scroll.handleScroll} onWheel={(event) => scroll.markScrollGesture(event.target)}
      onPointerDown={(event) => { if (event.target === event.currentTarget) scroll.markScrollGesture(event.target); }}>
      <div ref={contentRef} data-thread-virtualized={layout.virtualized}>
        {!ready || layout.fallback ? <div data-thread-loading /> : null}
        {layout.transcriptCommitted ? <div data-thread-history-complete={layout.complete} ref={(node) => {
          if (node) node.getBoundingClientRect = () => layout.transcriptHidden ? new DOMRect() : new DOMRect(0, 40 - scrollTop, 500, layout.height);
        }}>
        {layout.messages.map((message) => <Fragment key={message.id}>
          {layout.placeholders.filter((placeholder) => placeholder.before === message.id).map((placeholder) =>
            <div key={placeholder.id} data-thread-placeholder={placeholder.id} ref={(node) => {
              if (node) node.getBoundingClientRect = () => new DOMRect(0, 40 + placeholder.top - scrollTop, 500, placeholder.height);
            }} />)}
          <div data-thread-group={layout.virtualized ? message.id : undefined}>
            <div data-message-id={message.id} ref={(node) => {
              if (node) node.getBoundingClientRect = () => layout.transcriptHidden ? new DOMRect() : new DOMRect(0, 40 + message.top - scrollTop, 500, message.height);
            }}>{message.id}</div>
          </div>
        </Fragment>)}
        </div> : null}
        <div data-scrollable>Nested scroll area</div>
      </div>
    </div>;
  }
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => root.unmount());
    host.remove();
  };
  cleanups.push(unmount);
  return {
    layout,
    scrollWrites,
    unmount,
    async render(sessionId = "a", ready = true) { await act(async () => root.render(<Harness sessionId={sessionId} ready={ready} />)); },
    get container() {
      const container = host.firstElementChild;
      if (!(container instanceof HTMLDivElement)) throw new Error("Missing scroll viewport");
      return container;
    },
    get controls() {
      if (!controls) throw new Error("Missing scroll controller");
      return controls;
    },
    scroll(top: number) {
      this.container.scrollTop = top;
      this.container.dispatchEvent(new Event("scroll"));
    },
    wheel(top: number) {
      this.container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: top - scrollTop }));
      this.scroll(top);
    },
    resize() { for (const callback of observers) callback(); },
  };
}

describe("session reading position", () => {
  test.each(["keyboard", "wheel", "pointer"])("a padded page prepend preserves its boundary anchor until the next %s gesture", async (gesture) => {
    let finish = () => {};
    const load = mock(() => new Promise<void>((resolve) => { finish = resolve; }));
    const newest = { before: null, limit: 24, lineage: [null] };
    const older = { before: "older-page", limit: 24, lineage: [null, "older-page"] };
    const pages = { version: {}, hasOlder: true, hasNewer: false, loading: false, failed: false, load };
    const view = fixture("owner-a", { historyPages: pages, windowReady: true,
      pageForAnchor: (id) => id === "126" ? older : newest });
    view.layout.virtualized = true;
    view.layout.complete = false;
    view.layout.viewportHeight = 612;
    view.layout.height = 2232;
    view.layout.messages = [{ id: "127", top: 16, height: 84 }, { id: "150", top: 2132, height: 84 }];
    await view.render();
    view.container.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    view.scroll(0);
    expect(load.mock.calls).toEqual([["older"]]);
    expect(state("a", "owner-a")).toMatchObject({ anchor: { messageId: "127", offset: 16 }, geometry: { page: newest } });
    view.layout.messages = [{ id: "126", top: 16 + 2208 - 92, height: 84 },
      { id: "127", top: 16 + 2208, height: 84 }, { id: "150", top: 2132 + 2208, height: 84 }];
    view.layout.height += 2208;
    pages.version = {};
    await view.render();
    await act(async () => finish());
    expect(view.container.scrollTop).toBe(2208);
    expect(state("a", "owner-a")).toMatchObject({ anchor: { messageId: "127", offset: 16 }, geometry: { page: newest } });
    for (const message of view.layout.messages) message.top += 120;
    view.layout.height += 120;
    view.container.scrollTop += 120;
    view.resize();
    view.scroll(view.container.scrollTop);
    expect(state("a", "owner-a")).toMatchObject({ scrollTop: 2328, anchor: { messageId: "127", offset: 16 }, geometry: { page: newest } });
    pages.hasOlder = false;
    if (gesture === "keyboard") view.container.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    if (gesture === "pointer") view.container.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, bubbles: true }));
    if (gesture === "wheel") view.wheel(view.container.scrollTop - 92);
    else view.scroll(view.container.scrollTop - 92);
    if (gesture === "pointer") window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, isPrimary: true, button: 0 }));
    expect(state("a", "owner-a")).toMatchObject({ anchor: { messageId: "126", offset: 16 }, geometry: { page: older } });
  });

  test("virtual geometry saves only the contiguous reading window, excluding the pinned tail", async () => {
    const view = fixture("owner-a");
    view.layout.virtualized = true;
    view.layout.height = 4000;
    view.layout.messages[2].top = 3600;
    view.layout.placeholders = [{ id: "placeholder:gap", before: "latest", top: 600, height: 3000 }];
    await view.render();
    view.wheel(325);
    expect(state("a", "owner-a")).toMatchObject({ anchor: { messageId: "reading", offset: -25 },
      geometry: { before: 0, after: 3400, messageIds: ["first", "reading"] } });
    const geometry = state("a", "owner-a").geometry;
    view.wheel(1200);
    expect(state("a", "owner-a").geometry).toEqual(geometry);
    view.layout.messages = [{ id: "destination", top: 1200, height: 300 }, view.layout.messages[2]];
    view.layout.placeholders = [
      { id: "placeholder:before", before: "destination", top: 0, height: 1200 },
      { id: "placeholder:after", before: "latest", top: 1500, height: 2100 },
    ];
    await view.render();
    expect(state("a", "owner-a")).toMatchObject({ scrollTop: 1200, anchor: { messageId: "destination", offset: 0 },
      geometry: { before: 1200, after: 2500, messageIds: ["destination"] } });
  });

  test("virtual gaps do not trigger older-page requests until the loaded boundary is reached", async () => {
    const load = mock(async () => {});
    const pages = { version: {}, hasOlder: true, hasNewer: false, loading: false, failed: false, load };
    const view = fixture("owner-a", { historyPages: pages, windowReady: true });
    view.layout.virtualized = true;
    view.layout.complete = false;
    view.layout.placeholders = [{ id: "placeholder:loaded", before: "first", top: 0, height: 1000 }];
    for (const message of view.layout.messages) message.top += 1000;
    view.layout.height += 1000;
    await view.render();
    view.wheel(1100);
    runFrames();
    expect(load).not.toHaveBeenCalled();
    view.layout.placeholders[0].id = "history-prefix";
    await view.render();
    view.wheel(1050);
    expect(load.mock.calls).toEqual([["older"]]);
  });

  test.each([false, true])("older paging reaches the loaded boundary while its first groups are virtualized (reserved prefix: %s)", async (reserved) => {
    const load = mock(async () => {});
    const pages = { version: {}, hasOlder: true, hasNewer: false, loading: false, failed: false, load };
    const view = fixture("owner-a", { historyPages: pages, windowReady: true });
    view.layout.virtualized = true;
    view.layout.complete = false;
    view.layout.height = 5000;
    view.layout.messages = [{ id: "latest", top: 4600, height: 400 }];
    view.layout.placeholders = [
      ...(reserved ? [{ id: "history-prefix", before: "latest", top: 0, height: 1000 }] : []),
      { id: "placeholder:loaded", before: "latest", top: reserved ? 1000 : 0, height: reserved ? 3600 : 4600 },
    ];
    await view.render();
    view.wheel(2000);
    runFrames();
    expect(load).not.toHaveBeenCalled();
    view.wheel(0);
    runFrames();
    if (!reserved) {
      expect(load).not.toHaveBeenCalled();
      view.layout.messages.unshift({ id: "first", top: 0, height: 300 });
      view.layout.placeholders[0] = { id: "placeholder:loaded", before: "latest", top: 300, height: 4300 };
      await view.render();
    }
    expect(load.mock.calls).toEqual([["older"]]);
    if (!reserved) {
      view.layout.messages.unshift({ id: "older", top: 0, height: 300 });
      for (const message of view.layout.messages.slice(1)) message.top += 300;
      view.layout.placeholders[0].top += 300;
      view.layout.height += 300;
      pages.version = {};
      await view.render();
      expect(state("a", "owner-a")).toMatchObject({ scrollTop: 300, anchor: { messageId: "first", offset: 0 } });
      expect(load).toHaveBeenCalledTimes(1);
    }
  });

  test("top navigation completes only after the virtual destination mounts and saves its anchor", async () => {
    const view = fixture("owner-a", { historyComplete: true });
    view.layout.virtualized = true;
    view.layout.height = 5000;
    view.layout.messages = [{ id: "latest", top: 4600, height: 400 }];
    view.layout.placeholders = [{ id: "placeholder:first", before: "latest", top: 0, height: 4600 }];
    await view.render();
    let completed = false;
    let navigation: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      navigation = view.controls.scrollToTop();
      void navigation.then(() => { completed = true; });
    });
    expect(view.container.scrollTop).toBe(0);
    expect(completed).toBe(false);
    view.layout.messages.unshift({ id: "first", top: 0, height: 300 });
    view.layout.placeholders[0] = { id: "placeholder:middle", before: "latest", top: 300, height: 4300 };
    await view.render();
    expect(await navigation).toBe(true);
    expect(state("a", "owner-a")).toMatchObject({ mode: "manual", scrollTop: 0, anchor: { messageId: "first", offset: 0 } });
  });

  test("explicit first-message navigation waits for complete history and the corresponding DOM commit", async () => {
    let finish = () => {};
    const full = mock(() => new Promise<void>((resolve) => { finish = resolve; }));
    const older = mock(async () => {});
    const options = { historyComplete: false, windowReady: true, ensureFullHistory: full,
      historyPages: { version: {}, hasOlder: true, hasNewer: false, loading: false, failed: false, load: older } };
    const view = fixture("owner-a", options);
    view.layout.complete = false;
    await view.render();
    const before = view.container.scrollTop;
    let navigation: Promise<boolean> = Promise.resolve(false);
    await act(async () => { navigation = view.controls.scrollToTop(); });
    expect(full).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
    expect(view.container.scrollTop).toBe(before);
    await act(async () => finish());
    expect(view.container.scrollTop).toBe(before);
    for (const message of view.layout.messages) message.top += 500;
    view.layout.messages.unshift({ id: "actual-first", top: 0, height: 500 });
    view.layout.height += 500;
    view.layout.complete = true;
    options.historyComplete = true;
    await view.render();
    expect(await navigation).toBe(true);
    expect(view.container.scrollTop).toBe(0);
    expect(state("a", "owner-a")).toMatchObject({ mode: "manual", anchor: { messageId: "actual-first", offset: 0 } });
    expect(older).not.toHaveBeenCalled();
  });

  test("leaving a surface cancels a delayed first-message navigation", async () => {
    let finish = () => {};
    const options = { historyComplete: false, ensureFullHistory: () => new Promise<void>((resolve) => { finish = resolve; }) };
    const view = fixture("owner-a", options);
    await view.render();
    const navigation = view.controls.scrollToTop();
    await view.render("b");
    const destination = view.container.scrollTop;
    await act(async () => finish());
    expect(await navigation).toBe(false);
    expect(view.container.scrollTop).toBe(destination);
  });

  test("a missing saved anchor cannot be consumed while its bounded recovery is pending", async () => {
    const store = useSessionScrollStore.getState();
    const key = sessionScrollKey("a", "owner-a");
    store.setManualScroll(key, 325, null, { messageId: "saved", offset: -25 });
    const options = { windowReady: false };
    const view = fixture("owner-a", options);
    view.layout.complete = false;
    await view.render();
    expect(state("a", "owner-a")).toMatchObject({ scrollTop: 325, anchor: { messageId: "saved", offset: -25 } });
    for (const message of view.layout.messages) message.top += 400;
    view.layout.messages.unshift({ id: "saved", top: 0, height: 400 });
    view.layout.height += 400;
    options.windowReady = true;
    await view.render();
    expect(view.container.scrollTop).toBe(25);
    expect(state("a", "owner-a")).toMatchObject({ anchor: { messageId: "saved", offset: -25 } });
  });

  test("native page demand ignores sticky auto-scroll and preserves the latest message offset when older rows prepend", async () => {
    let finish = () => {};
    const load = mock(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pages = { version: {}, hasOlder: true, hasNewer: false, loading: false, failed: false, load };
    const page = { before: null, limit: 24, lineage: [null] };
    const view = fixture("owner-a", { windowReady: true, historyPages: pages, pageForAnchor: () => page });
    view.layout.complete = false;
    await view.render();
    view.scroll(800);
    runFrames();
    view.resize();
    expect(load).not.toHaveBeenCalled();
    view.wheel(120);
    expect(load.mock.calls).toEqual([["older"]]);
    view.wheel(160);
    const before = state("a", "owner-a");
    expect(before).toMatchObject({ mode: "manual", anchor: { messageId: "first", offset: -160 }, geometry: { page } });
    for (const message of view.layout.messages) message.top += 400;
    view.layout.messages.unshift({ id: "older", top: 0, height: 400 });
    view.layout.height += 400;
    pages.version = {};
    pages.hasOlder = false;
    await view.render();
    finish();
    expect(view.container.scrollTop).toBe(560);
    expect(state("a", "owner-a")).toMatchObject({ mode: "manual", anchor: { messageId: "first", offset: -160 } });
    expect(load).toHaveBeenCalledTimes(1);
    flushSessionScrollState();
    expect(readPersistedSessionScrollState()[sessionScrollKey("a", "owner-a")].geometry?.page).toEqual(page);
  });

  test("a saved middle window demands newer data near its loaded end rather than making its suffix sticky", async () => {
    const load = mock(async () => {});
    const pages = { version: {}, hasOlder: false, hasNewer: true, loading: false, failed: false, load };
    const view = fixture("owner-a", { historyPages: pages, windowReady: true });
    useSessionScrollStore.getState().setManualScroll(sessionScrollKey("a", "owner-a"), 325, null, { messageId: "reading", offset: -25 });
    view.layout.complete = false;
    view.layout.height = 2000;
    await view.render();
    expect(load).not.toHaveBeenCalled();
    view.wheel(800);
    expect(load.mock.calls).toEqual([["newer"]]);
    view.wheel(1800);
    expect(state("a", "owner-a").mode).toBe("manual");
    await Promise.resolve();
    pages.failed = true;
    view.wheel(1750);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("a stable page with a deleted saved anchor settles locally and an empty page can demand newer history", async () => {
    const load = mock(async () => {});
    const pages = { version: {}, hasOlder: false, hasNewer: true, loading: false, failed: false, load };
    const key = sessionScrollKey("a", "owner-a");
    useSessionScrollStore.getState().setManualScroll(key, 300, null, { messageId: "deleted", offset: 0 });
    const view = fixture("owner-a", { historyPages: pages, windowReady: true });
    view.layout.complete = false;
    await view.render();
    expect(state("a", "owner-a")).toMatchObject({ mode: "manual", anchor: { messageId: "reading", offset: 0 } });
    view.layout.messages = [];
    view.layout.height = 400;
    await view.render();
    view.controls.markScrollGesture(view.container);
    runFrames();
    expect(load.mock.calls).toEqual([["newer"]]);
  });

  test("persisted pagination requires a bounded nonrepeating lineage rooted at newest", () => {
    const geometry = { owner: "owner-a", scrollHeight: 1000, viewportWidth: 500, before: 0, after: 0, messageIds: ["reading"] };
    for (const lineage of [["cursor"], [null, "cursor", "cursor"], [null, ...Array.from({ length: 64 }, (_, index) => `c${index}`)]]) {
      localStorage.setItem(storageKey, JSON.stringify({ a: { mode: "manual", scrollTop: 300, anchor: { messageId: "reading", offset: 0 },
        geometry: { ...geometry, page: { before: "cursor", limit: 24, lineage } } } }));
      expect(readPersistedSessionScrollState().a.geometry?.page).toBeUndefined();
      expect(readPersistedSessionScrollState().a.geometry?.messageIds).toEqual(["reading"]);
    }
  });

  test("signals explicit navigation for pending Find cancellation, not passive sticky reconciliation", async () => {
    const view = fixture();
    await view.render();
    const navigation = mock(() => {});
    view.container.addEventListener(SESSION_SCROLL_NAVIGATION_EVENT, navigation);
    view.layout.height += 100;
    view.resize();
    runFrames();
    expect(navigation).not.toHaveBeenCalled();
    view.controls.markScrollGesture(view.container);
    view.scroll(0);
    expect(navigation).toHaveBeenCalledTimes(1);
    view.controls.jumpToLatest("auto");
    expect(navigation).toHaveBeenCalledTimes(2);
    runFrames();
    view.controls.jumpToStartOfMessage("auto");
    expect(navigation).toHaveBeenCalledTimes(3);
  });

  test("restores estimated loading geometry without consuming an anchor absent from a partial preview", async () => {
    const store = useSessionScrollStore.getState();
    store.setManualScroll("a", 325, null, { messageId: "reading", offset: -25 });
    store.setGeometry("a", { owner: "owner-a", scrollHeight: 1000, viewportWidth: 500, before: 0, after: 0, messageIds: ["first", "reading", "latest"] });
    const saved = state();
    const view = fixture("owner-a");
    view.layout.complete = false;
    view.layout.messages = [];
    await view.render("a", false);
    expect(view.container.scrollTop).toBe(325);
    view.layout.messages = [{ id: "latest", top: 600, height: 400 }];
    await view.render();
    expect(state("a", "owner-a")).toEqual(saved);
    view.layout.messages.unshift({ id: "reading", top: 420, height: 180 });
    await view.render();
    expect(view.container.scrollTop).toBe(445);
    expect(state("a", "owner-a")).toEqual(saved);
  });

  test.each(["hidden", "fallback", "uncommitted"])("waits for committed transcript geometry despite historyReady (%s)", async (kind) => {
    const store = useSessionScrollStore.getState();
    const key = sessionScrollKey("a", "owner-a");
    store.setManualScroll(key, 125, null, { messageId: "reading", offset: -25 });
    store.setGeometry(key, { owner: "owner-a", scrollHeight: 1000, viewportWidth: 500, before: 0, after: 0, messageIds: ["first", "reading", "latest"] });
    const saved = state("a", "owner-a");
    const view = fixture("owner-a");
    const messages = view.layout.messages;
    view.layout.transcriptHidden = kind === "hidden";
    view.layout.transcriptCommitted = kind !== "uncommitted";
    view.layout.fallback = kind === "fallback";
    if (kind === "fallback") view.layout.messages = [];
    await view.render();
    view.resize();
    runFrames();
    view.scroll(view.container.scrollTop);
    expect(state("a", "owner-a")).toEqual(saved);
    if (kind === "fallback") expect(view.container.scrollTop).toBe(125);
    view.layout.transcriptHidden = false;
    view.layout.fallback = false;
    view.layout.transcriptCommitted = true;
    view.layout.messages = messages;
    await view.render();
    view.controls.refresh();
    runFrames();
    expect(view.container.scrollTop).toBe(325);
    expect(state("a", "owner-a").anchor).toEqual(saved.anchor);
    expect(frames.size).toBe(0);
  });

  test("an empty history without a list settles without waiting for a transcript", async () => {
    const view = fixture();
    view.layout.transcriptCommitted = false;
    view.layout.messages = [];
    view.layout.height = 200;
    await view.render();
    runFrames();
    expect(view.container.scrollTop).toBe(0);
    expect(state().mode).toBe("stickyBottom");
    view.layout.height = 500;
    view.resize();
    runFrames();
    expect(view.container.scrollTop).toBe(300);
    expect(frames.size).toBe(0);
  });

  test.each(["manual", "stickyBottom"])("does not save fallback clamps after restoring (%s)", async (mode) => {
    if (mode === "manual") useSessionScrollStore.getState().setManualScroll("a", 325, null, { messageId: "reading", offset: -25 });
    const view = fixture();
    await view.render();
    const saved = state();
    view.layout.transcriptHidden = true;
    view.layout.fallback = true;
    view.layout.height = 400;
    await view.render();
    view.scroll(0);
    view.resize();
    runFrames();
    expect(state()).toEqual(saved);
    expect(frames.size).toBe(0);
    view.layout.transcriptHidden = false;
    view.layout.fallback = false;
    view.layout.height = 1000;
    await view.render();
    runFrames();
    expect(view.container.scrollTop).toBe(mode === "manual" ? 325 : 800);
    expect(state()).toEqual(saved);
    expect(frames.size).toBe(0);
  });

  test("a gesture during an independent fallback cancels restoration without saving hidden geometry", async () => {
    useSessionScrollStore.getState().setManualScroll("a", 325, null, { messageId: "reading", offset: -25 });
    const saved = state();
    const view = fixture();
    view.layout.transcriptHidden = true;
    view.layout.fallback = true;
    await view.render();
    view.wheel(80);
    expect(state()).toEqual(saved);
    view.layout.transcriptHidden = false;
    view.layout.fallback = false;
    await view.render();
    view.resize();
    runFrames();
    expect(view.container.scrollTop).toBe(80);
    expect(state()).toMatchObject({ mode: saved.mode, scrollTop: saved.scrollTop, anchor: saved.anchor });
  });

  test("pointer scrolling through hidden content preserves gesture intent for paging after reveal", async () => {
    useSessionScrollStore.getState().setManualScroll("a", 325, null, { messageId: "reading", offset: -25 });
    const saved = state();
    const load = mock(async () => {});
    const pages = { version: {}, hasOlder: true, hasNewer: false, loading: false, failed: false, load };
    const view = fixture(undefined, { historyPages: pages, windowReady: true });
    view.layout.transcriptHidden = true;
    view.layout.fallback = true;
    await view.render();
    const message = view.container.querySelector("[data-message-id]");
    if (!message) throw new Error("Missing pointer target");
    message.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1 }));
    view.scroll(80);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    expect(state()).toEqual(saved);
    expect(load).not.toHaveBeenCalled();
    view.layout.transcriptHidden = false;
    view.layout.fallback = false;
    await view.render();
    expect(view.container.scrollTop).toBe(80);
    view.scroll(60);
    expect(load.mock.calls).toEqual([["older"]]);
    expect(state()).toMatchObject({ mode: "manual", scrollTop: 60, anchor: { messageId: "first", offset: -60 } });
  });

  test("records complete geometry and nearby IDs without replacing it with partial or zero-sized layout", async () => {
    const view = fixture("owner-a");
    await view.render();
    view.wheel(325);
    expect(state("a", "owner-a").geometry).toEqual({ owner: "owner-a", scrollHeight: 1000, viewportWidth: 500, before: 0, after: 0, messageIds: ["first", "reading", "latest"] });
    const geometry = state("a", "owner-a").geometry;
    view.layout.complete = false;
    view.layout.height = 1200;
    await view.render();
    view.wheel(350);
    expect(state("a", "owner-a").geometry).toEqual(geometry);
    useSessionScrollStore.getState().setStickyBottom(sessionScrollKey("a", "owner-a"), null);
    flushSessionScrollState();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ [sessionScrollKey("a", "owner-a")]: { mode: "stickyBottom", geometry } });
  });

  test("two owners with the same session ID keep independent manual positions and geometry", async () => {
    const first = fixture("owner-a");
    const second = fixture("owner-b");
    second.layout.viewportHeight = 320;
    await first.render();
    first.wheel(325);
    const saved = state("a", "owner-a");
    await second.render();
    expect(state("a", "owner-b").mode).toBe("stickyBottom");
    now += 1_000;
    first.resize();
    runFrames();
    expect(first.container.scrollTop).toBe(325);
    expect(state("a", "owner-a")).toEqual(saved);
    second.wheel(120);
    expect(state("a", "owner-b")).toMatchObject({ mode: "manual", scrollTop: 120, geometry: { owner: "owner-b" } });
    first.controls.jumpToLatest("auto");
    runFrames();
    expect(second.container.scrollTop).toBe(120);
    expect(state("a", "owner-b").mode).toBe("manual");
  });

  test("does not consume a legacy anchor against a too-short preview", async () => {
    useSessionScrollStore.getState().setManualScroll("a", 325, null, { messageId: "reading", offset: -25 });
    const saved = state();
    const view = fixture();
    view.layout.complete = false;
    view.layout.height = 200;
    view.layout.messages = [{ id: "reading", top: 0, height: 100 }];
    await view.render();
    view.scroll(0);
    expect(state()).toEqual(saved);
    view.layout.height = 1000;
    view.layout.messages[0].top = 300;
    await view.render();
    expect(view.container.scrollTop).toBe(325);
    expect(state()).toEqual(saved);
  });

  test("remembers native reflow adjustments without applying a competing scroll", async () => {
    useSessionScrollStore.getState().setManualScroll("a", 325, null, { messageId: "reading", offset: -25 });
    const view = fixture();
    await view.render();
    expect(view.container.style.overflowAnchor).toBe("auto");
    // Simulate the browser preserving a paragraph as content above it expands
    // inside the same message; the controller only records the native result.
    view.layout.messages[1].height += 80;
    view.layout.messages[2].top += 80;
    view.layout.height += 80;
    view.scroll(405);
    expect(state()).toMatchObject({ mode: "manual", scrollTop: 405, anchor: { messageId: "reading", offset: -105 } });
    view.resize();
    runFrames();
    expect(view.container.scrollTop).toBe(405);
  });

  test("waits for authoritative history, ignores empty/live-tail clamping, and restores message-relative position on return", async () => {
    useSessionScrollStore.getState().setManualScroll("a", 900, "latest", { messageId: "reading", offset: -25 });
    const saved = state();
    const view = fixture();
    view.layout.height = 200;
    view.layout.messages = [];
    await view.render("a", false);
    view.scroll(0);
    runFrames();
    view.resize();
    expect(state()).toEqual(saved);

    view.layout.messages = [{ id: "latest", top: 0, height: 100 }];
    await view.render("a", false);
    view.scroll(0);
    expect(state()).toEqual(saved);
    view.layout.height = 1_000;
    view.layout.messages = [{ id: "reading", top: 300, height: 300 }, { id: "latest", top: 600, height: 400 }];
    await view.render();
    expect(view.container.scrollTop).toBe(325);
    expect(state()).toEqual(saved);
    await view.render("b");
    view.layout.messages[0].top += 180;
    view.layout.messages[1].top += 180;
    view.layout.height += 180;
    await view.render("a");
    runFrames();
    view.scroll(view.container.scrollTop);
    expect(view.container.scrollTop).toBe(505);
    expect(state()).toEqual(saved);
  });

  test("leaves manual reflow to native anchoring without competing scroll writes", async () => {
    useSessionScrollStore.getState().setManualScroll("a", 325, null, { messageId: "reading", offset: -25 });
    const view = fixture();
    await view.render();
    expect(view.container.style.overflowAnchor).toBe("auto");
    // Model a browser-owned adjustment inside the same message. This verifies
    // controller ownership, not the browser's layout or paragraph anchoring.
    view.layout.messages[1].height += 180;
    view.layout.messages[2].top += 180;
    view.layout.height += 180;
    view.scroll(505);
    view.scrollWrites.length = 0;
    view.resize();
    await view.render();
    runFrames();
    expect(view.scrollWrites).toEqual([]);
    expect(view.container.scrollTop).toBe(505);
    expect(view.container.style.overflowAnchor).toBe("auto");
    view.controls.jumpToLatest("auto");
    runFrames();
    expect(view.container.style.overflowAnchor).toBe("none");
    view.controls.jumpToStartOfMessage("auto");
    expect(view.container.style.overflowAnchor).toBe("auto");
    const detached = view.container;
    await view.unmount();
    expect(detached.style.overflowAnchor).toBe("");
    useSessionScrollStore.getState().setStickyBottom("a", null);
    expect(detached.style.overflowAnchor).toBe("");
  });

  test("ignores cancelled frames and observers on rapid switches and unmount", async () => {
    useSessionScrollStore.getState().setManualScroll("b", 325, null, { messageId: "reading", offset: -25 });
    const view = fixture();
    await view.render();
    const staleFrames = [...frames.values()];
    const oldObserver = observers[0];
    const oldControls = view.controls;
    await view.render("b");
    const saved = state("b");
    for (const callback of staleFrames) callback(now);
    oldObserver();
    oldControls.jumpToLatest();
    expect(view.container.scrollTop).toBe(325);
    expect(state("b")).toEqual(saved);
    await view.render("a", false);
    await view.render("b");
    runFrames();
    expect(view.container.scrollTop).toBe(325);
    const detached = view.container;
    const lastFrames = [...frames.values()];
    await view.unmount();
    for (const callback of lastFrames) callback(now);
    view.resize();
    expect(detached.scrollTop).toBe(325);
    expect(state("b")).toEqual(saved);
  });

  test("real input cancels delayed restoration and keeps recording continued momentum", async () => {
    useSessionScrollStore.getState().setManualScroll("a", 325, null, { messageId: "reading", offset: -25 });
    const view = fixture();
    await view.render("a", false);
    view.wheel(80);
    expect(state()).toMatchObject({ mode: "manual", scrollTop: 325 });
    now += 1_000;
    await view.render();
    runFrames();
    view.resize();
    expect(view.container.scrollTop).toBe(80);
    view.container.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    view.scroll(400);
    expect(state()).toMatchObject({ mode: "manual", scrollTop: 400, anchor: { messageId: "reading", offset: -100 } });
    now += 500;
    view.scroll(420);
    now += 500;
    view.scroll(440);
    expect(state()).toMatchObject({ mode: "manual", scrollTop: 440, anchor: { messageId: "reading", offset: -140 } });
    view.container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1 }));
    now += 1_000;
    view.scroll(500);
    view.resize();
    expect(view.container.scrollTop).toBe(500);
    expect(state()).toMatchObject({ mode: "manual", scrollTop: 500 });
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
  });

  test.each(["pointerup", "pointercancel"])("selection-drag scrolling owns the viewport until %s", async (endEvent) => {
    const view = fixture();
    await view.render();
    const staleFrames = [...frames.values()];
    const message = view.container.querySelector('[data-message-id="latest"]');
    if (!message) throw new Error("Missing selection target");
    message.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1 }));
    now += 1_000;
    view.layout.height += 100;
    view.resize();
    for (const callback of staleFrames) callback(now);
    expect(view.container.scrollTop).toBe(800);
    // Selection extending beyond the viewport generates scroll without a wheel
    // or key event, including while the pointer is outside the transcript.
    view.scroll(350);
    expect(state()).toMatchObject({ mode: "manual", scrollTop: 350 });
    expect(view.container.style.overflowAnchor).toBe("auto");
    window.dispatchEvent(new PointerEvent(endEvent, { pointerId: 2 }));
    now += 1_000;
    view.scroll(375);
    expect(state()).toMatchObject({ mode: "manual", scrollTop: 375 });
    window.dispatchEvent(new PointerEvent(endEvent, { pointerId: 1 }));
    now += 1_000;
    // Once released, a native layout adjustment can update the manual anchor,
    // but reaching the bottom without fresh input must not enable follow.
    view.scroll(view.layout.height - view.layout.viewportHeight);
    expect(state()).toMatchObject({ mode: "manual", scrollTop: 900 });
    view.scrollWrites.length = 0;
    view.resize();
    expect(view.scrollWrites).toEqual([]);
  });

  test.each(["pointerup", "pointercancel"])("non-scrolling clicks resume pending restoration and sticky follow after %s", async (endEvent) => {
    const view = fixture();
    await view.render("a", false);
    // The surface also marks direct viewport presses. They must not leave a
    // permanent loading cancellation when the press never actually scrolls.
    view.container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1 }));
    now += 1_000;
    await view.render();
    expect(view.container.scrollTop).toBe(0);
    window.dispatchEvent(new PointerEvent(endEvent, { pointerId: 1 }));
    runFrames();
    expect(view.container.scrollTop).toBe(800);
    expect(state().mode).toBe("stickyBottom");
    expect(view.container.style.overflowAnchor).toBe("none");
    const message = view.container.querySelector('[data-message-id="latest"]');
    if (!message) throw new Error("Missing click target");
    message.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 2 }));
    view.layout.height += 100;
    view.resize();
    expect(view.container.scrollTop).toBe(800);
    window.dispatchEvent(new PointerEvent(endEvent, { pointerId: 2 }));
    runFrames();
    expect(view.container.scrollTop).toBe(900);
  });

  test("a focus reveal away from the tail becomes the reading position instead of being undone by follow", async () => {
    const view = fixture();
    await view.render();
    runFrames();
    expect(view.container.scrollTop).toBe(800);
    // Live-tail clamping after content shrinks is not a reveal.
    view.layout.height -= 100;
    view.scroll(700);
    expect(state().mode).toBe("stickyBottom");
    view.layout.height += 100;
    view.scroll(800);
    // Keyboard focus (or scrollIntoView) moves an older message into view
    // without a wheel, key or pointer gesture.
    view.scroll(325);
    expect(state()).toMatchObject({ mode: "manual", scrollTop: 325, anchor: { messageId: "reading", offset: -25 } });
    expect(view.container.style.overflowAnchor).toBe("auto");
    const message = view.container.querySelector('[data-message-id="reading"]');
    if (!message) throw new Error("Missing click target");
    message.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    runFrames();
    expect(view.container.scrollTop).toBe(325);
    view.scrollWrites.length = 0;
    view.layout.height += 100;
    view.resize();
    runFrames();
    expect(view.scrollWrites).toEqual([]);
    expect(view.container.scrollTop).toBe(325);
  });

  test("uses legacy pixels or a missing anchor once without persisting clamps or locking manual mode", async () => {
    for (const anchor of [undefined, { messageId: "evicted", offset: -25 }]) {
      useSessionScrollStore.getState().setManualScroll("a", 900, null, anchor);
      const view = fixture();
      await view.render();
      view.scroll(view.container.scrollTop);
      expect(view.container.scrollTop).toBe(800);
      expect(state()).toMatchObject({ mode: "manual", scrollTop: 900 });
      view.layout.height = 1_200;
      await view.render();
      runFrames();
      expect(view.container.scrollTop).toBe(800);
      expect(state()).toMatchObject({ mode: "manual", scrollTop: 900 });
      view.wheel(150);
      expect(state()).toMatchObject({ mode: "manual", scrollTop: 150 });
      await view.unmount();
    }
  });

  test("keeps sticky streaming and jump controls, but never steals a wheel gesture", async () => {
    const view = fixture();
    await view.render();
    runFrames();
    expect(view.container.scrollTop).toBe(800);
    expect(state()).toMatchObject({ mode: "stickyBottom", topClippedMessageId: "latest" });
    view.layout.height += 100;
    view.resize();
    const stickyFrames = [...frames.values()];
    view.wheel(350);
    for (const callback of stickyFrames) callback(now);
    expect(view.container.scrollTop).toBe(350);
    expect(state()).toMatchObject({ mode: "manual", anchor: { messageId: "reading", offset: -50 } });
    now += 1_000;
    view.layout.height += 100;
    view.resize();
    expect(view.container.scrollTop).toBe(350);
    view.controls.jumpToLatest("auto");
    runFrames();
    expect(view.container.scrollTop).toBe(1_000);
    expect(state().mode).toBe("stickyBottom");
    view.controls.jumpToStartOfMessage("auto");
    expect(view.container.scrollTop).toBe(600);
    expect(state()).toMatchObject({ mode: "manual", anchor: { messageId: "latest", offset: 0 } });
  });

  test("nested scrolling does not cancel restoration or change the session's position", async () => {
    useSessionScrollStore.getState().setManualScroll("a", 325, null);
    const view = fixture();
    await view.render("a", false);
    const nested = view.container.querySelector("[data-scrollable]");
    if (!nested) throw new Error("Missing nested scroll area");
    nested.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    nested.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1 }));
    const message = view.container.querySelector('[data-message-id="reading"]');
    if (!message) throw new Error("Missing pointer target");
    message.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: false, pointerId: 2 }));
    message.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 2, isPrimary: true, pointerId: 3 }));
    await view.render();
    expect(view.container.scrollTop).toBe(325);
    expect(state()).toMatchObject({ mode: "manual", scrollTop: 325 });
  });
});

describe("scroll persistence", () => {
  test("hydrates legacy pixels, legacy geometry and owner-keyed positions after geometry eviction", () => {
    const geometry = { owner: "owner-a", scrollHeight: 1000, viewportWidth: 500, before: 0, after: 0, messageIds: ["reading"] };
    localStorage.setItem(storageKey, JSON.stringify({
      pixels: { mode: "manual", scrollTop: 125 },
      legacy: { mode: "manual", scrollTop: 325, anchor: { messageId: "reading", offset: -25 }, geometry },
      [sessionScrollKey("a", "owner-a")]: { mode: "manual", scrollTop: 450, owner: "owner-a", anchor: { messageId: "reading", offset: -150 } },
    }));
    useSessionScrollStore.setState({ sessions: readPersistedSessionScrollState() });
    const store = useSessionScrollStore.getState();
    expect(store.sessions.pixels).toMatchObject({ mode: "manual", scrollTop: 125 });
    expect(store.sessions.legacy).toMatchObject({ mode: "manual", owner: "owner-a", geometry });
    store.claimOwner("legacy", "owner-b");
    expect(state("legacy", "owner-b").mode).toBe("stickyBottom");
    store.claimOwner("legacy", "owner-a");
    expect(state("legacy", "owner-a")).toMatchObject({ mode: "manual", scrollTop: 325, anchor: { messageId: "reading", offset: -25 } });
    expect(state("a", "owner-a")).toMatchObject({ mode: "manual", scrollTop: 450, owner: "owner-a" });
    expect(state("a", "owner-b").mode).toBe("stickyBottom");
    flushSessionScrollState();
  });

  test.each([undefined, { messageId: "reading", offset: -25 }])("claims a geometry-free legacy position once without losing its pixels or anchor (%j)", (anchor) => {
    const store = useSessionScrollStore.getState();
    store.setManualScroll("a", 325, null, anchor);
    const saved = state();
    expect(state("a", "owner-a")).toEqual(saved);
    store.claimOwner("a", "owner-a");
    store.claimOwner("a", "owner-b");
    expect(state("a", "owner-a")).toEqual({ ...saved, owner: "owner-a" });
    expect(state("a", "owner-b").mode).toBe("stickyBottom");
    expect(useSessionScrollStore.getState().sessions.a).toBeUndefined();
    flushSessionScrollState();
    const persisted = JSON.parse(localStorage.getItem(storageKey)!);
    expect(persisted[sessionScrollKey("a", "owner-a")]).toEqual({ mode: "manual", scrollTop: 325, owner: "owner-a", ...(anchor ? { anchor } : {}) });
    expect(persisted.a).toBeUndefined();
  });

  test("legacy geometry can only migrate to its recorded owner and cannot overwrite a newer position", () => {
    const store = useSessionScrollStore.getState();
    store.setManualScroll("a", 325, null, { messageId: "reading", offset: -25 });
    store.setGeometry("a", { owner: "owner-a", scrollHeight: 1000, viewportWidth: 500, before: 0, after: 0, messageIds: ["reading"] });
    expect(state("a", "owner-b").mode).toBe("stickyBottom");
    store.claimOwner("a", "owner-b");
    expect(useSessionScrollStore.getState().sessions.a).toBeDefined();
    store.setManualScroll(sessionScrollKey("a", "owner-a"), 100, null);
    store.claimOwner("a", "owner-a");
    expect(state("a", "owner-a")).toMatchObject({ mode: "manual", scrollTop: 100 });
    expect(useSessionScrollStore.getState().sessions.a).toBeUndefined();
  });

  test("geometry eviction retains position ownership across persistence and cannot leak to another owner", () => {
    const store = useSessionScrollStore.getState();
    const key = sessionScrollKey("a", "owner-a");
    store.setManualScroll(key, 325, null, { messageId: "reading", offset: -25 });
    for (let index = 0; index < 65; index++) {
      const owner = index === 0 ? "owner-a" : `owner-${index}`;
      store.setGeometry(sessionScrollKey("a", owner), { owner, scrollHeight: 1000, viewportWidth: 500, before: 0, after: 0, messageIds: ["reading"] });
    }
    expect(Object.values(useSessionScrollStore.getState().sessions).filter((entry) => entry.geometry)).toHaveLength(64);
    expect(state("a", "owner-a").geometry).toBeUndefined();
    expect(state("a", "owner-a")).toMatchObject({ mode: "manual", scrollTop: 325, anchor: { messageId: "reading", offset: -25 } });
    expect(state("a", "new-owner").mode).toBe("stickyBottom");
    flushSessionScrollState();
    expect(JSON.parse(localStorage.getItem(storageKey)!)[key]).toEqual({ mode: "manual", scrollTop: 325, owner: "owner-a", anchor: { messageId: "reading", offset: -25 } });
  });

  test("evicting unclaimed legacy geometry does not make its position ownerless", () => {
    const store = useSessionScrollStore.getState();
    store.setManualScroll("a", 325, null);
    store.setGeometry("a", { owner: "owner-a", scrollHeight: 1000, viewportWidth: 500, before: 0, after: 0, messageIds: ["reading"] });
    for (let index = 0; index < 64; index++) {
      const owner = `other-${index}`;
      store.setGeometry(sessionScrollKey("a", owner), { owner, scrollHeight: 1000, viewportWidth: 500, before: 0, after: 0, messageIds: ["reading"] });
    }
    expect(state().geometry).toBeUndefined();
    store.claimOwner("a", "owner-b");
    expect(state("a", "owner-b").mode).toBe("stickyBottom");
    store.claimOwner("a", "owner-a");
    expect(state("a", "owner-a")).toMatchObject({ mode: "manual", scrollTop: 325, owner: "owner-a" });
  });

  test("coalesces hot scroll writes, keeps memory immediate and does not persist clipped-message controls", () => {
    const writes = observeStorageWrites();
    const store = useSessionScrollStore.getState();
    for (let top = 0; top < 100; top++) store.setManualScroll("a", top, null, { messageId: "reading", offset: -top });
    expect(state()).toMatchObject({ scrollTop: 99, anchor: { offset: -99 } });
    expect(writes).not.toHaveBeenCalled();
    jest.advanceTimersByTime(249);
    expect(writes).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
      a: { mode: "manual", scrollTop: 99, anchor: { messageId: "reading", offset: -99 } },
    });
    store.setTopClippedMessageId("a", "latest");
    jest.advanceTimersByTime(500);
    expect(state().topClippedMessageId).toBe("latest");
    expect(writes).toHaveBeenCalledTimes(1);
  });

  test("flushes current memory on session switch, visibility loss, pagehide and unmount", async () => {
    const view = fixture();
    await view.render();
    const writes = observeStorageWrites();
    view.wheel(325);
    await view.render("b");
    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ a: { mode: "manual", scrollTop: 325 } });
    view.wheel(200);
    window.dispatchEvent(new Event("pagehide"));
    expect(writes).toHaveBeenCalledTimes(2);
    view.wheel(250);
    const visibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    if (visibilityState) Object.defineProperty(document, "visibilityState", visibilityState);
    else Reflect.deleteProperty(document, "visibilityState");
    expect(writes).toHaveBeenCalledTimes(3);
    view.wheel(300);
    await view.unmount();
    expect(writes).toHaveBeenCalledTimes(4);
    jest.advanceTimersByTime(1_000);
    expect(writes).toHaveBeenCalledTimes(4);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ b: { mode: "manual", scrollTop: 300 } });
  });
});
