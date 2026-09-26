import { afterAll, afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import type { UIMessage } from "ai";

import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  __setSessionSyncDeltaFlushSchedulerForTest,
  trackWorkspaceSessionSync,
  snapshotKey,
  statusKey,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";

// The transcript cache is written by the module-singleton SSE sync and only
// observed by the mounted SessionSurface. When the user switches to another
// session while this one is still streaming, the transcript query has zero
// observers but events keep arriving (the session stays tracked/retained).
//
// TanStack GC is scheduled on query creation and when the last observer
// leaves; `Query.setData` never reschedules it. With a bounded gcTime the
// transcript was deleted mid-stream, the next delta flush rebuilt it from []
// without the in-flight text part, and every later delta was parked in
// pendingDeltas — invisible until the terminal message.part.updated arrived
// with the full text. The user saw a stalled conversation on return that
// "finished" all at once.

const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
const previousQueryClient = Reflect.get(globalThis, "__owReactQueryClient");
const key = transcriptKey("workspace-a", "session-a");

function transcript() {
  return getReactQueryClient().getQueryData<UIMessage[]>(key);
}

function hasTranscriptQuery() {
  return getReactQueryClient().getQueryCache().find({ queryKey: key, exact: true }) !== undefined;
}

function textPart(text: string) {
  return { id: "part-text", messageID: "msg-a", sessionID: "session-a", type: "text" as const, text };
}

function delta(text: string) {
  __applySessionSyncEventForTest(syncInput, {
    type: "message.part.delta",
    properties: { sessionID: "session-a", messageID: "msg-a", partID: "part-text", field: "text", delta: text },
  });
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, "__owReactQueryClient");
  jest.useFakeTimers();
  // Flush deltas synchronously so the test observes exactly one commit per event.
  __setSessionSyncDeltaFlushSchedulerForTest((_lane, flush) => {
    flush();
    return () => {};
  });
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {}, waitingByWorkspaceId: {} });
});

afterEach(() => {
  __setSessionSyncDeltaFlushSchedulerForTest(null);
  jest.useRealTimers();
  getReactQueryClient().clear();
});

afterAll(() => {
  if (previousQueryClient === undefined) Reflect.deleteProperty(globalThis, "__owReactQueryClient");
  else Reflect.set(globalThis, "__owReactQueryClient", previousQueryClient);
});

const parentMessages: UIMessage[] = [{
  id: "parent-message", role: "assistant", parts: [{
    type: "dynamic-tool", toolName: "task", toolCallId: "task-call", state: "input-available",
    input: { description: "Review notes" }, callProviderMetadata: { openwork: { childSessionId: "session-a" } },
  }],
}];

function declareAssistant() {
  __applySessionSyncEventForTest(syncInput, {
    type: "message.updated",
    properties: { info: { id: "msg-a", role: "assistant", sessionID: "session-a", time: { created: 1 } } },
  });
}

function declareTask() {
  __applySessionSyncEventForTest(syncInput, {
    type: "message.updated",
    properties: { info: { id: "parent-message", role: "assistant", sessionID: "parent", time: { created: 1 } } },
  });
  __applySessionSyncEventForTest(syncInput, {
    type: "message.part.updated", properties: { part: {
      id: "task-part", messageID: "parent-message", sessionID: "parent", type: "tool", tool: "task", callID: "task-call",
      state: { status: "running", input: { description: "Review notes" }, title: "Review notes", metadata: { sessionId: "session-a" }, time: { start: 1 } },
    } },
  });
}

