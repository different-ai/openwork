import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { OpenworkSessionHistory } from "../src/app/lib/openwork-server";
import { useOpeningSessionHistory, type OpeningHistoryWindow } from "../src/react-app/domains/session/surface/session-history";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import { sessionScrollKey, useSessionScrollStore } from "../src/react-app/domains/session/surface/scroll-store";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function history(text: string, running = false): OpenworkSessionHistory {
  return {
    session: { id: "ses_shared", title: text, version: "1", time: { created: 1, updated: 2 } },
    messages: [{ info: { id: "msg_assistant", sessionID: "ses_shared", role: "assistant", parentID: "msg_user", time: { created: 2 },
      modelID: "model", providerID: "fixture", mode: "build", agent: "build", path: { cwd: "/fixture", root: "/fixture" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{
      type: "tool", id: "prt_tool", sessionID: "ses_shared", messageID: "msg_assistant", tool: "bash", callID: "call_tool",
      state: running ? { status: "running", input: { command: "fixture" }, time: { start: 1 } }
        : { status: "completed", input: { command: "fixture" }, title: "Finished", output: text, metadata: {}, time: { start: 1, end: 2 } },
    }] }],
  };
}

async function fixture(pageBefore?: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const key = ["react-session-snapshot", "workspace", "ses_shared"];
  const transcriptKey = ["react-session-transcript", "workspace", "ses_shared"];
  const initial = history("Initially running", true);
  useSessionScrollStore.setState({ sessions: {} });
  if (pageBefore === undefined) client.setQueryData(key, initial);
  else {
    initial.pagination = { limit: 24, nextCursor: "older", ...(pageBefore === null ? {} : { before: pageBefore }) };
    if (pageBefore !== null) {
      const store = useSessionScrollStore.getState();
      const scrollKey = sessionScrollKey("ses_shared", "owner-a");
      store.setManualScroll(scrollKey, 400, null, { messageId: "msg_assistant", offset: -20 });
      store.setGeometry(scrollKey, { owner: "owner-a", scrollHeight: 2000, viewportWidth: 600, before: 300, after: 800,
        messageIds: ["msg_assistant"], page: { before: pageBefore, limit: 24, lineage: [null, pageBefore] } });
    }
  }
  client.setQueryData(transcriptKey, snapshotToUIMessages(initial));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const reads: { owner: string; token: string; signal: AbortSignal; window?: OpeningHistoryWindow; resolve: (value: OpenworkSessionHistory) => void }[] = [];
  let current: ReturnType<typeof useOpeningSessionHistory> | undefined;
  function Harness({ owner, token }: { owner: string; token: string }) {
    const opening = useOpeningSessionHistory({ owner, authToken: token, sessionId: "ses_shared", snapshotQueryKey: key, transcriptQueryKey: transcriptKey,
      readSnapshot: (signal, window) => new Promise(resolve => { reads.push({ owner, token, signal, window, resolve }); }),
      readLatest: async () => initial,
    });
    current = opening;
    const snapshot = useQuery({ queryKey: key, queryFn: ({ signal }) => opening.readFullSnapshot(signal), enabled: false });
    useEffect(() => {
      if (snapshot.data) opening.seedSnapshot(snapshot.data, () => client.setQueryData(transcriptKey, snapshotToUIMessages(snapshot.data)));
    }, [snapshot.data, opening.seedSnapshot]);
    return createElement("div", null, JSON.stringify(opening.pageMessages ?? opening.latestHistory?.messages));
  }
  let mounted = true;
  const render = async (owner = "owner-a", token = "token-a") => {
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Harness, { owner, token }))));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  };
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  cleanups.push(async () => {
    await unmount();
    client.clear();
    for (const read of reads) read.resolve(history("Fixture cleanup"));
    host.remove();
  });
  await render();
  const resolve = async (index: number, value: OpenworkSessionHistory) => {
    await act(async () => { reads[index].resolve(value); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  };
  if (pageBefore !== undefined) await resolve(0, initial);
  const historyState = () => { if (!current) throw new Error("Missing history"); return current; };
  return { client, key, host, reads, render, resolve, unmount, historyState };
}

test("send revealLatest keeps paging semantics with one bounded request", async () => {
  const view = await fixture("saved-middle");
  const sending = view.historyState().readSendHistory({ revealLatest: true });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(view.reads[1].window).toEqual({ limit: 24 });
  await view.resolve(1, { ...history("Latest turn"), pagination: { limit: 24, nextCursor: "bridge" } });
  expect(await sending).toHaveLength(1);
  expect(view.historyState().pages.hasNewer).toBe(false);
  expect(view.client.getQueryData(view.key)).toBeUndefined();
  expect(view.reads.every(read => read.window?.limit === 24)).toBe(true);
});
