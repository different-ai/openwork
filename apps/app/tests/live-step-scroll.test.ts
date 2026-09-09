import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";

import {
  isLiveStepAtBottom,
  pinnedAfterUserScroll,
  pinnedAfterWheel,
  shouldFollowLiveStepGrowth,
} from "../src/components/chat/live-step-scroll";
import { useSessionScrollController } from "../src/react-app/domains/session/surface/scroll-controller";
import { useSessionScrollStore } from "../src/react-app/domains/session/surface/scroll-store";

describe("live step scroll", () => {
  test("follows streaming growth only while the user is pinned to the tail", () => {
    expect(shouldFollowLiveStepGrowth({ isLive: true, pinned: true })).toBe(true);
    expect(shouldFollowLiveStepGrowth({ isLive: true, pinned: false })).toBe(false);
    expect(shouldFollowLiveStepGrowth({ isLive: false, pinned: true })).toBe(false);
  });

  test("a wheel-up gesture unpins even when the list is still at the bottom", () => {
    expect(pinnedAfterWheel({ deltaY: -12, pinned: true, atBottom: true })).toBe(false);
    expect(pinnedAfterUserScroll(false)).toBe(false);
    expect(pinnedAfterUserScroll(true)).toBe(true);
  });

  test("treats a small tail gap as still at the bottom", () => {
    expect(isLiveStepAtBottom({ scrollHeight: 800, scrollTop: 284, clientHeight: 520 })).toBe(true);
    expect(isLiveStepAtBottom({ scrollHeight: 800, scrollTop: 100, clientHeight: 520 })).toBe(false);
  });
});

