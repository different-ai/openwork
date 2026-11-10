/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const desktopFeatures = await import("../src/react-app/domains/session/status/use-desktop-feature");
const den = await import("../src/app/lib/den");
const { SessionFindBar } = await import("../src/react-app/domains/session/surface/find-bar");
const { useSessionFindStore } = await import("../src/react-app/domains/session/surface/find-store");
const { SESSION_SCROLL_NAVIGATION_EVENT } = await import("../src/react-app/domains/session/surface/scroll-controller");
let latestFirst = false;
let root: Root | null = null;
let host: HTMLDivElement;
let container: HTMLDivElement;
let scrollRef: RefObject<HTMLDivElement | null>;
const jumps: HTMLElement[] = [];
const usages: string[] = [];
let beforeJumps = 0;

beforeEach(() => {
  latestFirst = false;
  jumps.length = 0;
  usages.length = 0;
  beforeJumps = 0;
  spyOn(desktopFeatures, "useDesktopFeature").mockImplementation((key) => key === "conversationFindLatestFirst" && latestFirst);
  spyOn(den, "markFeatureUsed").mockImplementation((key) => { usages.push(key); });
  spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) { jumps.push(this); });
  useSessionFindStore.setState({ open: true, sessionId: "session-find", query: "needle", appliedQuery: "needle", focusNonce: 0 });
  host = document.createElement("div");
  container = document.createElement("div");
  container.setAttribute("data-scrollable", "true");
  document.body.append(host, container);
  scrollRef = { current: container };
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  container.remove();
  useSessionFindStore.getState().closeFind();
  mock.restore();
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function settle(ms = 180) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
}

async function render(historyComplete = true, sessionId = "session-find") {
  await act(async () => root?.render(<SessionFindBar sessionId={sessionId} scrollRef={scrollRef} historyComplete={historyComplete} onBeforeJump={() => { beforeJumps++; }} />));
}

function mark(label: string, prepend = false) {
  const element = document.createElement("mark");
  element.setAttribute("data-search-highlight", "true");
  element.textContent = label;
  if (prepend) container.prepend(element);
  else container.append(element);
  return element;
}

