/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { notifyManager, onlineManager, QueryClientProvider, skipToken, useQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import type { OpenworkSessionHistory } from "../src/app/lib/openwork-server";
import { openingHistoryWindow, openingSessionHistoryOptions, prefetchOpeningSessionHistory, sessionHistoryIdentity, SessionHistoryBoundary, SessionHistoryStatus, useOpeningSessionHistory, useSessionPrefetchIntent, type OpeningHistoryWindow } from "../src/react-app/domains/session/surface/session-history";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { flushSessionScrollState, useSessionScrollStore } from "../src/react-app/domains/session/surface/scroll-store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, applySessionRevert, applySessionUnrevert, seedSessionState, snapshotKey, statusKey, trackWorkspaceSessionSync, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";
import type { OpencodeEvent } from "../src/app/types";
import { deriveRenderedSessionMessages, type LatestSessionHistory } from "../src/react-app/domains/session/surface/session-render-state";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
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

function longHistory(): OpenworkSessionHistory {
  const history = snapshot("a", "Long active conversation");
  history.messages = Array.from({ length: 440 }, (_, index) => {
    const id = `message-${index}`;
    return {
      info: { id, sessionID: "a", role: "assistant", time: { created: index + 1 } },
      parts: [
        { id: `text-${index}`, sessionID: "a", messageID: id, type: "text", text: `Text ${index}` },
        { id: `reasoning-${index}`, sessionID: "a", messageID: id, type: "reasoning", text: `Reasoning ${index}`, time: { start: 1 } },
        {
          id: `tool-${index}`, sessionID: "a", messageID: id, type: "tool", tool: "bash", callID: `call-${index}`,
          state: index === 439
            ? { status: "running", input: { command: "work" }, time: { start: 1 } }
            : { status: "completed", input: { command: "work" }, output: `Result ${index}`, title: "Done", metadata: {}, time: { start: 1, end: 2 } },
        },
      ],
    };
  });
  return history;
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

function fixture() {
  const client = getReactQueryClient();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let ensureFullSnapshot: (() => Promise<OpenworkSessionHistory>) | undefined;
  let runWithFullSnapshot: ReturnType<typeof useOpeningSessionHistory>["runWithFullSnapshot"] | undefined;
  const reads: { owner: string; authToken?: string; window?: OpeningHistoryWindow; signal: AbortSignal; resolve: (snapshot: OpenworkSessionHistory) => void; reject: (error: Error) => void }[] = [];
  const latestReads: { owner: string; authToken?: string; signal: AbortSignal; resolve: (history: Pick<OpenworkSessionHistory, "session" | "messages">) => void; reject: (error: Error) => void }[] = [];
  function input(owner = "a", authToken?: string, cacheOwner = owner) {
    const readSnapshot = (signal: AbortSignal, window?: OpeningHistoryWindow) => new Promise<OpenworkSessionHistory>((resolve, reject) => {
      reads.push({ owner, authToken, window, signal, resolve, reject });
    });
    const readLatest = (signal: AbortSignal) => new Promise<Pick<OpenworkSessionHistory, "session" | "messages">>((resolve, reject) => {
      latestReads.push({ owner, authToken, signal, resolve, reject });
    });
    return { owner: cacheOwner, sessionId: owner, authToken, snapshotQueryKey: snapshotKey("workspace", owner), transcriptQueryKey: transcriptKey("workspace", owner), readSnapshot, readLatest };
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
    const full = useQuery({ queryKey: key, queryFn: ({ signal }) => opening.readFullSnapshot(signal), enabled: opening.backgroundReady, staleTime: 500, retry: false });
    const current = full.data ?? opening.snapshot;
    useEffect(() => {
      if (current) opening.seedSnapshot(current, () => seedSessionState(workspaceId, current, { preview: !full.data }));
    }, [workspaceId, current, full.data, opening.seedSnapshot]);
    const transcript = useQuery<UIMessage[]>({ queryKey: transcriptKey(workspaceId, owner), queryFn: skipToken });
    const messages = deriveRenderedSessionMessages({ snapshot: current, transcriptState: transcript.data, historyComplete: Boolean(full.data), latestHistory: opening.latestHistory });
    const pending = !current || (!full.data && Boolean(current.session.revert));
    const failed = full.isError && !full.isFetching;
    return <><span>Composer {owner}</span><input aria-label="Draft" /><div className="relative"><div data-thread-scroll><SessionHistoryBoundary owner={cacheOwner} pending={pending} saved={opening.saved} failed={failed}>
      <div>{current?.session.title}</div>{messages.map((message) => <div key={message.id} data-message-id={message.id}>{message.parts.map((part) => part.type === "text" ? part.text : part.type === "dynamic-tool" ? `${part.state}:${JSON.stringify({ input: part.input, output: "output" in part ? part.output : null })}` : "").join(" ")}</div>)}
    </SessionHistoryBoundary></div><SessionHistoryStatus key={cacheOwner} complete={Boolean(full.data)} pending={pending} loading={full.isFetching && opening.partial} failed={failed} onRetry={() => full.refetch()} /></div></>;
  }
  async function renderInput(options: ReturnType<typeof input>, mount: { strict?: boolean; onMount?: (ensure: () => Promise<OpenworkSessionHistory>) => void } = {}) {
    const tree = <QueryClientProvider client={client}><Harness options={options} onMount={mount.onMount} /></QueryClientProvider>;
    await act(async () => flushSync(() => root.render(mount.strict ? <StrictMode>{tree}</StrictMode> : tree)));
  }
  cleanups.push(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
  return {
    reads, latestReads, host, client, input, renderInput,
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
    render(owner = "a", authToken?: string, cacheOwner = owner) { return renderInput(input(owner, authToken, cacheOwner)); },
    async resolve(index: number, title: string | OpenworkSessionHistory) {
      await act(async () => reads[index].resolve(typeof title === "string" ? snapshot(reads[index].owner, title) : title));
      await settle();
    },
  };
}

describe("opening a thread", () => {
  test("a 440-message mixed-part history completes while the conversation stays active", async () => {
    const view = fixture();
    const event = sessionEvents();
    const full = longHistory();
    expect(full.messages.reduce((count, message) => count + message.parts.length, 0)).toBe(1320);
    await view.render();
    await view.resolve(0, { session: full.session, messages: full.messages.slice(-24) });
    await paint();
    await paint();
    await event({ type: "session.status", properties: { sessionID: "a", status: { type: "busy" } } });
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("Loading earlier messages…");
    expect(view.host.querySelectorAll("[data-message-id]")).toHaveLength(24);
    await view.resolve(1, full);
    expect(view.client.getQueryState(snapshotKey("workspace", "a"))).toMatchObject({ status: "success", fetchStatus: "idle" });
    expect(view.host.querySelectorAll("[data-message-id]")).toHaveLength(440);
    expect(view.host.textContent).toContain("Text 0");
    expect(view.host.textContent).toContain("input-streaming");
    expect(view.client.getQueryData(statusKey("workspace", "a"))).toEqual({ type: "busy" });
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    expect(view.latestReads).toHaveLength(0);
  });

  test("a stalled full history read releases loading for Retry without losing the active preview", async () => {
    const view = fixture();
    const event = sessionEvents();
    const full = longHistory();
    await view.render();
    await view.resolve(0, { session: full.session, messages: full.messages.slice(-24) });
    await paint();
    await paint();
    await event({ type: "session.status", properties: { sessionID: "a", status: { type: "busy" } } });
    const composer = view.host.querySelector("input");
    if (!composer) throw new Error("Missing composer");
    composer.value = "Keep my unsent draft";
    expect(view.reads).toHaveLength(2);
    expect(view.reads[1].window).toBeUndefined();
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("Loading earlier messages…");
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await settle();
    expect(view.reads[1].signal.aborted).toBe(true);
    expect(view.client.getQueryState(snapshotKey("workspace", "a"))).toMatchObject({ status: "error", fetchStatus: "idle" });
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("The rest of this conversation could not be loaded.");
    expect(view.host.querySelectorAll("[data-message-id]")).toHaveLength(24);
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    await act(async () => view.host.querySelector("button")?.click());
    expect(view.reads).toHaveLength(3);
    expect(view.reads[2].window).toBeUndefined();
    expect(view.reads[2].signal.aborted).toBe(false);
    await act(async () => view.reads[2].reject(new Error("Retry failed")));
    await settle();
    expect(view.host.querySelector("button")?.textContent).toBe("Retry");
    await act(async () => view.host.querySelector("button")?.click());
    expect(view.reads).toHaveLength(4);
    await view.resolve(3, full);
    await view.resolve(1, snapshot("a", "Obsolete timed-out result", ["obsolete"]));
    expect(view.host.querySelectorAll("[data-message-id]")).toHaveLength(440);
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    expect(view.host.textContent).not.toContain("Obsolete timed-out result");
    expect(view.host.querySelector("input")).toBe(composer);
    expect(composer.value).toBe("Keep my unsent draft");
  });

  test("an engine switch abandons the old preview and completes the new engine's full history", async () => {
    const view = fixture();
    const identity = (opencodeBaseUrl: string) => sessionHistoryIdentity({
      draftScope: "local", opencodeBaseUrl, runtimeWorkspaceId: "workspace", sessionId: "a",
    });
    const v1 = { ...view.input(), ...identity("http://localhost/opencode") };
    const v2 = { ...view.input(), ...identity("http://localhost/opencode2") };
    expect(v1.snapshotQueryKey).toEqual(v2.snapshotQueryKey);
    expect(v1.owner).not.toBe(v2.owner);
    await view.renderInput(v1);
    await view.renderInput(v2);
    expect(view.reads[0].signal.aborted).toBe(true);
    await view.resolve(0, snapshot("a", "Old engine", ["obsolete"]));
    expect(view.host.textContent).not.toContain("Old engine");
    const full = longHistory();
    await view.resolve(1, { session: full.session, messages: full.messages.slice(-24) });
    await paint();
    await paint();
    expect(view.reads).toHaveLength(3);
    expect(view.reads[2].window).toBeUndefined();
    await view.resolve(2, full);
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await settle();
    expect(view.client.getQueryState(v2.snapshotQueryKey)).toMatchObject({ status: "success", fetchStatus: "idle" });
    expect(view.host.querySelectorAll("[data-message-id]")).toHaveLength(440);
    expect(view.host.querySelector("[data-thread-history-status]")).toBeNull();
    expect(view.host.textContent).not.toContain("obsolete");
  });

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
