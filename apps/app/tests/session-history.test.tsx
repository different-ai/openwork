/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode, useEffect, useRef, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { focusManager, notifyManager, onlineManager, QueryClientProvider, skipToken, useQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import type { OpenworkSessionHistory } from "../src/app/lib/openwork-server";
import { latestConfirmsFullHistory, openingHistoryWindow, openingSessionHistoryOptions, prefetchOpeningSessionHistory, sessionHistoryIdentity, useSessionHistoryRuntimeOwners, SessionHistoryBoundary, SessionHistoryStatus, useOpeningSessionHistory, useSessionPrefetchIntent, type OpeningHistoryWindow } from "../src/react-app/domains/session/surface/session-history";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { flushSessionScrollState, readPersistedSessionScrollState, sessionScrollKey, useSessionScrollStore } from "../src/react-app/domains/session/surface/scroll-store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, applySessionRevert, applySessionUnrevert, seedSessionState, sessionHistoryCredential, sessionMetadataKey, snapshotKey, trackWorkspaceSessionSync, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";
import type { OpencodeEvent } from "../src/app/types";
import { deriveRenderedSessionMessages, type LatestSessionHistory } from "../src/react-app/domains/session/surface/session-render-state";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import { resolveForkBoundaryId } from "../src/react-app/domains/session/sync/transcript-reconcile";
import { resolveAdmissionOutcome } from "../src/react-app/domains/session/surface/session-admission-outcome";
import { mergeSessionHistoryPages } from "../src/react-app/domains/session/surface/session-history-pages";
import { useSessionScrollController } from "../src/react-app/domains/session/surface/scroll-controller";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const previousQueryClient = Reflect.get(globalThis, "__owReactQueryClient");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const frames = new Map<number, FrameRequestCallback>();
const cleanups: (() => Promise<void>)[] = [];
let frameId = 0;

beforeEach(() => {
  Reflect.deleteProperty(globalThis, "__owReactQueryClient");
  jest.useFakeTimers();
  notifyManager.setScheduler(queueMicrotask);
  useSessionScrollStore.setState({ sessions: {} });
  spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++frameId, callback); return frameId; });
  spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  frames.clear();
  flushSessionScrollState();
  jest.useRealTimers();
  mock.restore();
});
afterAll(async () => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (previousQueryClient === undefined) Reflect.deleteProperty(globalThis, "__owReactQueryClient");
  else Reflect.set(globalThis, "__owReactQueryClient", previousQueryClient);
  if (ownedDom) await GlobalRegistrator.unregister();
});

// A newest window that fills its limit may still be missing earlier messages.
const fullWindow = Array.from({ length: 24 }, (_, index) => `w${index}`);

function snapshot(id: string, title: string, ids: string[] = [], revert?: string): OpenworkSessionHistory {
  return {
    session: { id, title, version: "1", time: { created: 1, updated: 1 }, revert: revert ? { messageID: revert } : undefined },
    messages: ids.map((messageId, index) => ({
      info: { id: messageId, sessionID: id, role: "user", time: { created: index + 1 } },
      parts: [{ id: `part-${messageId}`, sessionID: id, messageID: messageId, type: "text", text: messageId }],
    })),
  };
}

function sessionEvents() {
  const input = { workspaceId: "workspace", baseUrl: "https://history.example/opencode", openworkToken: "history-test" };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, "a");
  cleanups.push(async () => { release(); dispose(); });
  return async (event: OpencodeEvent) => {
    await act(async () => __applySessionSyncEventForTest(input, event));
    await settle();
  };
}

function historyTool(output: string, input = "initial", running = false) {
  const history = snapshot("a", "Tools", ["old", "active"]);
  history.messages[1].parts.push({
    id: "tool-part", sessionID: "a", messageID: "active", type: "tool", tool: "bash", callID: "call",
    state: running
      ? { status: "running", input: { command: input }, time: { start: 1 } }
      : { status: "completed", input: { command: input }, output, title: "Done", metadata: {}, time: { start: 1, end: 2 } },
  });
  return history;
}

async function settle() {
  // Flush TanStack's notification task, not the visual loading grace period.
  await act(async () => { jest.advanceTimersByTime(1); });
}

async function paint() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const frame of pending) frame(0);
  });
}

function fixture(navigation = false) {
  let scrollControls: ReturnType<typeof useSessionScrollController> | undefined;
  function NavigationViewport({ opening, owner, children }: { opening: ReturnType<typeof useOpeningSessionHistory>; owner: string; children: ReactNode }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const top = useRef(0);
    const scroll = useSessionScrollController({
      selectedSessionId: owner, geometryOwner: owner, submittedMessageId: null,
      historyReady: opening.pages.ready, windowReady: opening.pages.ready && !opening.pages.anchorPending,
      historyComplete: opening.complete, historyPages: opening.pages,
      renderedMessages: opening.pageMessages, containerRef, contentRef,
    });
    scrollControls = scroll;
    return <div data-thread-scroll onScroll={scroll.handleScroll} ref={(node) => {
      containerRef.current = node;
      if (!node) return;
      const height = () => Math.max(200, node.querySelectorAll("[data-message-id]").length * 300);
      Object.defineProperties(node, {
        clientHeight: { configurable: true, get: () => 200 },
        clientWidth: { configurable: true, get: () => 500 },
        scrollHeight: { configurable: true, get: height },
        scrollTop: { configurable: true, get: () => top.current, set: (value: number) => { top.current = Math.max(0, Math.min(value, height() - 200)); } },
        scrollTo: { configurable: true, value: (options: ScrollToOptions) => { node.scrollTop = options.top ?? top.current; } },
        getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 500, 200) },
      });
      [...node.querySelectorAll<HTMLElement>("[data-message-id]")].forEach((message, index) => {
        message.getBoundingClientRect = () => new DOMRect(0, index * 300 - top.current, 500, 300);
      });
    }}><div ref={contentRef} data-thread-history-complete={opening.complete}>{children}</div></div>;
  }
  const client = getReactQueryClient();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let historyPages: ReturnType<typeof useOpeningSessionHistory>["pages"] | undefined;
  const panePages = new Map<string, ReturnType<typeof useOpeningSessionHistory>["pages"]>();
  let openingError: Error | null = null;
  let findRequested = false;
  let ensureFullSnapshot: (() => Promise<OpenworkSessionHistory>) | undefined;
  let readSendHistory: ReturnType<typeof useOpeningSessionHistory>["readSendHistory"] | undefined;
  let runWithFullSnapshot: ReturnType<typeof useOpeningSessionHistory>["runWithFullSnapshot"] | undefined;
  const reads: { owner: string; authToken?: string; window?: OpeningHistoryWindow; signal: AbortSignal; resolve: (snapshot: OpenworkSessionHistory) => void; reject: (error: Error) => void }[] = [];
  const latestReads: { owner: string; authToken?: string; signal: AbortSignal; resolve: (history: Pick<OpenworkSessionHistory, "session" | "messages">) => void; reject: (error: Error) => void }[] = [];
  function input(owner = "a", authToken?: string, cacheOwner = owner, runtimeOwner?: string) {
    const readSnapshot = (signal: AbortSignal, window?: OpeningHistoryWindow) => new Promise<OpenworkSessionHistory>((resolve, reject) => {
      reads.push({ owner, authToken, window, signal, resolve, reject });
    });
    const readLatest = (signal: AbortSignal) => new Promise<Pick<OpenworkSessionHistory, "session" | "messages">>((resolve, reject) => {
      latestReads.push({ owner, authToken, signal, resolve, reject });
    });
    return { owner: cacheOwner, runtimeOwner, sessionId: owner, authToken, snapshotQueryKey: snapshotKey("workspace", owner), transcriptQueryKey: transcriptKey("workspace", owner),
      metadataQueryKey: sessionMetadataKey({ workspaceId: "workspace", baseUrl: "https://history.example/opencode", openworkToken: authToken ?? "" }, owner), readSnapshot, readLatest };
  }
  function Harness({ options, onMount, pane }: { options: ReturnType<typeof input>; onMount?: (ensure: () => Promise<OpenworkSessionHistory>) => void; pane?: string }) {
    const { sessionId: owner, owner: cacheOwner } = options;
    const key = options.snapshotQueryKey;
    const workspaceId = key[1];
    const opening = useOpeningSessionHistory(options);
    historyPages = opening.pages;
    if (pane) panePages.set(pane, opening.pages);
    openingError = opening.openingError;
    ensureFullSnapshot = opening.ensureFullSnapshot;
    readSendHistory = opening.readSendHistory;
    runWithFullSnapshot = opening.runWithFullSnapshot;
    // The hero's one-step auto-send fires from a mount effect, before any read settled.
    useEffect(() => { onMount?.(opening.ensureFullSnapshot); }, [onMount, opening.ensureFullSnapshot]);
    const full = useQuery({ queryKey: key, queryFn: ({ signal }) => opening.readFullSnapshot(signal), enabled: opening.backgroundReady || findRequested, staleTime: opening.fullCurrent ? Infinity : 500, retry: false });
    const current = full.data ?? opening.snapshot;
    useEffect(() => {
      if (current) opening.seedSnapshot(current, () => seedSessionState(workspaceId, current, { preview: !opening.complete }));
    }, [workspaceId, current, opening.complete, opening.seedSnapshot]);
    const transcript = useQuery<UIMessage[]>({ queryKey: transcriptKey(workspaceId, owner), queryFn: skipToken });
    const messages = opening.pageMessages ?? deriveRenderedSessionMessages({ snapshot: current, transcriptState: transcript.data, historyComplete: Boolean(full.data), latestHistory: opening.latestHistory });
    const pending = !current || (!opening.complete && Boolean(current.session.revert));
    const unanswered = opening.complete && resolveAdmissionOutcome({ messages, statusType: "idle", sending: false,
      hasActiveQuestion: false, hasActivePermission: false, hasSessionError: false }) === "unresolved";
    const failed = Boolean(opening.openingError) || full.isError && !full.isFetching || opening.pages.failed;
    const transcriptView = <SessionHistoryBoundary owner={cacheOwner} pending={pending} saved={opening.saved} failed={failed}>
      <div data-history-complete={opening.complete} data-admission-unresolved={unanswered}>{current?.session.title}</div>{messages.map((message) => <div key={message.id} data-message-id={message.id}>{message.parts.map((part) => part.type === "text" ? part.text : part.type === "dynamic-tool" ? `${part.state}:${JSON.stringify({ input: part.input, output: "output" in part ? part.output : null })}` : "").join(" ")}</div>)}
    </SessionHistoryBoundary>;
    return <><span>Composer {owner}</span><input aria-label="Draft" /><div className="flex min-h-0 flex-col">
      <SessionHistoryStatus key={cacheOwner} complete={opening.complete && !opening.openingError} pending={pending}
        loading={opening.openingLoading || full.isFetching && opening.partial || opening.pages.loading} failed={failed}
        onRetry={() => opening.openingError ? opening.retryOpening() : opening.pages.failed ? opening.pages.retry() : full.refetch()} />
      <div className="relative min-h-0 flex-1">{navigation
        ? <NavigationViewport opening={opening} owner={owner}>{transcriptView}</NavigationViewport>
        : <div data-thread-scroll>{transcriptView}</div>}</div>
    </div></>;
  }
  function RuntimeOwners({ owners, children }: { owners: Parameters<typeof useSessionHistoryRuntimeOwners>[0]; children: ReactNode }) {
    useSessionHistoryRuntimeOwners(owners);
    return children;
  }
  async function renderInput(options: ReturnType<typeof input>, mount: { strict?: boolean; onMount?: (ensure: () => Promise<OpenworkSessionHistory>) => void } = {}) {
    const tree = <QueryClientProvider client={client}><Harness options={options} onMount={mount.onMount} /></QueryClientProvider>;
    await act(async () => flushSync(() => root.render(mount.strict ? <StrictMode>{tree}</StrictMode> : tree)));
  }
  cleanups.push(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
  return {
    reads, latestReads, host, client, input, renderInput, panePages,
    get controls() {
      if (!scrollControls) throw new Error("Navigation is not mounted");
      return scrollControls;
    },
    get openingError() { return openingError; },
    async renderRuntimeOwners(owners: Parameters<typeof useSessionHistoryRuntimeOwners>[0] | null, panes: ReturnType<typeof input>[], strict = false) {
      const tree = <QueryClientProvider client={client}>{owners && <RuntimeOwners owners={owners}>
        {panes.map((options, index) => <section key={index} data-pane={index}><Harness options={options} /></section>)}
      </RuntimeOwners>}</QueryClientProvider>;
      await act(async () => flushSync(() => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree)));
    },
    async renderSplit(left: string, right: string) {
      await act(async () => flushSync(() => root.render(<QueryClientProvider client={client}>
        <section data-pane="left"><Harness options={input(left)} pane="left" /></section>
        <section data-pane="right"><Harness options={input(right)} pane="right" /></section>
      </QueryClientProvider>)));
    },
    get pages() {
      if (!historyPages) throw new Error("History is not mounted");
      return historyPages;
    },
    async find() { findRequested = true; await renderInput(input()); },
    startSharedRead(owner = "a") {
      const options = input(owner);
      void client.fetchQuery({ queryKey: options.snapshotQueryKey, queryFn: ({ signal }) => options.readSnapshot(signal), retry: false }).catch(() => undefined);
    },
    async startOwnedRead(owner = "a") {
      const query = client.getQueryCache().find({ queryKey: snapshotKey("workspace", owner), exact: true });
      if (!query) throw new Error("History is not mounted");
      await act(async () => { void query.fetch().catch(() => undefined); });
    },
    async resolveLatest(index: number, history: Pick<OpenworkSessionHistory, "session" | "messages">) {
      await act(async () => latestReads[index].resolve(history));
      await settle();
    },
    get runWithFullSnapshot() {
      if (!runWithFullSnapshot) throw new Error("History is not mounted");
      return runWithFullSnapshot;
    },
    ensureFullSnapshot() {
      if (!ensureFullSnapshot) throw new Error("History is not mounted");
      return ensureFullSnapshot();
    },
    readSendHistory(options?: { revealLatest?: boolean }) {
      if (!readSendHistory) throw new Error("History is not mounted");
      return readSendHistory(options);
    },
    render(owner = "a", authToken?: string, cacheOwner = owner) { return renderInput(input(owner, authToken, cacheOwner)); },
    async resolve(index: number, title: string | OpenworkSessionHistory) {
      await act(async () => reads[index].resolve(typeof title === "string" ? snapshot(reads[index].owner, title) : title));
      await settle();
    },
  };
}

function page(ids: string[], before: string | null, nextCursor: string | null, sessionId = "a") {
  return { ...snapshot(sessionId, "Paged history", ids), pagination: { ...(before === null ? {} : { before }), nextCursor, limit: 24 } };
}

async function demand(view: ReturnType<typeof fixture>, direction: "older" | "newer" | "latest") {
  let pending: Promise<void> = Promise.resolve();
  await act(async () => { pending = view.pages.load(direction); });
  return { settled: pending.catch(() => undefined) };
}

function visibleIds(view: ReturnType<typeof fixture>) {
  return [...view.host.querySelectorAll("[data-message-id]")].map((message) => message.getAttribute("data-message-id"));
}