function active() { return container.querySelector('[data-search-highlight-active="true"]'); }
function counter() { return host.querySelector('[aria-live="polite"]')?.textContent; }
async function enter(shiftKey = false) {
  await act(async () => host.querySelector("input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true, cancelable: true })));
}
async function click(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}

test("turning the flag off retains the current match and immediately restores keyboard direction", async () => {
  latestFirst = true;
  const first = mark("first needle");
  const middle = mark("middle needle");
  const last = mark("last needle");
  await render();
  await settle();
  expect(active()).toBe(last);
  latestFirst = false;
  await render();
  await settle();
  expect(active()).toBe(last);
  expect(jumps).toHaveLength(1);
  await enter();
  expect(active()).toBe(first);
  await enter();
  expect(active()).toBe(middle);
  expect(usages).toEqual(["conversationFindLatestFirst"]);
});

for (const enabled of [false, true]) {
  describe(enabled ? "latest-first on" : "latest-first off", () => {
    beforeEach(() => { latestFirst = enabled; });

    test("starts at the expected end, traverses, wraps and keeps arrows spatial", async () => {
      const first = mark("oldest needle");
      const middle = mark("middle needle");
      const last = mark("newest needle");
      await render();
      await settle();
      expect(active()).toBe(enabled ? last : first);
      expect(counter()).toBe(enabled ? "3/3" : "1/3");
      expect(jumps).toEqual([enabled ? last : first]);
      expect(usages).toEqual(enabled ? ["conversationFindLatestFirst"] : []);
      await enter();
      expect(active()).toBe(middle);
      await enter();
      expect(active()).toBe(enabled ? first : last);
      await enter();
      expect(active()).toBe(enabled ? last : first);
      await enter(true);
      expect(active()).toBe(enabled ? first : last);
      await click("Previous match");
      expect(active()).toBe(enabled ? last : middle);
      await click("Next match");
      expect(active()).toBe(enabled ? first : last);
      expect(beforeJumps).toBe(jumps.length);
    });

    test("no matches disables navigation and does not record use", async () => {
      await render();
      await settle();
      expect(counter()).toBe("No matches");
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')?.disabled).toBe(true);
      await enter();
      expect(jumps).toHaveLength(0);
      expect(usages).toHaveLength(0);
    });

    test("one match wraps to itself", async () => {
      const only = mark("only needle");
      await render();
      await settle();
      await enter();
      await enter(true);
      expect(active()).toBe(only);
      expect(counter()).toBe("1/1");
      expect(jumps).toEqual([only, only, only]);
    });

    test("reopening and editing a query select the initial end again", async () => {
      const first = mark("first needle");
      const last = mark("last needle");
      await render();
      await settle();
      await enter();
      await act(async () => useSessionFindStore.getState().openFind({ sessionId: "session-find" }));
      await settle();
      expect(active()).toBe(enabled ? last : first);
      await act(async () => useSessionFindStore.getState().setQuery("different"));
      container.replaceChildren();
      await settle(180);
      const nextFirst = mark("different first");
      const nextLast = mark("different last");
      await settle();
      expect(active()).toBe(enabled ? nextLast : nextFirst);
      expect(jumps.at(-1)).toBe(enabled ? nextLast : nextFirst);
    });

    test("delayed marks jump once; prepended history retains the selected element", async () => {
      await render(false);
      await settle();
      expect(counter()).toBe("Searching...");
      const first = mark("first needle");
      const last = mark("last needle");
      await settle();
      expect(active()).toBe(enabled ? last : first);
      expect(jumps).toHaveLength(1);
      mark("earlier needle", true);
      await render(true);
      await settle();
      expect(active()).toBe(enabled ? last : first);
      expect(counter()).toBe(enabled ? "3/3" : "2/3");
      expect(jumps).toHaveLength(1);
    });

    for (const event of ["wheel", "touchmove", "pointerdown", SESSION_SCROLL_NAVIGATION_EVENT]) {
      test(`deliberate ${event} cancels a pending delayed jump`, async () => {
        await render(false);
        await act(async () => container.dispatchEvent(new Event(event, { bubbles: true })));
        mark("first needle");
        mark("last needle");
        await settle();
        expect(jumps).toHaveLength(0);
        expect(usages).toHaveLength(0);
      });
    }

    test("keyboard scrolling cancels delayed selection, while nested scrolling does not", async () => {
      await render(false);
      await act(async () => container.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })));
      mark("first needle");
      mark("last needle");
      await settle();
      expect(jumps).toHaveLength(0);
      await act(async () => useSessionFindStore.getState().openFind({ sessionId: "session-find" }));
      const nested = document.createElement("div");
      nested.setAttribute("data-scrollable", "true");
      container.append(nested);
      await act(async () => nested.dispatchEvent(new Event("wheel", { bubbles: true })));
      await settle();
      expect(jumps).toHaveLength(1);
    });

    test("history and streaming do not auto-jump after explicit match navigation", async () => {
      const first = mark("first needle");
      const middle = mark("middle needle");
      const last = mark("last needle");
      await render(false);
      await settle();
      await enter();
      expect(active()).toBe(middle);
      mark("earlier needle", true);
      mark("streamed needle");
      await render(true);
      await settle();
      expect(active()).toBe(middle);
      expect(jumps).toEqual([enabled ? last : first, middle]);
      expect(counter()).toBe("3/5");
    });

    test("short or empty queries never jump", async () => {
      mark("needle");
      useSessionFindStore.setState({ query: "n", appliedQuery: "n" });
      await render();
      await settle();
      expect(counter()).toBe("");
      expect(jumps).toHaveLength(0);
      await act(async () => useSessionFindStore.getState().setQuery(""));
      await settle(230);
      expect(counter()).toBe("");
      expect(jumps).toHaveLength(0);
      expect(usages).toHaveLength(0);
    });

    test("raw query edits cancel stale marks before their debounce", async () => {
      mark("stale first");
      mark("stale last");
      await render();
      await act(async () => useSessionFindStore.getState().setQuery("replacement"));
      await settle(80);
      expect(jumps).toHaveLength(0);
      container.replaceChildren();
      await settle(120);
      const replacement = mark("replacement");
      await settle();
      expect(jumps).toEqual([replacement]);
    });

    test("closing or switching sessions cancels a delayed jump", async () => {
      await render(false);
      await act(async () => useSessionFindStore.getState().closeFind());
      mark("late needle");
      await settle();
      expect(jumps).toHaveLength(0);
      await act(async () => useSessionFindStore.getState().openFind({ sessionId: "another-session" }));
      await settle();
      expect(host.textContent).toBe("");
      expect(jumps).toHaveLength(0);
    });
  });
}