describe("related child live progress", () => {
  test("admits a created child synchronously for its full live stream", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    trackWorkspaceSessionSync(syncInput, "parent");
    try {
      __applySessionSyncEventForTest(syncInput, { type: "session.created", properties: { info: { id: "session-a", parentID: "parent" } } });
      declareAssistant();
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("Hello") } });
      delta(" world");
      delta("!");
      expect(transcript()).toMatchObject([{ id: "msg-a", role: "assistant", parts: [{ type: "text", text: "Hello world!" }] }]);
    } finally {
      cleanup();
    }
  });

  test.each(["live", "restored"])("admits a %s task reference without child metadata", (source) => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    try {
      if (source === "restored") useSessionActivityStore.getState().observeTranscript("workspace-a", "parent", parentMessages, true);
      trackWorkspaceSessionSync(syncInput, "parent");
      if (source === "live") declareTask();
      declareAssistant();
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("Hello") } });
      delta(" world");
      expect(transcript()?.[0]?.parts).toMatchObject([{ type: "text", text: "Hello world" }]);
    } finally {
      cleanup();
    }
  });

  test("missing declarations do not block real delta progress or synthesize text", () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    try {
      __applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: "session-a", status: { type: "busy" } } });
      declareAssistant();
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("PRIVATE") } });
      expect(transcript()).toBeUndefined();
      trackWorkspaceSessionSync(syncInput, "parent");
      declareTask();
      const before = useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]["session-a"];
      clock.mockReturnValue(62_000);
      delta("");
      expect(useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]["session-a"]).toBe(before);
      delta(" OUTPUT");
      const after = useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]["session-a"];
      expect(after.lastProgressAt).toBe(62_000);
      expect(after.runActive).toBe(true);
      expect(after.runStatusAt).toBe(before.runStatusAt);
      expect(after.latestActivity).toBe(before.latestActivity);
      expect(transcript()?.flatMap((message) => message.parts) ?? []).toEqual([]);
      expect(JSON.stringify(after)).not.toContain("PRIVATE");
      expect(JSON.stringify(after)).not.toContain("OUTPUT");
      declareAssistant();
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("PRIVATE OUTPUT") } });
      expect(transcript()).toMatchObject([{ role: "assistant", parts: [{ type: "text", text: "PRIVATE OUTPUT" }] }]);
    } finally {
      cleanup();
      clock.mockRestore();
    }
  });

  test.each(["session.idle", "session.execution.succeeded", "session.execution.failed"])("late deltas leave %s activity unchanged", (terminalEvent) => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    try {
      trackWorkspaceSessionSync(syncInput, "parent");
      declareTask();
      __applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: "session-a", status: { type: "busy" } } });
      declareAssistant();
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("Hello") } });
      __applySessionSyncEventForTest(syncInput, { type: terminalEvent, properties: { sessionID: "session-a" } });
      const before = useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]["session-a"];
      const statusBefore = getReactQueryClient().getQueryData(statusKey("workspace-a", "session-a"));
      clock.mockReturnValue(62_000);
      delta(" late");
      expect(useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]["session-a"]).toBe(before);
      expect(before.runActive).toBe(false);
      expect(getReactQueryClient().getQueryData(statusKey("workspace-a", "session-a"))).toEqual(statusBefore);
    } finally {
      cleanup();
      clock.mockRestore();
    }
  });

  test("discovery and progress stay within the parent's workspace", () => {
    const other = { ...syncInput, workspaceId: "workspace-b" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const cleanupOther = __createWorkspaceSessionSyncForTest(other);
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      useSessionActivityStore.getState().observeTranscript("workspace-b", "parent", parentMessages);
      trackWorkspaceSessionSync(syncInput, "parent");
      __applySessionSyncEventForTest(syncInput, { type: "session.created", properties: { info: { id: "session-a", parentID: "unrelated" } } });
      declareAssistant();
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("Hello") } });
      expect(transcript()).toBeUndefined();
      declareTask();
      __applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: "session-a", status: { type: "busy" } } });
      __applySessionSyncEventForTest(other, { type: "session.status", properties: { sessionID: "session-a", status: { type: "busy" } } });
      const before = useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]["session-a"];
      clock.mockReturnValue(62_000);
      __applySessionSyncEventForTest(other, { type: "message.part.delta", properties: { sessionID: "session-a", messageID: "msg-a", partID: "part-text", field: "text", delta: "other" } });
      expect(useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]["session-a"]).toBe(before);
      expect(useSessionActivityStore.getState().recordsByWorkspaceId["workspace-b"]["session-a"].lastProgressAt).toBe(62_000);
      expect(transcript()).toBeUndefined();
      delta("here");
      expect(useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]["session-a"].lastProgressAt).toBe(62_000);
    } finally {
      cleanup();
      cleanupOther();
      clock.mockRestore();
    }
  });
});