describe("explicit navigation cancels saved-page recovery", () => {
  function saveAnchor(before: string | null = null, owner = "a") {
    const store = useSessionScrollStore.getState();
    store.setManualScroll(owner, 500, null, { messageId: "saved-anchor", offset: -20 });
    store.setGeometry(owner, { owner, scrollHeight: 1000, viewportWidth: 500, before: 0, after: 300,
      messageIds: ["saved-anchor"], page: { before, limit: 24, lineage: before ? [null, before] : [null] } });
  }

  test.each(["scrollToBottom", "jumpToLatest"])("%s does not restart an abandoned older anchor after latest replaces its IDs", async (action) => {
    saveAnchor("middle");
    const view = fixture(true);
    await view.render();
    await view.resolve(0, page(["saved-anchor"], "middle", "older"));
    expect(view.pages.hasNewer).toBe(true);
    await act(async () => action === "scrollToBottom" ? view.controls.scrollToBottom("auto") : view.controls.jumpToLatest("auto"));
    expect(view.reads[1].window).toEqual({ limit: 24 });
    await view.resolve(1, page(["latest"], null, "middle"));
    await paint();
    expect(view.pages.anchorPending).toBe(false);
    expect(view.reads).toHaveLength(2);
    expect(visibleIds(view)).toEqual(["latest"]);
    expect(view.host.querySelector("[data-thread-scroll]")?.scrollTop).toBe(100);
    const older = await demand(view, "older");
    await view.resolve(2, page(["saved-anchor"], "middle", "older"));
    await older.settled;
    expect(visibleIds(view)).toEqual(["saved-anchor", "latest"]);
  });

  test("latest cancels an in-flight automatic recovery even when the current page is already newest", async () => {
    saveAnchor();
    const view = fixture(true);
    await view.render();
    await view.resolve(0, page(["latest"], null, "older"));
    expect(view.pages.hasNewer).toBe(false);
    expect(view.reads[1].window).toEqual({ limit: 24, before: "older" });
    await act(async () => view.controls.jumpToLatest("auto"));
    await view.resolve(1, page(["abandoned"], "older", "more"));
    await paint();
    expect(visibleIds(view)).toEqual(["latest"]);
    expect(view.reads[1].signal.aborted).toBe(true);
    expect(view.pages.anchorPending).toBe(false);
    expect(view.pages.loading).toBe(false);
    expect(view.reads).toHaveLength(2);
  });

  test("cancelling automatic recovery releases its request without cancelling subsequent user paging or refresh", async () => {
    saveAnchor();
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["latest"], null, "older"));
    await act(async () => view.pages.cancelRestore());
    expect(view.reads[1].signal.aborted).toBe(true);
    const older = await demand(view, "older");
    expect(view.reads).toHaveLength(3);
    await act(async () => view.pages.cancelRestore());
    expect(view.reads[2].signal.aborted).toBe(false);
    await view.resolve(1, page(["abandoned"], "older", "more"));
    expect(view.pages.loading).toBe(true);
    await view.resolve(2, page(["chosen"], "older", "more"));
    await older.settled;
    expect(visibleIds(view)).toEqual(["chosen", "latest"]);
    await act(async () => { void view.client.invalidateQueries({ queryKey: snapshotKey("workspace", "a"), exact: true }); });
    await act(async () => view.pages.cancelRestore());
    expect(view.reads[3].signal.aborted).toBe(false);
    await view.resolve(3, page(["latest", "live"], null, "older"));
    expect(visibleIds(view)).toEqual(["chosen", "latest", "live"]);
    expect(view.pages.failed).toBe(false);
  });

  test("cancelling recovery preserves a queued live refresh and ignores its old response", async () => {
    saveAnchor();
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["latest"], null, "older"));
    await act(async () => { void view.client.invalidateQueries({ queryKey: snapshotKey("workspace", "a"), exact: true }); });
    expect(view.reads).toHaveLength(2);
    await act(async () => view.pages.cancelRestore());
    expect(view.reads[1].signal.aborted).toBe(true);
    expect(view.reads[2].window).toEqual({ limit: 24 });
    await view.resolve(1, page(["abandoned"], "older", "more"));
    expect(view.pages.loading).toBe(true);
    await view.resolve(2, page(["latest", "live"], null, "older"));
    expect(visibleIds(view)).toEqual(["latest", "live"]);
    expect(view.pages.anchorPending).toBe(false);
    expect(view.reads).toHaveLength(3);
  });

  test("passive sticky follow leaves an in-flight saved-anchor recovery alive", async () => {
    saveAnchor();
    const view = fixture(true);
    await view.render();
    await view.resolve(0, page(["latest"], null, "older"));
    await act(async () => {
      useSessionScrollStore.getState().setStickyBottom(sessionScrollKey("a", "a"), null);
      view.controls.refresh();
    });
    await paint();
    expect(view.reads[1].signal.aborted).toBe(false);
    expect(view.pages.anchorPending).toBe(true);
    await view.resolve(1, page(["saved-anchor"], "older", null));
    expect(visibleIds(view)).toEqual(["saved-anchor", "latest"]);
    expect(view.pages.anchorPending).toBe(false);
  });

  test.each(["find", "start"])("%s cancels automatic recovery without a late response changing its destination", async (action) => {
    saveAnchor();
    const view = fixture(true);
    await view.render();
    await view.resolve(0, page(fullWindow, null, "older"));
    const scroller = view.host.querySelector("[data-thread-scroll]");
    if (!(scroller instanceof HTMLDivElement)) throw new Error("Missing viewport");
    await act(async () => {
      if (action === "find") {
        view.controls.markScrollGesture(scroller);
        scroller.scrollTop = 3600;
        scroller.dispatchEvent(new Event("scroll"));
      } else {
        useSessionScrollStore.getState().setTopClippedMessageId(sessionScrollKey("a", "a"), fullWindow[23]);
        view.controls.jumpToStartOfMessage("auto");
      }
    });
    await view.resolve(1, page(["abandoned"], "older", "more"));
    await paint();
    expect(view.reads[1].signal.aborted).toBe(true);
    expect(visibleIds(view)).toEqual(fullWindow);
    expect(scroller.scrollTop).toBe(action === "find" ? 3600 : 6900);
    expect(view.reads).toHaveLength(2);
  });

  test("stale navigation and page callbacks cannot cancel another session's recovery", async () => {
    saveAnchor();
    saveAnchor(null, "b");
    const view = fixture(true);
    await view.render();
    await view.resolve(0, page(["latest-a"], null, "older-a"));
    const oldPages = view.pages;
    const oldControls = view.controls;
    await view.render("b");
    await view.resolve(2, page(["latest-b"], null, "older-b", "b"));
    await act(async () => {
      oldPages.cancelRestore();
      oldControls.jumpToLatest("auto");
      oldControls.jumpToStartOfMessage("auto");
      oldControls.markScrollGesture();
      expect(await oldControls.scrollToTop()).toBe(false);
    });
    expect(view.reads[3].signal.aborted).toBe(false);
    expect(view.pages.anchorPending).toBe(true);
    await view.resolve(1, page(["abandoned-a"], "older-a", null));
    expect(visibleIds(view)).toEqual(["latest-b"]);
    await view.resolve(3, page(["saved-anchor"], "older-b", null, "b"));
    expect(visibleIds(view)).toEqual(["saved-anchor", "latest-b"]);
    expect(view.reads).toHaveLength(4);
  });

  test("cancellation does not abort an explicit older read already in flight", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["latest"], null, "older"));
    const older = await demand(view, "older");
    await act(async () => view.pages.cancelRestore());
    expect(view.reads[1].signal.aborted).toBe(false);
    await view.resolve(1, page(["chosen"], "older", null));
    await older.settled;
    expect(visibleIds(view)).toEqual(["chosen", "latest"]);
  });
});

describe("independent opening regression audit", () => {
  test("a disjoint opening revalidation retains manual cumulative history until its gap is bridged", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["reading"], null, "older"));
    const older = await demand(view, "older");
    await view.resolve(1, page(["earlier"], "older", null));
    await older.settled;
    const openingKey = openingSessionHistoryOptions(view.input()).queryKey;
    const scrollKey = sessionScrollKey("a", "a");
    const anchor = { messageId: "reading", offset: -20 };
    useSessionScrollStore.getState().setManualScroll(scrollKey, 100, null, anchor);
    await act(async () => { void view.client.invalidateQueries({ queryKey: openingKey, exact: true }); });
    await view.resolve(2, page(["newest"], null, "bridge"));
    expect(visibleIds(view)).toEqual(["earlier", "reading"]);
    expect(view.pages.hasNewer).toBe(true);
    expect(view.pages.pageForAnchor("reading")).toBeUndefined();
    expect(view.pages.pageForAnchor("earlier")?.before).toBe("older");
    expect(useSessionScrollStore.getState().sessions[scrollKey].anchor).toEqual(anchor);
    const bridge = await demand(view, "newer");
    expect(view.reads[3].window).toEqual({ limit: 24, before: "bridge" });
    await view.resolve(3, page(["reading", "between"], "bridge", "older"));
    await bridge.settled;
    expect(visibleIds(view)).toEqual(["earlier", "reading", "between", "newest"]);
    expect(view.pages.pageForAnchor("reading")?.before).toBe("bridge");
    expect(view.pages.complete).toBe(true);
    await act(async () => { void view.client.invalidateQueries({ queryKey: openingKey, exact: true }); });
    await view.resolve(4, page(["newest", "tail"], null, "bridge"));
    expect(visibleIds(view)).toEqual(["earlier", "reading", "between", "newest", "tail"]);
    expect(view.pages.pageForAnchor("reading")?.before).toBe("bridge");
  });

  test("a reverted opening revalidation hides partial history until complete ordering arrives", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["visible", "boundary", "hidden"], null, "older"));
    await act(async () => {
      void view.client.invalidateQueries({ queryKey: openingSessionHistoryOptions(view.input()).queryKey, exact: true });
    });
    const reverted = page(["visible", "boundary", "hidden"], null, "older");
    reverted.session.revert = { messageID: "boundary" };
    await view.resolve(1, reverted);
    expect(visibleIds(view)).toEqual([]);
    await paint();
    await paint();
    expect(view.reads[2].window).toBeUndefined();
    await view.resolve(2, snapshot("a", "Reverted", ["earlier", "visible", "boundary", "hidden"], "boundary"));
    expect(visibleIds(view)).toEqual(["earlier", "visible"]);
  });

  test("opening revalidation preserves cumulative pages, live corrections, deletions and saved anchors", async () => {
    const view = fixture();
    const event = sessionEvents();
    useSessionScrollStore.getState().setManualScroll("a", 100, null, { messageId: "old", offset: -20 });
    useSessionScrollStore.getState().setGeometry("a", { owner: "a", scrollHeight: 1000, viewportWidth: 600,
      before: 0, after: 300, messageIds: ["old"], page: { before: null, limit: 24, lineage: [null] } });
    await view.render();
    await view.resolve(0, { ...historyTool("output-A"), pagination: { limit: 24, nextCursor: "older" } });
    const older = await demand(view, "older");
    await view.resolve(1, page(["earlier", "deleted"], "older", null));
    await older.settled;
    await event({ type: "message.removed", properties: { sessionID: "a", messageID: "deleted" } });
    const openingKey = openingSessionHistoryOptions(view.input()).queryKey;
    const anchor = { messageId: "earlier", offset: -20 };
    const scrollKey = sessionScrollKey("a", "a");
    useSessionScrollStore.getState().setManualScroll(scrollKey, 100, null, anchor);
    const position = view.pages.pageForAnchor("earlier");
    await act(async () => {
      void view.client.invalidateQueries({ queryKey: openingKey, exact: true });
    });
    expect(view.reads).toHaveLength(3);
    await event({ type: "message.part.updated", properties: { part: historyTool("output-B", "corrected").messages[1].parts[1] } });
    await view.resolve(2, { ...historyTool("output-A"), pagination: { limit: 24, nextCursor: "changed" } });
    expect(visibleIds(view)).toEqual(["earlier", "old", "active"]);
    expect(view.host.textContent).toContain("output-B");
    expect(view.host.textContent).not.toContain("output-A");
    expect(view.pages.pageForAnchor("earlier")).toEqual(position);
    expect(useSessionScrollStore.getState().sessions[scrollKey].anchor).toEqual(anchor);
    expect(view.pages.complete).toBe(true);
    await act(async () => {
      void view.client.invalidateQueries({ queryKey: openingKey, exact: true });
    });
    await view.resolve(3, { ...historyTool("output-C", "corrected"), pagination: { limit: 24, nextCursor: "changed" } });
    expect(view.host.textContent).toContain("output-C");
    expect(view.host.textContent).not.toContain("output-B");
    expect(visibleIds(view)).not.toContain("deleted");
  });

  test("opening adoption fences a pending older read and uses its new cursor on the next demand", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["old"], null, "old-cursor"));
    const pending = await demand(view, "older");
    await act(async () => {
      void view.client.invalidateQueries({ queryKey: openingSessionHistoryOptions(view.input()).queryKey, exact: true });
    });
    expect(view.reads).toHaveLength(3);
    await view.resolve(2, page(["old", "new"], null, "new-cursor"));
    expect(view.reads[1].signal.aborted).toBe(true);
    await view.resolve(1, page(["obsolete"], "old-cursor", null));
    await pending.settled;
    expect(visibleIds(view)).toEqual(["old", "new"]);
    expect(view.pages.loading).toBe(false);
    const current = await demand(view, "older");
    expect(view.reads[3].window).toEqual({ limit: 24, before: "new-cursor" });
    await view.resolve(3, page(["earlier"], "new-cursor", null));
    await current.settled;
    expect(visibleIds(view)).toEqual(["earlier", "old", "new"]);
  });

  test("a joining pane preserves live-only rows and deletions through opening revalidation", async () => {
    const view = fixture();
    const event = sessionEvents();
    await view.renderSplit("b", "a");
    await view.resolve(1, page(["old"], null, "older"));
    await event({ type: "message.updated", properties: { info: {
      id: "live", sessionID: "a", role: "assistant", time: { created: 100 },
    } } });
    await act(async () => { jest.advanceTimersByTime(2_001); });
    await view.renderSplit("a", "a");
    await view.resolve(2, page(["old", "new"], null, "changed"));
    await event({ type: "message.part.updated", properties: { part: {
      id: "live-text", sessionID: "a", messageID: "live", type: "text", text: "Still streaming",
    } } });
    await event({ type: "message.removed", properties: { sessionID: "a", messageID: "old" } });
    for (const pane of ["left", "right"]) {
      expect([...view.host.querySelectorAll(`[data-pane="${pane}"] [data-message-id]`)].map((node) => node.getAttribute("data-message-id")))
        .toEqual(["new", "live"]);
      expect(view.host.querySelector(`[data-pane="${pane}"]`)?.textContent).toContain("Still streaming");
    }
  });

  test("opening revalidation does not discard older pages loaded by another mounted pane", async () => {
    const view = fixture();
    await view.renderSplit("a", "a");
    await view.resolve(0, page(["old"], null, "older"));
    const right = view.panePages.get("right");
    if (!right) throw new Error("Right pane is missing");
    let pending = Promise.resolve();
    await act(async () => { pending = right.load("older"); });
    await view.resolve(1, page(["earlier"], "older", null));
    await pending;
    await act(async () => {
      void view.client.invalidateQueries({ queryKey: openingSessionHistoryOptions(view.input()).queryKey, exact: true });
    });
    await view.resolve(2, page(["old", "new"], null, "changed"));
    for (const pane of ["left", "right"]) {
      expect([...view.host.querySelectorAll(`[data-pane="${pane}"] [data-message-id]`)].map((node) => node.getAttribute("data-message-id")))
        .toEqual(["earlier", "old", "new"]);
      expect(view.panePages.get(pane)?.pageForAnchor("earlier")?.before).toBe("older");
    }
  });

  for (const engine of ["opencode", "opencode2"]) test(`runtime authority admits the resolved remote ${engine} endpoint rather than its sidebar alias`, async () => {
    const view = fixture();
    const endpoint = resolveWorkspaceEndpoint({ id: "rem_alias", workspaceType: "remote", baseUrl: "https://worker.example",
      openworkToken: "remote-token", openworkWorkspaceId: "runtime-x" }, { baseUrl: "http://localhost:7777", token: "local-token" });
    if (!endpoint) throw new Error("Remote endpoint is missing");
    const identity = sessionHistoryIdentity({ draftScope: "principal", opencodeBaseUrl: `${endpoint.mountedBaseUrl}/${engine}`,
      runtimeWorkspaceId: endpoint.workspaceId, sessionId: "a" });
    const selected = { ...view.input("a", endpoint.token), ...identity, transcriptQueryKey: transcriptKey(endpoint.workspaceId, "a") };
    await view.renderRuntimeOwners([{ owner: identity.runtimeOwner, authToken: endpoint.token }], [selected]);
    expect(view.reads).toHaveLength(1);
    expect(view.reads[0].signal.aborted).toBe(false);
    expect(identity.snapshotQueryKey).toEqual(snapshotKey("runtime-x", "a"));
    await view.resolve(0, page(["remote-message"], null, "older"));
    expect(visibleIds(view)).toEqual(["remote-message"]);
    expect(view.openingError).toBeNull();
  });

  test("retry after failed stale-cache revalidation replaces the displayed page and cursor", async () => {
    const view = fixture();
    await view.render("a");
    await view.resolve(0, page(["old"], null, "old-cursor"));
    await view.render("b");
    await act(async () => { jest.advanceTimersByTime(2_001); });
    await view.render("a");
    expect(view.reads).toHaveLength(3);
    await act(async () => view.reads[2].reject(new Error("Revalidation failed")));
    await settle();
    expect(view.openingError?.message).toBe("Revalidation failed");
    expect(visibleIds(view)).toEqual(["old"]);
    await act(async () => view.host.querySelector("button")?.click());
    expect(view.reads).toHaveLength(4);
    await view.resolve(3, page(["new"], null, "new-cursor"));
    expect(view.openingError).toBeNull();
    expect(visibleIds(view)).toEqual(["new"]);
    await demand(view, "older");
    expect(view.reads[4].window).toEqual({ limit: 24, before: "new-cursor" });
  });

  test("invalidating a completed opening updates the existing observer's displayed page", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["old"], null, "old-cursor"));
    await act(async () => {
      void view.client.invalidateQueries({ queryKey: openingSessionHistoryOptions(view.input()).queryKey, exact: true });
    });
    expect(view.reads).toHaveLength(2);
    await view.resolve(1, page(["new"], null, "new-cursor"));
    expect(view.openingError).toBeNull();
    expect(visibleIds(view)).toEqual(["new"]);
  });

  test("snapshot invalidation after completed opening refreshes without leaving a recovery error", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["old"], null, "old-cursor"));
    await act(async () => {
      void view.client.invalidateQueries({ queryKey: snapshotKey("workspace", "a"), exact: true });
    });
    expect(view.reads).toHaveLength(2);
    await view.resolve(1, page(["old", "new"], null, "new-cursor"));
    expect(visibleIds(view)).toEqual(["old", "new"]);
    expect(view.openingError).toBeNull();
    expect(view.reads).toHaveLength(2);
  });

  test("a second observer's two-second revalidation keeps the first observer's pagination current", async () => {
    const view = fixture();
    await view.renderSplit("b", "a");
    await view.resolve(1, page(["old"], null, "old-cursor"));
    await act(async () => { jest.advanceTimersByTime(2_001); });
    await view.renderSplit("a", "a");
    expect(view.reads).toHaveLength(3);
    await view.resolve(2, page(["new"], null, "new-cursor"));
    expect(view.host.querySelector('[data-pane="left"] [data-message-id]')?.textContent).toBe("new");
    expect(view.host.querySelector('[data-pane="right"] [data-message-id]')?.textContent).toBe("new");
    const right = view.panePages.get("right");
    if (!right) throw new Error("Right pane is missing");
    await act(async () => { void right.load("older").catch(() => undefined); });
    expect(view.reads[3].window).toEqual({ limit: 24, before: "new-cursor" });
  });
});