describe("submitted message reveal", () => {
  type Row = { id: string; top: number; height: number };
  const history: Row[] = [{ id: "history", top: 0, height: 2000 }];
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let contentHeight: number;
  let resize: () => void;
  let render: (sessionId: string, submittedMessageId: string | null, rows: Row[]) => Promise<void>;
  let flushFrames: () => Promise<void>;
  let originalResizeObserver: typeof ResizeObserver;

  beforeEach(() => {
    GlobalRegistrator.register({ url: "http://localhost/" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    useSessionScrollStore.setState({ sessions: {} });
    contentHeight = 2000;
    resize = () => {};
    originalResizeObserver = globalThis.ResizeObserver;
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class implements ResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          resize = () => callback([], this);
        }
        observe() {}
        unobserve() {}
        disconnect() { resize = () => {}; }
      },
    });
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    flushFrames = async () => {
      await act(async () => {
        for (let frame = 0; frame < 5 && frames.size; frame += 1) {
          const pending = [...frames.values()];
          frames.clear();
          for (const callback of pending) callback(frame * 16);
        }
      });
      expect(frames.size).toBe(0);
    };

    const containerRef = createRef<HTMLDivElement>();
    const contentRef = createRef<HTMLDivElement>();
    let scrollTop = 0;
    function Harness(props: { sessionId: string; submittedMessageId: string | null; rows: Row[] }) {
      const controller = useSessionScrollController({
        selectedSessionId: props.sessionId,
        submittedMessageId: props.submittedMessageId,
        renderedMessages: props.rows,
        containerRef,
        contentRef,
      });
      return createElement("div", {
        ref: (node: HTMLDivElement | null) => {
          containerRef.current = node;
          if (!node) return;
          container = node;
          // happy-dom has no layout or native scroll clamping.
          Object.defineProperties(node, {
            clientHeight: { configurable: true, get: () => 500 },
            scrollHeight: { configurable: true, get: () => contentHeight },
            scrollTop: {
              configurable: true,
              get: () => scrollTop,
              set: (value: number) => { scrollTop = Math.max(0, Math.min(value, contentHeight - 500)); },
            },
          });
          node.getBoundingClientRect = () => new DOMRect(0, 100, 800, 500);
        },
        onScroll: controller.handleScroll,
        onWheel: (event) => controller.markScrollGesture(event.target),
      }, createElement("div", {
        ref: (node: HTMLDivElement | null) => {
          contentRef.current = node;
          if (node) Object.defineProperty(node, "offsetHeight", { configurable: true, get: () => contentHeight });
        },
      }, props.rows.map((row) => createElement("div", {
        key: row.id,
        "data-message-id": row.id,
        ref: (node: HTMLDivElement | null) => {
          if (node) node.getBoundingClientRect = () => new DOMRect(0, 100 + row.top - scrollTop, 800, row.height);
        },
      }, row.id))));
    }
    root = createRoot(document.createElement("div"));
    render = async (sessionId, submittedMessageId, rows) => {
      await act(async () => { root.render(createElement(Harness, { sessionId, submittedMessageId, rows })); });
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    mock.restore();
    useSessionScrollStore.setState({ sessions: {} });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: originalResizeObserver });
    await GlobalRegistrator.unregister();
  });

  async function browse(top: number) {
    await act(async () => {
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      container.scrollTop = top;
      container.dispatchEvent(new Event("scroll"));
    });
  }

  test("waits for the submitted row, overrides a recent browse gesture, and does not repeat on passive updates", async () => {
    await render("session-a", null, history);
    await flushFrames();
    await browse(200);
    expect(useSessionScrollStore.getState().sessions["session-a"]).toMatchObject({ mode: "manual", scrollTop: 200 });

    await render("session-a", "submitted", history);
    expect(container.scrollTop).toBe(200);
    contentHeight = 2100;
    const rows = [...history, { id: "submitted", top: 2000, height: 100 }];
    await render("session-a", "submitted", rows);
    expect(container.scrollTop).toBe(1600);
    expect(useSessionScrollStore.getState().sessions["session-a"]).toMatchObject({ mode: "stickyBottom" });

    // Growth immediately after sending follows the tail despite the prior gesture.
    contentHeight = 2200;
    await act(async () => resize());
    await flushFrames();
    expect(container.scrollTop).toBe(1700);
    await browse(300);
    contentHeight = 2300;
    await render("session-a", "submitted", [...rows, { id: "assistant", top: 2100, height: 200 }]);
    await act(async () => resize());
    await flushFrames();
    expect(container.scrollTop).toBe(300);
    expect(useSessionScrollStore.getState().sessions["session-a"]).toMatchObject({ mode: "manual", scrollTop: 300 });
  });

  test("a pending reveal does not move the other session after navigation", async () => {
    useSessionScrollStore.getState().setManualScroll("session-b", 400, null);
    await render("session-a", null, history);
    await flushFrames();
    await browse(200);
    await render("session-a", "submitted-a", history);

    // SessionSurface clears the submitted ID when its owner is not selected.
    await render("session-b", null, history);
    await flushFrames();
    expect(container.scrollTop).toBe(400);
    contentHeight = 2100;
    await render("session-b", null, [...history, { id: "message-b", top: 2000, height: 100 }]);
    await act(async () => resize());
    await flushFrames();
    expect(container.scrollTop).toBe(400);
    expect(useSessionScrollStore.getState().sessions["session-a"]).toMatchObject({ mode: "manual", scrollTop: 200 });
    expect(useSessionScrollStore.getState().sessions["session-b"]).toMatchObject({ mode: "manual", scrollTop: 400 });
  });

  test("reveals the start rather than the tail of an oversized submitted prompt", async () => {
    await render("session-a", null, history);
    await flushFrames();
    await browse(200);
    contentHeight = 2800;
    const rows = [...history, { id: "submitted", top: 2000, height: 800 }];
    await render("session-a", "submitted", rows);
    await flushFrames();
    expect(container.scrollTop).toBe(2000);
    expect(container.querySelector('[data-message-id="submitted"]')?.getBoundingClientRect().top)
      .toBe(container.getBoundingClientRect().top);
    expect(useSessionScrollStore.getState().sessions["session-a"])
      .toEqual({ mode: "manual", scrollTop: 2000, topClippedMessageId: null });
    contentHeight = 2900;
    await render("session-a", "submitted", [...rows]);
    await act(async () => resize());
    await flushFrames();
    expect(container.scrollTop).toBe(2000);
  });

  test("session restoration does not overwrite a newly revealed prompt on the next frame", async () => {
    useSessionScrollStore.getState().setManualScroll("session-a", 200, null);
    await render("session-a", null, history);
    // Send before restoration's second (animation-frame) pass has executed.
    contentHeight = 2800;
    await render("session-a", "submitted", [...history, { id: "submitted", top: 2000, height: 800 }]);
    expect(container.scrollTop).toBe(2000);
    await flushFrames();
    expect(container.scrollTop).toBe(2000);
    expect(useSessionScrollStore.getState().sessions["session-a"])
      .toEqual({ mode: "manual", scrollTop: 2000, topClippedMessageId: null });
  });
});
