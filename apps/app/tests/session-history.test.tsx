/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import { openingHistoryWindow, SessionHistoryBoundary, useOpeningSessionHistory, type OpeningHistoryWindow } from "../src/react-app/domains/session/surface/session-history";
import { flushSessionScrollState, useSessionScrollStore } from "../src/react-app/domains/session/surface/scroll-store";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const frames = new Map<number, FrameRequestCallback>();
const cleanups: (() => Promise<void>)[] = [];
let frameId = 0;

beforeEach(() => {
  useSessionScrollStore.setState({ sessions: {} });
  spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++frameId, callback); return frameId; });
  spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  frames.clear();
  flushSessionScrollState();
  mock.restore();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function snapshot(id: string, title: string): OpenworkSessionSnapshot {
  return { session: { id, title, version: "1", time: { created: 1, updated: 1 } }, messages: [], todos: [], status: { type: "idle" } };
}

async function settle() {
  // TanStack notifications use a task, and React may throttle a Suspense reveal.
  await act(async () => { await Bun.sleep(350); });
}

async function paint() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const frame of pending) frame(0);
  });
}

function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const reads: { owner: string; window?: OpeningHistoryWindow; signal: AbortSignal; resolve: (snapshot: OpenworkSessionSnapshot) => void }[] = [];
  function Harness({ owner }: { owner: string }) {
    const key = ["snapshot", owner];
    const readSnapshot = (signal: AbortSignal, window?: OpeningHistoryWindow) => new Promise<OpenworkSessionSnapshot>((resolve) => {
      reads.push({ owner, window, signal, resolve });
    });
    const opening = useOpeningSessionHistory({ owner, sessionId: owner, snapshotQueryKey: key, readSnapshot });
    const full = useQuery({ queryKey: key, queryFn: ({ signal }) => readSnapshot(signal), enabled: opening.backgroundReady });
    const current = full.data ?? opening.snapshot;
    return <><span>Composer {owner}</span><SessionHistoryBoundary owner={owner} pending={!current} saved={opening.saved} options={opening.options}>
      <div>{current?.session.title}</div>
    </SessionHistoryBoundary></>;
  }
  cleanups.push(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
  return {
    reads, host, client,
    async render(owner = "a") { await act(async () => root.render(<QueryClientProvider client={client}><Harness owner={owner} /></QueryClientProvider>)); },
    async resolve(index: number, title: string) {
      await act(async () => reads[index].resolve(snapshot(reads[index].owner, title)));
      await settle();
    },
  };
}

describe("opening a thread", () => {
  test("Suspense shows feedback immediately, paints the newest window before the uncapped read, and keeps the composer mounted", async () => {
    const view = fixture();
    await view.render();
    expect(view.host.querySelector('[role="status"]')?.textContent).toContain("Loading latest messages");
    expect(view.host.textContent).toContain("Composer a");
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }]);
    await view.resolve(0, "Latest messages");
    expect(view.host.textContent).toContain("Latest messages");
    expect(view.reads).toHaveLength(1);
    await paint();
    expect(view.reads).toHaveLength(1);
    await paint();
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }, undefined]);
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    expect(view.host.textContent).toContain("Latest messages");
    await view.resolve(1, "Complete history");
    expect(view.host.textContent).toContain("Complete history");
  });

  test("saved positions request their own region, while a late previous-thread preview cannot render in the destination", async () => {
    const store = useSessionScrollStore.getState();
    store.setManualScroll("a", 800, null, { messageId: "reading", offset: -20 });
    store.setGeometry("a", { owner: "a", scrollHeight: 4000, viewportWidth: 600, before: 600, after: 2200, messageIds: ["before", "reading", "after"] });
    const view = fixture();
    await view.render();
    expect(view.reads[0].window).toEqual({ messageIds: ["before", "reading", "after"] });
    expect(view.host.textContent).toContain("Returning to your reading position");
    await view.render("b");
    await view.resolve(0, "Foreign preview");
    expect(view.host.textContent).not.toContain("Foreign preview");
    expect(view.host.textContent).toContain("Composer b");
    expect(view.reads[1].window).toEqual({ limit: 24 });
    await view.resolve(1, "Destination preview");
    await paint();
    await paint();
    expect(view.reads.filter((read) => read.window === undefined).map((read) => read.owner)).toEqual(["b"]);
  });

  test("warm full snapshots skip previews, and old anchors do not require persisted neighbors", async () => {
    expect(openingHistoryWindow({ mode: "manual", scrollTop: 500, anchor: { messageId: "legacy", offset: 0 }, topClippedMessageId: null }))
      .toEqual({ messageIds: ["legacy"] });
    expect(openingHistoryWindow({ mode: "manual", scrollTop: 500, anchor: { messageId: "turn:steps", offset: -20 }, topClippedMessageId: null }))
      .toEqual({ messageIds: ["turn"] });
    expect(openingHistoryWindow({ mode: "manual", scrollTop: 500, anchor: { messageId: "session-error:turn", offset: -20 }, topClippedMessageId: null }))
      .toEqual({ messageIds: ["turn"] });
    const view = fixture();
    view.client.setQueryData(["snapshot", "a"], snapshot("a", "Cached history"));
    await view.render();
    expect(view.host.textContent).toContain("Cached history");
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    expect(view.reads.map((read) => read.window)).toEqual([undefined]);
  });
});