describe("bounded opening recovery", () => {
  for (const kind of ["network", "http", "forbidden", "size", "deleted-session"]) test(`${kind} opening errors remain bounded and do not block another thread`, async () => {
    const view = fixture();
    class HistorySizeError extends Error { code = "history_too_large"; }
    const error = kind === "size" ? new HistorySizeError("History response exceeds the size limit.")
      : Object.assign(new Error(kind === "network" ? "Failed to fetch" : "History request failed"),
        kind === "deleted-session" ? { status: 404, code: "session_not_found" } : kind === "http" ? { status: 503 } : kind === "forbidden" ? { status: 403 } : {});
    if (kind === "network" || kind === "deleted-session") {
      useSessionScrollStore.getState().setManualScroll("a", 500, null, { messageId: "saved", offset: 0 });
    }
    await view.render();
    await act(async () => view.reads[0].reject(error));
    await settle();
    expect(view.openingError).toBe(error);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("This conversation could not be loaded.");
    expect(view.host.querySelector("[data-thread-loading]")).toBeNull();
    await paint();
    await paint();
    expect(view.reads).toHaveLength(1);
    await view.render("b");
    expect(view.reads[1].owner).toBe("b");
    expect(view.reads[1].window).toEqual({ limit: 24 });
    await view.resolve(1, page(["ready-b"], null, null, "b"));
    expect(visibleIds(view)).toEqual(["ready-b"]);
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    expect(view.reads).toHaveLength(2);
  });

  for (const malformed of ["owner", "pagination"]) test(`malformed ${malformed} replies expose Retry without starting full history`, async () => {
    const view = fixture();
    await view.render();
    const response = page(["bad"], malformed === "pagination" ? "unexpected-cursor" : null, "older");
    if (malformed === "owner") response.messages[0].parts[0].sessionID = "another-session";
    await view.resolve(0, response);
    expect(view.openingError).toBeInstanceOf(Error);
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.host.querySelector("[data-thread-loading]")).toBeNull();
    expect(visibleIds(view)).toEqual([]);
    await paint();
    await paint();
    expect(view.reads).toHaveLength(1);
    await act(async () => view.host.querySelector("button")?.click());
    expect(view.reads[1].window).toEqual({ limit: 24 });
    await view.resolve(1, page(["recovered"], null, null));
    expect(visibleIds(view)).toEqual(["recovered"]);
    expect(view.openingError).toBeNull();
    expect(view.reads).toHaveLength(2);
  });

  for (const missing of ["deleted-anchor", "unsupported", "empty"]) test(`${missing} saved-message reads recover through one bounded latest page`, async () => {
    const view = fixture();
    useSessionScrollStore.getState().setManualScroll("a", 500, null, { messageId: "missing", offset: 0 });
    await view.render();
    expect(view.reads[0].window).toEqual({ messageIds: ["missing"] });
    if (missing === "empty") await view.resolve(0, snapshot("a", "Saved message missing"));
    else await act(async () => view.reads[0].reject(Object.assign(new Error("Saved message unavailable"),
      missing === "deleted-anchor" ? { code: "message_not_found", status: 404 } : { status: 501 })));
    await settle();
    expect(view.reads[1].window).toEqual({ limit: 24 });
    await view.resolve(1, page(["latest"], null, null));
    expect(visibleIds(view)).toEqual(["latest"]);
    expect(view.openingError).toBeNull();
    await paint();
    await paint();
    expect(view.reads).toHaveLength(2);
  });

  test("a slow opening keeps waiting without a deadline or automatic reread", async () => {
    const view = fixture();
    await view.render();
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(view.openingError).toBeNull();
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    expect(view.host.querySelector("[data-thread-loading]")).not.toBeNull();
    expect(view.reads).toHaveLength(1);
    await view.resolve(0, page(["eventually-ready"], null, null));
    expect(visibleIds(view)).toEqual(["eventually-ready"]);
  });

  test("runtime authority restoration resumes the still-mounted pane without reading for a revoked owner", async () => {
    const view = fixture();
    const selected = { ...view.input(), ...sessionHistoryIdentity({ draftScope: "principal",
      opencodeBaseUrl: "https://history.example/opencode", runtimeWorkspaceId: "workspace", sessionId: "a" }) };
    const owners = [{ owner: selected.runtimeOwner }];
    await view.renderRuntimeOwners(owners, [selected]);
    await view.renderRuntimeOwners([], [selected]);
    await settle();
    expect(view.reads[0].signal.aborted).toBe(true);
    expect(view.reads).toHaveLength(1);
    expect(view.openingError).toBeNull();
    await view.renderRuntimeOwners(owners, [selected]);
    await settle();
    expect(view.reads).toHaveLength(2);
    expect(view.openingError).toBeNull();
    await view.resolve(0, page(["revoked"], null, null));
    expect(visibleIds(view)).toEqual([]);
    await view.resolve(1, page(["restored"], null, null));
    expect(visibleIds(view)).toEqual(["restored"]);
    await act(async () => { onlineManager.setOnline(false); onlineManager.setOnline(true); });
    await settle();
    expect(view.reads).toHaveLength(2);
  });

  test("a second cancellation exposes Retry without an automatic restart loop", async () => {
    const view = fixture();
    await view.render();
    const filters = { queryKey: openingSessionHistoryOptions(view.input()).queryKey, exact: true };
    await act(async () => { await view.client.cancelQueries(filters); });
    await settle();
    expect(view.reads).toHaveLength(2);
    await act(async () => { await view.client.cancelQueries(filters); });
    await settle();
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(view.reads).toHaveLength(2);
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => view.host.querySelector("button")?.click());
    expect(view.reads).toHaveLength(3);
    await view.resolve(2, page(["manual-recovery"], null, null));
    expect(visibleIds(view)).toEqual(["manual-recovery"]);
  });

  test("a cancelled selected opening resumes once without navigation or Retry", async () => {
    const view = fixture();
    await view.render();
    await act(async () => { await view.client.cancelQueries({ queryKey: openingSessionHistoryOptions(view.input()).queryKey, exact: true }); });
    await settle();
    expect(view.reads[0].signal.aborted).toBe(true);
    expect(view.openingError).toBeNull();
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    expect(view.host.querySelector("[data-thread-loading]")).not.toBeNull();
    expect(view.reads).toHaveLength(2);
    expect(view.reads[1].window).toEqual({ limit: 24 });
    await view.resolve(0, page(["cancelled"], null, null));
    expect(visibleIds(view)).toEqual([]);
    await view.resolve(1, page(["current"], null, null));
    expect(visibleIds(view)).toEqual(["current"]);
  });
});