describe("background session transcript", () => {
  test("native revert commit removes the old suffix from visible and paged history before clearing the cursor", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");
    try {
      const messages: UIMessage[] = [
        { id: "first", role: "user", parts: [{ type: "text", text: "Keep this turn" }] },
        { id: "edited", role: "user", parts: [{ type: "text", text: "Old request" }] },
        { id: "answer", role: "assistant", parts: [{ type: "text", text: "Old answer" }] },
      ];
      const query = getReactQueryClient();
      const pageKey = ["react-session-latest", ...snapshotKey("workspace-a", "session-a")];
      query.setQueryData(key, messages);
      query.setQueryData(pageKey, { messages, source: messages });
      __applySessionSyncEventForTest(syncInput, { type: "session.history.truncated", properties: { sessionID: "session-a", messageID: "edited" } });
      __applySessionSyncEventForTest(syncInput, { type: "session.updated", properties: { info: { id: "session-a", revert: undefined } } });
      expect(transcript()).toEqual([messages[0]]);
      expect(query.getQueryData(pageKey)).toEqual({ messages: [messages[0]], source: [messages[0]] });
    } finally { release(); cleanup(); }
  });

  test("deltas keep landing after the user has been away longer than any gc window", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");
    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-a", role: "assistant", sessionID: "session-a", time: { created: 1 } } },
      });
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("Hel") } });
      delta("lo");
      expect(transcript()?.[0]?.parts).toMatchObject([{ type: "text", text: "Hello", state: "streaming" }]);

      // User switches to another session: the surface's observer leaves, the
      // sync keeps the session retained because the run is still live.
      release();
      jest.advanceTimersByTime(60_000);
      expect(hasTranscriptQuery()).toBe(true);

      // Deltas streamed while away must extend the existing part, not be
      // parked against a rebuilt empty transcript.
      delta(", world");
      delta("!");
      expect(transcript()?.[0]?.parts).toMatchObject([{ type: "text", text: "Hello, world!", state: "streaming" }]);

      // Coming back re-tracks the session and sees the up-to-date text.
      const retrack = trackWorkspaceSessionSync(syncInput, "session-a");
      expect(transcript()).toMatchObject([{ id: "msg-a", role: "assistant", parts: [{ type: "text", text: "Hello, world!" }] }]);
      retrack();
    } finally {
      cleanup();
    }
  });

  test("an old endpoint cannot release the replacement endpoint's conversation", () => {
    const replacement = { ...syncInput, baseUrl: "http://127.0.0.1:1235" };
    const cleanupOld = __createWorkspaceSessionSyncForTest(syncInput);
    const cleanupNew = __createWorkspaceSessionSyncForTest(replacement);
    const releaseOld = trackWorkspaceSessionSync(syncInput, "session-a");
    const releaseNew = trackWorkspaceSessionSync(replacement, "session-a");
    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-a", role: "assistant", sessionID: "session-a", time: { created: 1 } } },
      });
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("Done") } });
      const current = transcript();
      releaseOld();
      __applySessionSyncEventForTest(syncInput, { type: "session.idle", properties: { sessionID: "session-a" } });
      jest.advanceTimersByTime(10_001);
      expect(transcript()).toBe(current);

      releaseNew();
      __applySessionSyncEventForTest(replacement, { type: "session.idle", properties: { sessionID: "session-a" } });
      jest.advanceTimersByTime(10_001);
      expect(hasTranscriptQuery()).toBe(false);
    } finally {
      cleanupOld();
      cleanupNew();
    }
  });

  test("tracked-session lifecycle owns transcript cleanup once the run is idle", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");
    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-a", role: "assistant", sessionID: "session-a", time: { created: 1 } } },
      });
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("Done") } });
      release();
      expect(hasTranscriptQuery()).toBe(true);

      __applySessionSyncEventForTest(syncInput, { type: "session.idle", properties: { sessionID: "session-a" } });
      // Idle shrinks retention to a short grace window; when it elapses the
      // transcript is released with the rest of the session caches.
      jest.advanceTimersByTime(10_001);
      expect(hasTranscriptQuery()).toBe(false);
    } finally {
      cleanup();
    }
  });
});
