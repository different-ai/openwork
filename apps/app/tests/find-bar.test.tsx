/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SessionFindBar } from "../src/react-app/domains/session/surface/find-bar";
import { useSessionFindStore } from "../src/react-app/domains/session/surface/find-store";
import { SESSION_SCROLL_NAVIGATION_EVENT } from "../src/react-app/domains/session/surface/scroll-controller";
import { TooltipProvider } from "../src/components/ui/tooltip";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  useSessionFindStore.setState({ open: false, sessionId: null, query: "", appliedQuery: "", target: null, focusNonce: 0 });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function collect() {
  // Exercise the real mutation observer and the bounded collection debounce.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
}

async function fixture(query = "needle") {
  const host = document.createElement("div");
  const container = document.createElement("div");
  document.body.append(host, container);
  const root = createRoot(host);
  const beforeJump = mock(() => {});
  const scrollRef = { current: container };
  const render = async (historyComplete = false) => {
    await act(async () => root.render(<TooltipProvider>
      <SessionFindBar sessionId="a" scrollRef={scrollRef} historyComplete={historyComplete} onBeforeJump={() => beforeJump()} />
    </TooltipProvider>));
  };
  const addMatch = (text = "needle") => {
    const message = document.createElement("div");
    message.dataset.messageId = text;
    const mark = document.createElement("mark");
    mark.dataset.searchHighlight = "true";
    mark.textContent = text;
    const scroll = mock(() => {});
    mark.scrollIntoView = scroll;
    message.append(mark);
    container.append(message);
    return { mark, scroll };
  };
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
    container.remove();
  });
  useSessionFindStore.getState().openFind({ sessionId: "a", query });
  await render();
  await collect();
  return { host, container, render, addMatch, beforeJump };
}

describe("Find during history loading", () => {
  test.each([
    { initial: "", cancel: true },
    { initial: "needle", cancel: true },
    { initial: "", cancel: false },
    { initial: "needle", cancel: false },
  ])("raw-query debounce preserves cancellation and explicit match navigation (%j)", async ({ initial, cancel }) => {
    const view = await fixture(initial);
    await act(async () => {
      useSessionFindStore.getState().setQuery("different");
      // Input can follow the raw store update before React commits it, and
      // certainly before the 150ms timer applies the query.
      if (cancel) view.container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    });
    expect(useSessionFindStore.getState().appliedQuery).toBe(initial);
    await collect();
    expect(useSessionFindStore.getState().appliedQuery).toBe("different");
    const first = view.addMatch("different first");
    const second = view.addMatch("different second");
    await view.render(true);
    await collect();
    expect(view.host.textContent).toContain("1/2");
    expect(first.scroll).toHaveBeenCalledTimes(cancel ? 0 : 1);
    expect(second.scroll).not.toHaveBeenCalled();
    const next = view.host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]');
    const previous = view.host.querySelector<HTMLButtonElement>('button[aria-label="Previous match"]');
    if (!next || !previous) throw new Error("Missing Find navigation buttons");
    await act(async () => next.click());
    expect(view.host.textContent).toContain("2/2");
    expect(second.scroll).toHaveBeenCalledTimes(1);
    await act(async () => previous.click());
    expect(view.host.textContent).toContain("1/2");
    expect(first.scroll).toHaveBeenCalledTimes(cancel ? 1 : 2);
    view.addMatch("different streamed");
    await collect();
    expect(view.beforeJump).toHaveBeenCalledTimes(cancel ? 2 : 3);
  });

  test("navigates to the first late match once, not on later streaming mutations or rerenders", async () => {
    const view = await fixture();
    expect(view.host.textContent).toContain("Searching...");
    expect(view.beforeJump).not.toHaveBeenCalled();
    const first = view.addMatch();
    await view.render(true);
    await collect();
    expect(view.host.textContent).toContain("1/1");
    expect(first.mark.dataset.searchHighlightActive).toBe("true");
    expect(first.scroll).toHaveBeenCalledTimes(1);
    const second = view.addMatch("needle streamed");
    await view.render(true);
    await collect();
    expect(view.host.textContent).toContain("1/2");
    expect(view.beforeJump).toHaveBeenCalledTimes(1);
    expect(second.scroll).not.toHaveBeenCalled();
    const next = view.host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]');
    if (!next) throw new Error("Missing next match button");
    await act(async () => next.click());
    expect(second.scroll).toHaveBeenCalledTimes(1);
    expect(view.host.textContent).toContain("2/2");
  });

  test.each(["wheel", "touchmove", "pointerdown", "Home", SESSION_SCROLL_NAVIGATION_EVENT])("reader %s cancels the pending jump without cancelling highlights", async (input) => {
    const view = await fixture();
    view.container.dispatchEvent(input === "Home" ? new KeyboardEvent("keydown", { key: "Home", bubbles: true }) : new Event(input));
    const first = view.addMatch();
    await collect();
    expect(view.host.textContent).toContain("1/1");
    expect(first.mark.dataset.searchHighlightActive).toBe("true");
    expect(view.beforeJump).not.toHaveBeenCalled();
  });

  test.each(["close", "session", "query"])("%s supersedes a pending initial jump", async (action) => {
    const view = await fixture();
    await act(async () => {
      const store = useSessionFindStore.getState();
      if (action === "close") store.closeFind();
      else if (action === "session") store.openFind({ sessionId: "b", query: "needle" });
      else store.setQuery("different");
    });
    const stale = view.addMatch();
    await collect();
    expect(stale.scroll).not.toHaveBeenCalled();
    if (action === "query") {
      // The new applied query replaces old highlights before collection.
      view.container.replaceChildren();
      const replacement = view.addMatch("different");
      await collect();
      expect(replacement.scroll).toHaveBeenCalledTimes(1);
    }
  });

  test("completed history reports no matches but still navigates once if streaming later creates a match", async () => {
    const view = await fixture();
    await view.render(true);
    expect(view.host.textContent).toContain("No matches");
    const match = view.addMatch();
    await collect();
    expect(match.scroll).toHaveBeenCalledTimes(1);
    view.addMatch();
    await collect();
    expect(view.beforeJump).toHaveBeenCalledTimes(1);
  });
});