describe("bounded opening completion", () => {
  test("more than 32 registered workspace tokens neither churn query credentials nor reject the active owner", async () => {
    const view = fixture();
    const runtimes = Array.from({ length: 40 }, (_, index) => ({
      ...sessionHistoryIdentity({ draftScope: "principal", opencodeBaseUrl: `https://runtime-${index}.example/opencode`,
        runtimeWorkspaceId: `workspace-${index}`, sessionId: `session-${index}` }),
      authToken: `private-runtime-token-${index}`,
    }));
    const selected = { ...view.input("session-0", runtimes[0].authToken), ...runtimes[0],
      transcriptQueryKey: transcriptKey("workspace-0", "session-0") };
    const owners = runtimes.map((runtime) => ({ owner: runtime.runtimeOwner, authToken: runtime.authToken }));
    const key = openingSessionHistoryOptions(selected).queryKey;
    await view.renderRuntimeOwners(owners, [selected]);
    expect(view.reads).toHaveLength(1);
    expect(view.reads[0].signal.aborted).toBe(false);
    expect(openingSessionHistoryOptions(selected).queryKey).toEqual(key);
    await view.renderRuntimeOwners(owners.toReversed(), [selected]);
    expect(view.reads).toHaveLength(1);
    expect(view.reads[0].signal.aborted).toBe(false);
    await view.resolve(0, page(["authorized"], null, null, "session-0"));
    expect(visibleIds(view)).toEqual(["authorized"]);
    const keys = JSON.stringify(view.client.getQueryCache().findAll().map((query) => query.queryKey));
    for (const runtime of runtimes) expect(keys).not.toContain(runtime.authToken);
  });

  test("revocation compares authority tokens even after numeric query credentials have been evicted", async () => {
    const view = fixture();
    const original = { ...view.input("a", "original"), ...sessionHistoryIdentity({ draftScope: "principal",
      opencodeBaseUrl: "https://history.example/opencode", runtimeWorkspaceId: "workspace", sessionId: "a" }) };
    await view.renderRuntimeOwners([{ owner: original.runtimeOwner, authToken: original.authToken }], [original]);
    for (let index = 0; index < 40; index++) sessionHistoryCredential(`unrelated-${index}`);
    await view.renderRuntimeOwners([{ owner: original.runtimeOwner, authToken: original.authToken }], []);
    expect(view.reads[0].signal.aborted).toBe(false);
    await view.renderRuntimeOwners([{ owner: original.runtimeOwner, authToken: "replacement" }], []);
    expect(view.reads[0].signal.aborted).toBe(true);
    await view.resolve(0, page(["revoked"], null, null));
    expect(view.reads).toHaveLength(1);
  });

  test("the last authority unmount denies stale admission and leaves a selected stale pane recoverable", async () => {
    const view = fixture();
    const original = { ...view.input("a", "original"), ...sessionHistoryIdentity({ draftScope: "principal",
      opencodeBaseUrl: "https://history.example/opencode", runtimeWorkspaceId: "workspace", sessionId: "a" }) };
    await view.renderRuntimeOwners([{ owner: original.runtimeOwner, authToken: original.authToken }], [original]);
    await view.renderRuntimeOwners(null, []);
    expect(view.reads[0].signal.aborted).toBe(true);
    const rejected = await view.client.fetchQuery(openingSessionHistoryOptions(original)).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect(view.reads).toHaveLength(1);
    await view.renderInput(original);
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.host.querySelector("[data-thread-loading]")).toBeNull();
    await act(async () => view.host.querySelector("button")?.click());
    await settle();
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.reads).toHaveLength(1);
    await view.resolve(0, page(["revoked"], null, null));
    expect(visibleIds(view)).toEqual([]);
  });

  for (const change of ["credential", "endpoint", "principal"]) test(`runtime ${change} replacement revokes an abandoned opening even with a warm disabled destination`, async () => {
    const view = fixture();
    const runtime = { draftScope: "principal-a", opencodeBaseUrl: "https://history.example/opencode", runtimeWorkspaceId: "workspace" };
    const original = { ...view.input("a", "initial"), ...sessionHistoryIdentity({ ...runtime, sessionId: "a" }) };
    const nextRuntime = { ...runtime, ...(change === "endpoint" ? { opencodeBaseUrl: "https://replacement.example/opencode" }
      : change === "principal" ? { draftScope: "principal-b" } : {}) };
    const destination = { ...view.input("b", change === "credential" ? "rotated" : "initial"),
      ...sessionHistoryIdentity({ ...nextRuntime, sessionId: "b" }) };
    view.client.setQueryData(destination.snapshotQueryKey, snapshot("b", "Warm destination", ["warm-b"]));
    await view.renderRuntimeOwners([{ owner: original.runtimeOwner, authToken: original.authToken }], [original]);
    expect(view.reads).toHaveLength(1);
    await view.renderRuntimeOwners([{ owner: destination.runtimeOwner, authToken: destination.authToken }], [destination]);
    expect(view.reads).toHaveLength(1);
    expect(view.reads[0].signal.aborted).toBe(true);
    await view.resolve(0, page(["revoked"], null, "older"));
    expect(view.client.getQueryData(openingSessionHistoryOptions(original).queryKey)).toBeUndefined();
    expect(visibleIds(view)).toEqual(["warm-b"]);
  });

  test("runtime removal while its panes are unavailable revokes only that workspace's abandoned read", async () => {
    const view = fixture();
    const runtime = { draftScope: "principal", opencodeBaseUrl: "https://history.example/opencode", runtimeWorkspaceId: "workspace" };
    const a = { ...view.input("a"), ...sessionHistoryIdentity({ ...runtime, sessionId: "a" }) };
    const b = { ...view.input("b"), ...sessionHistoryIdentity({ ...runtime, sessionId: "b" }) };
    const neighbor = { ...view.input("c"), ...sessionHistoryIdentity({ ...runtime, runtimeWorkspaceId: "neighbor", sessionId: "c" }),
      transcriptQueryKey: transcriptKey("neighbor", "c") };
    const owners = [{ owner: a.runtimeOwner }, { owner: neighbor.runtimeOwner }];
    view.client.setQueryData(b.snapshotQueryKey, snapshot("b", "Warm b", ["warm-b"]));
    await view.renderRuntimeOwners(owners, [a, neighbor], true);
    await view.renderRuntimeOwners(owners, [b, neighbor], true);
    expect(view.reads).toHaveLength(2);
    expect(view.reads.map((read) => read.signal.aborted)).toEqual([false, false]);
    await view.renderRuntimeOwners([{ owner: neighbor.runtimeOwner }], [neighbor], true);
    expect(view.reads).toHaveLength(2);
    expect(view.reads.map((read) => read.signal.aborted)).toEqual([true, false]);
    await view.resolve(0, page(["removed-runtime"], null, "older"));
    let rejected = false;
    await act(async () => {
      await view.client.fetchQuery(openingSessionHistoryOptions(a)).catch(() => { rejected = true; });
    });
    expect(rejected).toBe(true);
    expect(view.reads).toHaveLength(2);
    await view.resolve(1, page(["neighbor-c"], null, "older", "c"));
    expect(visibleIds(view)).toEqual(["neighbor-c"]);
  });

  test("unmounting one runtime authority does not revoke another provider with the same runtime workspace ID", async () => {
    const view = fixture();
    const neighbor = fixture();
    const runtime = { draftScope: "principal", opencodeBaseUrl: "https://history.example/opencode", runtimeWorkspaceId: "workspace" };
    const a = { ...view.input("a", "first"), ...sessionHistoryIdentity({ ...runtime, sessionId: "a" }) };
    const b = { ...neighbor.input("b", "second"), ...sessionHistoryIdentity({ ...runtime,
      opencodeBaseUrl: "https://neighbor.example/opencode", sessionId: "b" }) };
    await view.renderRuntimeOwners([{ owner: a.runtimeOwner, authToken: a.authToken }], [a]);
    await neighbor.renderRuntimeOwners([{ owner: b.runtimeOwner, authToken: b.authToken }], [b]);
    expect(view.reads[0].signal.aborted).toBe(false);
    expect(neighbor.reads[0].signal.aborted).toBe(false);
    await view.renderRuntimeOwners(null, []);
    expect(view.reads[0].signal.aborted).toBe(true);
    expect(neighbor.reads[0].signal.aborted).toBe(false);
    await view.resolve(0, page(["revoked"], null, "older"));
    await neighbor.resolve(0, page(["neighbor-b"], null, "older", "b"));
    expect(visibleIds(neighbor)).toEqual(["neighbor-b"]);
  });

  test("snapshot invalidation restarts a selected pending opening and does not loop after it settles", async () => {
    const view = fixture();
    await view.render();
    await act(async () => { await view.client.invalidateQueries({ queryKey: snapshotKey("workspace", "a"), exact: true }); });
    expect(view.reads).toHaveLength(2);
    expect(view.reads[0].signal.aborted).toBe(true);
    expect(view.reads[1].signal.aborted).toBe(false);
    await view.resolve(0, page(["obsolete"], null, "older"));
    expect(visibleIds(view)).toEqual([]);
    await view.resolve(1, page(["current"], null, "older"));
    expect(visibleIds(view)).toEqual(["current"]);
    expect(view.host.querySelector("[data-thread-loading]")).toBeNull();
    await settle();
    expect(view.reads).toHaveLength(2);
  });

  for (const completed of [false, true]) test(`a destination paints independently and a return adopts the ${completed ? "cached" : "in-flight"} opening`, async () => {
    const view = fixture();
    await view.render("a");
    await view.render("b");
    expect(view.reads.map((read) => [read.owner, read.signal.aborted])).toEqual([["a", false], ["b", false]]);
    await view.resolve(1, page(["destination"], null, "older", "b"));
    expect(visibleIds(view)).toEqual(["destination"]);
    if (completed) await view.resolve(0, page(["source"], null, "older"));
    expect(visibleIds(view)).toEqual(["destination"]);
    await view.render("a");
    expect(view.reads).toHaveLength(2);
    if (!completed) await view.resolve(0, page(["source"], null, "older"));
    expect(visibleIds(view)).toEqual(["source"]);
    await paint();
    await paint();
    expect(view.reads).toHaveLength(2);
    expect(view.client.getQueryData(snapshotKey("workspace", "a"))).toBeUndefined();
  });

  test("rapid switches retain only the most recently abandoned opening and fence an abort-ignoring response", async () => {
    const view = fixture();
    for (const owner of ["a", "b", "c", "d"]) await view.render(owner);
    expect(view.reads.map((read) => [read.owner, read.signal.aborted])).toEqual([["a", true], ["b", true], ["c", false], ["d", false]]);
    await view.resolve(0, page(["evicted-a"], null, "older"));
    await view.resolve(1, page(["evicted-b"], null, "older", "b"));
    expect(view.client.getQueryData(openingSessionHistoryOptions(view.input("a")).queryKey)).toBeUndefined();
    expect(view.client.getQueryData(openingSessionHistoryOptions(view.input("b")).queryKey)).toBeUndefined();
    await view.resolve(3, page(["selected-d"], null, "older", "d"));
    expect(visibleIds(view)).toEqual(["selected-d"]);
    await view.render("c");
    expect(view.reads).toHaveLength(4);
    await view.resolve(2, page(["retained-c"], null, "older", "c"));
    expect(visibleIds(view)).toEqual(["retained-c"]);
  });

  test("an abandoned opening expires without cancelling the selected read or restarting background work", async () => {
    const view = fixture();
    await view.render("a");
    await view.render("b");
    await act(async () => { jest.advanceTimersByTime(5_001); });
    expect(view.reads.map((read) => read.signal.aborted)).toEqual([true, false]);
    await view.resolve(0, page(["too-late"], null, "older"));
    expect(view.client.getQueryData(openingSessionHistoryOptions(view.input()).queryKey)).toBeUndefined();
    expect(view.reads).toHaveLength(2);
    await view.render("a");
    expect(view.reads).toHaveLength(3);
    await view.resolve(2, page(["fresh"], null, "older"));
    expect(visibleIds(view)).toEqual(["fresh"]);
  });

  test("re-adoption removes the abandonment deadline and settled openings revalidate after two seconds", async () => {
    const view = fixture();
    await view.render("a");
    await view.render("b");
    await act(async () => { jest.advanceTimersByTime(4_000); });
    await view.render("a");
    await act(async () => { jest.advanceTimersByTime(1_100); });
    expect(view.reads[0].signal.aborted).toBe(false);
    await view.resolve(0, page(["first"], null, "older"));
    await view.render("b");
    await act(async () => { jest.advanceTimersByTime(2_001); });
    await view.render("a");
    expect(view.reads).toHaveLength(3);
    await view.resolve(2, page(["updated"], null, "older"));
    expect(visibleIds(view)).toEqual(["updated"]);
  });

  test("both visible split panes are exempt from the abandoned-read budget", async () => {
    const view = fixture();
    await view.renderSplit("a", "b");
    await view.renderSplit("c", "b");
    await view.renderSplit("d", "b");
    expect(view.reads.map((read) => [read.owner, read.signal.aborted])).toEqual([["a", true], ["b", false], ["c", false], ["d", false]]);
    await view.resolve(1, page(["right-b"], null, "older", "b"));
    await view.resolve(3, page(["left-d"], null, "older", "d"));
    expect(view.host.querySelector('[data-pane="left"]')?.textContent).toContain("left-d");
    expect(view.host.querySelector('[data-pane="left"]')?.textContent).not.toContain("right-b");
    expect(view.host.querySelector('[data-pane="right"]')?.textContent).toContain("right-b");
    await view.resolve(2, page(["background-c"], null, "older", "c"));
    expect(view.host.textContent).not.toContain("background-c");
  });

  for (const change of ["owner", "credential"]) test(`an abandoned opening cannot survive ${change} replacement`, async () => {
    const view = fixture();
    const original = view.input("a", "initial");
    await view.renderInput(original);
    await view.render("b", "initial");
    expect(view.reads[0].signal.aborted).toBe(false);
    await view.render("a", change === "credential" ? "rotated" : "initial", change === "owner" ? "replacement" : "a");
    expect(view.reads[0].signal.aborted).toBe(true);
    await view.resolve(0, page(["obsolete"], null, "older"));
    expect(view.client.getQueryData(openingSessionHistoryOptions(original).queryKey)).toBeUndefined();
    await view.resolve(2, page(["authorized"], null, "older"));
    expect(visibleIds(view)).toEqual(["authorized"]);
  });

  test("credential rotation on another conversation revokes the workspace's abandoned opening", async () => {
    const view = fixture();
    const original = view.input("a", "initial");
    await view.renderInput(original);
    await view.render("b", "initial");
    expect(view.reads[0].signal.aborted).toBe(false);
    await view.render("b", "rotated");
    expect(view.reads[0].signal.aborted).toBe(true);
    expect(view.reads[1].signal.aborted).toBe(true);
    await view.resolve(0, page(["revoked"], null, "older"));
    expect(view.client.getQueryData(openingSessionHistoryOptions(original).queryKey)).toBeUndefined();
    await view.resolve(2, page(["current"], null, "older", "b"));
    expect(visibleIds(view)).toEqual(["current"]);
  });

  test("two panes observing the same opening dedupe and keep it active when just one pane switches", async () => {
    const view = fixture();
    await view.renderSplit("a", "a");
    expect(view.reads).toHaveLength(1);
    await view.renderSplit("b", "a");
    await view.renderSplit("c", "a");
    await act(async () => { jest.advanceTimersByTime(5_001); });
    expect(view.reads.map((read) => [read.owner, read.signal.aborted])).toEqual([["a", false], ["b", true], ["c", false]]);
    await view.resolve(0, page(["shared-a"], null, "older"));
    expect(view.host.querySelector('[data-pane="right"]')?.textContent).toContain("shared-a");
    expect(view.host.querySelector('[data-pane="left"]')?.textContent).not.toContain("shared-a");
  });

  for (const change of ["reset", "remove", "replace", "invalidate"]) test(`snapshot query ${change} rejects an abandoned completion`, async () => {
    const view = fixture();
    await view.render("a");
    await view.render("b");
    const filters = { queryKey: snapshotKey("workspace", "a"), exact: true };
    await act(async () => {
      if (change === "reset") await view.client.resetQueries(filters);
      else if (change === "invalidate") await view.client.invalidateQueries({ ...filters, refetchType: "none" });
      else {
        view.client.removeQueries(filters);
        if (change === "replace") view.client.setQueryData(filters.queryKey, snapshot("a", "Replacement"));
      }
    });
    expect(view.reads[0].signal.aborted).toBe(true);
    expect(view.reads[1].signal.aborted).toBe(false);
    await view.resolve(0, page(["obsolete"], null, "older"));
    expect(view.client.getQueryData(openingSessionHistoryOptions(view.input()).queryKey)).toBeUndefined();
    expect(view.reads).toHaveLength(2);
    expect(view.host.textContent).not.toContain("obsolete");
  });

  for (const layer of ["opening", "page"]) for (const change of ["reset", "invalidate", "remove"]) test(`${layer} query ${change} fences an abandoned read`, async () => {
    const view = fixture();
    await view.render();
    const queryKey = layer === "opening" ? openingSessionHistoryOptions(view.input()).queryKey
      : view.client.getQueryCache().findAll().find((query) => query.queryKey.includes("opening-read"))?.queryKey;
    if (!queryKey) throw new Error("The opening page query is missing");
    await view.render("b");
    await act(async () => {
      const filters = { queryKey, exact: true };
      if (change === "reset") await view.client.resetQueries(filters);
      else if (change === "remove") view.client.removeQueries(filters);
      else await view.client.invalidateQueries({ ...filters, refetchType: "none" });
    });
    expect(view.reads[0].signal.aborted).toBe(true);
    await view.resolve(0, page(["obsolete"], null, "older"));
    expect(view.reads).toHaveLength(2);
    expect(view.client.getQueryData(openingSessionHistoryOptions(view.input()).queryKey)).toBeUndefined();
    await view.resolve(1, page(["current-b"], null, "older", "b"));
    expect(visibleIds(view)).toEqual(["current-b"]);
  });

  test("resetting the selected snapshot starts a fresh opening without accepting the displaced response", async () => {
    const view = fixture();
    await view.render();
    await act(async () => { await view.client.resetQueries({ queryKey: snapshotKey("workspace", "a"), exact: true }); });
    expect(view.reads[0].signal.aborted).toBe(true);
    expect(view.reads).toHaveLength(2);
    await view.resolve(0, page(["displaced"], null, "older"));
    expect(visibleIds(view)).toEqual([]);
    await view.resolve(1, page(["current"], null, "older"));
    expect(visibleIds(view)).toEqual(["current"]);
  });
});

