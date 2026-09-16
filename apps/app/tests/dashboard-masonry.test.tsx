import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DashboardMasonry } from "../src/react-app/domains/dashboard/dashboard-masonry";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());

function masonryFixture() {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const previousObserver = globalThis.ResizeObserver;
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const heights = new Map([["short", 40.25], ["tall", 240.75]]);
  const observers: MockResizeObserver[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const requestFrame = spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  const cancelFrame = spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  class MockResizeObserver {
    target: Element | null = null;
    notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => {
        if (!this.target) return;
        const id = this.target.querySelector("[data-masonry-child]")?.getAttribute("data-masonry-child");
        const height = heights.get(id ?? "") ?? 0;
        callback([{
          target: this.target,
          contentRect: new DOMRect(0, 0, 320, height),
          borderBoxSize: [{ blockSize: height, inlineSize: 320 }],
          contentBoxSize: [{ blockSize: height, inlineSize: 320 }],
          devicePixelContentBoxSize: [],
        }], this);
      };
      observers.push(this);
    }
    observe = mock((target: Element) => { this.target = target; });
    unobserve() {}
    disconnect = mock(() => {});
  }
  Reflect.set(globalThis, "ResizeObserver", MockResizeObserver);
  const geometrySpy = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const id = this.querySelector("[data-masonry-child]")?.getAttribute("data-masonry-child");
    return new DOMRect(0, 0, 320, heights.get(id ?? "") ?? 0);
  });
  const render = async (ids: string[]) => {
    await act(async () => root.render(<DashboardMasonry>
      {ids.map(id => <input key={id} data-masonry-child={id} defaultValue={id} />)}
    </DashboardMasonry>));
  };
  const child = (id: string) => {
    const node = container.querySelector<HTMLInputElement>(`[data-masonry-child="${id}"]`);
    if (!node) throw new Error(`Missing child ${id}`);
    return node;
  };
  const item = (id: string) => {
    const node = child(id).parentElement;
    if (!node?.hasAttribute("data-dashboard-masonry-item")) throw new Error(`Missing item ${id}`);
    return node;
  };
  const observer = (id: string) => {
    const found = observers.find(observer => observer.target === item(id));
    if (!found) throw new Error(`Missing observer ${id}`);
    return found;
  };
  return {
    container, heights, observers, render, child, item, observer, frames, requestFrame, geometrySpy,
    async flush() {
      await act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      });
    },
    async dispose() {
      try {
        await act(async () => root.unmount());
        for (const observer of observers) expect(observer.disconnect).toHaveBeenCalledTimes(1);
      } finally {
        geometrySpy.mockRestore();
        requestFrame.mockRestore();
        cancelFrame.mockRestore();
        Reflect.set(globalThis, "ResizeObserver", previousObserver);
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
        container.remove();
      }
    },
  };
}

describe("Dashboard masonry mocked DOM measurements (not real geometry proof)", () => {
  test("rounds natural fractional heights to bounded 8px tracks with a gap and updates each item on resize", async () => {
    const host = masonryFixture();
    try {
      await host.render(["short", "tall"]);
      expect(host.container.querySelector<HTMLElement>("[data-dashboard-masonry]")?.style.gridAutoRows).toBe("8px");
      expect(host.item("short").style.gridRowEnd).toBe("span 7");
      expect(host.item("tall").style.gridRowEnd).toBe("span 32");
      expect(host.observers).toHaveLength(2);
      for (const id of ["short", "tall"]) {
        expect(host.observer(id).observe).toHaveBeenCalledTimes(1);
        expect(host.observer(id).observe).toHaveBeenCalledWith(host.item(id));
      }
      const short = host.item("short");
      for (const [height, span] of [[160.01, 22], [80, 11], [0.25, 2], [0, 1], [800, 101]]) {
        host.heights.set("short", height);
        await act(async () => host.observer("short").notify());
        await host.flush();
        expect(host.item("short")).toBe(short);
        expect(short.style.gridRowEnd).toBe(`span ${span}`);
        expect(host.item("tall").style.gridRowEnd).toBe("span 32");
      }
      host.heights.set("tall", 400.5);
      await act(async () => host.observer("tall").notify());
      await host.flush();
      expect(host.item("tall").style.gridRowEnd).toBe("span 52");
    } finally { await host.dispose(); }
  });

  test("uses observer sizes without layout reads, skips unchanged tracks and coalesces bursts", async () => {
    const host = masonryFixture();
    try {
      await host.render(["short"]);
      const item = host.item("short");
      expect(item.style.gridRowEnd).toBe("span 7");
      expect(host.requestFrame).not.toHaveBeenCalled();
      host.geometrySpy.mockClear();
      host.observer("short").notify();
      host.heights.set("short", 41);
      host.observer("short").notify();
      expect(host.requestFrame).not.toHaveBeenCalled();
      expect(host.geometrySpy).not.toHaveBeenCalled();
      host.heights.set("short", 80);
      host.observer("short").notify();
      host.heights.set("short", 120);
      host.observer("short").notify();
      expect(host.requestFrame).toHaveBeenCalledTimes(1);
      expect(item.style.gridRowEnd).toBe("span 7");
      await host.flush();
      expect(host.item("short")).toBe(item);
      expect(item.style.gridRowEnd).toBe("span 16");
      expect(host.geometrySpy).not.toHaveBeenCalled();
      host.heights.set("short", 160);
      host.observer("short").notify();
      await host.render([]);
      expect(host.frames.size).toBe(0);
      await host.flush();
      expect(item.isConnected).toBe(false);
    } finally { await host.dispose(); }
  });

  test("retains keyed child DOM and observers on reorder, then disconnects removed and unmounted items", async () => {
    const host = masonryFixture();
    try {
      await host.render(["short", "tall"]);
      const short = host.child("short");
      const tall = host.child("tall");
      const shortItem = host.item("short");
      const tallItem = host.item("tall");
      const shortObserver = host.observer("short");
      const tallObserver = host.observer("tall");
      short.value = "Retained app state";
      await host.render(["tall", "short"]);
      expect(Array.from(host.container.querySelectorAll("[data-masonry-child]"))).toEqual([tall, short]);
      expect(host.child("short")).toBe(short);
      expect(host.child("tall")).toBe(tall);
      expect(host.item("short")).toBe(shortItem);
      expect(host.item("tall")).toBe(tallItem);
      expect(short.value).toBe("Retained app state");
      expect(host.observers).toHaveLength(2);
      expect(shortObserver.disconnect).not.toHaveBeenCalled();
      expect(tallObserver.disconnect).not.toHaveBeenCalled();
      expect(shortItem.style.gridRowEnd).toBe("span 7");
      expect(tallItem.style.gridRowEnd).toBe("span 32");
      await host.render(["short"]);
      expect(host.child("short")).toBe(short);
      expect(tall.isConnected).toBe(false);
      expect(tallObserver.disconnect).toHaveBeenCalledTimes(1);
      expect(shortObserver.disconnect).not.toHaveBeenCalled();
    } finally { await host.dispose(); }
  });
});
