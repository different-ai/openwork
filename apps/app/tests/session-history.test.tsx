/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import { openingHistoryWindow, SessionHistoryBoundary, useOpeningSessionHistory, type OpeningHistoryWindow } from "../src/react-app/domains/session/surface/session-history";
import { flushSessionScrollState, useSessionScrollStore } from "../src/react-app/domains/session/surface/scroll-store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { applySessionUnrevert, seedSessionState, snapshotKey, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";
import { deriveRenderedSessionMessages } from "../src/react-app/domains/session/surface/session-render-state";
import { resolveForkBoundaryId } from "../src/react-app/domains/session/sync/transcript-reconcile";

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

function snapshot(id: string, title: string, ids: string[] = [], revert?: string): OpenworkSessionSnapshot {
  return {
    session: { id, title, version: "1", time: { created: 1, updated: 1 }, revert: revert ? { messageID: revert } : undefined },
    messages: ids.map((messageId, index) => ({
      info: { id: messageId, sessionID: id, role: "user", time: { created: index + 1 } },
      parts: [{ id: `part-${messageId}`, sessionID: id, messageID: messageId, type: "text", text: messageId }],
    })),
    todos: [], status: { type: "idle" },
  };
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
  const client = getReactQueryClient();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let ensureFullSnapshot: (() => Promise<OpenworkSessionSnapshot>) | undefined;
  let runWithFullSnapshot: ReturnType<typeof useOpeningSessionHistory>["runWithFullSnapshot"] | undefined;
  const reads: { owner: string; window?: OpeningHistoryWindow; signal: AbortSignal; resolve: (snapshot: OpenworkSessionSnapshot) => void; reject: (error: Error) => void }[] = [];
  function Harness({ owner }: { owner: string }) {
    const key = snapshotKey("workspace", owner);
    const readSnapshot = (signal: AbortSignal, window?: OpeningHistoryWindow) => new Promise<OpenworkSessionSnapshot>((resolve, reject) => {
      reads.push({ owner, window, signal, resolve, reject });
    });
    const opening = useOpeningSessionHistory({ owner, sessionId: owner, snapshotQueryKey: key, readSnapshot });
    ensureFullSnapshot = opening.ensureFullSnapshot;
    runWithFullSnapshot = opening.runWithFullSnapshot;
    const full = useQuery({ queryKey: key, queryFn: ({ signal }) => readSnapshot(signal), enabled: opening.backgroundReady, staleTime: 500, retry: false });
    const current = full.data ?? opening.snapshot;
    useEffect(() => {
      if (current) seedSessionState("workspace", current, { preview: !full.data });
    }, [current, full.data]);
    const messages = deriveRenderedSessionMessages({ snapshot: current, transcriptState: client.getQueryData(transcriptKey("workspace", owner)), historyComplete: Boolean(full.data) });
    return <><span>Composer {owner}</span><input aria-label="Draft" /><SessionHistoryBoundary owner={owner} pending={!current || (!full.data && Boolean(current.session.revert))} saved={opening.saved} options={opening.options}
      onRetry={full.isError && !full.isFetching && current && !full.data ? () => { void full.refetch(); } : undefined}>
      <div>{current?.session.title}</div>{messages.map((message) => <div key={message.id} data-message-id={message.id}>{message.id}</div>)}
    </SessionHistoryBoundary></>;
  }
  cleanups.push(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
  return {
    reads, host, client,
    get runWithFullSnapshot() {
      if (!runWithFullSnapshot) throw new Error("History is not mounted");
      return runWithFullSnapshot;
    },
    ensureFullSnapshot() {
      if (!ensureFullSnapshot) throw new Error("History is not mounted");
      return ensureFullSnapshot();
    },
    async render(owner = "a") { await act(async () => flushSync(() => root.render(<QueryClientProvider client={client}><Harness owner={owner} /></QueryClientProvider>))); },
    async resolve(index: number, title: string | OpenworkSessionSnapshot) {
      await act(async () => reads[index].resolve(typeof title === "string" ? snapshot(reads[index].owner, title) : title));
      await settle();
    },
  };
}

describe("opening a thread", () => {
  test("branching at a singleton preview waits for the next native message in complete history", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, snapshot("a", "Older preview", ["z-earlier"]));
    const fork = mock();
    const pending = view.runWithFullSnapshot((full) => {
      fork(resolveForkBoundaryId(full.messages.map(({ info }) => info), "z-earlier"), full.session.id);
    }, { fresh: true });
    expect(fork).not.toHaveBeenCalled();
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }, undefined]);
    await view.resolve(1, snapshot("a", "Complete", ["z-earlier", "a-next", "m-last"]));
    await pending;
    expect(fork.mock.calls).toEqual([["a-next", "a"]]);
    expect(fork).toHaveBeenCalledTimes(1);
  });

  for (const backgroundRead of [false, true]) test(`Branch refreshes cached history and shares only the fresh read (older read in flight=${backgroundRead})`, async () => {
    const view = fixture();
    const cached = snapshot("a", "Cached through B", ["A", "B"]);
    view.client.setQueryData(snapshotKey("workspace", "a"), cached, { updatedAt: Date.now() - (backgroundRead ? 1_000 : 0) });
    await view.render();
    const precedingReads = backgroundRead ? 1 : 0;
    expect(view.reads).toHaveLength(precedingReads);
    view.client.setQueryData(transcriptKey("workspace", "a"), ["A", "B", "C", "D"].map((id) => ({ id, role: "assistant", parts: [] })));
    // Sends retain their original cache-hit behavior, even during a full read.
    expect((await view.ensureFullSnapshot()).messages.map(({ info }) => info.id)).toEqual(["A", "B"]);
    expect(view.reads).toHaveLength(precedingReads);
    const fork = mock();
    const branchAt = (id: string) => view.runWithFullSnapshot((full) => {
      fork(id, resolveForkBoundaryId(full.messages.map(({ info }) => info), id), full.session.id);
    }, { fresh: true });
    const atB = branchAt("B");
    const atC = branchAt("C");
    expect(fork).not.toHaveBeenCalled();
    expect(view.reads).toHaveLength(precedingReads + 1);
    expect(view.reads[precedingReads].window).toBeUndefined();
    if (backgroundRead) {
      expect(view.reads[0].signal.aborted).toBe(false);
      await view.resolve(0, cached);
      expect(fork).not.toHaveBeenCalled();
    }
    await view.resolve(precedingReads, snapshot("a", "Fresh through D", ["A", "B", "C", "D"]));
    await Promise.all([atB, atC]);
    expect(fork.mock.calls).toEqual([["B", "C", "a"], ["C", "D", "a"]]);
    // A subsequent branch must also refresh, not reuse the just-cached branch read.
    const atD = branchAt("D");
    expect(fork).toHaveBeenCalledTimes(2);
    expect(view.reads).toHaveLength(precedingReads + 2);
    expect(view.reads[precedingReads + 1].window).toBeUndefined();
    await view.resolve(precedingReads + 1, snapshot("a", "Fresh through E", ["A", "B", "C", "D", "E"]));
    await atD;
    expect(fork.mock.calls).toEqual([["B", "C", "a"], ["C", "D", "a"], ["D", "E", "a"]]);
  });

  for (const fresh of [false, true]) test(`history actions cannot run against a destination owner or after unmount (fresh=${fresh})`, async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, "Preview a");
    const runForA = view.runWithFullSnapshot;
    const action = mock();
    // A query aborted by navigation is not an action failure in the destination.
    const pending = runForA(action, { fresh }).catch(() => undefined);
    await view.render("b");
    await view.resolve(1, snapshot("a", "Late full a", ["a-message"]));
    await pending;
    await runForA(action, { fresh });
    expect(action).not.toHaveBeenCalled();
    expect(view.host.textContent).not.toContain("Late full a");
    expect(view.host.textContent).toContain("Composer b");
    const runForB = view.runWithFullSnapshot;
    await cleanups.pop()?.();
    const readCount = view.reads.length;
    await runForB(action, { fresh });
    expect(view.reads).toHaveLength(readCount);
    expect(action).not.toHaveBeenCalled();
  });

  test("Restore waits for full history before clearing its cursor and never strands the read", async () => {
    const view = fixture();
    const neighbor = snapshot("b", "Neighbor", ["neighbor"]);
    view.client.setQueryData(snapshotKey("workspace", "b"), neighbor);
    await view.render();
    const composer = view.host.querySelector("input");
    await view.resolve(0, snapshot("a", "Reverted preview", ["hidden"], "cursor"));
    await paint();
    await paint();
    const restore = mock(() => applySessionUnrevert("workspace", "a"));
    const pending = view.runWithFullSnapshot(restore);
    expect(restore).not.toHaveBeenCalled();
    expect(view.reads).toHaveLength(2);
    expect(view.reads[1].signal.aborted).toBe(false);
    await view.resolve(1, snapshot("a", "Complete restored history", ["before", "cursor", "hidden"], "cursor"));
    await pending;
    await settle();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(view.client.getQueryState(snapshotKey("workspace", "a"))).toMatchObject({ status: "success", fetchStatus: "idle" });
    expect(view.client.getQueryData<OpenworkSessionSnapshot>(snapshotKey("workspace", "a"))?.session.revert).toBeUndefined();
    expect(view.host.querySelectorAll("[data-message-id]").length).toBe(3);
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    expect(view.host.querySelector("input")).toBe(composer);
    expect(view.client.getQueryData(snapshotKey("workspace", "b"))).toEqual(neighbor);
  });

  test("a cache-hit history action is cancelled if ownership changes before its callback", async () => {
    const view = fixture();
    view.client.setQueryData(snapshotKey("workspace", "a"), snapshot("a", "Cached a", ["a-message"]));
    await view.render();
    const action = mock();
    const pending = view.runWithFullSnapshot(action);
    await view.render("b");
    await pending;
    expect(action).not.toHaveBeenCalled();
    expect(view.host.textContent).not.toContain("Cached a");
  });

  test("a failed full read reports the error without invoking a history mutation", async () => {
    const view = fixture();
    view.client.setQueryDefaults(snapshotKey("workspace", "a"), { retry: false });
    await view.render();
    await view.resolve(0, "Preview");
    const action = mock();
    const pending = view.runWithFullSnapshot(action).catch((error: unknown) => error);
    await act(async () => view.reads[1].reject(new Error("Full read failed")));
    await settle();
    expect(await pending).toMatchObject({ message: "Full read failed" });
    expect(action).not.toHaveBeenCalled();
  });

  test("a reverted full-read failure replaces loading with Retry without revealing hidden messages", async () => {
    const view = fixture();
    await view.render();
    view.client.setQueryData(transcriptKey("workspace", "a"), [{ id: "live-suffix", role: "assistant", parts: [] }]);
    await view.resolve(0, snapshot("a", "Unsafe newest preview", ["a-suffix", "z-suffix"], "m-cursor"));
    expect(view.host.querySelectorAll("[data-message-id]")).toHaveLength(0);
    expect(view.client.getQueryData(snapshotKey("workspace", "a"))).toBeUndefined();
    await paint();
    await paint();
    await act(async () => view.reads[1].reject(new Error("Full history unavailable")));
    await settle();
    expect(view.host.querySelectorAll("[data-message-id]")).toHaveLength(0);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
    expect(view.host.querySelector('[data-thread-loading]')).toBeNull();
    expect(view.host.textContent).toContain("Composer a");
    const retry = view.host.querySelector("button");
    expect(retry?.textContent).toBe("Retry");
    await act(async () => retry?.click());
    await settle();
    expect(view.host.querySelector('[data-thread-loading]')).not.toBeNull();
    expect(view.host.querySelectorAll("[data-message-id]")).toHaveLength(0);
    expect(view.reads).toHaveLength(3);
    expect(view.reads[2].window).toBeUndefined();
    await view.resolve(2, snapshot("a", "Recovered full history", ["before", "m-cursor", "a-suffix", "z-suffix"], "m-cursor"));
    expect([...view.host.querySelectorAll("[data-message-id]")].map((element) => element.getAttribute("data-message-id"))).toEqual(["before"]);
    expect(view.host.querySelector('[data-thread-loading]')).toBeNull();
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
  });

  test("explicit sends can finish the uncapped read without trusting or duplicating the preview", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, "Reading preview");
    const pending = view.ensureFullSnapshot();
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }, undefined]);
    const sameRead = view.ensureFullSnapshot();
    expect(view.reads).toHaveLength(2);
    await view.resolve(1, "Full current turn");
    expect((await pending).session.title).toBe("Full current turn");
    expect((await sameRead).session.title).toBe("Full current turn");
    expect((await view.ensureFullSnapshot()).session.title).toBe("Full current turn");
    expect(view.reads).toHaveLength(2);
  });

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
    view.client.setQueryData(snapshotKey("workspace", "a"), snapshot("a", "Cached history"), { updatedAt: Date.now() - 1_000 });
    await view.render();
    expect(view.host.textContent).toContain("Cached history");
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    expect(view.reads.map((read) => read.window)).toEqual([undefined]);
  });
});