describe("native paged history", () => {
  test("page aggregation touches each native ID once and preserves overlapping order with deduplication", () => {
    const pages = Array.from({ length: 40 }, (_, index) => page(Array.from({ length: 24 }, (_, row) => `id-${index * 23 + row}`), `entry-${index}`, null));
    let reads = 0;
    for (const current of pages) for (const message of current.messages) {
      const id = message.info.id;
      Object.defineProperty(message.info, "id", { get: () => { reads++; return id; } });
    }
    const merged = mergeSessionHistoryPages(pages, () => true);
    expect(reads).toBe(40 * 24);
    expect(merged.messages.map((message) => message.info.id)).toEqual(Array.from({ length: 40 * 23 + 1 }, (_, index) => `id-${index}`));
  });

  test("saved-page provenance lookup reuses its index instead of scanning native rows on scroll", async () => {
    const view = fixture();
    const latest = page(fullWindow, null, "older");
    await view.render();
    await view.resolve(0, latest);
    let reads = 0;
    for (const message of latest.messages) {
      const id = message.info.id;
      Object.defineProperty(message.info, "id", { get: () => { reads++; return id; } });
    }
    for (let pass = 0; pass < 20; pass++) for (const id of fullWindow) expect(view.pages.pageForAnchor(id)?.before).toBeNull();
    expect(reads).toBe(0);
  });

  test("sending from a restored middle window installs latest history and preserves concurrently arriving live rows", async () => {
    const store = useSessionScrollStore.getState();
    store.setManualScroll("a", 500, null, { messageId: "reading", offset: -20 });
    store.setGeometry("a", { owner: "a", scrollHeight: 4000, viewportWidth: 600, before: 480, after: 2400, messageIds: ["reading"],
      page: { before: "middle", limit: 24, lineage: [null, "middle"] } });
    const view = fixture();
    const event = sessionEvents();
    await view.render();
    await view.resolve(0, page(["reading"], "middle", "older"));
    let preparing: Promise<OpenworkSessionHistory["messages"]> = Promise.resolve([]);
    await act(async () => { preparing = view.readSendHistory({ revealLatest: true }); });
    expect(view.reads[1].window).toEqual({ limit: 24 });
    for (const [id, role] of [["server-user", "user"], ["server-assistant", "assistant"]]) {
      await event({ type: "message.updated", properties: { info: { id, sessionID: "a", role, time: { created: 100 } } } });
    }
    await view.resolve(1, page(["previous-tail"], null, "intervening"));
    expect((await preparing).map((message) => message.info.id)).toEqual(["previous-tail"]);
    expect(view.pages.hasNewer).toBe(false);
    expect(visibleIds(view)).toEqual(["previous-tail", "server-user", "server-assistant"]);
    await event({ type: "message.part.updated", properties: { part: {
      id: "answer", sessionID: "a", messageID: "server-assistant", type: "text", text: "Still streaming", time: { start: 100 },
    } } });
    expect(view.host.textContent).toContain("Still streaming");
    expect(view.latestReads).toHaveLength(0);
    expect(view.reads.every((read) => read.window)).toBe(true);
  });

  test("warm page return revalidates a bounded page after text, tool and terminal corrections", async () => {
    const view = fixture();
    const event = sessionEvents();
    await view.render();
    await view.resolve(0, { ...historyTool("old-output"), pagination: { limit: 24, nextCursor: "older" } });
    const corrected = historyTool("correct-output");
    corrected.messages[1].parts[0] = { id: "part-active", sessionID: "a", messageID: "active", type: "text", text: "correct-text" };
    for (const part of corrected.messages[1].parts) await event({ type: "message.part.updated", properties: { part } });
    await act(async () => { void view.client.invalidateQueries({ queryKey: snapshotKey("workspace", "a"), exact: true }); });
    await view.resolve(1, { ...corrected, pagination: { limit: 24, nextCursor: "older" } });
    expect(view.host.textContent).toContain("correct-output");
    await view.render("b");
    await view.render("a");
    expect(view.reads[3].window).toEqual({ limit: 24 });
    expect(view.host.textContent).not.toContain("old-output");
    await view.resolve(3, { ...corrected, pagination: { limit: 24, nextCursor: "older" } });
    expect(view.host.textContent).toContain("correct-output");
    expect(view.host.textContent).toContain("correct-text");
    expect(view.reads.every((read) => read.window)).toBe(true);
  });

  test("a saved newest-page anchor pushed out by appends is recovered through bounded older pages", async () => {
    const store = useSessionScrollStore.getState();
    store.setManualScroll("a", 500, null, { messageId: "saved-anchor", offset: -20 });
    store.setGeometry("a", { owner: "a", scrollHeight: 1000, viewportWidth: 600, before: 0, after: 300, messageIds: ["saved-anchor"],
      page: { before: null, limit: 24, lineage: [null] } });
    const view = fixture();
    await view.render();
    await view.resolve(0, page(fullWindow, null, "appended-boundary"));
    expect(view.pages.anchorPending).toBe(true);
    expect(view.reads[1].window).toEqual({ limit: 24, before: "appended-boundary" });
    expect(useSessionScrollStore.getState().sessions.a).toMatchObject({ anchor: { messageId: "saved-anchor", offset: -20 } });
    await view.resolve(1, page(["saved-anchor", "previous-tail"], "appended-boundary", "older"));
    expect(view.pages.anchorPending).toBe(false);
    expect(visibleIds(view)).toEqual(["saved-anchor", "previous-tail", ...fullWindow]);
    expect(view.pages.pageForAnchor("saved-anchor")?.before).toBe("appended-boundary");
    expect(view.reads).toHaveLength(2);
    expect(view.client.getQueryData(snapshotKey("workspace", "a"))).toBeUndefined();
  });

  test("live session metadata activates the revert boundary without refreshing tool status", async () => {
    const view = fixture();
    const event = sessionEvents();
    await view.render("a", "history-test");
    await view.resolve(0, page(["visible", "boundary", "hidden"], null, "older"));
    await event({ type: "session.updated", properties: { info: { id: "a", revert: { messageID: "boundary" } } } });
    expect(visibleIds(view)).toEqual([]);
    expect(view.reads).toHaveLength(1);
    expect(view.latestReads).toHaveLength(0);
    await paint();
    await paint();
    expect(view.reads[1].window).toBeUndefined();
    await view.resolve(1, snapshot("a", "Reverted", ["oldest", "visible", "boundary", "hidden"], "boundary"));
    expect(visibleIds(view)).toEqual(["oldest", "visible"]);
  });

  for (const boundary of ["token", "engine"]) test(`metadata from another ${boundary} cannot hide the current page`, async () => {
    const view = fixture();
    const event = sessionEvents();
    const input = view.input("a", boundary === "token" ? "different-token" : "history-test");
    if (boundary === "engine") input.metadataQueryKey = sessionMetadataKey({ workspaceId: "workspace", baseUrl: "https://history.example/opencode2", openworkToken: "history-test" }, "a");
    await view.renderInput(input);
    await view.resolve(0, page(["visible", "boundary"], null, "older"));
    await event({ type: "session.updated", properties: { info: { id: "a", revert: { messageID: "boundary" } } } });
    expect(visibleIds(view)).toEqual(["visible", "boundary"]);
    await paint();
    await paint();
    expect(view.reads).toHaveLength(1);
  });

  test("exhausted native coverage enables complete transcript and unanswered admission gates without a full-key placeholder", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["unanswered-user"], null, null));
    expect(view.host.querySelector('[data-history-complete="true"]')).not.toBeNull();
    expect(view.host.querySelector('[data-admission-unresolved="true"]')).not.toBeNull();
    expect(view.client.getQueryData(snapshotKey("workspace", "a"))).toBeUndefined();
    await paint();
    await paint();
    expect(view.reads).toHaveLength(1);
  });

  test("opens one bounded page and only loads older history on demand, with deduplication and explicit exhaustion", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(fullWindow, null, "older-entry"));
    await paint();
    await paint();
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }]);
    expect(view.client.getQueryData(snapshotKey("workspace", "a"))).toBeUndefined();
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    const pending = await demand(view, "older");
    expect(view.reads[1].window).toEqual({ limit: 24, before: "older-entry" });
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("Loading earlier messages…");
    await view.resolve(1, page(["first", fullWindow[0]], "older-entry", null));
    await pending.settled;
    expect(visibleIds(view)).toEqual(["first", ...fullWindow]);
    expect(view.pages.hasOlder).toBe(false);
    expect(view.pages.complete).toBe(true);
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    await demand(view, "older");
    expect(view.reads).toHaveLength(2);
    expect(view.client.getQueryData(snapshotKey("workspace", "a"))).toBeUndefined();
  });

  test("exactly N messages with nextCursor null are exhausted, not an invitation to fetch uncapped history", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(fullWindow, null, null));
    await paint();
    await paint();
    expect(view.pages.complete).toBe(true);
    await demand(view, "older");
    expect(view.reads).toHaveLength(1);
    expect(visibleIds(view)).toEqual(fullWindow);
  });

  test("persists the engine cursor and lineage, cold-reopens one page, then fills newer pages without splicing a live tail across a gap", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["latest"], null, "middle-entry"));
    const older = await demand(view, "older");
    await view.resolve(1, page(["reading"], "middle-entry", "oldest-entry"));
    await older.settled;
    const provenance = view.pages.pageForAnchor("reading:steps");
    expect(provenance).toEqual({ before: "middle-entry", limit: 24, lineage: [null, "middle-entry"] });
    const store = useSessionScrollStore.getState();
    const key = sessionScrollKey("a", "a");
    store.setManualScroll(key, 500, null, { messageId: "reading", offset: -20 });
    store.setGeometry(key, { owner: "a", scrollHeight: 4000, viewportWidth: 600, before: 480, after: 2400, messageIds: ["reading"], page: provenance });
    flushSessionScrollState();
    await cleanups.pop()?.();
    useSessionScrollStore.setState({ sessions: readPersistedSessionScrollState() });
    const reopened = fixture();
    await reopened.render();
    expect(reopened.reads[0].window).toEqual({ limit: 24, before: "middle-entry" });
    await reopened.resolve(0, page(["reading"], "middle-entry", "oldest-entry"));
    await act(async () => reopened.client.setQueryData<UIMessage[]>(transcriptKey("workspace", "a"), [
      ...snapshotToUIMessages(snapshot("a", "", ["reading"])), { id: "live-tail", role: "assistant", parts: [] },
    ]));
    await settle();
    expect(visibleIds(reopened)).toEqual(["reading"]);
    const sendHistory = reopened.readSendHistory();
    expect(reopened.latestReads).toHaveLength(1);
    expect(reopened.reads).toHaveLength(1);
    await reopened.resolveLatest(0, snapshot("a", "Latest for sending", ["live-tail"]));
    expect((await sendHistory).map((message) => message.info.id)).toEqual(["live-tail"]);
    expect(visibleIds(reopened)).toEqual(["reading"]);
    const newer = await demand(reopened, "newer");
    expect(reopened.reads[1].window).toEqual({ limit: 24 });
    await reopened.resolve(1, page(["latest", "live-tail"], null, "middle-entry"));
    await newer.settled;
    expect(visibleIds(reopened)).toEqual(["reading", "latest", "live-tail"]);
    expect(reopened.pages.hasNewer).toBe(false);
    expect(reopened.reads.every((read) => read.window && !read.window.messageIds)).toBe(true);
  });

  test("deep reading positions retain a bounded lineage of engine-issued cursors instead of falling back to message IDs", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["newest"], null, "cursor-1"));
    for (let index = 1; index <= 64; index++) {
      const pending = await demand(view, "older");
      await view.resolve(index, page([`message-${index}`], `cursor-${index}`, `cursor-${index + 1}`));
      await pending.settled;
    }
    const position = view.pages.pageForAnchor("message-64");
    expect(position?.before).toBe("cursor-64");
    expect(position?.lineage).toEqual([null, ...Array.from({ length: 63 }, (_, index) => `cursor-${index + 2}`)]);
    expect(view.reads.every((read) => read.window && !read.window.messageIds)).toBe(true);
  });

  test("a shifted newest page stays detached until demand fills its intervening cursor", async () => {
    const store = useSessionScrollStore.getState();
    store.setManualScroll("a", 500, null, { messageId: "reading", offset: 0 });
    store.setGeometry("a", { owner: "a", scrollHeight: 4000, viewportWidth: 600, before: 480, after: 2400, messageIds: ["reading"],
      page: { before: "middle", limit: 24, lineage: [null, "middle"] } });
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["reading"], "middle", "oldest"));
    const newer = await demand(view, "newer");
    await view.resolve(1, page(["newest"], null, "intervening"));
    await newer.settled;
    expect(visibleIds(view)).toEqual(["reading"]);
    expect(view.reads).toHaveLength(2);
    const bridge = await demand(view, "newer");
    expect(view.reads[2].window).toEqual({ limit: 24, before: "intervening" });
    await view.resolve(2, page(["between"], "intervening", "middle"));
    await bridge.settled;
    expect(visibleIds(view)).toEqual(["reading", "between", "newest"]);
    expect(view.pages.pageForAnchor("reading")?.lineage).toEqual([null, "intervening", "middle"]);
  });

  test("failed and repeated cursors retain readable messages and only announce actual loads", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["latest"], null, "older"));
    const older = await demand(view, "older");
    await view.resolve(1, page(["bad"], "older", "older"));
    await older.settled;
    await settle();
    expect(visibleIds(view)).toEqual(["latest"]);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
    await act(async () => view.host.querySelector("button")?.click());
    expect(view.reads[2].window).toEqual({ before: "older", limit: 24 });
    await view.resolve(2, page(["first"], "older", null));
    expect(visibleIds(view)).toEqual(["first", "latest"]);
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
  });

  for (const change of ["session", "owner", "credential"]) test(`a late page is aborted and fenced after ${change} changes`, async () => {
    const view = fixture();
    await view.render("a", "initial");
    await view.resolve(0, page(["original"], null, "older"));
    const oldLoad = view.pages.load;
    const pending = await demand(view, "older");
    await view.render(change === "session" ? "b" : "a", change === "credential" ? "rotated" : "initial", change === "owner" ? "other-engine" : change === "session" ? "b" : "a");
    expect(view.reads[1].signal.aborted).toBe(true);
    await view.resolve(1, page(["late-old-page"], "older", null));
    await pending.settled;
    await view.resolve(2, page(["destination"], null, "destination-older", change === "session" ? "b" : "a"));
    expect(visibleIds(view)).toEqual(["destination"]);
    const count = view.reads.length;
    await oldLoad("older");
    expect(view.reads).toHaveLength(count);
  });

  test("deletion during the first read retries only the bounded page and rejects its stale response", async () => {
    const view = fixture();
    const event = sessionEvents();
    await view.render();
    await event({ type: "message.removed", properties: { sessionID: "a", messageID: "removed-before-open" } });
    expect(view.reads[0].signal.aborted).toBe(true);
    expect(view.reads[1].window).toEqual({ limit: 24 });
    await view.resolve(0, page(["removed-before-open"], null, null));
    expect(visibleIds(view)).toEqual([]);
    await view.resolve(1, page(["kept"], null, "older"));
    await paint();
    await paint();
    expect(visibleIds(view)).toEqual(["kept"]);
    expect(view.reads).toHaveLength(2);
  });

  test("warm page reopen cannot reuse an opening snapshot invalidated by removal", async () => {
    const view = fixture();
    const event = sessionEvents();
    await view.render();
    await view.resolve(0, page(["kept", "removed"], null, "older"));
    await event({ type: "message.removed", properties: { sessionID: "a", messageID: "removed" } });
    await view.render("b");
    await view.render("a");
    expect(visibleIds(view)).not.toContain("removed");
    expect(view.reads[2].window).toEqual({ limit: 24 });
    await view.resolve(2, page(["kept"], null, "older"));
    expect(visibleIds(view)).toEqual(["kept"]);
    expect(view.reads.every((read) => read.window)).toBe(true);
  });

  test("an unseen removed message aborts an older read even before that message has entered the window", async () => {
    const view = fixture();
    const event = sessionEvents();
    await view.render();
    await view.resolve(0, page(["latest"], null, "older"));
    const pending = await demand(view, "older");
    await event({ type: "message.removed", properties: { sessionID: "a", messageID: "unseen" } });
    expect(view.reads[1].signal.aborted).toBe(true);
    await view.resolve(1, page(["unseen"], "older", null));
    await pending.settled;
    expect(visibleIds(view)).toEqual(["latest"]);
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    expect(view.reads).toHaveLength(2);
  });

  test("removal cancels a pending page and cannot be resurrected by cached pages or a bounded terminal refresh", async () => {
    const view = fixture();
    const event = sessionEvents();
    await view.render();
    await view.resolve(0, page(["keep", "remove"], null, "older"));
    const older = await demand(view, "older");
    await event({ type: "message.removed", properties: { sessionID: "a", messageID: "remove" } });
    expect(view.reads[1].signal.aborted).toBe(true);
    await view.resolve(1, page(["earlier", "remove"], "older", null));
    await older.settled;
    expect(visibleIds(view)).toEqual(["keep"]);
    await act(async () => { void view.client.invalidateQueries({ queryKey: snapshotKey("workspace", "a"), exact: true }); });
    expect(view.reads[2].window).toEqual({ limit: 24 });
    await view.resolve(2, page(["keep", "remove", "terminal"], null, "older"));
    expect(visibleIds(view)).toEqual(["keep", "terminal"]);
    expect(view.reads.every((read) => read.window)).toBe(true);
  });

  test("bounded reconciliation preserves live tool corrections against a stale read and unrelated older-page hydration", async () => {
    const view = fixture();
    const event = sessionEvents();
    await view.render();
    await view.resolve(0, { ...historyTool("output-A"), pagination: { limit: 24, nextCursor: "older" } });
    await act(async () => { void view.client.invalidateQueries({ queryKey: snapshotKey("workspace", "a"), exact: true }); });
    const correction = historyTool("output-B", "corrected").messages[1].parts[1];
    await event({ type: "message.part.updated", properties: { part: correction } });
    await view.resolve(1, { ...historyTool("output-A"), pagination: { limit: 24, nextCursor: "older" } });
    expect(view.host.textContent).toContain("output-B");
    expect(view.host.textContent).not.toContain("output-A");
    const older = await demand(view, "older");
    await view.resolve(2, page(["earlier"], "older", null));
    await older.settled;
    expect(view.host.textContent).toContain("output-B");
    expect(view.host.textContent).not.toContain("output-A");
    await act(async () => { void view.client.invalidateQueries({ queryKey: snapshotKey("workspace", "a"), exact: true }); });
    await view.resolve(3, { ...historyTool("output-C", "corrected"), pagination: { limit: 24, nextCursor: "older" } });
    expect(view.host.textContent).toContain("output-C");
    expect(view.reads.every((read) => read.window)).toBe(true);
  });

  test("a disjoint terminal refresh preserves a manual window until the intervening page is demanded", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["reading"], null, "old"));
    useSessionScrollStore.getState().setManualScroll(sessionScrollKey("a", "a"), 100, null, { messageId: "reading", offset: -20 });
    await act(async () => { void view.client.invalidateQueries({ queryKey: snapshotKey("workspace", "a"), exact: true }); });
    await view.resolve(1, page(["newest"], null, "bridge"));
    expect(visibleIds(view)).toEqual(["reading"]);
    expect(view.pages.hasNewer).toBe(true);
    expect(view.pages.pageForAnchor("reading")).toBeUndefined();
    const pending = await demand(view, "newer");
    expect(view.reads[2].window).toEqual({ limit: 24, before: "bridge" });
    await view.resolve(2, page(["reading", "between"], "bridge", "old"));
    await pending.settled;
    expect(visibleIds(view)).toEqual(["reading", "between", "newest"]);
    expect(view.pages.pageForAnchor("reading")?.before).toBe("bridge");
  });

  test("jumping to latest fetches one newest page without rendering the old middle window beside it", async () => {
    const store = useSessionScrollStore.getState();
    store.setManualScroll("a", 400, null, { messageId: "middle", offset: 0 });
    store.setGeometry("a", { owner: "a", scrollHeight: 2000, viewportWidth: 600, before: 300, after: 800, messageIds: ["middle"],
      page: { before: "middle-entry", limit: 24, lineage: [null, "middle-entry"] } });
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["middle"], "middle-entry", "older"));
    const pending = await demand(view, "latest");
    expect(view.reads[1].window).toEqual({ limit: 24 });
    await view.resolve(1, page(["latest"], null, "intervening"));
    await pending.settled;
    expect(visibleIds(view)).toEqual(["latest"]);
    expect(view.pages.hasNewer).toBe(false);
    expect(view.pages.hasOlder).toBe(true);
  });

  test("Find and full operations demand complete history while sends retain the latest bounded reader", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, page(["recent"], null, "older"));
    await view.find();
    expect(view.reads[1].window).toBeUndefined();
    await view.resolve(1, snapshot("a", "Complete", ["find-older", "recent"]));
    expect(visibleIds(view)).toEqual(["find-older", "recent"]);
    const operation = mock();
    const pending = view.runWithFullSnapshot(operation, { fresh: true });
    expect(view.reads[2].window).toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
    await view.resolve(2, snapshot("a", "Fresh", ["find-older", "recent", "new"]));
    await pending;
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test("reverted native pages remain hidden until the full ordering arrives", async () => {
    const view = fixture();
    await view.render();
    const reverted = page(["hidden"], null, "older");
    reverted.session.revert = { messageID: "boundary" };
    await view.resolve(0, reverted);
    expect(visibleIds(view)).toEqual([]);
    await paint();
    await paint();
    expect(view.reads[1].window).toBeUndefined();
    await view.resolve(1, snapshot("a", "Reverted", ["visible", "boundary", "hidden"], "boundary"));
    expect(visibleIds(view)).toEqual(["visible"]);
  });
});

