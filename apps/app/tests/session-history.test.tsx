/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { OpenworkSessionHistory, OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import { openingHistoryWindow, openingSessionHistoryOptions, prefetchOpeningSessionHistory, sessionHistoryIdentity, SessionHistoryBoundary, SessionHistoryStatus, useOpeningSessionHistory, useSessionPrefetchIntent, type OpeningHistoryWindow } from "../src/react-app/domains/session/surface/session-history";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
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
  jest.useFakeTimers();
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
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

// A newest window that fills its limit may still be missing earlier messages.
const fullWindow = Array.from({ length: 24 }, (_, index) => `w${index}`);

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

function fixture() {
  const client = getReactQueryClient();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let ensureFullSnapshot: (() => Promise<OpenworkSessionHistory>) | undefined;
  let runWithFullSnapshot: ReturnType<typeof useOpeningSessionHistory>["runWithFullSnapshot"] | undefined;
  const reads: { owner: string; authToken?: string; window?: OpeningHistoryWindow; signal: AbortSignal; resolve: (snapshot: OpenworkSessionHistory) => void; reject: (error: Error) => void }[] = [];
  function input(owner = "a", authToken?: string, cacheOwner = owner) {
    const readSnapshot = (signal: AbortSignal, window?: OpeningHistoryWindow) => new Promise<OpenworkSessionHistory>((resolve, reject) => {
      reads.push({ owner, authToken, window, signal, resolve, reject });
    });
    return { owner: cacheOwner, sessionId: owner, authToken, snapshotQueryKey: snapshotKey("workspace", owner), readSnapshot };
  }
  function Harness({ options, onMount }: { options: ReturnType<typeof input>; onMount?: (ensure: () => Promise<OpenworkSessionHistory>) => void }) {
    const { sessionId: owner, owner: cacheOwner } = options;
    const key = options.snapshotQueryKey;
    const workspaceId = key[1];
    const opening = useOpeningSessionHistory(options);
    ensureFullSnapshot = opening.ensureFullSnapshot;
    runWithFullSnapshot = opening.runWithFullSnapshot;
    // The hero's one-step auto-send fires from a mount effect, before any read settled.
    useEffect(() => { onMount?.(opening.ensureFullSnapshot); }, [onMount, opening.ensureFullSnapshot]);
    const full = useQuery({ queryKey: key, queryFn: ({ signal }) => options.readSnapshot(signal), enabled: opening.backgroundReady, staleTime: 500, retry: false });
    const current = full.data ?? opening.snapshot;
    useEffect(() => {
      if (current) seedSessionState(workspaceId, current, { preview: !full.data });
    }, [workspaceId, current, full.data]);
    const messages = deriveRenderedSessionMessages({ snapshot: current, transcriptState: client.getQueryData(transcriptKey(workspaceId, owner)), historyComplete: Boolean(full.data) });
    const pending = !current || (!full.data && Boolean(current.session.revert));
    const failed = full.isError && !full.isFetching;
    return <><span>Composer {owner}</span><input aria-label="Draft" /><div className="relative"><div data-thread-scroll><SessionHistoryBoundary owner={cacheOwner} pending={pending} saved={opening.saved} failed={failed}>
      <div>{current?.session.title}</div>{messages.map((message) => <div key={message.id} data-message-id={message.id}>{message.id}</div>)}
    </SessionHistoryBoundary></div><SessionHistoryStatus key={cacheOwner} complete={Boolean(full.data)} pending={pending} loading={full.isFetching && opening.partial} failed={failed} onRetry={() => full.refetch()} /></div></>;
  }
  async function renderInput(options: ReturnType<typeof input>, mount: { strict?: boolean; onMount?: (ensure: () => Promise<OpenworkSessionHistory>) => void } = {}) {
    const tree = <QueryClientProvider client={client}><Harness options={options} onMount={mount.onMount} /></QueryClientProvider>;
    await act(async () => flushSync(() => root.render(mount.strict ? <StrictMode>{tree}</StrictMode> : tree)));
  }
  cleanups.push(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
  return {
    reads, host, client, input, renderInput,
    get runWithFullSnapshot() {
      if (!runWithFullSnapshot) throw new Error("History is not mounted");
      return runWithFullSnapshot;
    },
    ensureFullSnapshot() {
      if (!ensureFullSnapshot) throw new Error("History is not mounted");
      return ensureFullSnapshot();
    },
    render(owner = "a", authToken?: string, cacheOwner = owner) { return renderInput(input(owner, authToken, cacheOwner)); },
    async resolve(index: number, title: string | OpenworkSessionHistory) {
      await act(async () => reads[index].resolve(typeof title === "string" ? snapshot(reads[index].owner, title) : title));
      await settle();
    },
  };
}

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
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    await paint();
    await paint();
    await act(async () => view.reads[1].reject(new Error("Full read unavailable")));
    await settle();
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("This conversation could not be loaded.");
    expect(view.host.querySelector("[data-thread-placeholder]")?.getAttribute("style")).toBe(geometry);
    const retry = view.host.querySelector("button");
    expect(retry?.type).toBe("button");
    expect(retry?.disabled).toBe(false);
    retry?.focus();
    expect(document.activeElement).toBe(retry);
    await act(async () => { retry?.click(); retry?.click(); });
    expect(view.host.querySelector("button")?.disabled).toBe(true);
    expect(view.host.querySelector('[data-thread-history-status] [role="status"]')?.textContent).toContain("Retrying");
    expect(view.reads).toHaveLength(3);
    expect(view.reads[2].window).toBeUndefined();
    await act(async () => view.reads[2].reject(new Error("Still unavailable")));
    await settle();
    expect(view.host.querySelector("button")?.textContent).toBe("Retry");
    await act(async () => view.host.querySelector("button")?.click());
    await view.resolve(3, "Recovered history");
    expect(view.host.textContent).toContain("Recovered history");
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
    expect(view.client.getQueryState(openingSessionHistoryOptions(view.input()).queryKey)?.status).toBe("success");
    await view.render();
    // A failed optional warmup is stale, not an infinite null cache hit.
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

  test("partial, failed, retrying, and complete history status stays outside the reader's scroll geometry", async () => {
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
        expect(element?.className).toContain("absolute");
        expect(element?.textContent).toContain(status);
      }
    };
    // Nothing is in flight until the uncapped read is staged.
    checkGeometry(null);
    await paint();
    await paint();
    checkGeometry("Loading earlier messages…");
    await act(async () => view.reads[1].reject(new Error("Full read unavailable")));
    await settle();
    checkGeometry("could not be loaded");
    await act(async () => view.host.querySelector("button")?.click());
    checkGeometry("Retrying…");
    await view.resolve(2, snapshot("a", "Full history", ["before", ...fullWindow, "anchor", "after"]));
    expect(scroller.scrollTop).toBe(800);
    expect(scroller.querySelector('[data-message-id="anchor"]')).toBe(anchor);
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
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

  test("a send started from a mount effect survives StrictMode dropping and re-adding the reader mid-read", async () => {
    // Development builds run every mount effect twice (StrictMode simulates an
    // unmount). The hero's auto-send starts the uncapped read in the first pass;
    // the simulated unmount removes the surface's only observer and TanStack
    // cancels that read. The send must still receive complete history.
    const view = fixture();
    let send: Promise<{ snapshot: OpenworkSessionSnapshot } | { error: unknown }> | null = null;
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
    expect(view.host.querySelector('[data-thread-history-status]')?.className).toContain("absolute");
    expect(view.host.textContent).toContain("Latest messages");
    await view.resolve(1, "Complete history");
    expect(view.host.textContent).toContain("Complete history");
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    await act(async () => { jest.advanceTimersByTime(150); });
    expect(view.host.querySelector('[data-thread-loading-visual]')).toBeNull();
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

  test("warm full snapshots skip previews, and old anchors do not require persisted neighbors", async () => {
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
    expect(view.reads.map((read) => read.window)).toEqual([undefined]);
  });
});