describe("opening a thread", () => {
  test("preview and full history become readable without an activity snapshot", async () => {
    const view = fixture();
    await view.render();
    const preview = snapshot("a", "Readable preview", ["msg_latest"]);
    await view.resolve(0, { session: preview.session, messages: preview.messages });
    expect(view.host.textContent).toContain("msg_latest");
    expect(view.host.querySelector("[data-thread-loading]")).toBeNull();
    expect(view.client.getQueryData(snapshotKey("workspace", "a"))).toBeUndefined();
    await paint();
    await paint();
    const full = snapshot("a", "Readable full history", ["msg_old", "msg_latest"]);
    await view.resolve(1, { session: full.session, messages: full.messages });
    expect(view.host.textContent).toContain("msg_old");
    expect(view.host.textContent).toContain("msg_latest");
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    const cached = view.client.getQueryData<OpenworkSessionHistory>(snapshotKey("workspace", "a"));
    expect(cached?.status).toBeUndefined();
    expect(cached?.todos).toBeUndefined();
  });

  for (const openworkWorkspaceId of [undefined, "runtime-x"]) test(`remote sidebar alias shares runtime preview/full keys with click (explicit runtime ID=${Boolean(openworkWorkspaceId)})`, async () => {
    const sidebarWorkspaceId = "rem_x";
    const endpoint = resolveWorkspaceEndpoint({ id: sidebarWorkspaceId, workspaceType: "remote", baseUrl: "https://worker.example", openworkToken: "remote-token", openworkWorkspaceId }, { baseUrl: "http://localhost:7777", token: "local-token" });
    if (!endpoint) throw new Error("Missing remote endpoint");
    const runtimeWorkspaceId = openworkWorkspaceId ?? "x";
    expect(endpoint.workspaceId).toBe(runtimeWorkspaceId);
    // The route's resolved engine can be v2 even though endpoint.opencodeBaseUrl
    // is v1. Both prefetch and the mounted primary surface use this resolved URL.
    const opencodeBaseUrl = `${endpoint.mountedBaseUrl}/opencode2`;
    const draftScope = "org-a/member-a";
    const prefetchIdentity = sessionHistoryIdentity({ draftScope, opencodeBaseUrl, runtimeWorkspaceId: endpoint.workspaceId, sessionId: "a" });
    const surfaceIdentity = sessionHistoryIdentity({ draftScope, opencodeBaseUrl, runtimeWorkspaceId, sessionId: "a" });
    expect(prefetchIdentity).toEqual(surfaceIdentity);
    expect(prefetchIdentity.owner).toBe(JSON.stringify([draftScope, opencodeBaseUrl, runtimeWorkspaceId, "a"]));
    expect(prefetchIdentity.snapshotQueryKey).toEqual(snapshotKey(runtimeWorkspaceId, "a"));
    expect(prefetchIdentity.snapshotQueryKey).not.toEqual(snapshotKey(sidebarWorkspaceId, "a"));
    const view = fixture();
    view.client.setQueryData(snapshotKey(sidebarWorkspaceId, "a"), snapshot("a", "Wrong alias cache"));
    const warmed = { ...view.input("a", endpoint.token), ...prefetchIdentity };
    const clicked = { ...view.input("a", endpoint.token), ...surfaceIdentity };
    const cancel = prefetchOpeningSessionHistory(view.client, warmed);
    expect(view.reads.map((read) => [read.authToken, read.window])).toEqual([["remote-token", { limit: 24 }]]);
    await view.renderInput(clicked);
    cancel?.();
    expect(view.reads).toHaveLength(1);
    expect(view.reads[0].signal.aborted).toBe(false);
    expect(view.host.textContent).not.toContain("Wrong alias cache");
    await view.resolve(0, "Shared remote preview");
    expect(view.host.textContent).toContain("Shared remote preview");
    expect(view.reads).toHaveLength(1);

    const openingKey = openingSessionHistoryOptions(clicked).queryKey;
    for (const identity of [
      sessionHistoryIdentity({ draftScope: "org-a/member-b", opencodeBaseUrl, runtimeWorkspaceId, sessionId: "a" }),
      sessionHistoryIdentity({ draftScope, opencodeBaseUrl: endpoint.opencodeBaseUrl, runtimeWorkspaceId, sessionId: "a" }),
      sessionHistoryIdentity({ draftScope, opencodeBaseUrl, runtimeWorkspaceId: sidebarWorkspaceId, sessionId: "a" }),
    ]) expect(openingSessionHistoryOptions({ ...clicked, ...identity }).queryKey).not.toEqual(openingKey);
    const rotated = { ...view.input("a", "rotated-token"), ...surfaceIdentity };
    expect(openingSessionHistoryOptions(rotated).queryKey).not.toEqual(openingKey);
    await view.renderInput(rotated);
    expect(view.reads).toHaveLength(2);
    expect(view.host.textContent).not.toContain("Shared remote preview");
    const nextPrincipal = {
      ...rotated,
      ...sessionHistoryIdentity({ draftScope: "org-b/member-c", opencodeBaseUrl, runtimeWorkspaceId, sessionId: "a" }),
    };
    await view.renderInput(nextPrincipal);
    expect(view.reads[1].signal.aborted).toBe(true);
    await view.resolve(1, "Old principal preview");
    expect(view.host.textContent).not.toContain("Old principal preview");
    await view.resolve(2, "Current principal preview");
    expect(view.host.textContent).toContain("Current principal preview");

    // A complete runtime snapshot, not the sidebar alias entry, skips warming.
    await act(async () => view.client.setQueryData(surfaceIdentity.snapshotQueryKey, snapshot("a", "Complete runtime history")));
    await settle();
    prefetchOpeningSessionHistory(view.client, nextPrincipal);
    expect(view.reads).toHaveLength(3);
    expect(view.reads.map((read) => read.authToken)).toEqual(["remote-token", "rotated-token", "rotated-token"]);
    expect(view.reads.every((read) => read.window?.limit === 24)).toBe(true);
  });

  test("a cold failure offers Retry and immediate Retrying without replacing the draft or reserved geometry", async () => {
    const view = fixture();
    await view.render();
    const composer = view.host.querySelector("input");
    if (!composer) throw new Error("Missing composer");
    composer.value = "Keep this draft";
    const geometry = view.host.querySelector("[data-thread-loading]")?.getAttribute("style");
    await act(async () => view.reads[0].reject(new Error("Preview unavailable")));
    await settle();
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("This conversation could not be loaded.");
    await paint();
    await paint();
    expect(view.reads).toHaveLength(1);
    expect(view.host.querySelector("[data-thread-loading]")).toBeNull();
    expect(view.host.querySelector("[data-thread-placeholder]")?.getAttribute("style")).toBe(geometry);
    const retry = view.host.querySelector("button");
    expect(retry?.type).toBe("button");
    expect(retry?.disabled).toBe(false);
    retry?.focus();
    expect(document.activeElement).toBe(retry);
    await act(async () => { retry?.click(); retry?.click(); });
    expect(view.host.querySelector("button")?.disabled).toBe(true);
    expect(view.host.querySelector('[data-thread-history-status] [role="status"]')?.textContent).toContain("Loading conversation");
    expect(view.host.querySelector("button")?.getAttribute("aria-label")).toBe("Reload conversation");
    expect(view.reads).toHaveLength(2);
    expect(view.reads[1].window).toEqual({ limit: 24 });
    await act(async () => view.reads[1].reject(new Error("Still unavailable")));
    await settle();
    expect(view.host.querySelector("button")?.getAttribute("aria-label")).toBe("Reload conversation");
    await act(async () => view.host.querySelector("button")?.click());
    await view.resolve(2, page(["Recovered history"], null, null));
    expect(view.host.textContent).toContain("Recovered history");
    await paint();
    await paint();
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }, { limit: 24 }, { limit: 24 }]);
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    expect(view.host.querySelector("input")).toBe(composer);
    expect(composer.value).toBe("Keep this draft");
  });

  for (const resolved of [false, true]) test(`deliberate prefetch shares the opening query on click (resolved=${resolved})`, async () => {
    const view = fixture();
    const cancel = prefetchOpeningSessionHistory(view.client, view.input());
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }]);
    if (resolved) await view.resolve(0, "Warmed preview");
    await view.render();
    cancel?.(); // Release after click must not cancel the new observer's read.
    expect(view.reads[0].signal.aborted).toBe(false);
    expect(view.reads).toHaveLength(1);
    if (!resolved) await view.resolve(0, "Warmed preview");
    expect(view.host.textContent).toContain("Warmed preview");
    expect(view.client.getQueryData(snapshotKey("workspace", "a"))).toBeUndefined();
    await paint();
    await paint();
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }, undefined]);
  });

  test("speculation has no queue or parallel neighbor reads, cancels abandoned intent, and never reports optional errors", async () => {
    const view = fixture();
    const cancel = prefetchOpeningSessionHistory(view.client, view.input());
    for (const id of ["a", "b", "c", "d"]) prefetchOpeningSessionHistory(view.client, view.input(id));
    expect(view.reads).toHaveLength(1);
    cancel?.();
    expect(view.reads[0].signal.aborted).toBe(true);
    await view.resolve(0, "Abandoned preview");
    expect(view.client.getQueryData(openingSessionHistoryOptions(view.input()).queryKey)).toBeUndefined();
    prefetchOpeningSessionHistory(view.client, view.input());
    expect(view.reads).toHaveLength(2);
    await act(async () => view.reads[1].reject(new Error("Optional preview failed")));
    await settle();
    expect(view.client.getQueryState(openingSessionHistoryOptions(view.input()).queryKey)?.status).toBe("error");
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    await view.render();
    expect(view.reads).toHaveLength(3);
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    await view.resolve(2, "Fresh preview");
    expect(view.host.textContent).toContain("Fresh preview");
  });

  test("prefetch and click fence credentials and owners without putting credentials in keys", async () => {
    const view = fixture();
    const original = view.input("a", "credential-old");
    const rotated = view.input("a", "credential-new");
    expect(openingSessionHistoryOptions(original).queryKey).not.toEqual(openingSessionHistoryOptions(rotated).queryKey);
    expect(JSON.stringify(openingSessionHistoryOptions(original).queryKey)).not.toContain("credential-old");
    expect(openingSessionHistoryOptions({ ...original, owner: "other-endpoint/workspace/a" }).queryKey)
      .not.toEqual(openingSessionHistoryOptions(original).queryKey);
    const cancel = prefetchOpeningSessionHistory(view.client, original);
    cancel?.(); // Route releases its warmup when endpoint/auth ownership changes.
    await view.render("a", "credential-new");
    expect(view.reads.map((read) => read.authToken)).toEqual(["credential-old", "credential-new"]);
    await view.resolve(0, "Old credential data");
    expect(view.host.textContent).not.toContain("Old credential data");
    // Also exercise a credential change while the actual opening hook is mounted.
    await view.render("a", "credential-newest");
    expect(view.reads[1].signal.aborted).toBe(true);
    await view.resolve(1, "Superseded data");
    expect(view.host.textContent).not.toContain("Superseded data");
    await view.render("a", "credential-newest", "other-endpoint/workspace/a");
    expect(view.reads[2].signal.aborted).toBe(true);
    await view.resolve(2, "Previous endpoint data");
    expect(view.host.textContent).not.toContain("Previous endpoint data");
    await view.resolve(3, "Current credential data");
    expect(view.host.textContent).toContain("Current credential data");
  });

  test("dwell intent cancels on leave, blur, callback ownership change, and unmount but transfers a clicked read", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const cancel = mock();
    const prefetch = mock(() => cancel);
    const replacement = mock(() => cancel);
    let commit = () => {};
    function Intent({ hover, focus, callback }: { hover: boolean; focus: boolean; callback: typeof prefetch }) {
      commit = useSessionPrefetchIntent(hover || focus, callback);
      return null;
    }
    const render = async (hover: boolean, focus = false, callback = prefetch) => {
      await act(async () => root.render(<Intent hover={hover} focus={focus} callback={callback} />));
    };
    const advance = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); };
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
    await render(false);
    for (let row = 0; row < 5; row++) {
      await render(true);
      await advance(249);
      await render(false);
    }
    expect(prefetch).not.toHaveBeenCalled();
    await render(false, true);
    await advance(250);
    expect(prefetch).toHaveBeenCalledTimes(1);
    await render(true, true);
    await render(true, false);
    expect(cancel).not.toHaveBeenCalled(); // Pointer intent still owns the read.
    await render(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    await render(true);
    await advance(100);
    await render(true, false, replacement);
    await advance(150);
    expect(replacement).not.toHaveBeenCalled();
    await advance(100);
    expect(replacement).toHaveBeenCalledTimes(1);
    commit();
    await render(false, false, replacement);
    expect(cancel).toHaveBeenCalledTimes(1); // Click owns the in-flight query now.
    await render(false, true, replacement);
    await advance(250);
    await cleanups.pop()?.();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  test("partial, failed, retrying, and complete history status reserves a row above the reader", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, snapshot("a", "Reading preview", [...fullWindow, "anchor"]));
    const scroller = view.host.querySelector<HTMLDivElement>("[data-thread-scroll]");
    if (!scroller) throw new Error("Missing scroll viewport");
    scroller.scrollTop = 800;
    const anchor = scroller.querySelector('[data-message-id="anchor"]');
    const checkGeometry = (status: string | null) => {
      expect(view.host.querySelector("[data-thread-scroll]")).toBe(scroller);
      expect(scroller.scrollTop).toBe(800);
      expect(scroller.querySelector('[data-message-id="anchor"]')).toBe(anchor);
      expect(scroller.querySelector("[data-thread-history-status]")).toBeNull();
      const element = view.host.querySelector("[data-thread-history-status]");
      if (status === null) expect(element).toBeNull();
      else {
        expect(element?.classList.contains("absolute")).toBe(false);
        expect(element?.classList.contains("shrink-0")).toBe(true);
        expect(element?.nextElementSibling).toBe(scroller.parentElement);
        expect(element?.textContent).toContain(status);
      }
    };
    // Nothing is in flight until the uncapped read is staged.
    checkGeometry(null);
    await paint();
    await paint();
    checkGeometry("Loading earlier messages…");
    const loadingStatus = view.host.querySelector("[data-thread-history-status]");
    await act(async () => view.reads[1].reject(new Error("Full read unavailable")));
    await settle();
    checkGeometry("could not be loaded");
    expect(view.host.querySelector('[data-thread-history-status] [role="status"]')).toBeNull();
    expect(view.host.querySelectorAll("[data-thread-history-status]")).toHaveLength(1);
    await act(async () => view.host.querySelector("button")?.click());
    checkGeometry("Loading earlier messages…");
    await view.resolve(2, snapshot("a", "Full history", ["before", ...fullWindow, "anchor", "after"]));
    expect(scroller.scrollTop).toBe(800);
    expect(scroller.querySelector('[data-message-id="anchor"]')).toBe(anchor);
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    expect(loadingStatus?.isConnected).toBe(false);
    await view.render();
    checkGeometry(null);
  });

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
    if (backgroundRead) view.startSharedRead();
    await view.render();
    const precedingReads = backgroundRead ? 1 : 0;
    expect(view.reads).toHaveLength(precedingReads);
    await view.resolveLatest(0, snapshot("a", "Newest through C", ["A", "B", "C"]));
    expect(view.host.querySelector('[data-message-id="C"]')).not.toBeNull();
    await act(async () => view.client.setQueryData(transcriptKey("workspace", "a"), ["A", "B", "C", "D"].map((id) => ({ id, role: "assistant", parts: [] }))));
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
    expect(view.client.getQueryData<OpenworkSessionHistory>(snapshotKey("workspace", "a"))?.session.revert).toBeUndefined();
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
    expect(retry?.getAttribute("aria-label")).toBe("Reload conversation");
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

  test("a send reads the current turn from cached complete history or one bounded newest read, never the uncapped read", async () => {
    const view = fixture();
    await view.render();
    await view.resolve(0, "Reading preview");
    // Cold thread: the preview may be an older saved region and the uncapped
    // read is still in flight. The send takes the bounded newest read instead.
    const pending = view.readSendHistory();
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }]);
    expect(view.latestReads).toHaveLength(1);
    await view.resolveLatest(0, snapshot("a", "Newest turn", ["older", "current"]));
    expect((await pending).map(({ info }) => info.id)).toEqual(["older", "current"]);
    // A newest read that belongs to another thread is refused, never sent with.
    const foreign = view.readSendHistory().then(() => "sent", (error: unknown) => (error instanceof Error ? error.message : String(error)));
    await view.resolveLatest(1, snapshot("b", "Other thread", ["x"]));
    expect(await foreign).toBe("Conversation history belongs to another session.");
    // Warm thread: cached complete history answers without any read.
    view.client.setQueryData(snapshotKey("workspace", "a"), snapshot("a", "Complete", ["1", "2", "3"]));
    expect((await view.readSendHistory()).map(({ info }) => info.id)).toEqual(["1", "2", "3"]);
    expect(view.latestReads).toHaveLength(2);
    expect(view.reads.filter((read) => read.window === undefined)).toHaveLength(0);
  });

  test("a bounded first-send read retries once after StrictMode restores the same owner", async () => {
    const view = fixture();
    let send: Promise<OpenworkSessionHistory["messages"] | string> | undefined;
    await view.renderInput(view.input(), { strict: true, onMount: () => {
      send ??= view.readSendHistory().catch((error: unknown) => String(error));
    } });
    expect(view.latestReads).toHaveLength(1);
    expect(view.latestReads[0].signal.aborted).toBe(true);
    await view.resolveLatest(0, snapshot("a", "Cancelled read", ["stale"]));
    expect(view.latestReads).toHaveLength(2);
    expect(view.latestReads[1].signal.aborted).toBe(false);
    await view.resolveLatest(1, snapshot("a", "Current turn", ["current"]));
    expect(await send).toEqual(snapshot("a", "Current turn", ["current"]).messages);
    expect(view.latestReads).toHaveLength(2);
  });

  test.each(["session", "credentials"])("a cancelled send-history read does not retry after changing %s", async (change) => {
    const view = fixture();
    await view.render("a", "first");
    const send = view.readSendHistory().then(() => "sent", () => "cancelled");
    await view.render(change === "session" ? "b" : "a", change === "credentials" ? "second" : "first");
    expect(view.latestReads[0].signal.aborted).toBe(true);
    await view.resolveLatest(0, snapshot("a", "Old turn", ["stale"]));
    expect(await send).toBe("cancelled");
    expect(view.latestReads).toHaveLength(1);
  });

  test("a send started from a mount effect survives StrictMode dropping and re-adding the reader mid-read", async () => {
    // Development builds run every mount effect twice (StrictMode simulates an
    // unmount). The hero's auto-send starts the uncapped read in the first pass;
    // the simulated unmount removes the surface's only observer and TanStack
    // cancels that read. The send must still receive complete history.
    const view = fixture();
    let send: Promise<{ snapshot: OpenworkSessionHistory } | { error: unknown }> | null = null;
    await view.renderInput(view.input(), { strict: true, onMount: (ensure) => {
      send ??= ensure().then((snapshot) => ({ snapshot }), (error: unknown) => ({ error }));
    } });
    if (!send) throw new Error("The mount effect did not start a send");
    const uncapped = view.reads.filter((read) => read.window === undefined);
    expect(uncapped[0]?.signal.aborted).toBe(true);
    await settle();
    const reissued = view.reads.filter((read) => read.window === undefined && !read.signal.aborted);
    expect(reissued).toHaveLength(1);
    await view.resolve(view.reads.indexOf(reissued[0]), "Complete history for the send");
    const outcome = await send;
    expect("snapshot" in outcome ? outcome.snapshot.session.title : outcome.error).toBe("Complete history for the send");
  });

  test("announces immediately, reveals fast content without a spinner, and stages the uncapped read", async () => {
    const view = fixture();
    await view.render();
    expect(view.host.querySelector('[role="status"]')?.textContent).toContain("Loading conversation");
    expect(view.host.querySelector('[data-thread-loading-visual]')).toBeNull();
    expect(view.host.textContent).toContain("Composer a");
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }]);
    await view.resolve(0, snapshot("a", "Latest messages", fullWindow));
    expect(view.host.querySelector('[data-thread-loading-visual]')).toBeNull();
    expect(view.host.textContent).toContain("Latest messages");
    expect(view.reads).toHaveLength(1);
    // The window is full, yet nothing is loading until the read is staged.
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    await paint();
    expect(view.reads).toHaveLength(1);
    await paint();
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }, undefined]);
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("Loading earlier messages…");
    expect(view.host.querySelector('[data-thread-scroll] [data-thread-history-status]')).toBeNull();
    expect(view.host.querySelector('[data-thread-history-status]')?.classList.contains("absolute")).toBe(false);
    expect(view.host.querySelector('[data-thread-history-status]')?.classList.contains("shrink-0")).toBe(true);
    expect(view.host.textContent).toContain("Latest messages");
    await view.resolve(1, "Complete history");
    expect(view.host.textContent).toContain("Complete history");
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    await act(async () => { jest.advanceTimersByTime(150); });
    expect(view.host.querySelector('[data-thread-loading-visual]')).toBeNull();
  });

  test("an empty preview and completed empty read leave no history status or loading node", async () => {
    const view = fixture();
    await view.render();
    const loading = view.host.querySelector("[data-thread-loading]");
    expect(loading).not.toBeNull();
    await view.resolve(0, snapshot("a", "Empty conversation"));
    expect(loading?.isConnected).toBe(false);
    await paint();
    await paint();
    expect(view.reads.map((read) => read.window)).toEqual([{ limit: 24 }, undefined]);
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    await view.resolve(1, snapshot("a", "Empty conversation"));
    expect(view.client.getQueryState(snapshotKey("workspace", "a"))).toMatchObject({ status: "success", fetchStatus: "idle" });
    await view.render();
    expect(view.host.querySelectorAll("[data-message-id], [data-thread-loading], [data-thread-history-status]")).toHaveLength(0);
    expect(view.reads).toHaveLength(2);
  });

  test("a short preview never announces earlier messages, and a reverted read does not stay announced", async () => {
    // A newest window shorter than its limit is the whole conversation: the
    // uncapped read still runs, but there are no earlier messages to announce
    // over the first one.
    const short = fixture();
    await short.render();
    await short.resolve(0, snapshot("a", "Whole conversation", ["first", "second"]));
    await paint();
    await paint();
    expect(short.reads.map((read) => read.window)).toEqual([{ limit: 24 }, undefined]);
    expect(short.host.querySelector("[data-thread-history-status]")).toBeNull();
    expect(short.host.querySelectorAll("[data-message-id]")).toHaveLength(2);
    await short.resolve(1, snapshot("a", "Whole conversation", ["first", "second"]));
    expect(short.latestReads).toHaveLength(0);
    expect(short.host.querySelector("[data-thread-history-status]")).toBeNull();
    await cleanups.pop()?.();

    // A cancelled read reverts to idle without history. The announcement must
    // follow the read, not the missing history, or it never clears.
    const view = fixture();
    await view.render();
    await view.resolve(0, snapshot("a", "Partial window", fullWindow));
    await paint();
    await paint();
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("Loading earlier messages…");
    await act(async () => { await view.client.cancelQueries({ queryKey: snapshotKey("workspace", "a"), exact: true }); });
    await settle();
    expect(view.reads[1].signal.aborted).toBe(true);
    expect(view.client.getQueryState(snapshotKey("workspace", "a"))).toMatchObject({ status: "pending", fetchStatus: "idle" });
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    expect(view.host.querySelectorAll("[data-message-id]")).toHaveLength(24);
    await act(async () => { void view.client.refetchQueries({ queryKey: snapshotKey("workspace", "a"), exact: true }); });
    await settle();
    expect(view.reads).toHaveLength(3);
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("Loading earlier messages…");
    await view.resolve(2, snapshot("a", "Complete history", ["earlier", ...fullWindow]));
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    expect(view.host.querySelectorAll("[data-message-id]")).toHaveLength(25);
  });

  test("saved positions request their own region, while a late previous-thread preview cannot render in the destination", async () => {
    const store = useSessionScrollStore.getState();
    store.setManualScroll("a", 800, null, { messageId: "reading", offset: -20 });
    store.setGeometry("a", { owner: "a", scrollHeight: 4000, viewportWidth: 600, before: 600, after: 2200, messageIds: ["before", "reading", "after"] });
    const view = fixture();
    await view.render();
    expect(view.reads[0].window).toEqual({ messageIds: ["before", "reading", "after"] });
    expect(view.host.querySelector('[data-thread-loading]')?.getAttribute("style")).toContain("3968px");
    await act(async () => { jest.advanceTimersByTime(149); });
    expect(view.host.querySelector('[data-thread-loading-visual]')).toBeNull();
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(view.host.textContent).toContain("Returning to your reading position");
    expect(view.host.querySelector('[data-thread-loading]')?.getAttribute("style")).toContain("3968px");
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

  test("warm full snapshots skip speculative previews but refresh the selected tail", async () => {
    expect(openingHistoryWindow({ mode: "manual", scrollTop: 500, anchor: { messageId: "legacy", offset: 0 }, topClippedMessageId: null }))
      .toEqual({ messageIds: ["legacy"] });
    expect(openingHistoryWindow({ mode: "manual", scrollTop: 500, anchor: { messageId: "turn:steps", offset: -20 }, topClippedMessageId: null }))
      .toEqual({ messageIds: ["turn"] });
    expect(openingHistoryWindow({ mode: "manual", scrollTop: 500, anchor: { messageId: "session-error:turn", offset: -20 }, topClippedMessageId: null }))
      .toEqual({ messageIds: ["turn"] });
    const view = fixture();
    view.client.setQueryData(snapshotKey("workspace", "a"), snapshot("a", "Cached history"), { updatedAt: Date.now() - 1_000 });
    prefetchOpeningSessionHistory(view.client, view.input());
    expect(view.reads).toHaveLength(0);
    await view.render();
    expect(view.host.textContent).toContain("Cached history");
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    expect(view.reads).toHaveLength(0);
    expect(view.latestReads).toHaveLength(1);
    await view.resolveLatest(0, snapshot("a", "Fresh", ["tail"]));
    expect(view.host.textContent).toContain("tail");
    expect(view.reads.map((read) => read.window)).toEqual([undefined]);
  });

  test("a warm return whose newest window matches the cached tail keeps complete history without an uncapped re-read", async () => {
    const view = fixture();
    const ids = ["first", "second", ...fullWindow];
    const cached = snapshot("a", "Cached history", ids);
    const key = snapshotKey("workspace", "a");
    const tail = (history: OpenworkSessionHistory) => ({ session: history.session, messages: history.messages.slice(-24) });
    const refocus = async () => {
      await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
      await settle();
    };
    // Every fresh newest read re-judges the cache; drive one without touching the full query.
    const rejudge = async () => {
      await act(async () => { void view.client.refetchQueries({ queryKey: ["react-session-latest", ...key] }); });
      await settle();
    };
    // Backdated well past the default freshness window: without confirmation this would refetch.
    view.client.setQueryData(key, cached, { updatedAt: Date.now() - 60_000 });
    await view.render();
    expect(view.latestReads).toHaveLength(1);
    expect(view.reads).toHaveLength(0);
    await view.resolveLatest(0, tail(cached));
    await paint();
    await settle();
    expect(view.reads).toHaveLength(0);
    expect(view.client.getQueryData(key)).toBe(cached);
    expect(visibleIds(view)).toEqual(ids);
    expect(view.host.querySelector("[data-thread-loading]")).toBeNull();
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    // Confirmed history stays current through focus changes.
    await refocus();
    expect(view.reads).toHaveLength(0);
    // A cache object the newest read never judged returns to the default policy.
    const replaced = snapshot("a", "Cached history", [...ids, "appended"]);
    await act(async () => { view.client.setQueryData(key, replaced, { updatedAt: Date.now() - 60_000 }); });
    await settle();
    await refocus();
    expect(view.reads).toHaveLength(1);
    expect(view.reads[0].window).toBeUndefined();
    await view.resolve(0, replaced);
    expect(visibleIds(view)).toEqual([...ids, "appended"]);
    await act(async () => { view.client.setQueryData(key, replaced, { updatedAt: Date.now() - 60_000 }); });
    // A fresh newest read that matches the replacement confirms it again.
    await rejudge();
    expect(view.latestReads).toHaveLength(2);
    await view.resolveLatest(1, tail(replaced));
    await paint();
    await settle();
    await refocus();
    expect(view.reads).toHaveLength(1);
    // Same length as "appended": content changes count even when size does not.
    const changed = snapshot("a", "Cached history", [...ids, "appended"]);
    changed.messages.at(-1)!.parts[0] = { ...changed.messages.at(-1)!.parts[0], type: "text", text: "appendix" };
    await rejudge();
    expect(view.latestReads).toHaveLength(3);
    await view.resolveLatest(2, tail(changed));
    await paint();
    await settle();
    expect(view.reads).toHaveLength(2);
    expect(view.reads[1].window).toBeUndefined();
  });

  test("latestConfirmsFullHistory accepts only an identical tail and compares inline images by size", () => {
    const ids = ["older", ...fullWindow];
    const full = snapshot("a", "Images", ids);
    const image = (bytes: number) => ({ id: "image", sessionID: "a", messageID: "w23", type: "file" as const, mime: "image/png", url: `data:image/png;base64,${"A".repeat(bytes)}` });
    full.messages.at(-1)!.parts.push(image(4_000));
    const latest = (mutate: (copy: OpenworkSessionHistory) => void = () => {}) => {
      const copy = structuredClone(full);
      mutate(copy);
      return { session: copy.session, messages: copy.messages.slice(-24) };
    };
    expect(latestConfirmsFullHistory(full, latest())).toBe(true);
    expect(latestConfirmsFullHistory(full, latest((copy) => { copy.messages.at(-1)!.parts[1] = image(4_001); }))).toBe(false);
    expect(latestConfirmsFullHistory(full, latest((copy) => { copy.messages.at(-1)!.parts.pop(); }))).toBe(false);
    expect(latestConfirmsFullHistory(full, latest((copy) => { copy.session.time.updated = 2; }))).toBe(false);
    expect(latestConfirmsFullHistory(full, latest((copy) => { copy.session.revert = { messageID: "w20" }; }))).toBe(false);
    expect(latestConfirmsFullHistory(full, latest((copy) => { copy.messages.at(-1)!.info.id = "replacement"; }))).toBe(false);
    expect(latestConfirmsFullHistory(full, { session: full.session, messages: full.messages.slice(-24, -1) })).toBe(false);
    const short = snapshot("a", "Short", ["only"]);
    expect(latestConfirmsFullHistory(short, { session: short.session, messages: short.messages })).toBe(true);
    expect(latestConfirmsFullHistory(snapshot("a", "Grown", ["only", "more"]), { session: short.session, messages: short.messages })).toBe(false);
    expect(latestConfirmsFullHistory({ ...full, pagination: { nextCursor: "older", limit: 24 } }, latest())).toBe(false);
  });

  test("a selected warm return shows a persisted tail before a held full read without replacing complete history", async () => {
    const view = fixture();
    const ids = ["first", ...fullWindow, "anchor"];
    const cached = snapshot("a", "Cached history", ids);
    const complete = snapshot("a", "Updated history", [...ids, "new-tail"]);
    const key = snapshotKey("workspace", "a");
    view.client.setQueryData(key, cached, { updatedAt: Date.now() - 1_000 });
    view.startSharedRead();
    await view.render("b");
    await view.render();
    const composer = view.host.querySelector("input");
    expect(view.latestReads).toHaveLength(1);
    const fullRead = view.reads.findIndex((read) => read.owner === "a" && !read.window);
    expect(fullRead).toBeGreaterThanOrEqual(0);
    await view.resolveLatest(0, { session: complete.session, messages: complete.messages.slice(-24) });
    expect(view.host.textContent).toContain("new-tail");
    expect([...view.host.querySelectorAll("[data-message-id]")].map((item) => item.getAttribute("data-message-id"))).toEqual([...ids, "new-tail"]);
    expect(view.host.querySelector("input")).toBe(composer);
    expect(view.host.querySelector("[data-thread-loading]")).toBeNull();
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    expect(view.client.getQueryData(key)).toBe(cached);
    expect(view.client.getQueryData<UIMessage[]>(transcriptKey("workspace", "a"))?.map((item) => item.id)).toEqual(ids);
    expect(await view.ensureFullSnapshot()).toBe(cached);
    await view.resolve(fullRead, cached);
    expect(view.host.textContent).toContain("new-tail");
    await act(async () => { void view.client.refetchQueries({ queryKey: key, exact: true }); });
    await act(async () => view.reads.at(-1)!.reject(new Error("Full refresh unavailable")));
    await settle();
    expect(view.host.textContent).toContain("new-tail");
    expect(view.client.getQueryData(key)).toBe(cached);
    await view.render();
    await view.render();
    expect(view.latestReads).toHaveLength(1);
    await act(async () => { void view.client.refetchQueries({ queryKey: key, exact: true }); });
    const refreshed = view.reads.length - 1;
    expect(view.reads[refreshed].window).toBeUndefined();
    const replacement = snapshot("a", "New authoritative history", [...ids, "new-tail"]);
    replacement.messages.at(-1)!.parts = [{ id: "new-text", sessionID: "a", messageID: "new-tail", type: "text", text: "confirmed" }];
    await view.resolve(refreshed, replacement);
    expect(view.host.textContent).toContain("confirmed");
    expect(view.host.textContent).not.toContain("new-tail");
    expect(view.host.querySelectorAll("[data-message-id]")).toHaveLength(ids.length + 1);
  });

  test("newest and delayed full results cannot duplicate or roll back newer live text and tool completion", async () => {
    const view = fixture();
    const cached = snapshot("a", "Cached", ["old", "active"]);
    const active = cached.messages[1];
    active.parts.push({
      id: "tool-part", sessionID: "a", messageID: "active", type: "tool", tool: "bash", callID: "call",
      state: { status: "running", input: {}, time: { start: 1 } },
    });
    const key = snapshotKey("workspace", "a");
    view.client.setQueryData(key, cached, { updatedAt: Date.now() - 1_000 });
    const initial = snapshotToUIMessages(cached);
    view.client.setQueryData(transcriptKey("workspace", "a"), initial);
    await view.render();
    await view.startOwnedRead();
    expect(view.reads).toHaveLength(1);
    const live: UIMessage[] = [initial[0], {
      ...initial[1],
      parts: [
        { type: "text", text: "newer streaming text", state: "streaming" },
        { type: "dynamic-tool", toolName: "bash", toolCallId: "call", state: "output-available", input: {}, output: "newer live result" },
      ],
    }];
    await act(async () => view.client.setQueryData(transcriptKey("workspace", "a"), live));
    const latest = snapshot("a", "Latest", ["old", "active", "persisted-tail"]);
    latest.messages[1].parts.push({
      ...active.parts[1],
      type: "tool", tool: "bash", callID: "call",
      state: { status: "completed", input: {}, output: "older persisted result", title: "Done", metadata: {}, time: { start: 1, end: 2 } },
    });
    await view.resolveLatest(0, latest);
    const assertLive = () => {
      expect(view.host.textContent).toContain("newer streaming text");
      expect(view.host.textContent).toContain("newer live result");
      expect(view.host.textContent).not.toContain("older persisted result");
      expect([...view.host.querySelectorAll("[data-message-id]")].map((item) => item.getAttribute("data-message-id"))).toEqual(["old", "active", "persisted-tail"]);
    };
    assertLive();
    const staleFull = { ...cached, messages: [cached.messages[0], latest.messages[1]] };
    await view.resolve(0, staleFull);
    assertLive();
    expect(view.client.getQueryData<OpenworkSessionHistory>(key)?.messages).toEqual(staleFull.messages);
  });

  test("warm refresh leaves manual scroll state and the mounted anchor untouched", async () => {
    const view = fixture();
    const cached = snapshot("a", "Reading history", ["before", "anchor", ...fullWindow]);
    view.client.setQueryData(snapshotKey("workspace", "a"), cached, { updatedAt: Date.now() - 1_000 });
    const store = useSessionScrollStore.getState();
    store.setManualScroll("a", 800, null, { messageId: "anchor", offset: -20 }, "a");
    const saved = useSessionScrollStore.getState().sessions;
    await view.render();
    const scroller = view.host.querySelector<HTMLDivElement>("[data-thread-scroll]");
    if (!scroller) throw new Error("Missing scroll viewport");
    scroller.scrollTop = 800;
    const anchor = scroller.querySelector('[data-message-id="anchor"]');
    const latest = snapshot("a", "Latest", ["before", "anchor", ...fullWindow, "new-tail"]);
    await view.resolveLatest(0, { session: latest.session, messages: latest.messages.slice(-24) });
    expect(view.host.textContent).toContain("new-tail");
    expect(scroller.scrollTop).toBe(800);
    expect(scroller.querySelector('[data-message-id="anchor"]')).toBe(anchor);
    expect(useSessionScrollStore.getState().sessions).toBe(saved);
  });

  test("warm refresh is owner and credential scoped, cancels obsolete reads, and never touches a neighbor", async () => {
    const view = fixture();
    const key = snapshotKey("workspace", "a");
    const cached = snapshot("a", "Cached a", ["cached"]);
    const neighbor = snapshot("b", "Neighbor", ["neighbor"]);
    view.client.setQueryData(key, cached);
    view.client.setQueryData(snapshotKey("workspace", "b"), neighbor);
    await view.render("a", "old-credential");
    const oldKey = view.client.getQueryCache().find({ queryKey: ["react-session-latest"], exact: false })?.queryKey;
    expect(JSON.stringify(oldKey)).not.toContain("old-credential");
    await view.render("a", "new-credential");
    expect(view.latestReads[0].signal.aborted).toBe(true);
    await view.resolveLatest(0, snapshot("a", "Old", ["obsolete-credential"]));
    expect(view.host.textContent).not.toContain("obsolete-credential");
    await view.render("a", "new-credential", "other-owner");
    expect(view.latestReads[1].signal.aborted).toBe(true);
    await view.resolveLatest(1, snapshot("a", "Old", ["obsolete-owner"]));
    expect(view.host.textContent).not.toContain("obsolete-owner");
    await view.resolveLatest(2, snapshot("a", "Current", ["current-tail"]));
    expect(view.host.textContent).toContain("current-tail");
    expect(view.client.getQueryData(key)).toBe(cached);
    expect(view.client.getQueryData(snapshotKey("workspace", "b"))).toBe(neighbor);
    await view.render("b");
    expect(view.host.textContent).not.toContain("current-tail");
    await cleanups.pop()?.();
    expect(view.latestReads[3].signal.aborted).toBe(true);
    await act(async () => view.latestReads[3].resolve(snapshot("b", "Late", ["late-unmounted"])));
    expect(view.client.getQueryCache().findAll({ queryKey: ["react-session-latest"] })).toHaveLength(0);
  });

  test("failed or foreign warm reads retain cached content; reconnect retries only the selected entry", async () => {
    const view = fixture();
    const cached = snapshot("a", "Cached history", ["old"]);
    const key = snapshotKey("workspace", "a");
    view.client.setQueryData(key, cached);
    await view.render();
    await act(async () => view.latestReads[0].reject(new Error("Newest unavailable")));
    await settle();
    expect(view.host.textContent).toContain("old");
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    expect(view.client.getQueryData(key)).toBe(cached);
    const reconnect = async () => {
      await act(async () => { onlineManager.setOnline(false); onlineManager.setOnline(true); });
      await settle();
    };
    await reconnect();
    expect(view.latestReads).toHaveLength(2);
    await view.resolveLatest(1, snapshot("a", "New", ["old", "fresh"]));
    expect(view.host.textContent).toContain("fresh");
    await reconnect();
    await act(async () => view.latestReads[2].reject(new Error("Still unavailable")));
    await settle();
    expect(view.host.textContent).toContain("fresh");
    await reconnect();
    await view.resolveLatest(3, snapshot("b", "Foreign", ["foreign"]));
    expect(view.host.textContent).not.toContain("foreign");
    expect(view.host.textContent).toContain("fresh");
    await reconnect();
    const malformed = snapshot("a", "Foreign part", ["foreign-part"]);
    malformed.messages[0].parts[0].sessionID = "b";
    await view.resolveLatest(4, malformed);
    expect(view.host.textContent).not.toContain("foreign-part");
    expect(view.host.textContent).toContain("fresh");
    expect(view.client.getQueryData(key)).toBe(cached);
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
  });

  for (const shared of [false, true]) test(`overlapping full hydration cannot roll newest terminal B back to A without a stream event (shared=${shared})`, async () => {
    const view = fixture();
    const cached = historyTool("terminal-A");
    const key = snapshotKey("workspace", "a");
    view.client.setQueryData(key, cached, { updatedAt: Date.now() - 1_000 });
    if (shared) view.startSharedRead();
    await view.render();
    if (!shared) await view.startOwnedRead();
    expect(view.reads).toHaveLength(1);
    expect(view.reads[0].window).toBeUndefined();
    await view.resolveLatest(0, historyTool("terminal-B"));
    expect(view.host.textContent).toContain("terminal-B");
    const oldFull = historyTool("terminal-A");
    oldFull.messages.push(snapshot("a", "Added history", ["full-only"]).messages[0]);
    await view.resolve(0, oldFull);
    expect(view.host.textContent).toContain("terminal-B");
    expect(view.host.textContent).not.toContain("terminal-A");
    expect(view.host.textContent).toContain("full-only");
    expect(view.client.getQueryData<OpenworkSessionHistory>(key)?.messages).toEqual(oldFull.messages);
    expect(JSON.stringify(view.client.getQueryData(transcriptKey("workspace", "a")))).toContain("terminal-A");
    await view.render();
    expect(view.host.textContent).toContain("terminal-B");
  });

  for (const cachedTool of [false, true]) test(`full reads started after newest advance tools without SSE through completion and later correction (cached tool=${cachedTool})`, async () => {
    const view = fixture();
    const key = snapshotKey("workspace", "a");
    const cached = cachedTool ? historyTool("cached-terminal") : snapshot("a", "Before tool", ["old"]);
    view.client.setQueryData(key, cached, { updatedAt: Date.now() - 1_000 });
    await view.render();
    expect(view.reads).toHaveLength(0);
    await view.resolveLatest(0, historyTool("newest-terminal", "initial", !cachedTool));
    expect(view.host.textContent).toContain(cachedTool ? "newest-terminal" : "input-streaming");
    expect(view.client.getQueryData(key)).toBe(cached);
    expect(view.reads).toHaveLength(1);
    const outputs = ["first-completion", "first-completion", "forward-correction"];
    for (const [index, output] of outputs.entries()) {
      if (index > 0) {
        await act(async () => { void view.client.refetchQueries({ queryKey: key, exact: true }); });
      }
      expect(view.reads).toHaveLength(index + 1);
      expect(view.reads[index].window).toBeUndefined();
      await view.resolve(index, historyTool(output));
      expect(view.host.textContent).toContain("output-available");
      expect(view.host.textContent).toContain(output);
      expect(view.host.textContent).not.toContain("input-streaming");
      expect(view.host.textContent).not.toContain("newest-terminal");
      expect(view.host.querySelectorAll('[data-message-id="active"]')).toHaveLength(1);
      expect(view.host.querySelector('[data-message-id="old"]')).not.toBeNull();
      expect(view.latestReads).toHaveLength(1);
    }
    expect(view.host.textContent).not.toContain("first-completion");
  });

  test("an existing full read finishing before newest does not turn its hydration into a live update", async () => {
    const view = fixture();
    view.client.setQueryData(snapshotKey("workspace", "a"), historyTool("terminal-A"), { updatedAt: Date.now() - 1_000 });
    view.startSharedRead();
    await view.render();
    const full = historyTool("terminal-A2");
    full.session.title = "Finished full";
    await view.resolve(0, full);
    expect(view.client.getQueryData<OpenworkSessionHistory>(snapshotKey("workspace", "a"))?.session.title).toBe("Finished full");
    await view.resolveLatest(0, historyTool("terminal-B"));
    expect(view.host.textContent).toContain("terminal-B");
    expect(view.host.textContent).not.toContain("terminal-A2");
  });

  for (const running of [false, true]) test(`live corrections after stale full hydration replace preserved tool data (running=${running})`, async () => {
    const view = fixture();
    const event = sessionEvents();
    const cached = historyTool("terminal-A", "input-A", running);
    view.client.setQueryData(snapshotKey("workspace", "a"), cached, { updatedAt: Date.now() - 1_000 });
    view.startSharedRead();
    await view.render();
    await view.resolveLatest(0, historyTool("terminal-B", "input-B", running));
    const oldFull = historyTool("terminal-A", "input-A", running);
    oldFull.session.title = "Hydrated";
    await view.resolve(0, oldFull);
    expect(view.host.textContent).toContain("input-B");
    for (const version of ["C", "D"]) {
      const correction = historyTool(`terminal-${version}`, `input-${version}`, running).messages[1].parts[1];
      await event({ type: "message.part.updated", properties: { part: correction } });
      expect(view.host.textContent).toContain(`input-${version}`);
      expect(view.host.textContent).not.toContain("input-B");
      if (!running) expect(view.host.textContent).toContain(`terminal-${version}`);
      await view.render();
      expect(view.host.textContent).toContain(`input-${version}`);
    }
  });

  for (const resolved of [false, true]) for (const reverted of [false, true]) test(`confirmed removal cannot be resurrected by newest or late full reads (resolved=${resolved}, revert cleanup=${reverted})`, async () => {
    const view = fixture();
    const event = sessionEvents();
    const cached = snapshot("a", "Cached", ["old", "M", "after"]);
    const key = snapshotKey("workspace", "a");
    view.client.setQueryData(key, cached, { updatedAt: Date.now() - 1_000 });
    view.client.setQueryData(snapshotKey("workspace", "b"), snapshot("b", "Neighbor", ["M"]));
    view.startSharedRead();
    await view.render();
    if (resolved) await view.resolveLatest(0, snapshot("a", "Newest", ["M", "after", "tail"]));
    if (reverted) {
      await act(async () => applySessionRevert("workspace", { ...cached.session, revert: { messageID: "M" } }));
      await settle();
    }
    await event({ type: "message.removed", properties: { sessionID: "a", messageID: "M" } });
    expect(view.reads[0].signal.aborted).toBe(true);
    if (!resolved) {
      expect(view.latestReads[0].signal.aborted).toBe(true);
      await view.resolveLatest(0, snapshot("a", "Late newest", ["M", "after", "late-tail"]));
    }
    await view.resolve(0, cached);
    if (reverted) {
      await act(async () => applySessionUnrevert("workspace", "a"));
      await settle();
    }
    expect(view.host.querySelector('[data-message-id="M"]')).toBeNull();
    expect(view.host.querySelector('[data-message-id="after"]')).not.toBeNull();
    if (resolved) expect(view.host.querySelector('[data-message-id="tail"]')).not.toBeNull();
    expect(view.client.getQueryData<OpenworkSessionHistory>(key)?.messages.some(({ info }) => info.id === "M")).toBe(false);
    for (const query of view.client.getQueryCache().findAll({ queryKey: ["react-session-latest", ...key] })) {
      const latest = view.client.getQueryData<LatestSessionHistory>(query.queryKey);
      expect(latest?.messages.some((message) => message.id === "M") ?? false).toBe(false);
    }
    await event({ type: "message.updated", properties: { info: { id: "unrelated", sessionID: "a", role: "assistant" } } });
    expect(view.host.querySelector('[data-message-id="M"]')).toBeNull();
    expect(view.client.getQueryData<OpenworkSessionHistory>(snapshotKey("workspace", "b"))?.messages[0].info.id).toBe("M");
  });

  test("a transport that ignores cancellation cannot hold full history behind the newest deadline", async () => {
    const view = fixture();
    const cached = snapshot("a", "Cached", ["old"]);
    view.client.setQueryData(snapshotKey("workspace", "a"), cached, { updatedAt: Date.now() - 1_000 });
    await view.render();
    expect(view.latestReads).toHaveLength(1);
    expect(view.reads).toHaveLength(0);
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await settle();
    expect(view.latestReads[0].signal.aborted).toBe(true);
    expect(view.reads.map((read) => read.window)).toEqual([undefined]);
    await view.resolve(0, snapshot("a", "Complete", ["old", "confirmed"]));
    expect(view.host.textContent).toContain("confirmed");
    // The underlying request can finish even though its caller stopped waiting.
    await view.resolveLatest(0, snapshot("a", "Too late", ["old", "obsolete-tail"]));
    expect(view.host.textContent).not.toContain("obsolete-tail");
    expect(view.host.textContent).toContain("confirmed");
  });

  test("absence from a bounded window is not deletion, and a credential change cannot reuse its scoped data", async () => {
    const view = fixture();
    const cached = snapshot("a", "Cached", ["M", ...fullWindow]);
    view.client.setQueryData(snapshotKey("workspace", "a"), cached);
    await view.render("a", "first-credential");
    await view.resolveLatest(0, snapshot("a", "Window", [...fullWindow, "private-tail"]));
    expect(view.host.querySelector('[data-message-id="M"]')).not.toBeNull();
    expect(view.host.textContent).toContain("private-tail");
    await view.render("a", "second-credential");
    expect(view.host.textContent).not.toContain("private-tail");
    expect(view.client.getQueryData(snapshotKey("workspace", "a"))).toBe(cached);
  });

  test("warm reverted history never uses a partial tail or restores a cursor from it", async () => {
    const view = fixture();
    const cached = snapshot("a", "Reverted", ["before", "cursor", "hidden"], "cursor");
    const key = snapshotKey("workspace", "a");
    view.client.setQueryData(key, cached);
    await view.render();
    await view.resolveLatest(0, snapshot("a", "Unreverted partial", ["hidden", "new-hidden"]));
    expect([...view.host.querySelectorAll("[data-message-id]")].map((item) => item.getAttribute("data-message-id"))).toEqual(["before"]);
    expect(view.client.getQueryData(key)).toBe(cached);
    expect((await view.ensureFullSnapshot()).session.revert?.messageID).toBe("cursor");
  });
});
